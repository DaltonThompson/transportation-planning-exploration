"""
Phase 6: Sequential dual-run simulation runner.
Phase 7: Metrics computation and comparison.

Runs baseline to completion, then scenario. Both runs start from the same
seeded graph state (no shared runtime state). Computes deltas and returns
a RunResult containing frames and metrics for both runs plus a changelog entry.
"""

import copy
import logging
import time
from dataclasses import dataclass, field

from graph.loader import GraphState, copy_edge_flow_state, restore_edge_flow_state
from scenarios.patcher import Scenario, apply_scenario
from simulation.engine import SimulationFrame, SimulationResult, TransitStop, run_simulation

logger = logging.getLogger(__name__)


@dataclass
class MetricDeltas:
    """Comparative metrics: scenario − baseline."""
    travel_time_delta_pct: float   # % change in mean travel time
    congestion_delta_pct: float    # % change in mean congestion factor
    transit_time_delta_pct: float  # % change in transit dwell time
    delay_delta_pct: float         # % change in mean excess delay (fraction of free-flow speed lost)


@dataclass
class ChangelogEntry:
    run_id: str
    timestamp_iso: str
    trigger: str                    # 'gtfs_sync' | 'manual_scenario_edit'
    scenario_id: str
    scenario_name: str
    feed_slug: str | None
    affected_stop_count: int
    metrics: MetricDeltas
    summary: str
    attribution_tags: list[str] = field(default_factory=list)


@dataclass
class RunResult:
    run_id: str
    scenario_id: str
    status: str                     # 'running' | 'complete' | 'failed'
    progress_pct: float

    baseline: SimulationResult | None = None
    scenario_result: SimulationResult | None = None
    deltas: MetricDeltas | None = None
    changelog_entry: ChangelogEntry | None = None
    error: str | None = None
    aadt_calibration_pct: float | None = None  # fraction of AADT edges within ±20% tolerance
    frames_in_db: bool = False   # True once keyframes have been persisted to SQLite
    stale: bool = False          # True if graph fingerprint changed since run was saved
    # Per-edge congestion and speed deltas (scenario − baseline) at final keyframe.
    # {edge_id: (congestion_delta, speed_delta_ms)}
    edge_delta_index: dict[int, tuple[float, float]] | None = None


def _build_final_congestion(frames: list) -> dict[int, float]:
    """Reconstruct final per-edge congestion by replaying frames in order."""
    state: dict[int, float] = {}
    for frame in frames:
        for e in frame.edges:
            state[e["id"]] = e["c"]
    return state


def _compute_edge_delta_index(
    baseline: SimulationResult,
    scenario: SimulationResult,
    graph_edges: list,
) -> dict[int, tuple[float, float]]:
    """
    Compute per-edge (congestion_delta, speed_delta_ms) for edges that differ.
    Only includes edges where |congestion_delta| > 0.001.
    """
    b_state = _build_final_congestion(baseline.frames)
    s_state = _build_final_congestion(scenario.frames)
    index: dict[int, tuple[float, float]] = {}
    all_ids = set(b_state) | set(s_state)
    for eid in all_ids:
        bc = b_state.get(eid, 0.0)
        sc = s_state.get(eid, 0.0)
        delta_c = sc - bc
        if abs(delta_c) <= 0.001:
            continue
        speed_limit = graph_edges[eid].speed_limit_ms if eid < len(graph_edges) else 0.0
        delta_s = delta_c * speed_limit
        index[eid] = (delta_c, delta_s)
    return index


_PATCH_TYPE_TO_TAG: dict[str, str] = {
    "route_headway": "headway_change",
    "stop_headway":  "headway_change",
    "edge_capacity": "capacity_change",
    "edge_speed":    "speed_change",
    "stop_add":      "stop_added",
    "stop_remove":   "stop_removed",
}


def _derive_attribution_tags(patches: list) -> list[str]:
    """Return sorted unique factual labels derived from patch types."""
    tags: set[str] = set()
    for p in patches:
        tag = _PATCH_TYPE_TO_TAG.get(p.type)
        if tag:
            tags.add(tag)
    return sorted(tags)


def _compute_deltas(
    baseline: SimulationResult,
    scenario: SimulationResult,
) -> MetricDeltas:
    def pct_change(base: float, scen: float) -> float:
        if abs(base) < 1e-9:
            return 0.0
        return (scen - base) / base * 100.0

    # Travel time is inverse of speed: higher speed = lower travel time
    baseline_travel = 1.0 / max(baseline.mean_speed_ms, 1e-6)
    scenario_travel = 1.0 / max(scenario.mean_speed_ms, 1e-6)

    return MetricDeltas(
        travel_time_delta_pct=pct_change(baseline_travel, scenario_travel),
        congestion_delta_pct=pct_change(
            baseline.mean_congestion, scenario.mean_congestion
        ),
        transit_time_delta_pct=pct_change(
            baseline.transit_dwell_total_s, scenario.transit_dwell_total_s
        ),
        delay_delta_pct=pct_change(
            baseline.mean_excess_delay, scenario.mean_excess_delay
        ),
    )


