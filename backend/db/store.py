"""
SQLite persistence layer for scenarios, runs, and keyframes.

Each public function opens and closes its own connection so callers
running in background threads don't share SQLite connection objects.
WAL mode allows concurrent reads alongside any single write.
"""

import hashlib
import json
import logging
import sqlite3
import zlib
from contextlib import contextmanager
from pathlib import Path

logger = logging.getLogger(__name__)


def _db_path() -> Path:
    from config import settings
    return Path(settings.DB_PATH)


@contextmanager
def _conn():
    con = sqlite3.connect(str(_db_path()), check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def init_db() -> None:
    with _conn() as con:
        con.executescript("""
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scenarios (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                parent_id    TEXT REFERENCES scenarios(id),
                patches_json TEXT NOT NULL,
                created_at   TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runs (
                id               TEXT PRIMARY KEY,
                scenario_id      TEXT NOT NULL,
                status           TEXT NOT NULL,
                delta_index_json TEXT,
                stale            INTEGER NOT NULL DEFAULT 0,
                created_at       TEXT NOT NULL
            );
        """)
        # Idempotent column additions for schema migrations
        existing = {row[1] for row in con.execute("PRAGMA table_info(runs)").fetchall()}
        if "edge_delta_index_json" not in existing:
            con.execute("ALTER TABLE runs ADD COLUMN edge_delta_index_json TEXT")
        if "attribution_tags_json" not in existing:
            con.execute("ALTER TABLE runs ADD COLUMN attribution_tags_json TEXT")
        con.executescript("""
            CREATE TABLE IF NOT EXISTS keyframes (
                run_id   TEXT    NOT NULL REFERENCES runs(id),
                run_type TEXT    NOT NULL,
                t        INTEGER NOT NULL,
                payload  BLOB    NOT NULL,
                PRIMARY KEY (run_id, run_type, t)
            );
        """)


# ---------------------------------------------------------------------------
# Graph fingerprint
# ---------------------------------------------------------------------------

def compute_graph_fingerprint(edges) -> str:
    pairs = sorted((e.u, e.v) for e in edges)
    return hashlib.sha256(json.dumps(pairs).encode()).hexdigest()[:16]


def get_stored_fingerprint() -> str | None:
    with _conn() as con:
        row = con.execute(
            "SELECT value FROM meta WHERE key='graph_fingerprint'"
        ).fetchone()
    return row[0] if row else None


def set_graph_fingerprint(fp: str) -> None:
    with _conn() as con:
        con.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES('graph_fingerprint', ?)",
            (fp,),
        )


def mark_runs_stale() -> None:
    """Mark all complete DB runs as stale (graph fingerprint changed)."""
    with _conn() as con:
        con.execute("UPDATE runs SET stale=1 WHERE status='complete'")


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

def save_scenario(scenario) -> None:
    import datetime
    patches_json = json.dumps([
        {
            "type":         p.type,
            "edge_key":     list(p.edge_key) if p.edge_key else None,
            "stop_id":      p.stop_id,
            "route_prefix": p.route_prefix,
            "value":        p.value,
        }
        for p in scenario.patches
    ])
    with _conn() as con:
        con.execute(
            """
            INSERT OR REPLACE INTO scenarios(id, name, parent_id, patches_json, created_at)
            VALUES (?, ?, ?, ?, COALESCE(
                (SELECT created_at FROM scenarios WHERE id=?),
                ?
            ))
            """,
            (
                scenario.id,
                scenario.name,
                scenario.parent_id,
                patches_json,
                scenario.id,
                datetime.datetime.utcnow().isoformat() + "Z",
            ),
        )


def delete_scenario(scenario_id: str) -> None:
    with _conn() as con:
        con.execute("DELETE FROM scenarios WHERE id=?", (scenario_id,))


def load_all_scenarios() -> list[dict]:
    with _conn() as con:
        rows = con.execute(
            "SELECT id, name, parent_id, patches_json FROM scenarios"
        ).fetchall()
    result = []
    for row in rows:
        result.append({
            "id":        row[0],
            "name":      row[1],
            "parent_id": row[2],
            "patches":   json.loads(row[3]),
        })
    return result


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

def save_run(run_result, created_at: str) -> None:
    delta_json = None
    if run_result.deltas is not None:
        delta_json = json.dumps({
            "travel_time_delta_pct":  run_result.deltas.travel_time_delta_pct,
            "congestion_delta_pct":   run_result.deltas.congestion_delta_pct,
            "transit_time_delta_pct": run_result.deltas.transit_time_delta_pct,
            "delay_delta_pct":        run_result.deltas.delay_delta_pct,
            "aadt_calibration_pct":   run_result.aadt_calibration_pct,
        })
    edge_delta_json = None
    if run_result.edge_delta_index is not None:
        # Serialize as list of [edge_id, c_delta, s_delta] for compactness
        edge_delta_json = json.dumps([
            [eid, round(c, 4), round(s, 4)]
            for eid, (c, s) in run_result.edge_delta_index.items()
        ])
    tags_json = None
    if run_result.changelog_entry and run_result.changelog_entry.attribution_tags:
        tags_json = json.dumps(run_result.changelog_entry.attribution_tags)
    with _conn() as con:
        con.execute(
            """
            INSERT OR REPLACE INTO runs(
                id, scenario_id, status, delta_index_json,
                edge_delta_index_json, attribution_tags_json, stale, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
            """,
            (
                run_result.run_id,
                run_result.scenario_id,
                run_result.status,
                delta_json,
                edge_delta_json,
                tags_json,
                created_at,
            ),
        )


def save_keyframes(run_id: str, run_type: str, frames) -> None:
    """Compress and insert all keyframes for one run (baseline or scenario)."""
    rows = []
    for frame in frames:
        payload = json.dumps({
            "t":       frame.timestamp_s,
            "full":    frame.is_full,
            "edges":   frame.edges,
            "transit": frame.transit,
        })
        compressed = zlib.compress(payload.encode(), level=6)
        rows.append((run_id, run_type, frame.timestamp_s, compressed))
    with _conn() as con:
        con.executemany(
            "INSERT OR IGNORE INTO keyframes(run_id, run_type, t, payload) VALUES (?,?,?,?)",
            rows,
        )


def load_all_runs() -> list[dict]:
    """Load run metadata from DB (no keyframes). Used at startup."""
    with _conn() as con:
        rows = con.execute(
            "SELECT id, scenario_id, status, delta_index_json, stale, "
            "edge_delta_index_json, attribution_tags_json FROM runs"
        ).fetchall()
    result = []
    for row in rows:
        deltas = json.loads(row[3]) if row[3] else None
        edge_delta = None
        if row[5]:
            raw = json.loads(row[5])
            edge_delta = {int(r[0]): (float(r[1]), float(r[2])) for r in raw}
        result.append({
            "run_id":           row[0],
            "scenario_id":      row[1],
            "status":           row[2],
            "deltas":           deltas,
            "stale":            bool(row[4]),
            "edge_delta_index": edge_delta,
            "attribution_tags": json.loads(row[6]) if row[6] else [],
        })
    return result


def load_frames(run_id: str, run_type: str) -> list[dict] | None:
    """Load and decompress keyframes for one run. Returns None if none stored."""
    with _conn() as con:
        rows = con.execute(
            "SELECT payload FROM keyframes WHERE run_id=? AND run_type=? ORDER BY t",
            (run_id, run_type),
        ).fetchall()
    if not rows:
        return None
    frames = []
    for (compressed,) in rows:
        raw = zlib.decompress(compressed)
        frames.append(json.loads(raw))
    return frames
