"""
FastAPI route handlers.
"""

import json
import math
import os
import pathlib
import uuid
from collections import OrderedDict
from typing import Any

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from pydantic import BaseModel

from api.state import app_state
from bike.loader import BikeInfraResult, load_bike_infrastructure
from config import settings
from graph.loader import load_graph
from gtfs.loader import load_gtfs_stops
from scenarios.patcher import Patch, Scenario
from schedule.arithmetic import (
    DEFAULT_DWELL_S,
    StopNodeRef,
    compute_trip_time,
    headway_impact as _headway_impact,
    nearest_node,
    stop_impact as _stop_impact,
)
from schedule.performance import reliability_annotation
from simulation.runner import RunResult, execute_dual_run

router = APIRouter()

# ---------------------------------------------------------------------------
# Geographic helpers — derive region context from graph bbox
# ---------------------------------------------------------------------------

# Static US state table: (abbr, fips, min_lon, min_lat, max_lon, max_lat)
# Used to identify which state a graph bbox falls in so external API queries
# (LODES, future state DOT feeds) can be parameterized automatically.
_US_STATES: list[tuple[str, str, float, float, float, float]] = [
    ("al","01",-88.5,30.1,-84.9,35.0), ("ak","02",-180.0,51.2,-130.0,71.4),
    ("az","04",-114.8,31.3,-109.0,37.0), ("ar","05",-94.6,33.0,-89.6,36.5),
    ("ca","06",-124.5,32.5,-114.1,42.0), ("co","08",-109.1,37.0,-102.0,41.0),
    ("ct","09",-73.7,41.0,-71.8,42.1), ("de","10",-75.8,38.4,-75.0,39.8),
    ("dc","11",-77.1,38.8,-76.9,38.9), ("fl","12",-87.6,24.5,-80.0,31.0),
    ("ga","13",-85.6,30.4,-80.8,35.0), ("hi","15",-160.3,18.9,-154.8,22.2),
    ("id","16",-117.2,42.0,-111.0,49.0), ("il","17",-91.5,36.9,-87.0,42.5),
    ("in","18",-88.1,37.8,-84.8,41.8), ("ia","19",-96.6,40.4,-90.1,43.5),
    ("ks","20",-102.1,37.0,-94.6,40.0), ("ky","21",-89.6,36.5,-81.9,39.1),
    ("la","22",-94.0,29.0,-88.8,33.0), ("me","23",-71.1,43.0,-67.0,47.5),
    ("md","24",-79.5,37.9,-75.0,39.7), ("ma","25",-73.5,41.2,-69.9,42.9),
    ("mi","26",-90.4,41.7,-82.4,48.3), ("mn","27",-97.2,43.5,-89.5,49.4),
    ("ms","28",-91.7,30.2,-88.1,35.0), ("mo","29",-95.8,35.9,-89.1,40.6),
    ("mt","30",-116.1,44.4,-104.0,49.0), ("ne","31",-104.1,40.0,-95.3,43.0),
    ("nv","32",-120.0,35.0,-114.0,42.0), ("nh","33",-72.6,42.7,-70.7,45.3),
    ("nj","34",-75.6,38.9,-73.9,41.4), ("nm","35",-109.1,31.3,-103.0,37.0),
    ("ny","36",-79.8,40.5,-71.9,45.0), ("nc","37",-84.3,33.8,-75.5,36.6),
    ("nd","38",-104.1,45.9,-96.6,49.0), ("oh","39",-84.8,38.4,-80.5,42.3),
    ("ok","40",-103.0,33.6,-94.4,37.0), ("or","41",-124.6,42.0,-116.5,46.2),
    ("pa","42",-80.5,39.7,-74.7,42.3), ("ri","44",-71.9,41.1,-71.1,42.0),
    ("sc","45",-83.4,32.0,-78.5,35.2), ("sd","46",-104.1,42.5,-96.4,45.9),
    ("tn","47",-90.3,35.0,-81.6,36.7), ("tx","48",-106.6,25.8,-93.5,36.5),
    ("ut","49",-114.1,37.0,-109.0,42.0), ("vt","50",-73.4,42.7,-71.5,45.0),
    ("va","51",-83.7,36.5,-75.2,39.5), ("wa","53",-124.8,45.5,-116.9,49.0),
    ("wv","54",-82.6,37.2,-77.7,40.6), ("wi","55",-92.9,42.5,-86.2,47.1),
    ("wy","56",-111.1,41.0,-104.1,45.0),
]


def _bbox_state(bbox: tuple[float, float, float, float]) -> tuple[str, str]:
    """
    Given graph bbox (min_lon, min_lat, max_lon, max_lat), return the
    (state_abbr, state_fips) of the state whose bbox contains the center.
    Falls back to ("ny", "36") if no match (safe default for current scope).
    """
    cx = (bbox[0] + bbox[2]) / 2
    cy = (bbox[1] + bbox[3]) / 2
    for abbr, fips, min_lon, min_lat, max_lon, max_lat in _US_STATES:
        if min_lon <= cx <= max_lon and min_lat <= cy <= max_lat:
            return abbr, fips
    return "ny", "36"


def _bbox_socrata_geo_filter(bbox: tuple[float, float, float, float]) -> str:
    """
    Socrata $where clause that filters rows to the graph's bounding box
    using latitude/longitude columns. Works for any NY Open Data dataset
    that exposes these column names.
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    return (
        f"latitude > {min_lat:.6f} AND latitude < {max_lat:.6f} "
        f"AND longitude > {min_lon:.6f} AND longitude < {max_lon:.6f}"
    )


async def _fetch_county_fips_in_bbox(
    bbox: tuple[float, float, float, float],
    state_fips: str,
) -> list[str]:
    """
    Query Census TIGERweb to get the full 5-digit county FIPS codes (state+county)
    for all counties that intersect the graph bbox. Returns e.g. ["36001","36083"].
    Falls back to empty list on error (caller should handle gracefully).
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    url = (
        "https://tigerweb.geo.census.gov/arcgis/rest/services/"
        "TIGERweb/State_County/MapServer/13/query"
    )
    params = {
        "geometry": f"{min_lon},{min_lat},{max_lon},{max_lat}",
        "geometryType": "esriGeometryEnvelope",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "STATE,COUNTY",
        "where": f"STATE='{state_fips}'",
        "f": "json",
    }
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
        fips_codes = []
        for feature in data.get("features", []):
            attrs = feature.get("attributes", {})
            s = str(attrs.get("STATE", "")).zfill(2)
            c = str(attrs.get("COUNTY", "")).zfill(3)
            if s and c:
                fips_codes.append(s + c)
        return fips_codes
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Persistence helpers — backed by SQLite via db.store
# ---------------------------------------------------------------------------

_DATA_DIR = pathlib.Path(__file__).parent.parent / "data"
_SCENARIOS_FILE = _DATA_DIR / "scenarios.json"

import db.store as _db

# Ordered set of run_ids whose frames are currently in memory, LRU-eviction order.
# Keys are run_ids; values are None. The leftmost entry is evicted first.
_frames_lru: OrderedDict[str, None] = OrderedDict()


def _lru_touch(run_id: str) -> None:
    """Mark run_id as most-recently-used and evict if over LRU_MAX_RUNS."""
    _frames_lru[run_id] = None
    _frames_lru.move_to_end(run_id)
    while len(_frames_lru) > settings.LRU_MAX_RUNS:
        evicted_id, _ = _frames_lru.popitem(last=False)
        rr = app_state.runs.get(evicted_id)
        if rr is not None:
            rr.baseline = None
            rr.scenario_result = None
            import logging as _log
            _log.getLogger(__name__).debug("LRU evicted frames for run %s", evicted_id)


