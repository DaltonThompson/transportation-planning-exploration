"""
In-process state store. Holds loaded graph, GTFS stops, scenarios,
simulation runs, and changelog entries for the lifetime of the process.
"""

from dataclasses import dataclass, field

from bike.loader import BikeInfraResult
from graph.loader import GraphState
from gtfs.loader import RouteDetail, RouteShapeRecord, StopRecord, StopSchedule
from scenarios.patcher import Scenario
from simulation.engine import TransitStop
from simulation.runner import ChangelogEntry, RunResult


@dataclass
class AppState:
    graph: GraphState | None = None
    transit_stops: list[TransitStop] = field(default_factory=list)
    stop_records: list[StopRecord] = field(default_factory=list)
    route_shapes: list[RouteShapeRecord] = field(default_factory=list)
    route_details: dict[str, RouteDetail] = field(default_factory=dict)    # "feed_slug:route_id" → detail
    stop_schedules: dict[str, StopSchedule] = field(default_factory=dict) # stop_id → schedule
    scenarios: dict[str, Scenario] = field(default_factory=dict)
    runs: dict[str, RunResult] = field(default_factory=dict)
    changelog: list[ChangelogEntry] = field(default_factory=list)
    feed_slugs: list[str] = field(default_factory=list)
    bike_infra: BikeInfraResult | None = None
    gtfs_syncing: bool = False
    run_in_progress: bool = False


# Module-level singleton
app_state = AppState()
