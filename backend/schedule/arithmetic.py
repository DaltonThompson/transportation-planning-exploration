"""
Phase 12 schedule arithmetic.

Pure functions over a loaded GraphState + a stop sequence. No simulation
run required. Every call returns an `assumptions` block so the caller can
surface them in the UI.

Model:

- A segment is the span between two consecutive stops. It is realised as
  the OSM shortest-path edge chain between the stops' snapped nodes.
- Segment travel time = sum(edge.length_m / edge.speed_limit_ms) over that
  chain.
- Turn penalty at each interior vertex of the chain is a fixed
  TCRP/TRB-style delay by tier (severe / moderate / gentle) based on the
  interior angle between incoming and outgoing edges.
- Dwell time is a configurable constant per stop.

All times are in seconds internally; we convert to minutes at the API
boundary.
"""

from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field

from graph.loader import GraphState


# ── TCRP-style turn-penalty lookup ───────────────────────────────────────────
# Interior-angle tiers. The `turn_angle` below is the deflection from
# straight-line travel (0° = no turn). Severity rises with deflection.
SEVERE_DEFLECTION_DEG = 90.0     # sharper than 90° off straight → severe
MODERATE_DEFLECTION_DEG = 45.0   # 45°–90° → moderate; 10°–45° → gentle
GENTLE_MIN_DEFLECTION_DEG = 10.0 # below this is treated as straight (no turn)

# Per-turn fixed delay (seconds). Derived from TCRP Report 100 curve-speed
# guidance for transit buses at urban intersections and bends.
TURN_PENALTY_S = {
    "severe":   6.0,
    "moderate": 2.5,
    "gentle":   0.5,
}

DEFAULT_DWELL_S = 30.0


@dataclass
class SegmentResult:
    """Single inter-stop segment."""
    distance_m: float
    base_travel_s: float      # length / speed only
    turn_penalty_s: float     # added from turn geometry
    edge_indices: list[int] = field(default_factory=list)
    turn_counts: dict[str, int] = field(default_factory=lambda: {
        "severe": 0, "moderate": 0, "gentle": 0,
    })
    deflections_deg: list[float] = field(default_factory=list)

    @property
    def total_s(self) -> float:
        return self.base_travel_s + self.turn_penalty_s


@dataclass
class StopNodeRef:
    """A stop, identified to the arithmetic layer by its OSM node id."""
    stop_id: str
    name: str
    node: int
    lat: float
    lng: float


# ── Internal helpers ─────────────────────────────────────────────────────────

def _shortest_path_nodes_and_edges(
    graph: GraphState, source: int, target: int,
) -> tuple[list[int], list[int]]:
    """Dijkstra on free-flow travel time. Returns (node_path, edge_path)."""
    if source == target:
        return [source], []

    dist: dict[int, float] = {source: 0.0}
    prev: dict[int, tuple[int, int]] = {}
    heap: list[tuple[float, int]] = [(0.0, source)]

    while heap:
        d, u = heapq.heappop(heap)
        if d > dist.get(u, math.inf):
            continue
        if u == target:
            break
        for edge_idx in graph.node_out_edges.get(u, []):
            e = graph.edges[edge_idx]
            cost = e.length_m / max(e.speed_limit_ms, 0.1)
            nd = d + cost
            if nd < dist.get(e.v, math.inf):
                dist[e.v] = nd
                prev[e.v] = (u, edge_idx)
                heapq.heappush(heap, (nd, e.v))

    if target not in prev:
        return [], []

    edges_rev: list[int] = []
    nodes_rev: list[int] = [target]
    cur = target
    while cur in prev:
        p, edge_idx = prev[cur]
        edges_rev.append(edge_idx)
        nodes_rev.append(p)
        cur = p
    nodes_rev.reverse()
    edges_rev.reverse()
    return nodes_rev, edges_rev


def _node_xy(graph: GraphState, n: int) -> tuple[float, float]:
    node = graph.nodes.get(n, {})
    return float(node.get("x", 0.0)), float(node.get("y", 0.0))


def _deflection_deg(
    graph: GraphState, a: int, b: int, c: int,
) -> float:
    """
    Deflection (in degrees) at node `b` when travelling a→b→c. 0° means
    straight, 180° means a hairpin reversal. Returns 0° if vectors are
    degenerate.
    """
    ax, ay = _node_xy(graph, a)
    bx, by = _node_xy(graph, b)
    cx, cy = _node_xy(graph, c)
    v1x, v1y = bx - ax, by - ay
    v2x, v2y = cx - bx, cy - by
    n1 = math.hypot(v1x, v1y)
    n2 = math.hypot(v2x, v2y)
    if n1 < 1e-12 or n2 < 1e-12:
        return 0.0
    cos_t = (v1x * v2x + v1y * v2y) / (n1 * n2)
    cos_t = max(-1.0, min(1.0, cos_t))
    # interior angle between incoming-reversed and outgoing is (180 - deflection)
    # angle between raw vectors equals deflection.
    return math.degrees(math.acos(cos_t))