def _save_scenario(scenario) -> None:
    _db.save_scenario(scenario)


def _delete_scenario_db(scenario_id: str) -> None:
    _db.delete_scenario(scenario_id)


def load_persisted_scenarios() -> None:
    """Load scenarios from SQLite (migrating from JSON on first run if needed)."""
    import logging as _log
    log = _log.getLogger(__name__)

    rows = _db.load_all_scenarios()

    # One-time migration: if DB is empty and legacy JSON exists, import it
    if not rows and _SCENARIOS_FILE.exists():
        try:
            with open(_SCENARIOS_FILE) as f:
                data = json.load(f)
            for raw in data.get("scenarios", []):
                patches = [
                    Patch(
                        type=p["type"],
                        edge_key=tuple(p["edge_key"]) if p.get("edge_key") else None,
                        stop_id=p.get("stop_id"),
                        route_prefix=p.get("route_prefix"),
                        value=p.get("value"),
                    )
                    for p in raw.get("patches", [])
                ]
                scenario = Scenario(
                    id=raw["id"],
                    name=raw["name"],
                    patches=patches,
                    parent_id=raw.get("parent_id"),
                )
                app_state.scenarios[scenario.id] = scenario
                _db.save_scenario(scenario)
            _SCENARIOS_FILE.rename(str(_SCENARIOS_FILE) + ".migrated")
            log.info("Migrated %d scenarios from JSON to SQLite", len(data.get("scenarios", [])))
        except Exception as exc:
            log.warning("Could not migrate legacy scenarios.json: %s", exc)
        return

    for raw in rows:
        patches = [
            Patch(
                type=p["type"],
                edge_key=tuple(p["edge_key"]) if p.get("edge_key") else None,
                stop_id=p.get("stop_id"),
                route_prefix=p.get("route_prefix"),
                value=p.get("value"),
            )
            for p in raw.get("patches", [])
        ]
        scenario = Scenario(
            id=raw["id"],
            name=raw["name"],
            patches=patches,
            parent_id=raw.get("parent_id"),
        )
        app_state.scenarios[scenario.id] = scenario


def load_persisted_runs() -> None:
    """Load run metadata from SQLite into app_state on startup (no keyframes)."""
    from simulation.runner import ChangelogEntry, MetricDeltas, RunResult
    for row in _db.load_all_runs():
        rr = RunResult(
            run_id=row["run_id"],
            scenario_id=row["scenario_id"],
            status=row["status"],
            progress_pct=100.0 if row["status"] == "complete" else 0.0,
            stale=row["stale"],
            frames_in_db=row["status"] == "complete",
        )
        if row["deltas"]:
            d = row["deltas"]
            rr.deltas = MetricDeltas(
                travel_time_delta_pct=d["travel_time_delta_pct"],
                congestion_delta_pct=d["congestion_delta_pct"],
                transit_time_delta_pct=d["transit_time_delta_pct"],
                delay_delta_pct=d["delay_delta_pct"],
            )
            rr.aadt_calibration_pct = d.get("aadt_calibration_pct")
        rr.edge_delta_index = row.get("edge_delta_index")
        # Restore lightweight changelog entry for attribution tags
        if row.get("attribution_tags") and rr.deltas:
            import datetime as _dt
            rr.changelog_entry = ChangelogEntry(
                run_id=rr.run_id,
                timestamp_iso=_dt.datetime.utcnow().isoformat() + "Z",
                trigger="",
                scenario_id=rr.scenario_id,
                scenario_name="",
                feed_slug=None,
                affected_stop_count=0,
                metrics=rr.deltas,
                summary="",
                attribution_tags=row["attribution_tags"],
            )
        app_state.runs[rr.run_id] = rr


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class PatchIn(BaseModel):
    type: str
    edge_key: list[int] | None = None
    stop_id: str | None = None
    route_prefix: str | None = None
    value: Any = None


class ScenarioIn(BaseModel):
    name: str
    patches: list[PatchIn] = []


class RunRequest(BaseModel):
    scenario_id: str
    duration_minutes: int | None = None


# ---------------------------------------------------------------------------
# Graph
# ---------------------------------------------------------------------------

@router.get("/api/status")
def get_status() -> dict:
    """Lightweight readiness probe. Returns whether GTFS data is loaded."""
    return {
        "graph_loaded": app_state.graph is not None,
        "stops_loaded": len(app_state.stop_records) > 0,
        "stop_count":   len(app_state.stop_records),
        "shape_count":  len(app_state.route_shapes),
        "feeds_synced": list(app_state.feed_slugs),
        "gtfs_disabled": settings.DISABLE_GTFS_SYNC,
    }


@router.get("/api/graph")
def get_graph_info() -> dict:
    g = app_state.graph
    if g is None:
        return {"loaded": False}
    place_str = ", ".join(p.split(",")[0] for p in g.place) if isinstance(g.place, list) else g.place
    return {
        "loaded": True,
        "place": place_str,
        "node_count": len(g.nodes),
        "edge_count": len(g.edges),
        "bbox": g.bbox,
        "stop_count": len(g.stop_nodes),
    }


@router.get("/api/graph/edges")
def get_graph_edges() -> dict:
    """
    Returns edge geometries for frontend map rendering.
    Each entry: { id, coords: [[lat, lng], ...], highway, speed_limit_kmh }
    """
    g = app_state.graph
    if g is None:
        raise HTTPException(status_code=409, detail="Graph not loaded")

    edges_out = []
    for i, e in enumerate(g.edges):
        if e.coords_latlon:
            coords = e.coords_latlon
        else:
            # Fallback to straight u→v line (should not occur after graph reload)
            u_node = g.nodes.get(e.u)
            v_node = g.nodes.get(e.v)
            if not u_node or not v_node:
                continue
            coords = [[u_node["y"], u_node["x"]], [v_node["y"], v_node["x"]]]

        entry: dict = {
            "id": i,
            "coords": coords,
            "highway": e.highway,
            "road_name": e.road_name,
            "speed_limit_kmh": round(e.speed_limit_ms * 3.6, 1),
        }
        if e.aadt_count is not None:
            entry["aadt_count"] = e.aadt_count
        edges_out.append(entry)

    return {"edge_count": len(edges_out), "edges": edges_out}


@router.get("/api/graph/edges/aadt")
def get_edges_aadt() -> dict:
    """Per-edge AADT counts where available."""
    g = app_state.graph
    if g is None:
        raise HTTPException(status_code=409, detail="Graph not loaded")
    result = []
    for i, e in enumerate(g.edges):
        if e.aadt_count is not None:
            result.append({"edge_id": i, "aadt_count": e.aadt_count, "aadt_year": e.aadt_year})
    return {"edges": result}


@router.post("/api/graph/reload", status_code=202)
def reload_graph(background_tasks: BackgroundTasks) -> dict:
    def _load():
        app_state.graph = load_graph()
    background_tasks.add_task(_load)
    return {"status": "reloading"}


# ---------------------------------------------------------------------------
# GTFS feeds
# ---------------------------------------------------------------------------

