"""
Phase 1: OSM graph loading, attribute normalization, and background flow seeding.

Loads a drive network via osmnx, normalises edge attributes to a consistent
schema, and seeds each edge with background traffic so that baseline and
scenario simulations diverge meaningfully from timestep 0.
"""

import logging
import math
import os
import pickle
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import osmnx as ox

from config import settings

logger = logging.getLogger(__name__)

# OSRM car.lua speed fallbacks (km/h) when OSM maxspeed tag is absent
_OSRM_SPEED_KMH: dict[str, float] = {
    "motorway": 90.0,
    "motorway_link": 60.0,
    "trunk": 85.0,
    "trunk_link": 60.0,
    "primary": 65.0,
    "primary_link": 50.0,
    "secondary": 55.0,
    "secondary_link": 45.0,
    "tertiary": 40.0,
    "tertiary_link": 35.0,
    "residential": 25.0,
    "living_street": 10.0,
    "unclassified": 25.0,
    "service": 15.0,
    "road": 40.0,
}

# Road class load fractions (flow / capacity at peak hour).
# These produce visible congestion gradients in the simulation.
_ROAD_CLASS_FACTOR: dict[str, float] = {
    "motorway": 0.78,
    "motorway_link": 0.55,
    "trunk": 0.70,
    "trunk_link": 0.50,
    "primary": 0.62,
    "primary_link": 0.48,
    "secondary": 0.45,
    "secondary_link": 0.35,
    "tertiary": 0.28,
    "tertiary_link": 0.22,
    "residential": 0.12,
    "living_street": 0.06,
    "unclassified": 0.14,
    "service": 0.10,
    "road": 0.20,
}

# Vehicles-per-lane-per-hour capacity estimates (PCU)
_CAPACITY_PER_LANE: dict[str, float] = {
    "motorway": 2200.0,
    "motorway_link": 1800.0,
    "trunk": 2000.0,
    "trunk_link": 1600.0,
    "primary": 1600.0,
    "primary_link": 1400.0,
    "secondary": 1200.0,
    "secondary_link": 1000.0,
    "tertiary": 900.0,
    "tertiary_link": 800.0,
    "residential": 600.0,
    "living_street": 200.0,
    "unclassified": 600.0,
    "service": 400.0,
    "road": 600.0,
}

# Timestep duration used when converting hourly capacity to per-timestep units
_TIMESTEPS_PER_HOUR = 3600.0 / settings.TIMESTEP_SECONDS  # 720


def _first(val: Any) -> Any:
    """Unwrap osmnx list-valued attributes (takes first element)."""
    if isinstance(val, list):
        return val[0] if val else None
    return val


def _road_class(highway: Any) -> str:
    """Normalise the OSM highway tag to a single string road class."""
    hw = _first(highway) or "road"
    return hw if hw in _OSRM_SPEED_KMH else "road"


def _speed_limit_ms(highway: Any, maxspeed: Any) -> float:
    """Return free-flow speed in m/s, from OSM maxspeed tag or OSRM defaults."""
    ms = _first(maxspeed)
    if ms is not None:
        try:
            kmh = float(str(ms).replace("mph", "").strip())
            # crude mph detection: values > 150 are likely already km/h labels
            if "mph" in str(ms):
                kmh = kmh * 1.60934
            return kmh / 3.6
        except ValueError:
            pass
    cls = _road_class(highway)
    return _OSRM_SPEED_KMH.get(cls, 25.0) / 3.6


def _lanes(lanes_attr: Any) -> int:
    raw = _first(lanes_attr)
    if raw is None:
        return 1
    try:
        return max(1, int(raw))
    except (ValueError, TypeError):
        return 1


def _capacity_per_timestep(highway: Any, lanes_attr: Any) -> float:
    """Capacity in vehicles per 5-second timestep."""
    cls = _road_class(highway)
    hourly_per_lane = _CAPACITY_PER_LANE.get(cls, 600.0)
    total_hourly = hourly_per_lane * _lanes(lanes_attr)
    return total_hourly / _timesteps_per_hour()


def _timesteps_per_hour() -> float:
    return _TIMESTEPS_PER_HOUR


