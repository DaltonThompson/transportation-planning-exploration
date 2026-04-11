"""Shared test fixtures for simulation and API contract tests."""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from graph.loader import (
    EdgeRecord,
    GraphState,
    _compute_turn_weights,
    _seed_background_flow,
)


def make_graph() -> GraphState:
    """
    Synthetic OSM graph: cyclic 0→1→2→3→0 with branch 1→4→0.
    10 nodes, 6 edges. Fully deterministic — no external downloads.
    """
    nodes = {
        0: {"x": 0.0,  "y": 0.0},
        1: {"x": 0.01, "y": 0.0},
        2: {"x": 0.02, "y": 0.0},
        3: {"x": 0.03, "y": 0.0},
        4: {"x": 0.01, "y": 0.01},
    }

    def _edge(u: int, v: int) -> EdgeRecord:
        return EdgeRecord(
            u=u, v=v, key=0,
            length_m=1000.0,
            speed_limit_ms=14.0,
            capacity=2.0,
            lanes=1,
            highway="primary",
            road_name="",
            has_passing_lane=False,
            current_speed_ms=14.0,
        )

    edges = [
        _edge(0, 1),  # 0
        _edge(1, 2),  # 1
        _edge(2, 3),  # 2
        _edge(1, 4),  # 3 branch
        _edge(3, 0),  # 4 close main cycle
        _edge(4, 0),  # 5 close branch
    ]
    edge_index = {
        (0, 1, 0): 0, (1, 2, 0): 1, (2, 3, 0): 2,
        (1, 4, 0): 3, (3, 0, 0): 4, (4, 0, 0): 5,
    }
    node_out_edges = {0: [0], 1: [1, 3], 2: [2], 3: [4], 4: [5]}

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