@router.get("/api/feeds")
def list_feeds() -> list[dict]:
    """
    Returns all configured feeds (from settings.GTFS_FEED_URLS) with their
    sync status. Feeds appear here before they are ever synced.
    """
    return [
        {
            "slug":   slug,
            "synced": slug in app_state.feed_slugs,
        }
        for slug in settings.GTFS_FEED_URLS
    ]


@router.post("/api/feeds/{slug}/sync", status_code=202)
def sync_feed(slug: str, background_tasks: BackgroundTasks, force: bool = False) -> dict:
    if app_state.graph is None:
        raise HTTPException(status_code=409, detail="Graph not loaded yet")

    url = settings.GTFS_FEED_URLS.get(slug)
    if url is None:
        raise HTTPException(status_code=404, detail=f"Unknown feed slug: {slug}")

    if app_state.gtfs_syncing:
        raise HTTPException(status_code=409, detail="GTFS sync already in progress")

    def _sync():
        app_state.gtfs_syncing = True
        try:
            stops, stop_records, route_shapes, route_details, stop_schedules, changed = load_gtfs_stops(
                app_state.graph, url, slug, force=force
            )
            if changed:
                app_state.transit_stops = stops
                # Merge: replace only this feed's stops/shapes/details/schedules, preserve others
                app_state.stop_records = [r for r in app_state.stop_records if r.feed_slug != slug] + stop_records
                app_state.route_shapes = [r for r in app_state.route_shapes if r.feed_slug != slug] + route_shapes
                app_state.route_details = {k: v for k, v in app_state.route_details.items() if not k.startswith(f"{slug}:")}
                for rid, detail in route_details.items():
                    app_state.route_details[f"{slug}:{rid}"] = detail
                app_state.stop_schedules.update(stop_schedules)
                if slug not in app_state.feed_slugs:
                    app_state.feed_slugs.append(slug)
                for scenario in app_state.scenarios.values():
                    if any(
                        p.type in ("stop_add", "stop_remove", "stop_headway", "route_headway")
                        for p in scenario.patches
                    ):
                        sync_run_id = str(uuid.uuid4())
                        app_state.runs[sync_run_id] = RunResult(
                            run_id=sync_run_id,
                            scenario_id=scenario.id,
                            status="running",
                            progress_pct=0.0,
                        )
                        _run_scenario(sync_run_id, scenario.id, trigger="gtfs_sync", feed_slug=slug)
        finally:
            app_state.gtfs_syncing = False

    background_tasks.add_task(_sync)
    return {"slug": slug, "status": "syncing"}


# ---------------------------------------------------------------------------
# GTFS stops & routes
# ---------------------------------------------------------------------------

@router.get("/api/stops")
def get_stops() -> list[dict]:
    """All snapped GTFS stops with position and headway (for map overlay)."""
    return [
        {
            "id":        s.stop_id,
            "name":      s.stop_name,
            "lat":       s.lat,
            "lng":       s.lng,
            "headway_s": round(s.headway_s, 1),
        }
        for s in app_state.stop_records
    ]


@router.get("/api/stops/{stop_id}")
def get_stop_detail(stop_id: str) -> dict:
    """Detail for a single stop including routes serving it."""
    rec = next((s for s in app_state.stop_records if s.stop_id == stop_id), None)
    if rec is None:
        raise HTTPException(status_code=404, detail="Stop not found")
    return {
        "id":        rec.stop_id,
        "name":      rec.stop_name,
        "lat":       rec.lat,
        "lng":       rec.lng,
        "headway_s": round(rec.headway_s, 1),
        "routes_serving": [
            {
                "route_id":         r.route_id,
                "route_short_name": r.route_short_name,
                "route_long_name":  r.route_long_name,
                "route_color":      f"#{r.route_color}",
                "route_type":       r.route_type,
                "feed_slug":        r.feed_slug,
            }
            for r in rec.routes_serving
        ],
    }


@router.get("/api/routes/shapes")
def get_route_shapes() -> dict:
    """
    GeoJSON FeatureCollection of bus route polylines.
    Each feature has properties: route_id, route_short_name, route_long_name,
    route_color (hex), route_type.
    """
    features = []
    for r in app_state.route_shapes:
        detail = app_state.route_details.get(f"{r.feed_slug}:{r.route_id}")
        if detail and detail.headway_by_period:
            vals = [v for v in detail.headway_by_period.values() if v > 0]
            avg_headway_s: float | None = sum(vals) / len(vals) if vals else None
        else:
            avg_headway_s = None
        features.append({
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": r.coordinates,  # [[lon, lat], ...]
            },
            "properties": {
                "route_id":         r.route_id,
                "route_short_name": r.route_short_name,
                "route_long_name":  r.route_long_name,
                "route_color":      f"#{r.route_color}",
                "route_type":       r.route_type,
                "feed_slug":        r.feed_slug,
                "avg_headway_s":    avg_headway_s,
                "avg_speed_kmh":    detail.avg_speed_kmh if detail else None,
            },
        })
    return {"type": "FeatureCollection", "features": features}


@router.get("/api/routes/{route_id}")
def get_route_detail(route_id: str, feed: str | None = None) -> dict:
    """
    Enriched detail for a single route: long name, ordered stop sequence,
    per-period headway, and trip count.

    Pass ?feed=<slug> to disambiguate when multiple feeds have the same route_id.
    If omitted, the first matching detail across all feeds is returned.
    """
    detail = None
    if feed:
        detail = app_state.route_details.get(f"{feed}:{route_id}")
    else:
        # Search all feeds
        for key, d in app_state.route_details.items():
            if d.route_id == route_id:
                detail = d
                break

    if detail is None:
        raise HTTPException(status_code=404, detail=f"Route {route_id!r} not found")

    return {
        "route_id":         detail.route_id,
        "route_short_name": detail.route_short_name,
        "route_long_name":  detail.route_long_name,
        "route_color":      f"#{detail.route_color}",
        "route_type":       detail.route_type,
        "feed_slug":        detail.feed_slug,
        "trip_count":       detail.trip_count,
        "stop_count":       len(detail.stop_sequence),
        "stop_sequence": [
            {"stop_id": s.stop_id, "stop_name": s.stop_name, "lat": s.lat, "lng": s.lng}
            for s in detail.stop_sequence
        ],
        "headway_by_period":    detail.headway_by_period,
        "route_length_m":       detail.route_length_m,
        "avg_trip_duration_s":  detail.avg_trip_duration_s,
        "avg_speed_kmh":        detail.avg_speed_kmh,
        "timetable": [
            {
                "headsign": trip.headsign,
                "stops": [{"stop_name": st.stop_name, "departure": st.departure} for st in trip.stops],
            }
            for trip in detail.timetable
        ],
    }


@router.get("/api/stops/{stop_id}/schedule")
def get_stop_schedule(stop_id: str) -> dict:
    """
    Departure schedule for a single stop, grouped by route and time-of-day period.
    Returns up to 10 departure times per period per route.
    """
    from gtfs.loader import PERIODS, _fmt_time

    schedule = app_state.stop_schedules.get(stop_id)
    if schedule is None:
        raise HTTPException(status_code=404, detail="Schedule not found for this stop")

    routes_out = []
    for r in schedule.routes:
        # Group departure_secs by period
        by_period: dict[str, list[str]] = {}
        for secs in r.departure_secs:
            h = secs // 3600
            for label, h_start, h_end in PERIODS:
                if h_start <= h < h_end:
                    bucket = by_period.setdefault(label, [])
                    if len(bucket) < 10:
                        bucket.append(_fmt_time(secs))
                    break

        total = len(r.departure_secs)
        first = _fmt_time(r.departure_secs[0])  if r.departure_secs else None
        last  = _fmt_time(r.departure_secs[-1]) if r.departure_secs else None

        routes_out.append({
            "route_id":          r.route_id,
            "route_short_name":  r.route_short_name,
            "route_color":       f"#{r.route_color}",
            "headsigns":         r.headsigns,
            "first_departure":   first,
            "last_departure":    last,
            "total_departures":  total,
            "departures_by_period": by_period,
        })

    # Sort by route short name for consistent display
    routes_out.sort(key=lambda r: r["route_short_name"])
    return {"stop_id": stop_id, "routes": routes_out}


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