@dataclass
class EdgeRecord:
    """Normalised edge state for one directed road segment."""

    # Immutable graph topology
    u: int
    v: int
    key: int
    length_m: float
    speed_limit_ms: float       # free-flow speed (m/s)
    capacity: float             # vehicles per timestep
    lanes: int
    highway: str                # normalised road class
    road_name: str              # OSM name tag, e.g. "Madison Avenue"
    has_passing_lane: bool

    # Mutable simulation state (reset each run)
    flow_rate: float = 0.0
    congestion_factor: float = 1.0
    current_speed_ms: float = 0.0

    # Steady-state injection rate (vehicles/timestep) to counteract decay.
    # Set once during seeding; never modified by the simulation.
    background_flow_rate: float = 0.0

    # AADT calibration data (optionally set by import-aadt)
    aadt_count: int | None = None
    aadt_year:  int | None = None

    # OSM road geometry: [[lat, lng], ...] (populated from edge LineString)
    coords_latlon: list[list[float]] = field(default_factory=list)

    # Downstream edge indices and pre-computed turn weights
    downstream_indices: list[int] = field(default_factory=list)
    turn_weights: list[float] = field(default_factory=list)


@dataclass
class GraphState:
    """Full in-memory graph ready for simulation."""

    nodes: dict[int, dict]          # osmid → {x, y}
    edges: list[EdgeRecord]         # ordered list; index = simulation edge id
    edge_index: dict[tuple, int]    # (u, v, key) → list index
    node_out_edges: dict[int, list[int]]  # osmid → [edge indices leaving node]
    bbox: tuple[float, float, float, float]  # (min_lon, min_lat, max_lon, max_lat)
    place: str | list[str]

    # Transit overlay (populated by gtfs/loader)
    stop_nodes: dict[str, int] = field(default_factory=dict)  # stop_id → osm node


def load_graph(place: str | list[str] | None = None) -> GraphState:
    """
    Download the OSM drive network for *place*, normalize all edge attributes,
    compute turn weights, and seed background flow.

    Returns a GraphState ready to be passed to the simulation engine.
    """
    place = place or settings.OSM_PLACE

    pickle_path = os.environ.get("GRAPH_PICKLE_PATH")
    if pickle_path and Path(pickle_path).exists():
        logger.info("Loading GraphState from pickle: %s", pickle_path)
        with open(pickle_path, "rb") as f:
            return pickle.load(f)

    logger.info("Loading OSM graph for %s …", place)

    G = ox.graph_from_place(place, network_type=settings.OSM_NETWORK_TYPE)
    G = ox.add_edge_speeds(G)       # fills speed_kph from maxspeed + OSRM
    G = ox.add_edge_travel_times(G)  # adds travel_time in seconds

    gdf_nodes, gdf_edges = ox.graph_to_gdfs(G)

    # Build node lookup
    nodes: dict[int, dict] = {}
    for osmid, row in gdf_nodes.iterrows():
        nodes[osmid] = {"x": row.geometry.x, "y": row.geometry.y}

    # Build edge list
    edges: list[EdgeRecord] = []
    edge_index: dict[tuple, int] = {}
    node_out_edges: dict[int, list[int]] = {}

    for (u, v, key), row in gdf_edges.iterrows():
        idx = len(edges)
        hw = _road_class(row.get("highway"))

        # Extract OSM LineString geometry as [[lat, lng], ...]
        geom = row.get("geometry")
        if geom is not None and hasattr(geom, "coords"):
            coords_latlon = [[c[1], c[0]] for c in geom.coords]
        else:
            # Fallback: straight line between node centroids
            u_n = nodes.get(u, {})
            v_n = nodes.get(v, {})
            coords_latlon = [
                [u_n.get("y", 0.0), u_n.get("x", 0.0)],
                [v_n.get("y", 0.0), v_n.get("x", 0.0)],
            ]

        rec = EdgeRecord(
            u=u,
            v=v,
            key=key,
            length_m=float(row.get("length", 1.0)),
            speed_limit_ms=_speed_limit_ms(
                row.get("highway"), row.get("maxspeed")
            ),
            capacity=_capacity_per_timestep(row.get("highway"), row.get("lanes")),
            lanes=_lanes(row.get("lanes")),
            highway=hw,
            road_name=str(row.get("name") or ""),
            has_passing_lane=_lanes(row.get("lanes")) > 1,
            current_speed_ms=_speed_limit_ms(
                row.get("highway"), row.get("maxspeed")
            ),
            coords_latlon=coords_latlon,
        )
        edges.append(rec)
        edge_index[(u, v, key)] = idx
        node_out_edges.setdefault(u, []).append(idx)

    logger.info("Graph loaded: %d nodes, %d edges", len(nodes), len(edges))

    # Compute turn weights for each edge
    _compute_turn_weights(edges, nodes, node_out_edges)

    # Seed background flow
    _seed_background_flow(edges)

    # Compute bounding box
    xs = [n["x"] for n in nodes.values()]
    ys = [n["y"] for n in nodes.values()]
    bbox = (min(xs), min(ys), max(xs), max(ys))

    return GraphState(
        nodes=nodes,
        edges=edges,
        edge_index=edge_index,
        node_out_edges=node_out_edges,
        bbox=bbox,
        place=place,
    )


