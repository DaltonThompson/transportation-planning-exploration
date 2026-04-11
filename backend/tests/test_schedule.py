"""
Phase 12 (Schedule Arithmetic) unit tests.

Uses a small synthetic graph — no network calls — to verify:

  * straight-shape route has ≈ 0 turn penalty
  * route with a severe bend shows a visible penalty and downgraded comfort
  * headway delta is symmetric in sign (+/- H/2)
  * inserting a stop on-path adds dwell only
  * inserting a stop off the mainline (detour) adds distance + worsens comfort
  * removing a stop shifts downstream times earlier by ≈ dwell
"""

import math
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from graph.loader import EdgeRecord, GraphState
from schedule.arithmetic import (
    DEFAULT_DWELL_S,
    StopNodeRef,
    compute_trip_time,
    headway_impact,
    stop_impact,
)


# ── Graph fixture ────────────────────────────────────────────────────────────
#
#       N0 ──► N1 ──► N2 ──► N3 ──► N4   (straight mainline, 200 m each edge)
#                     │
#                     ▼
#                     N5              (detour hop — 90° turn south)
#                     │
#                     ▼
#                     N6 ──► N3       (rejoins mainline via another 90°)
#
# N1.5 is an implicit "on-path" point realised by snapping a new stop to
# N2 (the midpoint of the mainline).

def _make_graph() -> GraphState:
    # Node coords are (x=lon, y=lat). Use small offsets so haversine treats
    # each segment as ~200 m; at ~42°N, 0.002° lon ≈ 165 m, close enough.
    nodes = {
        0: {"x": 0.000, "y": 42.000},
        1: {"x": 0.002, "y": 42.000},
        2: {"x": 0.004, "y": 42.000},
        3: {"x": 0.006, "y": 42.000},
        4: {"x": 0.008, "y": 42.000},
        5: {"x": 0.004, "y": 41.998},  # south of N2
        6: {"x": 0.006, "y": 41.998},  # south of N3
    }

    speed = 10.0  # m/s for every edge (→ deterministic 20 s per 200 m)

    def mk(u, v, length=200.0) -> EdgeRecord:
        return EdgeRecord(
            u=u, v=v, key=0,
            length_m=length, speed_limit_ms=speed,
            capacity=2.0, lanes=1, highway="primary",
            road_name="", has_passing_lane=False, current_speed_ms=speed,
        )

    edges = [
        mk(0, 1),            # 0  mainline
        mk(1, 2),            # 1
        mk(2, 3),            # 2
        mk(3, 4),            # 3
        mk(2, 5, length=220.0),  # 4  detour south from N2 (90° turn)
        mk(5, 6, length=200.0),  # 5  east leg of detour
        mk(6, 3, length=220.0),  # 6  back north to N3 (90° turn)
    ]
    edge_index = {(e.u, e.v, 0): i for i, e in enumerate(edges)}
    node_out_edges: dict[int, list[int]] = {}
    for i, e in enumerate(edges):
        node_out_edges.setdefault(e.u, []).append(i)

    return GraphState(
        nodes=nodes, edges=edges, edge_index=edge_index,
        node_out_edges=node_out_edges,
        bbox=(0.0, 41.997, 0.010, 42.001),
        place="synthetic",
    )


def _ref(stop_id: str, name: str, node: int, g: GraphState) -> StopNodeRef:
    nd = g.nodes[node]
    return StopNodeRef(stop_id=stop_id, name=name, node=node,
                       lat=nd["y"], lng=nd["x"])


# ── 12A trip time ────────────────────────────────────────────────────────────

def test_straight_route_has_zero_turn_penalty():
    g = _make_graph()
    stops = [
        _ref("A", "A", 0, g),
        _ref("B", "B", 2, g),
        _ref("C", "C", 4, g),
    ]
    r = compute_trip_time(g, stops, dwell_seconds=30.0)

    assert r.turn_penalty_s == 0.0
    assert r.comfort_index["severe"] == 0
    assert r.comfort_index["moderate"] == 0

    # 4 mainline edges × 200 m / 10 m/s = 80 s base; one intermediate dwell (30 s)
    assert r.total_s == pytest.approx(80.0 + 30.0, abs=0.5)

    # Cumulative minutes are strictly increasing
    cm = [s["cumulative_minutes"] for s in r.stops]
    assert cm == sorted(cm)