@router.get("/api/scenarios")
def list_scenarios() -> list[dict]:
    return [
        {"id": s.id, "name": s.name, "patch_count": len(s.patches)}
        for s in app_state.scenarios.values()
    ]


@router.post("/api/scenarios", status_code=201)
def create_scenario(body: ScenarioIn) -> dict:
    scenario_id = str(uuid.uuid4())
    patches = [
        Patch(
            type=p.type,
            edge_key=tuple(p.edge_key) if p.edge_key else None,
            stop_id=p.stop_id,
            route_prefix=p.route_prefix,
            value=p.value,
        )
        for p in body.patches
    ]
    scenario = Scenario(id=scenario_id, name=body.name, patches=patches)
    app_state.scenarios[scenario_id] = scenario
    _save_scenario(scenario)
    return {"id": scenario_id, "name": scenario.name}


@router.get("/api/scenarios/{scenario_id}")
def get_scenario(scenario_id: str) -> dict:
    s = app_state.scenarios.get(scenario_id)
    if s is None:
        raise HTTPException(status_code=404)
    return {
        "id": s.id,
        "name": s.name,
        "parent_id": s.parent_id,
        "patches": [
            {
                "type":         p.type,
                "edge_key":     list(p.edge_key) if p.edge_key else None,
                "stop_id":      p.stop_id,
                "route_prefix": p.route_prefix,
                "value":        p.value,
            }
            for p in s.patches
        ],
    }


@router.patch("/api/scenarios/{scenario_id}")
def update_scenario(scenario_id: str, body: ScenarioIn) -> dict:
    s = app_state.scenarios.get(scenario_id)
    if s is None:
        raise HTTPException(status_code=404)
    s.name = body.name
    s.patches = [
        Patch(
            type=p.type,
            edge_key=tuple(p.edge_key) if p.edge_key else None,
            stop_id=p.stop_id,
            route_prefix=p.route_prefix,
            value=p.value,
        )
        for p in body.patches
    ]
    _save_scenario(s)
    return {"id": s.id, "name": s.name}


@router.delete("/api/scenarios/{scenario_id}", status_code=204)
def delete_scenario(scenario_id: str) -> None:
    app_state.scenarios.pop(scenario_id, None)
    _delete_scenario_db(scenario_id)


@router.post("/api/scenarios/{scenario_id}/fork", status_code=201)
def fork_scenario(scenario_id: str) -> dict:
    """Create a copy of a scenario with parent_id set to the source."""
    s = app_state.scenarios.get(scenario_id)
    if s is None:
        raise HTTPException(status_code=404)
    import copy as _copy
    new_id = str(uuid.uuid4())
    forked = Scenario(
        id=new_id,
        name=f"{s.name} (fork)",
        patches=_copy.deepcopy(s.patches),
        parent_id=scenario_id,
    )
    app_state.scenarios[new_id] = forked
    _save_scenario(forked)
    return {"id": new_id, "name": forked.name, "parent_id": forked.parent_id}


# ---------------------------------------------------------------------------
# Simulation runs
# ---------------------------------------------------------------------------

def _run_scenario(
    run_id: str,
    scenario_id: str,
    duration_minutes: int | None = None,
    trigger: str = "manual_scenario_edit",
    feed_slug: str | None = None,
) -> None:
    if app_state.graph is None:
        app_state.run_in_progress = False
        return
    scenario = app_state.scenarios.get(scenario_id)
    if scenario is None:
        app_state.run_in_progress = False
        return
    try:
        result = execute_dual_run(
            run_id=run_id,
            graph=app_state.graph,
            transit_stops=app_state.transit_stops,
            scenario=scenario,
            duration_minutes=duration_minutes,
            trigger=trigger,
            feed_slug=feed_slug,
        )
        app_state.runs[run_id] = result
        if result.changelog_entry:
            app_state.changelog.insert(0, result.changelog_entry)
        # Persist run + keyframes to SQLite
        if result.status == "complete":
            import datetime
            ts = (
                result.changelog_entry.timestamp_iso
                if result.changelog_entry
                else datetime.datetime.utcnow().isoformat() + "Z"
            )
            try:
                _db.save_run(result, ts)
                if result.baseline and result.baseline.frames:
                    _db.save_keyframes(run_id, "baseline", result.baseline.frames)
                if result.scenario_result and result.scenario_result.frames:
                    _db.save_keyframes(run_id, "scenario", result.scenario_result.frames)
                result.frames_in_db = True
                _lru_touch(run_id)
            except Exception as _exc:
                import logging as _log
                _log.getLogger(__name__).warning("Failed to persist run %s: %s", run_id, _exc)
    finally:
        app_state.run_in_progress = False


@router.post("/api/runs", status_code=202)
def create_run(body: RunRequest, background_tasks: BackgroundTasks) -> dict:
    if app_state.graph is None:
        raise HTTPException(status_code=409, detail="Graph not loaded")
    if body.scenario_id not in app_state.scenarios:
        raise HTTPException(status_code=404, detail="Scenario not found")
    if app_state.run_in_progress:
        raise HTTPException(status_code=409, detail="A simulation run is already in progress")

    run_id = str(uuid.uuid4())
    app_state.runs[run_id] = RunResult(
        run_id=run_id,
        scenario_id=body.scenario_id,
        status="running",
        progress_pct=0.0,
    )
    app_state.run_in_progress = True
    background_tasks.add_task(_run_scenario, run_id, body.scenario_id, body.duration_minutes)
    return {"run_id": run_id, "status": "running"}


@router.get("/api/runs/{run_id}")
def get_run(run_id: str) -> dict:
    r = app_state.runs.get(run_id)
    if r is None:
        raise HTTPException(status_code=404)
    frames_available = (
        r.baseline is not None and r.scenario_result is not None
    ) or r.frames_in_db
    out: dict = {
        "run_id":          r.run_id,
        "scenario_id":     r.scenario_id,
        "status":          r.status,
        "progress_pct":    r.progress_pct,
        "frames_available": frames_available,
        "stale":           r.stale,
    }
    if r.deltas:
        out["metrics"] = {
            "travel_time_delta_pct":  r.deltas.travel_time_delta_pct,
            "congestion_delta_pct":   r.deltas.congestion_delta_pct,
            "transit_time_delta_pct": r.deltas.transit_time_delta_pct,
            "delay_delta_pct":        r.deltas.delay_delta_pct,
        }
    if r.error:
        out["error"] = r.error
    if r.aadt_calibration_pct is not None:
        out["aadt_calibration_pct"] = r.aadt_calibration_pct
    return out