def execute_dual_run(
    run_id: str,
    graph: GraphState,
    transit_stops: list[TransitStop],
    scenario: Scenario,
    duration_minutes: int | None = None,
    trigger: str = "manual_scenario_edit",
    feed_slug: str | None = None,
) -> RunResult:
    """
    Run baseline then scenario sequentially.

    1. Snapshot the seeded graph state.
    2. Run baseline simulation.
    3. Restore snapshot.
    4. Apply scenario patches to a deep copy.
    5. Run scenario simulation.
    6. Compute deltas and build changelog entry.
    """
    import datetime

    result = RunResult(
        run_id=run_id,
        scenario_id=scenario.id,
        status="running",
        progress_pct=0.0,
    )

    try:
        t0 = time.monotonic()

        # Snapshot initial (seeded) flow state
        initial_state = copy_edge_flow_state(graph.edges)

        # --- Baseline run ---
        logger.info("[%s] Starting baseline run…", run_id)
        result.progress_pct = 5.0
        baseline_result = run_simulation(graph, transit_stops, duration_minutes)
        result.baseline = baseline_result
        result.progress_pct = 50.0
        logger.info("[%s] Baseline complete in %.2fs", run_id, time.monotonic() - t0)

        # Restore graph to initial state for scenario run
        restore_edge_flow_state(graph.edges, initial_state)

        # --- Scenario run ---
        patched_graph, patched_stops = apply_scenario(graph, transit_stops, scenario)
        logger.info("[%s] Starting scenario run '%s'…", run_id, scenario.name)
        scenario_result = run_simulation(patched_graph, patched_stops, duration_minutes)
        result.scenario_result = scenario_result
        result.progress_pct = 95.0
        logger.info("[%s] Scenario complete in %.2fs", run_id, time.monotonic() - t0)

        # Restore baseline graph state so graph object is re-usable
        restore_edge_flow_state(graph.edges, initial_state)

        # --- AADT calibration check (N2) ---
        try:
            aadt_edges = [(i, e) for i, e in enumerate(graph.edges) if e.aadt_count]
            if aadt_edges:
                within_tolerance = 0
                for i, e in aadt_edges:
                    # mean flow rate from last baseline frame, annualised to hourly
                    simulated_hourly = e.flow_rate * 3600 / max(1, getattr(graph, "timestep_seconds", 5))
                    expected_hourly  = e.aadt_count / 16  # 16 operating hours
                    ratio = simulated_hourly / max(expected_hourly, 1)
                    if 0.8 <= ratio <= 1.2:
                        within_tolerance += 1
                result.aadt_calibration_pct = within_tolerance / len(aadt_edges) * 100.0
                logger.info(
                    "[%s] AADT calibration: %.1f%% of %d matched edges within ±20%%",
                    run_id, result.aadt_calibration_pct, len(aadt_edges),
                )
        except Exception:
            pass  # calibration is advisory, never fail the run

        # --- Compute deltas ---
        deltas = _compute_deltas(baseline_result, scenario_result)
        result.deltas = deltas

        # --- Per-edge delta index ---
        result.edge_delta_index = _compute_edge_delta_index(
            baseline_result, scenario_result, graph.edges
        )

        # --- Attribution tags (11C) ---
        attribution_tags = _derive_attribution_tags(scenario.patches)

        # --- Changelog entry ---
        entry = ChangelogEntry(
            run_id=run_id,
            timestamp_iso=datetime.datetime.utcnow().isoformat() + "Z",
            trigger=trigger,
            scenario_id=scenario.id,
            scenario_name=scenario.name,
            feed_slug=feed_slug,
            affected_stop_count=len(patched_stops),
            metrics=deltas,
            summary=(
                f"Scenario '{scenario.name}': "
                f"travel_time {deltas.travel_time_delta_pct:+.1f}%, "
                f"congestion {deltas.congestion_delta_pct:+.1f}%, "
                f"transit_dwell {deltas.transit_time_delta_pct:+.1f}%, "
                f"delay {deltas.delay_delta_pct:+.1f}%"
            ),
            attribution_tags=attribution_tags,
        )
        result.changelog_entry = entry
        result.status = "complete"
        result.progress_pct = 100.0

        logger.info("[%s] Run complete: %s", run_id, entry.summary)

    except Exception as exc:
        logger.exception("[%s] Simulation failed: %s", run_id, exc)
        result.status = "failed"
        result.error = str(exc)

    return result
