"""
API contract tests (Phase 9C).

Guards the frontend/backend field contract. If a field is renamed or
dropped, CI catches it before the frontend breaks silently.

Uses FastAPI's test client mounted on a minimal app (no startup events,
no OSM downloads, no GTFS fetches). app_state is pre-populated with
the synthetic graph fixture and canned run data.
"""

import sys
import os
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import router
from api.state import app_state
from config import settings
from db import store as _db
from simulation.runner import MetricDeltas, RunResult
from simulation.engine import SimulationResult, SimulationFrame
from tests.fixtures import make_graph
from scenarios.patcher import Scenario


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _reset_state(tmp_path, monkeypatch):
    """Reset app_state and point persistence at a per-test temp SQLite file."""
    monkeypatch.setattr(settings, "DB_PATH", str(tmp_path / "test.db"))
    _db.init_db()
    app_state.graph = make_graph()
    app_state.scenarios = {}
    app_state.runs = {}
    app_state.stop_records = []
    app_state.route_shapes = []
    app_state.feed_slugs = []
    app_state.run_in_progress = False
    yield
    app_state.graph = None
    app_state.scenarios = {}
    app_state.runs = {}


@pytest.fixture()
def client():
    test_app = FastAPI()
    test_app.include_router(router)
    return TestClient(test_app, raise_server_exceptions=True)


def _canned_run(scenario_id: str) -> RunResult:
    """A completed RunResult with realistic delta values for contract checks."""
    deltas = MetricDeltas(
        travel_time_delta_pct=5.0,
        congestion_delta_pct=-3.0,
        transit_time_delta_pct=1.0,
        delay_delta_pct=2.0,
    )
    full_frame = SimulationFrame(timestamp_s=0, is_full=True, edges=[{"id": 0, "c": 0.8}])
    sim = SimulationResult(frames=[full_frame], mean_speed_ms=10.0, mean_congestion=0.8, transit_dwell_total_s=0.0, mean_excess_delay=0.0)
    return RunResult(
        run_id=str(uuid.uuid4()),
        scenario_id=scenario_id,
        status="complete",
        progress_pct=100.0,
        baseline=sim,
        scenario_result=sim,
        deltas=deltas,
    )


# ---------------------------------------------------------------------------
# GET /api/graph/edges
# ---------------------------------------------------------------------------

class TestGraphEdges:
    def test_required_fields(self, client):
        resp = client.get("/api/graph/edges")
        assert resp.status_code == 200
        body = resp.json()
        assert "edges" in body
        assert "edge_count" in body

        for edge in body["edges"]:
            assert "id"    in edge, f"Missing 'id' in edge: {edge}"
            assert "coords" in edge, f"Missing 'coords' in edge: {edge}"

    def test_edge_count_matches_fixture(self, client):
        resp = client.get("/api/graph/edges")
        # Synthetic graph has 6 edges but coords_latlon is None on EdgeRecord
        # (fixture uses straight-line fallback) — all 6 should appear
        assert resp.json()["edge_count"] == 6


# ---------------------------------------------------------------------------
# POST /api/scenarios  +  GET /api/scenarios
# ---------------------------------------------------------------------------

class TestScenarios:
    def test_create_returns_id(self, client):
        resp = client.post("/api/scenarios", json={"name": "Test", "patches": []})
        assert resp.status_code == 201
        body = resp.json()
        assert "id" in body

    def test_created_scenario_appears_in_list(self, client):
        create = client.post("/api/scenarios", json={"name": "Headway-30", "patches": []})
        sid = create.json()["id"]

        list_resp = client.get("/api/scenarios")
        assert list_resp.status_code == 200
        ids = [s["id"] for s in list_resp.json()]
        assert sid in ids

    def test_delete_removes_from_list(self, client):
        sid = client.post("/api/scenarios", json={"name": "ToDelete", "patches": []}).json()["id"]
        del_resp = client.delete(f"/api/scenarios/{sid}")
        assert del_resp.status_code == 204

        ids = [s["id"] for s in client.get("/api/scenarios").json()]
        assert sid not in ids


# ---------------------------------------------------------------------------
# POST /api/runs
# ---------------------------------------------------------------------------

class TestRunCreate:
    def test_returns_run_id(self, client, monkeypatch):
        sid = client.post("/api/scenarios", json={"name": "S", "patches": []}).json()["id"]

        # Patch execute_dual_run so CI doesn't run the real simulation
        from unittest.mock import patch as mpatch

        def fake_dual_run(**kw):
            run_id = kw["run_id"]
            r = _canned_run(kw["scenario"].id)
            r.run_id = run_id
            app_state.runs[run_id] = r
            return r

        with mpatch("api.routes.execute_dual_run", side_effect=fake_dual_run):
            resp = client.post("/api/runs", json={"scenario_id": sid})

        assert resp.status_code == 202
        body = resp.json()
        assert "run_id" in body

    def test_unknown_scenario_404(self, client):
        resp = client.post("/api/runs", json={"scenario_id": "no-such-id"})
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/runs/{run_id}
# ---------------------------------------------------------------------------

class TestRunGet:
    def _setup_run(self, client, scenario_name: str = "S") -> tuple[str, str]:
        sid = client.post("/api/scenarios", json={"name": scenario_name, "patches": []}).json()["id"]
        run = _canned_run(sid)
        app_state.runs[run.run_id] = run
        return run.run_id, sid

    def test_complete_run_has_status(self, client):
        run_id, _ = self._setup_run(client)
        resp = client.get(f"/api/runs/{run_id}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "complete"

    def test_complete_run_has_metrics(self, client):
        """ComparisonPanel reads metrics.{travel_time,congestion,transit_time,delay}_delta_pct."""
        run_id, _ = self._setup_run(client)
        resp = client.get(f"/api/runs/{run_id}")
        assert resp.status_code == 200
        body = resp.json()
        assert "metrics" in body, f"Missing 'metrics' key in {list(body.keys())}"
        m = body["metrics"]
        for field in ("travel_time_delta_pct", "congestion_delta_pct",
                      "transit_time_delta_pct", "delay_delta_pct"):
            assert field in m, f"Missing metrics field '{field}'"

    def test_run_has_run_id_and_scenario_id(self, client):
        run_id, sid = self._setup_run(client)
        body = client.get(f"/api/runs/{run_id}").json()
        assert body["run_id"] == run_id
        assert body["scenario_id"] == sid

    def test_missing_run_404(self, client):
        resp = client.get("/api/runs/nonexistent")
        assert resp.status_code == 404