@router.get("/api/runs/{run_id}/frames")
def get_run_frames(run_id: str, baseline: bool = False) -> dict:
    r = app_state.runs.get(run_id)
    if r is None:
        raise HTTPException(status_code=404)
    if r.status != "complete":
        raise HTTPException(status_code=409, detail=f"Run status: {r.status}")

    from simulation.engine import SimulationFrame, SimulationResult

    run_type = "baseline" if baseline else "scenario"
    source = r.baseline if baseline else r.scenario_result

    if source is not None:
        # Frames already in memory — touch LRU so this run stays warm
        _lru_touch(run_id)
        frames_out = [
            {"t": f.timestamp_s, "full": f.is_full, "edges": f.edges, "transit": f.transit}
            for f in source.frames
        ]
    elif r.frames_in_db:
        # Cache miss: load both baseline and scenario from DB, rehydrate RunResult
        for rt in ("baseline", "scenario"):
            raw = _db.load_frames(run_id, rt)
            if raw is None:
                continue
            sim = SimulationResult(
                frames=[
                    SimulationFrame(
                        timestamp_s=d["t"],
                        is_full=d["full"],
                        edges=d["edges"],
                        transit=d["transit"],
                    )
                    for d in raw
                ],
                mean_congestion=0.0,
                mean_speed_ms=0.0,
                transit_dwell_total_s=0.0,
            )
            if rt == "baseline":
                r.baseline = sim
            else:
                r.scenario_result = sim
        _lru_touch(run_id)
        source = r.baseline if baseline else r.scenario_result
        if source is None:
            raise HTTPException(status_code=409, detail="Frames not available")
        frames_out = [
            {"t": f.timestamp_s, "full": f.is_full, "edges": f.edges, "transit": f.transit}
            for f in source.frames
        ]
    else:
        raise HTTPException(status_code=409, detail="Frames not available")

    return {
        "run_id":      run_id,
        "is_baseline": baseline,
        "frame_count": len(frames_out),
        "frames":      frames_out,
    }


@router.get("/api/runs/{run_id}/metrics")
def get_run_metrics(run_id: str) -> dict:
    r = app_state.runs.get(run_id)
    if r is None:
        raise HTTPException(status_code=404)
    if r.deltas is None:
        raise HTTPException(status_code=409, detail="Metrics not yet available")
    return {
        "run_id":                 run_id,
        "travel_time_delta_pct":  r.deltas.travel_time_delta_pct,
        "congestion_delta_pct":   r.deltas.congestion_delta_pct,
        "transit_time_delta_pct": r.deltas.transit_time_delta_pct,
        "delay_delta_pct":        r.deltas.delay_delta_pct,
    }


@router.get("/api/runs/{run_id}/delta_index")
def get_run_delta_index(run_id: str) -> dict:
    """
    Per-edge congestion and speed deltas (scenario − baseline) at the final keyframe.
    Returns {edge_id: [congestion_delta, speed_delta_ms]} for all edges that changed.
    """
    r = app_state.runs.get(run_id)
    if r is None:
        raise HTTPException(status_code=404)
    if r.status != "complete":
        raise HTTPException(status_code=409, detail=f"Run status: {r.status}")
    if r.edge_delta_index is None:
        raise HTTPException(status_code=409, detail="Delta index not available for this run")
    return {
        "run_id": run_id,
        "edge_count": len(r.edge_delta_index),
        "deltas": {str(eid): list(vals) for eid, vals in r.edge_delta_index.items()},
    }


@router.get("/api/runs/{run_id}/changelog")
def get_run_changelog(run_id: str) -> dict:
    r = app_state.runs.get(run_id)
    if r is None:
        raise HTTPException(status_code=404)
    if r.changelog_entry is None:
        return {"run_id": run_id, "entry": None}
    e = r.changelog_entry
    return {
        "run_id": run_id,
        "entry": {
            "timestamp":          e.timestamp_iso,
            "trigger":            e.trigger,
            "scenario_id":        e.scenario_id,
            "scenario_name":      e.scenario_name,
            "feed_slug":          e.feed_slug,
            "affected_stop_count": e.affected_stop_count,
            "metrics": {
                "travel_time_delta_pct":  e.metrics.travel_time_delta_pct,
                "congestion_delta_pct":   e.metrics.congestion_delta_pct,
                "transit_time_delta_pct": e.metrics.transit_time_delta_pct,
                "delay_delta_pct":        e.metrics.delay_delta_pct,
            },
            "summary": e.summary,
        },
    }


# ---------------------------------------------------------------------------
# Share
# ---------------------------------------------------------------------------

@router.get("/api/share/{run_id}")
def get_share(run_id: str) -> dict:
    """
    Return a shareable descriptor for a completed run.
    The share_url encodes the run_id as a query parameter so recipients
    can open the frontend directly in read-only view mode.
    """
    r = app_state.runs.get(run_id)
    if r is None:
        raise HTTPException(status_code=404)
    if r.status != "complete":
        raise HTTPException(status_code=409, detail=f"Run not complete (status: {r.status})")

    scenario = app_state.scenarios.get(r.scenario_id)
    scenario_name = scenario.name if scenario else r.scenario_id

    share_url = f"{settings.FRONTEND_URL}/?run={run_id}"

    out: dict = {
        "run_id":        run_id,
        "scenario_id":   r.scenario_id,
        "scenario_name": scenario_name,
        "share_url":     share_url,
        "stale":         r.stale,
    }
    if r.deltas:
        out["metrics"] = {
            "travel_time_delta_pct":  r.deltas.travel_time_delta_pct,
            "congestion_delta_pct":   r.deltas.congestion_delta_pct,
            "transit_time_delta_pct": r.deltas.transit_time_delta_pct,
            "delay_delta_pct":        r.deltas.delay_delta_pct,
        }
    return out


# ---------------------------------------------------------------------------
# Changelog
# ---------------------------------------------------------------------------

@router.get("/api/changelog")
def get_changelog(trigger: str | None = None) -> list[dict]:
    entries = app_state.changelog
    if trigger:
        entries = [e for e in entries if e.trigger == trigger]
    return [
        {
            "run_id":            e.run_id,
            "timestamp":         e.timestamp_iso,
            "trigger":           e.trigger,
            "scenario_id":       e.scenario_id,
            "scenario_name":     e.scenario_name,
            "feed_slug":         e.feed_slug,
            "summary":           e.summary,
            "attribution_tags":  e.attribution_tags,
        }
        for e in entries
    ]


# ---------------------------------------------------------------------------
# Bike infrastructure (pre-baked on startup, served as GeoJSON)
# ---------------------------------------------------------------------------

@router.get("/api/bike-infra")
def get_bike_infra() -> dict:
    """
    Pre-baked bike infrastructure for the configured OSM_PLACE as a
    GeoJSON FeatureCollection. Loaded once at server startup (and on
    demand via POST /api/bike-infra/sync), so the frontend never has
    to query Overpass directly.
    """
    bi = app_state.bike_infra
    if bi is None:
        # Not loaded yet — return empty collection so the overlay just
        # shows nothing until the startup task finishes.
        return {
            "type": "FeatureCollection",
            "features": [],
            "status": "loading",
        }
    return {
        "type": "FeatureCollection",
        "features": bi.features,
        "status": "ready",
        "fetched_at": bi.fetched_at,
        "source": bi.source,
    }