def test_route_with_severe_turn_shows_penalty():
    g = _make_graph()
    # Force the router to take the detour by going A=N1 → B=N5 → C=N4.
    # Path: 1→2→5 (severe turn at N2), 5→6→3→4 (severe at N6, moderate at N3).
    stops = [
        _ref("A", "A", 1, g),
        _ref("B", "B", 5, g),
        _ref("C", "C", 4, g),
    ]
    r = compute_trip_time(g, stops, dwell_seconds=30.0)

    assert r.turn_penalty_s > 0.0
    assert r.comfort_index["severe"] >= 1
    # Separate field, not folded into base:
    assert r.assumptions["turn_model"] == "tcrp_lookup"


# ── 12B headway impact ──────────────────────────────────────────────────────

def test_headway_delta_is_symmetric():
    inc = headway_impact(old_headway_minutes=10.0, new_headway_minutes=20.0)
    dec = headway_impact(old_headway_minutes=20.0, new_headway_minutes=10.0)

    assert inc["wait_delta_minutes"] == pytest.approx(+5.0)
    assert dec["wait_delta_minutes"] == pytest.approx(-5.0)
    assert inc["wait_delta_minutes"] == -dec["wait_delta_minutes"]


# ── 12C stop impact ─────────────────────────────────────────────────────────

def test_insert_on_path_adds_only_dwell():
    """Inserting a stop that already lies on the baseline path should add
    only the dwell time — no detour distance."""
    g = _make_graph()
    baseline = [_ref("A", "A", 0, g), _ref("C", "C", 4, g)]
    # N2 lies on the shortest path N0→N4 (0→1→2→3→4)
    inserted = _ref("B", "B", 2, g)

    res = stop_impact(
        g, baseline, action="insert",
        dwell_seconds=30.0,
        after_stop_id="A", inserted=inserted,
    )

    # Travel distance unchanged → delta should equal one inserted-stop dwell
    assert res.delta_s == pytest.approx(30.0, abs=1.0)
    # Comfort index should not get worse (same path)
    assert (res.comfort_index_proposed["severe"]
            == res.comfort_index_baseline["severe"])


def test_insert_detour_adds_distance_and_hurts_comfort():
    """Inserting a stop off the mainline forces a detour — added travel time
    and a worsened comfort index."""
    g = _make_graph()
    baseline = [_ref("A", "A", 1, g), _ref("C", "C", 4, g)]  # N1→N4 direct
    inserted = _ref("B", "B", 5, g)                          # off-mainline

    res = stop_impact(
        g, baseline, action="insert",
        dwell_seconds=30.0,
        after_stop_id="A", inserted=inserted,
    )

    # Detour adds distance, turn penalty, AND dwell: delta must exceed dwell.
    assert res.delta_s > 30.0
    assert (res.comfort_index_proposed["severe"]
            > res.comfort_index_baseline["severe"])


def test_remove_shifts_downstream_earlier():
    g = _make_graph()
    baseline = [
        _ref("A", "A", 0, g),
        _ref("B", "B", 2, g),
        _ref("C", "C", 4, g),
    ]
    res = stop_impact(
        g, baseline, action="remove",
        dwell_seconds=30.0,
        remove_stop_id="B",
    )

    # B contributed a 30 s dwell — removing it pulls C earlier by ~30 s.
    assert res.delta_s == pytest.approx(-30.0, abs=1.0)

    # C should appear in downstream_shift with a negative delta.
    c_entry = next(d for d in res.downstream_shift if d["stop_id"] == "C")
    assert c_entry["delta_seconds"] == pytest.approx(-30.0, abs=1.0)


# ── 12D reliability annotations ─────────────────────────────────────────────

def test_reliability_annotation_variants():
    from schedule.performance import reliability_annotation

    # Normal fixed-schedule route
    r1 = reliability_annotation("1")
    assert r1["available"] is True
    assert r1["on_time_pct"] == 68
    assert r1["source"].startswith("FY2025")

    # CAD/AVL absent
    r2 = reliability_annotation("411")
    assert r2["available"] is False
    assert "CAD/AVL" in r2["reason"]

    # Managed-headway route
    r3 = reliability_annotation("905")
    assert r3["available"] is False
    assert r3.get("headway_managed") is True

    # Unknown route
    r4 = reliability_annotation("9999")
    assert r4["available"] is False