def _bearing(ax: float, ay: float, bx: float, by: float) -> float:
    """Compass bearing in radians from point A to point B."""
    dx = bx - ax
    dy = by - ay
    return math.atan2(dx, dy)


def _angle_diff(a: float, b: float) -> float:
    """Absolute angular difference between two bearings (0–π)."""
    diff = abs(a - b) % (2 * math.pi)
    if diff > math.pi:
        diff = 2 * math.pi - diff
    return diff


def _compute_turn_weights(
    edges: list[EdgeRecord],
    nodes: dict[int, dict],
    node_out_edges: dict[int, list[int]],
) -> None:
    """
    For each edge, find downstream edges and assign turn weights via the
    angle-continuity heuristic: weight = cos(turn_angle / 2), normalized.
    U-turns (angle > 150°) are excluded.
    """
    for edge in edges:
        downstream_indices = node_out_edges.get(edge.v, [])
        if not downstream_indices:
            edge.downstream_indices = []
            edge.turn_weights = []
            continue

        # Bearing of the arriving edge (u → v)
        u_pos = nodes[edge.u]
        v_pos = nodes[edge.v]
        arrive_bearing = _bearing(u_pos["x"], u_pos["y"], v_pos["x"], v_pos["y"])

        weights: list[float] = []
        valid_indices: list[int] = []

        for d_idx in downstream_indices:
            d_edge = edges[d_idx]
            d_v_pos = nodes[d_edge.v]
            depart_bearing = _bearing(v_pos["x"], v_pos["y"], d_v_pos["x"], d_v_pos["y"])
            angle = _angle_diff(arrive_bearing, depart_bearing)

            # Exclude U-turns (> 150°)
            if angle > math.radians(150):
                continue

            w = math.cos(angle / 2)
            valid_indices.append(d_idx)
            weights.append(w)

        if not weights:
            # All exits are U-turns (dead end or roundabout edge) — allow all
            valid_indices = list(downstream_indices)
            weights = [1.0] * len(downstream_indices)

        total = sum(weights)
        edge.downstream_indices = valid_indices
        edge.turn_weights = [w / total for w in weights]


def _seed_background_flow(edges: list[EdgeRecord]) -> None:
    """
    Assign initial background flow to each edge so the network is non-empty
    at simulation start. Road class factors represent fraction of capacity
    at peak hour. background_flow_rate is set so _step re-injects exactly
    enough to counteract decay, keeping congestion at steady state.
    """
    for edge in edges:
        factor = _ROAD_CLASS_FACTOR.get(edge.highway, 0.14)
        edge.flow_rate = edge.capacity * factor
        edge.congestion_factor = max(
            settings.CONGESTION_FLOOR,
            1.0 - edge.flow_rate / max(edge.capacity, 1e-9),
        )
        edge.current_speed_ms = _safe_speed(edge.speed_limit_ms) * edge.congestion_factor
        # Injection per timestep to exactly offset decay and maintain steady-state flow.
        # At equilibrium: flow = flow * DECAY_FACTOR + background_flow_rate → flow = initial.
        edge.background_flow_rate = edge.flow_rate * settings.DECAY_FACTOR


def _safe_speed(val: float) -> float:
    import math
    return val if math.isfinite(val) else 25.0 / 3.6


def copy_edge_flow_state(edges: list[EdgeRecord]) -> np.ndarray:
    """
    Return a float32 array of shape (N, 3) — [flow_rate, congestion_factor,
    current_speed_ms] — for fast numpy comparison and diff encoding.
    """
    arr = np.zeros((len(edges), 3), dtype=np.float32)
    for i, e in enumerate(edges):
        arr[i, 0] = e.flow_rate
        arr[i, 1] = e.congestion_factor
        arr[i, 2] = e.current_speed_ms
    return arr


def restore_edge_flow_state(edges: list[EdgeRecord], arr: np.ndarray) -> None:
    """Apply a previously snapshotted flow state array back onto edge objects."""
    for i, e in enumerate(edges):
        e.flow_rate = float(arr[i, 0])
        e.congestion_factor = float(arr[i, 1])
        e.current_speed_ms = float(arr[i, 2])