@router.post("/api/bike-infra/sync", status_code=202)
def sync_bike_infra(background_tasks: BackgroundTasks, force: bool = False) -> dict:
    """Force a refresh from OSM (bypasses the 7-day disk cache when force=true)."""
    def _sync() -> None:
        result = load_bike_infrastructure(force=force)
        app_state.bike_infra = result

    background_tasks.add_task(_sync)
    return {"status": "syncing", "force": force}


# ---------------------------------------------------------------------------
# External data proxies (F3–F4)
# ---------------------------------------------------------------------------

@router.get("/api/external/collisions")
async def get_collisions() -> dict:
    """
    Proxy to NYSDOT CRIS crash data API.
    Filters to the loaded graph's bounding box — works for any OSM_PLACE.

    NYSDOT CRIS public API (no key required):
    https://data.ny.gov/resource/e8ky-4vqe.json
    """
    g = app_state.graph
    if g is None:
        raise HTTPException(status_code=409, detail="Graph not loaded")

    geo_filter = _bbox_socrata_geo_filter(g.bbox)
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(
                "https://data.ny.gov/resource/e8ky-4vqe.json",
                params={
                    "$where":  geo_filter,
                    "$limit":  "10000",
                    "$select": "longitude,latitude,number_of_persons_killed,"
                               "number_of_persons_injured,crash_date",
                },
            )
            resp.raise_for_status()
            raw = resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"CRIS API unavailable: {exc}")

    points = []
    for rec in raw:
        try:
            lon = float(rec["longitude"])
            lat = float(rec["latitude"])
        except (KeyError, ValueError, TypeError):
            continue
        points.append({
            "lat": lat,
            "lng": lon,
            "killed":  int(rec.get("number_of_persons_killed") or 0),
            "injured": int(rec.get("number_of_persons_injured") or 0),
            "date":    rec.get("crash_date", ""),
        })

    # Aggregate by junction: cluster within 30m radius
    junctions = _cluster_crash_points(points, radius_m=30)

    # Aggregate by road segment (snap to nearest edge)
    segments = _aggregate_crashes_by_segment(points)

    return {
        "point_count": len(points),
        "points":      points,
        "junctions":   junctions,
        "segments":    segments,
    }


def _cluster_crash_points(
    points: list[dict],
    radius_m: float = 30,
) -> list[dict]:
    """Simple grid-based clustering of crash points by proximity."""
    import math
    clusters: list[dict] = []
    used = [False] * len(points)

    for i, p in enumerate(points):
        if used[i]:
            continue
        cluster = [p]
        used[i] = True
        for j, q in enumerate(points):
            if used[j]:
                continue
            dlat = math.radians(q["lat"] - p["lat"])
            dlon = math.radians(q["lng"] - p["lng"])
            a = (math.sin(dlat / 2) ** 2
                 + math.cos(math.radians(p["lat"])) * math.cos(math.radians(q["lat"]))
                 * math.sin(dlon / 2) ** 2)
            dist = 6_371_000 * 2 * math.asin(math.sqrt(a))
            if dist <= radius_m:
                cluster.append(q)
                used[j] = True

        if len(cluster) >= 2:
            avg_lat = sum(c["lat"] for c in cluster) / len(cluster)
            avg_lng = sum(c["lng"] for c in cluster) / len(cluster)
            clusters.append({
                "lat":   avg_lat,
                "lng":   avg_lng,
                "count": len(cluster),
                "killed":  sum(c["killed"] for c in cluster),
                "injured": sum(c["injured"] for c in cluster),
                "high_collision": len(cluster) >= 5,
            })

    return clusters


def _aggregate_crashes_by_segment(points: list[dict]) -> list[dict]:
    """
    Snap crash points to nearest graph edge and count per edge.
    Returns list of {edge_id, count, killed, injured}.
    """
    g = app_state.graph
    if g is None or not points:
        return []

    import math
    edge_counts: dict[int, dict] = {}

    for pt in points:
        best_idx = -1
        best_dist = float("inf")
        # Find nearest edge midpoint (approximate)
        for i, e in enumerate(g.edges):
            u = g.nodes.get(e.u)
            v = g.nodes.get(e.v)
            if not u or not v:
                continue
            mid_lat = (u["y"] + v["y"]) / 2
            mid_lon = (u["x"] + v["x"]) / 2
            dlat = math.radians(pt["lat"] - mid_lat)
            dlon = math.radians(pt["lng"] - mid_lon)
            a = (math.sin(dlat / 2) ** 2
                 + math.cos(math.radians(mid_lat)) * math.cos(math.radians(pt["lat"]))
                 * math.sin(dlon / 2) ** 2)
            dist = 6_371_000 * 2 * math.asin(math.sqrt(a))
            if dist < best_dist and dist < 50:  # 50m snap threshold
                best_dist = dist
                best_idx = i

        if best_idx >= 0:
            if best_idx not in edge_counts:
                edge_counts[best_idx] = {"edge_id": best_idx, "count": 0, "killed": 0, "injured": 0}
            edge_counts[best_idx]["count"] += 1
            edge_counts[best_idx]["killed"]  += pt["killed"]
            edge_counts[best_idx]["injured"] += pt["injured"]

    return sorted(edge_counts.values(), key=lambda x: x["count"], reverse=True)


@router.get("/api/external/lodes")
async def get_lodes(
    lat:       float = Query(...),
    lng:       float = Query(...),
    radius_km: float = Query(default=20.0),
) -> dict:
    """
    Serve LODES job data from lodes_cache.json (populated by POST /api/admin/import-lodes).
    Returns features within radius_km of the given lat/lng.
    """
    cache_file = _DATA_DIR / "lodes_cache.json"
    if not cache_file.exists():
        return {"status": "not_imported", "features": []}

    with open(cache_file) as f:
        all_features = json.load(f)

    # Filter to radius
    radius_m = radius_km * 1000
    filtered = []
    for pt in all_features:
        dlat = math.radians(pt["lat"] - lat)
        dlon = math.radians(pt["lng"] - lng)
        a = (math.sin(dlat / 2) ** 2
             + math.cos(math.radians(lat)) * math.cos(math.radians(pt["lat"]))
             * math.sin(dlon / 2) ** 2)
        dist = 6_371_000 * 2 * math.asin(math.sqrt(a))
        if dist <= radius_m:
            filtered.append(pt)

    return {"status": "ok", "features": filtered}


@router.get("/api/external/population-density")
async def get_population_density() -> dict:
    """
    Returns WMS tile configuration for US Census population density.
    The frontend renders this as a tile layer directly — no data proxying needed.
    """
    return {
        "wms_url": "https://tigerweb.geo.census.gov/arcgis/services/TIGERweb/tigerWMS_Census2020/MapServer/WMSServer",
        "layer": "Census Tracts",
        "description": "US Census 2020 Tiger/Web population density tiles",
    }


# ---------------------------------------------------------------------------
# Admin: AADT import (N1)
# ---------------------------------------------------------------------------

