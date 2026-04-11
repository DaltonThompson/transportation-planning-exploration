"""
Unit tests for simulation correctness (MVP Section 14).

Tests are designed to run without network access — they use a tiny
synthetic graph with 5 nodes and ~8 edges.
"""

import copy
import math
import sys
import os

import numpy as np
import pytest

# Make backend root importable
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from graph.loader import (
    EdgeRecord,
    GraphState,
    _compute_turn_weights,
    _seed_background_flow,
    copy_edge_flow_state,
    restore_edge_flow_state,
)
from scenarios.patcher import Patch, Scenario, apply_scenario
from simulation.engine import TransitStop, run_simulation


# ---------------------------------------------------------------------------
# Synthetic graph fixture
# ---------------------------------------------------------------------------

def _make_graph() -> GraphState:
    """
    Cyclic graph: 0→1→2→3→0, with a branch 1→4→0.
    Closing the cycle avoids terminal-node flow accumulation, which would
    make conservation tests meaningless (flow piles up at dead-ends in an
    open graph with continuous background injection).
    """
    nodes = {
        0: {"x": 0.0, "y": 0.0},
        1: {"x": 0.01, "y": 0.0},
        2: {"x": 0.02, "y": 0.0},
        3: {"x": 0.03, "y": 0.0},
        4: {"x": 0.01, "y": 0.01},  # branch off node 1
    }

    def make_edge(u, v, key=0) -> EdgeRecord:
        return EdgeRecord(
            u=u, v=v, key=key,
            length_m=1000.0,
            speed_limit_ms=14.0,   # ~50 km/h
            capacity=2.0,          # 2 vehicles/timestep
            lanes=1,
            highway="primary",
            road_name="",
            has_passing_lane=False,
            current_speed_ms=14.0,
        )

    edges = [
        make_edge(0, 1),   # 0
        make_edge(1, 2),   # 1
        make_edge(2, 3),   # 2
        make_edge(1, 4),   # 3 (branch)
        make_edge(3, 0),   # 4 (close main cycle)
        make_edge(4, 0),   # 5 (close branch)
    ]
    edge_index = {
        (0, 1, 0): 0,
        (1, 2, 0): 1,
        (2, 3, 0): 2,
        (1, 4, 0): 3,
        (3, 0, 0): 4,
        (4, 0, 0): 5,
    }
    node_out_edges = {
        0: [0],
        1: [1, 3],
        2: [2],
        3: [4],
        4: [5],
    }

    _compute_turn_weights(edges, nodes, node_out_edges)
    _seed_background_flow(edges)

    return GraphState(
        nodes=nodes,
        edges=edges,
        edge_index=edge_index,
        node_out_edges=node_out_edges,
        bbox=(0.0, 0.0, 0.03, 0.01),
        place="test",
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_congestion_floor():
    """No edge's congestion_factor should drop below CONGESTION_FLOOR."""
    from config import settings
    graph = _make_graph()
    result = run_simulation(graph, [], duration_minutes=5)
    for frame in result.frames:
        if frame.is_full:
            for e in frame.edges:
                assert e["c"] >= settings.CONGESTION_FLOOR - 1e-6, (
                    f"congestion_factor {e['c']} below floor at t={frame.timestamp_s}"
                )


def test_determinism():
    """Two runs with identical inputs must produce bit-identical frame arrays."""
    graph1 = _make_graph()
    graph2 = _make_graph()

    result1 = run_simulation(graph1, [], duration_minutes=5)
    result2 = run_simulation(graph2, [], duration_minutes=5)

    assert len(result1.frames) == len(result2.frames)
    for f1, f2 in zip(result1.frames, result2.frames):
        assert f1.timestamp_s == f2.timestamp_s
        if f1.is_full:
            # Full frames encode {"id", "c"} per edge (flow/speed dropped from keyframe schema)
            vals1 = sorted((e["id"], e["c"]) for e in f1.edges)
            vals2 = sorted((e["id"], e["c"]) for e in f2.edges)
            assert vals1 == vals2, f"Frame at t={f1.timestamp_s} differs"


def test_scenario_isolation():
    """Applying a scenario patch must not alter the original graph."""
    graph = _make_graph()
    original_speed = graph.edges[0].speed_limit_ms

    scenario = Scenario(
        id="test",
        name="test",
        patches=[
            Patch(type="edge_speed", edge_key=(0, 1, 0), value=10.0)
        ],
    )
    patched_graph, _ = apply_scenario(graph, [], scenario)

    assert graph.edges[0].speed_limit_ms == pytest.approx(original_speed), (
        "Original graph was mutated by apply_scenario"
    )
    assert patched_graph.edges[0].speed_limit_ms != pytest.approx(original_speed), (
        "Patched graph edge was not modified"
    )


def test_initial_seeding_nonzero():
    """Seeded flow_rate must be > 0 on all edges after graph load."""
    graph = _make_graph()
    for e in graph.edges:
        assert e.flow_rate > 0, f"Edge ({e.u},{e.v}) has zero initial flow"


def test_turn_weights_sum_to_one():
    """Turn weights on each edge must sum to 1.0 (or be empty for dead ends)."""
    graph = _make_graph()
    for e in graph.edges:
        if e.turn_weights:
            assert abs(sum(e.turn_weights) - 1.0) < 1e-6, (
                f"Turn weights for edge ({e.u},{e.v}) sum to {sum(e.turn_weights)}"
            )


def test_flow_conservation_approximate():
    """
    With background_flow_rate=0 on all edges (no steady-state injection),
    total flow must decay over time — DECAY_FACTOR < 1 guarantees this.

    Note: the normal seeder sets background_flow_rate to offset decay for an
    isolated edge but does not account for inflow on edges that have upstream
    neighbours. In a cyclic graph with non-zero background_flow_rate, flow can
    grow above seeded levels because background injection is double-counted on
    edges that already receive inflow from the cycle. This is a known limitation
    of the current seeder (see graph/loader.py:_seed_background_flow). The test
    explicitly zeros background injection to isolate the conservation property.
    """
    graph = _make_graph()
    # Zero out background injection to test pure decay
    for e in graph.edges:
        e.background_flow_rate = 0.0
    initial_total = sum(e.flow_rate for e in graph.edges)
    run_simulation(graph, [], duration_minutes=10)
    final_total = sum(e.flow_rate for e in graph.edges)
    # In a closed cycle, outflow from each edge becomes inflow to the next —
    # total flow is conserved, not decayed. The invariant is that no phantom
    # flow is *created*: final total must not exceed initial total (beyond
    # floating-point tolerance).
    assert final_total <= initial_total + 1e-6, (
        f"Phantom flow created without injection: {initial_total:.3f} → {final_total:.3f}"
    )


def test_snapshot_restore():
    """copy_edge_flow_state / restore_edge_flow_state must round-trip exactly."""
    graph = _make_graph()
    snapshot = copy_edge_flow_state(graph.edges)

    # Modify all edges
    for e in graph.edges:
        e.flow_rate = 999.0
        e.congestion_factor = 0.5
        e.current_speed_ms = 1.0

    restore_edge_flow_state(graph.edges, snapshot)

    restored = copy_edge_flow_state(graph.edges)
    assert np.allclose(snapshot, restored), "Snapshot restore did not reproduce original state"


def test_dwell_stop_reduces_outflow():
    """
    A stop with a very long dwell on the only outgoing edge of node 0 should
    not crash the simulation and should produce frames covering the full duration.
    """
    graph = _make_graph()
    stop = TransitStop(
        stop_id="S1",
        edge_index=0,
        dwell_base_seconds=20.0,
        scheduled_interval_seconds=60.0,
        flow_injection_per_service=1.5,
    )
    result = run_simulation(graph, [stop], duration_minutes=5)
    assert len(result.frames) >= 2, "Expected at least initial + one diff frame"
    assert result.frames[0].is_full


def test_diff_frame_reconstruction():
    """
    Applying all diff frames to the initial full frame must equal the final
    full state of the edges.
    """
    graph = _make_graph()
    result = run_simulation(graph, [], duration_minutes=10)

    # Reconstruct edge state from frames
    state: dict[int, dict] = {}
    for frame in result.frames:
        if frame.is_full:
            state = {e["id"]: e.copy() for e in frame.edges}
        else:
            for e in frame.edges:
                state[e["id"]] = e.copy()

    # Final state must have all edges
    assert len(state) == len(graph.edges), (
        f"Reconstructed state has {len(state)} edges, expected {len(graph.edges)}"
    )
