"""
Phase 3: Static routing.

Used exclusively to snap GTFS routes onto the OSM graph — not for individual
vehicle routing. Finds the shortest-path sequence of OSM edges between two
nodes and returns the edge indices. Results are cached.
"""

import heapq
import logging
from functools import lru_cache

from graph.loader import GraphState

logger = logging.getLogger(__name__)


def shortest_path_edges(
    graph: GraphState,
    source_node: int,
    target_node: int,
) -> list[int]:
    """
    Dijkstra shortest path from *source_node* to *target_node*.
    Returns an ordered list of edge indices (simulation ids).
    Returns [] if no path exists.
    """
    if source_node == target_node:
        return []

    # dist maps node → (distance, prev_node, edge_index_used)
    dist: dict[int, float] = {source_node: 0.0}
    prev: dict[int, tuple[int, int]] = {}  # node → (prev_node, edge_idx)
    heap: list[tuple[float, int]] = [(0.0, source_node)]

    while heap:
        d, u = heapq.heappop(heap)
        if d > dist.get(u, float("inf")):
            continue
        if u == target_node:
            break
        for edge_idx in graph.node_out_edges.get(u, []):
            e = graph.edges[edge_idx]
            # Cost = travel time at free-flow speed
            cost = e.length_m / max(e.speed_limit_ms, 0.1)
            nd = d + cost
            if nd < dist.get(e.v, float("inf")):
                dist[e.v] = nd
                prev[e.v] = (u, edge_idx)
                heapq.heappush(heap, (nd, e.v))

    if target_node not in prev and target_node != source_node:
        logger.debug("No path from %d to %d", source_node, target_node)
        return []

    # Reconstruct path
    path_edges: list[int] = []
    cur = target_node
    while cur in prev:
        _, edge_idx = prev[cur]
        path_edges.append(edge_idx)
        cur = prev[cur][0]

    path_edges.reverse()
    return path_edges