@router.post("/api/admin/import-aadt")
async def import_aadt() -> dict:
    """
    Fetch NYSDOT AADT traffic count data from NY Open Data (Socrata),
    snap each station to the nearest OSM edge, and persist the counts.
    """
    g = app_state.graph
    if g is None:
        raise HTTPException(status_code=409, detail="Graph not loaded")

    # NYSDOT Highway Traffic Data — filtered to graph bbox
    geo_filter = _bbox_socrata_geo_filter(g.bbox)
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                "https://data.ny.gov/resource/6amx-2pbv.json",
                params={
                    "$where":  geo_filter,
                    "$limit":  "10000",
                    "$select": "latitude,longitude,aadt,year_of_data",
                },
            )
            resp.raise_for_status()
            raw = resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"NYSDOT API unavailable: {exc}")

    imported = 0
    matched = 0
    unmatched = 0
    snap_threshold_m = 20.0

    for rec in raw:
        try:
            lat  = float(rec["latitude"])
            lon  = float(rec["longitude"])
            aadt = int(float(rec.get("aadt") or 0))
            year = int(rec["year_of_data"]) if rec.get("year_of_data") else None
        except (KeyError, ValueError, TypeError):
            continue
        imported += 1

        # Snap to nearest edge midpoint within threshold
        best_idx = -1
        best_dist = float("inf")
        for i, e in enumerate(g.edges):
            u = g.nodes.get(e.u)
            v = g.nodes.get(e.v)
            if not u or not v:
                continue
            mid_lat = (u["y"] + v["y"]) / 2
            mid_lon = (u["x"] + v["x"]) / 2
            dlat = math.radians(lat - mid_lat)
            dlon = math.radians(lon - mid_lon)
            a = (math.sin(dlat / 2) ** 2
                 + math.cos(math.radians(mid_lat)) * math.cos(math.radians(lat))
                 * math.sin(dlon / 2) ** 2)
            dist = 6_371_000 * 2 * math.asin(math.sqrt(a))
            if dist < best_dist and dist < snap_threshold_m:
                best_dist = dist
                best_idx = i

        if best_idx >= 0:
            g.edges[best_idx].aadt_count = aadt
            g.edges[best_idx].aadt_year  = year
            matched += 1
        else:
            unmatched += 1

    # Persist to data/aadt_cache.json for reference
    _DATA_DIR.mkdir(exist_ok=True)
    aadt_cache = [
        {"edge_id": i, "aadt_count": e.aadt_count, "aadt_year": e.aadt_year}
        for i, e in enumerate(g.edges)
        if e.aadt_count is not None
    ]
    tmp = str(_DATA_DIR / "aadt_cache.json") + ".tmp"
    with open(tmp, "w") as f:
        json.dump(aadt_cache, f)
    os.replace(tmp, str(_DATA_DIR / "aadt_cache.json"))

    return {"imported": imported, "matched": matched, "unmatched": unmatched}


# ---------------------------------------------------------------------------
# Admin: LODES import (M1)
# ---------------------------------------------------------------------------

@router.post("/api/admin/import-lodes")
async def import_lodes() -> dict:
    """
    Download the LODES WAC CSV for the graph's state, filter to counties
    within the graph bbox, and write lodes_cache.json.

    State and county FIPS are derived automatically from the loaded graph
    so this works for any OSM_PLACE, not just the Capital District.
    Approximate block centroids use bbox-center jitter (true TIGERweb
    block centroids are a future improvement).
    """
    import gzip
    import io
    import csv

    g = app_state.graph
    if g is None:
        raise HTTPException(status_code=409, detail="Graph not loaded")

    # Derive state and county FIPS from graph bbox
    state_abbr, state_fips = _bbox_state(g.bbox)
    county_fips_list = await _fetch_county_fips_in_bbox(g.bbox, state_fips)
    if not county_fips_list:
        # Fallback: use state FIPS prefix filter (accepts any county in state)
        county_fips_set: set[str] = set()
        use_state_fallback = True
    else:
        county_fips_set = set(county_fips_list)
        use_state_fallback = False

    lodes_url = (
        f"https://lehd.ces.census.gov/data/lodes/LODES8/{state_abbr}/wac/"
        f"{state_abbr}_wac_S000_JT00_2021.csv.gz"
    )
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.get(lodes_url)
            resp.raise_for_status()
            content = resp.content
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LODES download failed: {exc}")

    # Parse CSV.gz and filter to counties in bbox
    with gzip.open(io.BytesIO(content), "rt") as f:
        reader = csv.DictReader(f)
        if use_state_fallback:
            rows = list(reader)
        else:
            rows = [r for r in reader if str(r.get("w_geocode", ""))[:5] in county_fips_set]

    if not rows:
        raise HTTPException(
            status_code=422,
            detail=f"No records found for {state_abbr.upper()} counties {county_fips_list} in LODES file",
        )

    # Aggregate job counts per GEOID
    geoid_jobs: dict[str, int] = {}
    for row in rows:
        geoid = row["w_geocode"]
        jobs  = int(float(row.get("C000") or 0))
        geoid_jobs[geoid] = geoid_jobs.get(geoid, 0) + jobs

    # Approximate block centroids: bbox center + hash-based jitter.
    # Jitter is proportional to bbox size so it scales to any geography.
    # True Census block centroids (TIGERweb) are a future improvement.
    cx = (g.bbox[0] + g.bbox[2]) / 2   # center lon
    cy = (g.bbox[1] + g.bbox[3]) / 2   # center lat
    lon_spread = (g.bbox[2] - g.bbox[0]) * 0.4
    lat_spread = (g.bbox[3] - g.bbox[1]) * 0.4

    features = []
    for geoid, jobs in list(geoid_jobs.items())[:500]:
        if jobs < 10:
            continue
        lat = cy + (hash(geoid)        % 2000 - 1000) / 2000 * lat_spread
        lng = cx + (hash(geoid[:14])   % 2000 - 1000) / 2000 * lon_spread
        features.append({"lat": lat, "lng": lng, "jobs": jobs})

    _DATA_DIR.mkdir(exist_ok=True)
    tmp = str(_DATA_DIR / "lodes_cache.json") + ".tmp"
    with open(tmp, "w") as f:
        json.dump(features, f)
    os.replace(tmp, str(_DATA_DIR / "lodes_cache.json"))

    return {
        "state": state_abbr,
        "counties": county_fips_list,
        "blocks_imported": len(geoid_jobs),
        "blocks_with_centroids": len(features),
    }


# ---------------------------------------------------------------------------
# Phase 12 — Schedule arithmetic
# ---------------------------------------------------------------------------


def _find_route_detail(route_id: str, feed: str | None):
    if feed:
        return app_state.route_details.get(f"{feed}:{route_id}")
    for d in app_state.route_details.values():
        if d.route_id == route_id:
            return d
    return None


def _stop_refs_from_route(detail, graph) -> list[StopNodeRef]:
    """Build ordered StopNodeRef list from a RouteDetail's stop_sequence."""
    refs: list[StopNodeRef] = []
    for s in detail.stop_sequence:
        node = graph.stop_nodes.get(s.stop_id)
        if node is None:
            node = nearest_node(graph, s.lat, s.lng)
        if node is None or node < 0:
            continue
        refs.append(StopNodeRef(
            stop_id=s.stop_id, name=s.stop_name or s.stop_id,
            node=node, lat=s.lat, lng=s.lng,
        ))
    return refs


def _maybe_reverse(refs: list[StopNodeRef], direction_id: int) -> list[StopNodeRef]:
    """GTFS direction_id=1 is the return trip. Reverse the canonical sequence.

    This is a geometry-based approximation: the backend stores one canonical
    stop_sequence per route (currently direction 0). True per-direction
    stop ordering would require direction-aware canonical trips from GTFS.
    """
    return list(reversed(refs)) if direction_id == 1 else refs