def _tier_for_deflection(deg: float) -> str | None:
    """Return tier label or None when the deflection is below the noise floor."""
    if deg >= SEVERE_DEFLECTION_DEG:
        return "severe"
    if deg >= MODERATE_DEFLECTION_DEG:
        return "moderate"
    if deg >= GENTLE_MIN_DEFLECTION_DEG:
        return "gentle"
    return None


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def nearest_node(graph: GraphState, lat: float, lng: float) -> int:
    """Brute-force nearest graph node to a lat/lng. Used for ad-hoc new stops."""
    best_n = -1
    best_d = math.inf
    for n, coords in graph.nodes.items():
        x, y = float(coords.get("x", 0.0)), float(coords.get("y", 0.0))
        # small-angle euclidean is fine for a single-county bbox
        dx = x - lng
        dy = y - lat
        d = dx * dx + dy * dy
        if d < best_d:
            best_d = d
            best_n = n
    return best_n


# ── Segment computation ──────────────────────────────────────────────────────

def compute_segment(
    graph: GraphState, from_node: int, to_node: int,
) -> SegmentResult:
    """
    Compute distance, travel time, and turn penalty for the shortest OSM
    path between two nodes. Returns a SegmentResult with zeros if no path
    exists.
    """
    node_path, edge_path = _shortest_path_nodes_and_edges(graph, from_node, to_node)
    seg = SegmentResult(distance_m=0.0, base_travel_s=0.0, turn_penalty_s=0.0,
                        edge_indices=edge_path)

    if not edge_path:
        return seg

    for idx in edge_path:
        e = graph.edges[idx]
        seg.distance_m += e.length_m
        seg.base_travel_s += e.length_m / max(e.speed_limit_ms, 0.1)

    # Turns at interior vertices of the path. node_path has len(edge_path)+1
    # entries; interior vertices are indices 1..-2.
    for i in range(1, len(node_path) - 1):
        a, b, c = node_path[i - 1], node_path[i], node_path[i + 1]
        deg = _deflection_deg(graph, a, b, c)
        tier = _tier_for_deflection(deg)
        if tier is None:
            continue
        seg.turn_counts[tier] += 1
        seg.deflections_deg.append(deg)
        seg.turn_penalty_s += TURN_PENALTY_S[tier]

    return seg


# ── Top-level API ────────────────────────────────────────────────────────────

@dataclass
class TripTimeResult:
    stops: list[dict]                # [{stop_id, name, cumulative_seconds}]
    total_s: float
    turn_penalty_s: float
    comfort_index: dict              # {severe, moderate, gentle, mean_angle_deg}
    assumptions: dict
    segments: list[SegmentResult]


def compute_trip_time(
    graph: GraphState,
    stops: list[StopNodeRef],
    dwell_seconds: float = DEFAULT_DWELL_S,
    dwell_by_stop_id: dict[str, float] | None = None,
) -> TripTimeResult:
    """
    End-to-end trip time along the given ordered stop list.

    Dwell is applied at every intermediate stop (not the first or the
    last — you don't dwell before you start or after you finish).
    """
    dwell_by_stop_id = dwell_by_stop_id or {}

    segments: list[SegmentResult] = []
    cumulative = 0.0
    total_turn_penalty = 0.0
    all_deflections: list[float] = []
    turn_totals = {"severe": 0, "moderate": 0, "gentle": 0}

    out_stops: list[dict] = []
    if stops:
        out_stops.append({
            "stop_id": stops[0].stop_id,
            "name": stops[0].name,
            "cumulative_seconds": 0.0,
            "cumulative_minutes": 0.0,
        })

    for i in range(1, len(stops)):
        prev = stops[i - 1]
        cur = stops[i]
        seg = compute_segment(graph, prev.node, cur.node)
        segments.append(seg)

        # dwell is added at the arriving stop for every intermediate stop
        is_terminal = (i == len(stops) - 1)
        dwell = 0.0 if is_terminal else dwell_by_stop_id.get(cur.stop_id, dwell_seconds)

        cumulative += seg.total_s + dwell
        total_turn_penalty += seg.turn_penalty_s
        all_deflections.extend(seg.deflections_deg)
        for tier, n in seg.turn_counts.items():
            turn_totals[tier] += n

        out_stops.append({
            "stop_id": cur.stop_id,
            "name": cur.name,
            "cumulative_seconds": cumulative,
            "cumulative_minutes": cumulative / 60.0,
        })

    mean_angle = (sum(all_deflections) / len(all_deflections)) if all_deflections else 0.0

    return TripTimeResult(
        stops=out_stops,
        total_s=cumulative,
        turn_penalty_s=total_turn_penalty,
        comfort_index={
            **turn_totals,
            "mean_angle_deg": mean_angle,
        },
        assumptions={
            "dwell_seconds": dwell_seconds,
            "speed_source": "osm_maxspeed",
            "turn_model": "tcrp_lookup",
            "severe_deflection_deg": SEVERE_DEFLECTION_DEG,
            "moderate_deflection_deg": MODERATE_DEFLECTION_DEG,
        },
        segments=segments,
    )


