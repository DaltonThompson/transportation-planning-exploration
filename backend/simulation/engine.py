"""
Phase 2: Flow-based simulation engine.

Each timestep (5 s) updates all edges via the formula from the MVP spec:
  outflow        = min(flow_rate, capacity) × DECAY_FACTOR
  inflow         = Σ outflow(upstream) × turn_weight(this_edge)
  flow_rate      = flow_rate + inflow − outflow + transit_injection
  congestion_factor = max(CONGESTION_FLOOR, 1 − flow_rate / capacity)
  current_speed  = speed_limit × congestion_factor

Keyframes are emitted every 30 s (every 6 timesteps). Frame 0 is a full
snapshot; subsequent frames are diffs (only changed edges, threshold 0.01).
"""

import copy
import logging
import math


def _safe(val: float) -> float:
    """Return 0.0 for NaN/inf so frame JSON is always valid."""
    return val if math.isfinite(val) else 0.0
from dataclasses import dataclass, field

import numpy as np

from config import settings
from graph.loader import EdgeRecord, GraphState, copy_edge_flow_state

logger = logging.getLogger(__name__)

_KEYFRAME_EVERY = settings.KEYFRAME_INTERVAL_SECONDS // settings.TIMESTEP_SECONDS


@dataclass
class TransitStop:
    """Minimal stop record needed by the engine."""

    stop_id: str
    edge_index: int          # edge this stop sits on
    dwell_base_seconds: float
    scheduled_interval_seconds: float  # headway between services
    flow_injection_per_service: float  # vehicles added to edge per service event


@dataclass
class SimulationFrame:
    """One keyframe in the output sequence."""

    timestamp_s: int
    is_full: bool            # True = full snapshot, False = diff
    # For full frames: list of all edge states
    # For diff frames: list of changed edge states only
    edges: list[dict] = field(default_factory=list)
    transit: list[dict] = field(default_factory=list)


@dataclass
class SimulationResult:
    """Output of a single simulation run."""

    frames: list[SimulationFrame]
    # Per-edge aggregate metrics for this run
    mean_congestion: float
    mean_speed_ms: float
    transit_dwell_total_s: float
    mean_excess_delay: float = 0.0  # mean fraction of free-flow speed lost to congestion


def _step(
    edges: list[EdgeRecord],
    transit_stops: list[TransitStop],
    elapsed_s: int,
) -> None:
    """
    Advance simulation by one 5-second timestep in-place.
    Uses two passes to avoid order-dependency between edges.
    """
    n = len(edges)

    # Pass 1: compute outflow for every edge (read-only from current state)
    outflows = np.empty(n, dtype=np.float64)
    for i, e in enumerate(edges):
        outflows[i] = min(e.flow_rate, e.capacity) * settings.DECAY_FACTOR

    # Compute injections: background (steady-state) + transit events
    injections = np.array(
        [e.background_flow_rate for e in edges], dtype=np.float64
    )
    for stop in transit_stops:
        interval = max(stop.scheduled_interval_seconds, 1.0)
        # Inject at each scheduled service interval
        if elapsed_s > 0 and (elapsed_s % round(interval)) == 0:
            injections[stop.edge_index] += stop.flow_injection_per_service

    # Vectorised inflow accumulation
    # turn_weights are stored on upstream edges; each upstream edge distributes
    # its outflow to downstream edges proportionally. O(E) total.
    inflow_acc = np.zeros(n, dtype=np.float64)
    for i, e in enumerate(edges):
        for j, w in zip(e.downstream_indices, e.turn_weights):
            inflow_acc[j] += outflows[i] * w

    # Pass 2: apply update
    for i, e in enumerate(edges):
        e.flow_rate = max(
            0.0, e.flow_rate + inflow_acc[i] - outflows[i] + injections[i]
        )
        e.congestion_factor = max(
            settings.CONGESTION_FLOOR,
            1.0 - e.flow_rate / max(e.capacity, 1e-9),
        )
        e.current_speed_ms = _safe(e.speed_limit_ms) * e.congestion_factor


def _encode_full_frame(
    edges: list[EdgeRecord],
    transit_stops: list[TransitStop],
    elapsed_s: int,
    dwell_active: set[int],
) -> SimulationFrame:
    frame = SimulationFrame(timestamp_s=elapsed_s, is_full=True)
    frame.edges = [
        {"id": i, "c": round(_safe(e.congestion_factor), 3)}
        for i, e in enumerate(edges)
    ]
    frame.transit = _encode_transit(transit_stops, elapsed_s, dwell_active)
    return frame