def _headway_minutes_for_route(detail) -> float | None:
    """Pick a representative headway (minutes) from the route's headway_by_period.
    Prefer AM peak, then Midday, then any available period."""
    hb = detail.headway_by_period or {}
    for label in ("AM peak", "Midday", "PM peak", "Early morning", "Evening", "Night"):
        if label in hb and hb[label] > 0:
            return hb[label] / 60.0
    return None


@router.get("/api/schedule/trip_time")
def schedule_trip_time(
    route_id: str,
    direction_id: int = 0,
    feed: str | None = None,
    dwell_seconds: float = DEFAULT_DWELL_S,
) -> dict:
    """Geometry-based end-to-end trip time for a route + direction.

    No simulation run required. Every response surfaces its assumptions.
    """
    if app_state.graph is None:
        raise HTTPException(503, "Graph not loaded")

    detail = _find_route_detail(route_id, feed)
    if detail is None:
        raise HTTPException(404, f"Route {route_id!r} not found")

    refs = _maybe_reverse(_stop_refs_from_route(detail, app_state.graph), direction_id)
    if len(refs) < 2:
        raise HTTPException(422, "Route has fewer than two stops with OSM mappings")

    result = compute_trip_time(app_state.graph, refs, dwell_seconds=dwell_seconds)

    return {
        "route_id": detail.route_id,
        "route_short_name": detail.route_short_name,
        "feed_slug": detail.feed_slug,
        "direction_id": direction_id,
        "stops": [
            {
                "stop_id": s["stop_id"],
                "name": s["name"],
                "cumulative_minutes": s["cumulative_minutes"],
            }
            for s in result.stops
        ],
        "total_minutes": result.total_s / 60.0,
        "turn_penalty_minutes": result.turn_penalty_s / 60.0,
        "comfort_index": result.comfort_index,
        "assumptions": result.assumptions,
        "reliability": reliability_annotation(detail.route_short_name),
        "label": "geometry-based",
    }


@router.get("/api/schedule/headway_impact")
def schedule_headway_impact(
    route_id: str,
    new_headway_minutes: float,
    feed: str | None = None,
    old_headway_minutes: float | None = None,
) -> dict:
    """Wait-time impact of a headway change. Uniform-arrival (E[wait]=H/2)."""
    detail = _find_route_detail(route_id, feed)
    if detail is None:
        raise HTTPException(404, f"Route {route_id!r} not found")

    if old_headway_minutes is None:
        old_headway_minutes = _headway_minutes_for_route(detail)
    if old_headway_minutes is None or old_headway_minutes <= 0:
        raise HTTPException(422, "Could not determine current headway for this route")

    result = _headway_impact(old_headway_minutes, new_headway_minutes)
    return {
        "route_id": detail.route_id,
        "route_short_name": detail.route_short_name,
        **result,
        "reliability": reliability_annotation(detail.route_short_name),
        "label": "geometry-based",
    }


class NewStopIn(BaseModel):
    lat: float
    lng: float | None = None
    lon: float | None = None
    name: str = ""

    def as_lnglat(self) -> tuple[float, float]:
        lng = self.lng if self.lng is not None else self.lon
        if lng is None:
            raise ValueError("NewStopIn requires lng or lon")
        return float(self.lat), float(lng)


class StopImpactRequest(BaseModel):
    route_id: str
    direction_id: int = 0
    feed: str | None = None
    action: str                                 # "insert" | "remove"
    after_stop_id: str | None = None            # required for insert
    stop_id: str | None = None                  # existing stop id (insert or remove)
    new_stop: NewStopIn | None = None           # ad-hoc insert target
    dwell_seconds: float = DEFAULT_DWELL_S
    inserted_dwell_seconds: float | None = None


@router.post("/api/schedule/stop_impact")
def schedule_stop_impact(body: StopImpactRequest) -> dict:
    """Impact of a single stop insertion or removal on cumulative trip time."""
    if app_state.graph is None:
        raise HTTPException(503, "Graph not loaded")

    detail = _find_route_detail(body.route_id, body.feed)
    if detail is None:
        raise HTTPException(404, f"Route {body.route_id!r} not found")

    graph = app_state.graph
    baseline = _maybe_reverse(_stop_refs_from_route(detail, graph), body.direction_id)
    if len(baseline) < 2:
        raise HTTPException(422, "Route has fewer than two stops with OSM mappings")

    inserted_ref: StopNodeRef | None = None
    remove_stop_id: str | None = None

    if body.action == "insert":
        if not body.after_stop_id:
            raise HTTPException(422, "insert requires after_stop_id")
        if body.stop_id:
            # existing stop re-used as insertion target
            match = next((s for s in baseline if s.stop_id == body.stop_id), None)
            if match is None:
                # pull from full feed if possible
                rec = next(
                    (r for r in app_state.stop_records if r.stop_id == body.stop_id),
                    None,
                )
                if rec is None:
                    raise HTTPException(404, f"stop_id {body.stop_id!r} not found")
                node = graph.stop_nodes.get(rec.stop_id) or nearest_node(graph, rec.lat, rec.lng)
                inserted_ref = StopNodeRef(rec.stop_id, rec.stop_name, node, rec.lat, rec.lng)
            else:
                inserted_ref = match
        elif body.new_stop:
            lat, lng = body.new_stop.as_lnglat()
            node = nearest_node(graph, lat, lng)
            if node < 0:
                raise HTTPException(422, "Could not snap new_stop to graph")
            sid = f"new:{lat:.6f},{lng:.6f}"
            inserted_ref = StopNodeRef(sid, body.new_stop.name or sid, node, lat, lng)
        else:
            raise HTTPException(422, "insert requires either stop_id or new_stop")
    elif body.action == "remove":
        if not body.stop_id:
            raise HTTPException(422, "remove requires stop_id")
        remove_stop_id = body.stop_id
    else:
        raise HTTPException(422, f"unknown action {body.action!r}")

    try:
        result = _stop_impact(
            graph,
            baseline,
            action=body.action,
            dwell_seconds=body.dwell_seconds,
            after_stop_id=body.after_stop_id,
            inserted=inserted_ref,
            remove_stop_id=remove_stop_id,
            inserted_dwell_seconds=body.inserted_dwell_seconds,
        )
    except ValueError as e:
        raise HTTPException(422, str(e))

    return {
        "route_id": detail.route_id,
        "route_short_name": detail.route_short_name,
        "action": result.action,
        "baseline_total_minutes": result.baseline_total_s / 60.0,
        "proposed_total_minutes": result.proposed_total_s / 60.0,
        "delta_minutes": result.delta_s / 60.0,
        "downstream_shift": [
            {
                "stop_id": d["stop_id"],
                "name": d["name"],
                "baseline_minutes": d["baseline_seconds"] / 60.0,
                "proposed_minutes": d["proposed_seconds"] / 60.0,
                "delta_minutes": d["delta_seconds"] / 60.0,
            }
            for d in result.downstream_shift
        ],
        "comfort_index_baseline": result.comfort_index_baseline,
        "comfort_index_proposed": result.comfort_index_proposed,
        "assumptions": result.assumptions,
        "reliability": reliability_annotation(detail.route_short_name),
        "label": "geometry-based",
    }


@router.get("/api/schedule/reliability")
def schedule_reliability() -> dict:
    """Full FY2025 reliability table, one entry per route_short_name."""
    from schedule.performance import FY2025_PERFORMANCE
    out = {}
    for key in FY2025_PERFORMANCE:
        out[key] = reliability_annotation(key)
    return {"source": "FY2025 actuals (CDTA)", "routes": out}