# ── 12B: Headway impact ──────────────────────────────────────────────────────

def headway_impact(
    old_headway_minutes: float,
    new_headway_minutes: float,
) -> dict:
    """
    Standard expected-wait formula: E[wait] = headway / 2 for a passenger
    arriving uniformly at random. Delta is symmetric in sign.
    """
    old_wait = old_headway_minutes / 2.0
    new_wait = new_headway_minutes / 2.0
    return {
        "old_headway_minutes": old_headway_minutes,
        "new_headway_minutes": new_headway_minutes,
        "old_expected_wait_minutes": old_wait,
        "new_expected_wait_minutes": new_wait,
        "wait_delta_minutes": new_wait - old_wait,
        "assumptions": {
            "wait_model": "uniform_arrival_half_headway",
        },
    }


# ── 12C: Stop addition / removal impact ──────────────────────────────────────

@dataclass
class StopImpactResult:
    action: str                        # "insert" | "remove"
    baseline_total_s: float
    proposed_total_s: float
    delta_s: float
    downstream_shift: list[dict]       # {stop_id, name, baseline_s, proposed_s, delta_s}
    comfort_index_baseline: dict
    comfort_index_proposed: dict
    assumptions: dict


def stop_impact(
    graph: GraphState,
    baseline_stops: list[StopNodeRef],
    action: str,
    dwell_seconds: float = DEFAULT_DWELL_S,
    after_stop_id: str | None = None,
    inserted: StopNodeRef | None = None,
    remove_stop_id: str | None = None,
    inserted_dwell_seconds: float | None = None,
) -> StopImpactResult:
    """
    Compare baseline trip time against a proposed one-stop edit.
    """
    baseline_result = compute_trip_time(graph, baseline_stops, dwell_seconds)

    proposed: list[StopNodeRef]
    if action == "insert":
        if inserted is None or after_stop_id is None:
            raise ValueError("insert requires inserted + after_stop_id")
        proposed = []
        placed = False
        for s in baseline_stops:
            proposed.append(s)
            if not placed and s.stop_id == after_stop_id:
                proposed.append(inserted)
                placed = True
        if not placed:
            raise ValueError(f"after_stop_id={after_stop_id!r} not in baseline stop list")
    elif action == "remove":
        if remove_stop_id is None:
            raise ValueError("remove requires remove_stop_id")
        proposed = [s for s in baseline_stops if s.stop_id != remove_stop_id]
        if len(proposed) == len(baseline_stops):
            raise ValueError(f"remove_stop_id={remove_stop_id!r} not in baseline stop list")
        if len(proposed) < 2:
            raise ValueError("removing this stop would leave fewer than two stops")
    else:
        raise ValueError(f"unknown action {action!r}")

    dwell_overrides: dict[str, float] = {}
    if action == "insert" and inserted_dwell_seconds is not None and inserted is not None:
        dwell_overrides[inserted.stop_id] = inserted_dwell_seconds

    proposed_result = compute_trip_time(
        graph, proposed, dwell_seconds, dwell_by_stop_id=dwell_overrides,
    )

    # Align downstream shift by stop_id — report all stops present in both.
    baseline_by_id = {s["stop_id"]: s for s in baseline_result.stops}
    downstream_shift: list[dict] = []
    for p in proposed_result.stops:
        sid = p["stop_id"]
        if sid in baseline_by_id:
            b = baseline_by_id[sid]
            downstream_shift.append({
                "stop_id": sid,
                "name": p["name"],
                "baseline_seconds": b["cumulative_seconds"],
                "proposed_seconds": p["cumulative_seconds"],
                "delta_seconds": p["cumulative_seconds"] - b["cumulative_seconds"],
            })

    return StopImpactResult(
        action=action,
        baseline_total_s=baseline_result.total_s,
        proposed_total_s=proposed_result.total_s,
        delta_s=proposed_result.total_s - baseline_result.total_s,
        downstream_shift=downstream_shift,
        comfort_index_baseline=baseline_result.comfort_index,
        comfort_index_proposed=proposed_result.comfort_index,
        assumptions={
            **baseline_result.assumptions,
            "inserted_dwell_seconds": (
                inserted_dwell_seconds if inserted_dwell_seconds is not None else dwell_seconds
            ) if action == "insert" else None,
        },
    )