def _encode_diff_frame(
    edges: list[EdgeRecord],
    prev_state: np.ndarray,
    transit_stops: list[TransitStop],
    elapsed_s: int,
    dwell_active: set[int],
    threshold: float = 0.02,
) -> SimulationFrame:
    frame = SimulationFrame(timestamp_s=elapsed_s, is_full=False)
    changed: list[dict] = []
    for i, e in enumerate(edges):
        if abs(e.congestion_factor - float(prev_state[i, 1])) > threshold:
            changed.append({"id": i, "c": round(_safe(e.congestion_factor), 3)})
    frame.edges = changed
    frame.transit = _encode_transit(transit_stops, elapsed_s, dwell_active)
    return frame


def _encode_transit(
    transit_stops: list[TransitStop],
    elapsed_s: int,
    dwell_active: set[int],
) -> list[dict]:
    result = []
    for stop in transit_stops:
        interval = max(stop.scheduled_interval_seconds, 1.0)
        next_dep = math.ceil(elapsed_s / interval) * interval
        result.append(
            {
                "id": stop.stop_id,
                "dwell": stop.stop_id in dwell_active,
                "next_dep_s": round(next_dep - elapsed_s),
            }
        )
    return result


def run_simulation(
    graph: GraphState,
    transit_stops: list[TransitStop],
    duration_minutes: int | None = None,
) -> SimulationResult:
    """
    Run a single simulation (baseline or scenario) on *graph* for *duration_minutes*.

    graph.edges must already contain the correct initial flow state (seeded or
    patched). This function does NOT reset flow — call graph_snapshot/restore
    externally to manage baseline vs. scenario isolation.

    Returns a SimulationResult with keyframes and aggregate metrics.
    """
    duration_s = (duration_minutes or settings.DEFAULT_DURATION_MINUTES) * 60
    total_steps = duration_s // settings.TIMESTEP_SECONDS

    edges = graph.edges
    frames: list[SimulationFrame] = []

    # Full frame at t=0
    dwell_active: set[int] = set()
    frames.append(_encode_full_frame(edges, transit_stops, 0, dwell_active))
    prev_state = copy_edge_flow_state(edges)

    # Accumulators for aggregate metrics
    congestion_sum = 0.0
    speed_sum = 0.0
    dwell_total_s = 0.0
    excess_delay_sum = 0.0

    logger.info("Simulation starting: %d timesteps (%d min)", total_steps, duration_minutes or settings.DEFAULT_DURATION_MINUTES)

    for step in range(1, total_steps + 1):
        elapsed_s = step * settings.TIMESTEP_SECONDS

        # Update dwell state for stops that are currently servicing
        dwell_active = set()
        for stop in transit_stops:
            interval = max(stop.scheduled_interval_seconds, 1.0)
            phase = elapsed_s % round(interval)
            if phase < stop.dwell_base_seconds:
                dwell_active.add(stop.stop_id)
                dwell_total_s += settings.TIMESTEP_SECONDS

        _step(edges, transit_stops, elapsed_s)

        # Accumulate for metrics
        for e in edges:
            congestion_sum += e.congestion_factor
            speed_sum += e.current_speed_ms
            if e.speed_limit_ms > 0:
                excess_delay_sum += max(0.0, 1.0 - e.current_speed_ms / e.speed_limit_ms)

        # Emit keyframe every KEYFRAME_INTERVAL_SECONDS
        if elapsed_s % settings.KEYFRAME_INTERVAL_SECONDS == 0:
            frame = _encode_diff_frame(
                edges, prev_state, transit_stops, elapsed_s, dwell_active
            )
            frames.append(frame)
            prev_state = copy_edge_flow_state(edges)

    n_samples = total_steps * len(edges)
    mean_congestion = congestion_sum / max(n_samples, 1)
    mean_speed_ms = speed_sum / max(n_samples, 1)

    logger.info(
        "Simulation complete: %d frames, mean_congestion=%.3f, mean_speed=%.1f m/s",
        len(frames),
        mean_congestion,
        mean_speed_ms,
    )

    mean_excess_delay = excess_delay_sum / max(n_samples, 1)

    return SimulationResult(
        frames=frames,
        mean_congestion=mean_congestion,
        mean_speed_ms=mean_speed_ms,
        transit_dwell_total_s=dwell_total_s,
        mean_excess_delay=mean_excess_delay,
    )
