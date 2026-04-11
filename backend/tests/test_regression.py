"""
Simulation regression tests (Phase 9C).

These tests pin exact numeric output for the synthetic fixture graph.
Any change in output is a hard CI failure. If a refactor intentionally
changes results, update the EXPECTED_* constants explicitly and note it in review.

Pinned on 2026-04-22 against claude_output/backend @ commit b23575e.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from tests.fixtures import make_graph
from scenarios.patcher import Patch, Scenario
from simulation.runner import execute_dual_run

# ---------------------------------------------------------------------------
# Pinned expected values — update these only when an intentional change lands
# ---------------------------------------------------------------------------

# edge_speed patch: halve speed on edge (0→1) from 14 m/s to 7 m/s, 5 min run
PATCH_EDGE_SPEED_HALF = Patch(type="edge_speed", edge_key=(0, 1, 0), value=7.0)

EXPECTED_TRAVEL_TIME_DELTA_PCT  = 16.75675675675641
EXPECTED_CONGESTION_DELTA_PCT   = 0.0
EXPECTED_TRANSIT_TIME_DELTA_PCT = 0.0
EXPECTED_DELAY_DELTA_PCT        = 0.0

# Keyframe structure constants
EXPECTED_BASELINE_FRAME_COUNT = 11  # t=0 full + 10 diff frames over 5 min
EXPECTED_DIFF_FRAME_COUNT     = 10


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(scenario_patches: list[Patch], duration_minutes: int = 5):
    graph = make_graph()
    scenario = Scenario(id="reg", name="reg", patches=scenario_patches)
    return execute_dual_run("run-reg", graph, [], scenario, duration_minutes=duration_minutes)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_delta_output_pinned():
    """Exact delta values must not drift from the pinned baseline."""
    result = _run([PATCH_EDGE_SPEED_HALF])
    assert result.status == "complete", result.error

    d = result.deltas
    assert d.travel_time_delta_pct  == pytest.approx(EXPECTED_TRAVEL_TIME_DELTA_PCT,  abs=1e-9)
    assert d.congestion_delta_pct   == pytest.approx(EXPECTED_CONGESTION_DELTA_PCT,   abs=1e-9)
    assert d.transit_time_delta_pct == pytest.approx(EXPECTED_TRANSIT_TIME_DELTA_PCT, abs=1e-9)
    assert d.delay_delta_pct        == pytest.approx(EXPECTED_DELAY_DELTA_PCT,        abs=1e-9)


def test_keyframe_structure():
    """t=0 must be a full snapshot; all subsequent frames must be diffs."""
    result = _run([PATCH_EDGE_SPEED_HALF])
    frames = result.baseline.frames

    assert len(frames) == EXPECTED_BASELINE_FRAME_COUNT
    assert frames[0].is_full, "First frame must be a full snapshot"
    assert frames[0].timestamp_s == 0

    diff_count = sum(1 for f in frames if not f.is_full)
    assert diff_count == EXPECTED_DIFF_FRAME_COUNT


def test_dual_run_determinism():
    """Two identical runs must produce bit-identical delta values."""
    result1 = _run([PATCH_EDGE_SPEED_HALF])
    result2 = _run([PATCH_EDGE_SPEED_HALF])

    assert result1.deltas.travel_time_delta_pct  == result2.deltas.travel_time_delta_pct
    assert result1.deltas.congestion_delta_pct   == result2.deltas.congestion_delta_pct
    assert result1.deltas.transit_time_delta_pct == result2.deltas.transit_time_delta_pct
    assert result1.deltas.delay_delta_pct        == result2.deltas.delay_delta_pct

    # Keyframe counts must also match
    assert len(result1.baseline.frames) == len(result2.baseline.frames)
    assert len(result1.scenario_result.frames) == len(result2.scenario_result.frames)


def test_no_patch_zero_delta():
    """A scenario with no patches must produce zero deltas (identical runs)."""
    result = _run([])
    assert result.status == "complete"
    d = result.deltas
    assert d.travel_time_delta_pct  == pytest.approx(0.0, abs=1e-9)
    assert d.congestion_delta_pct   == pytest.approx(0.0, abs=1e-9)
    assert d.transit_time_delta_pct == pytest.approx(0.0, abs=1e-9)
    assert d.delay_delta_pct        == pytest.approx(0.0, abs=1e-9)
