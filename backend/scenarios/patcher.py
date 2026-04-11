"""
Phase 5: Scenario patch engine.

A scenario is a named set of deterministic patches. Each patch modifies one
attribute of an edge or stop. Patches are applied to a deep copy of the graph
and stop list so that the baseline is never mutated.

Supported patch types:
  edge_speed      — change speed_limit_ms on an edge
  edge_capacity   — change capacity on an edge
  edge_lanes      — change lanes / has_passing_lane
  stop_add        — inject a new TransitStop
  stop_remove     — remove a stop by stop_id
  stop_headway    — change scheduled_interval_seconds for a stop
  route_headway   — change headway for all stops on a route prefix
"""

import copy
import logging
from dataclasses import dataclass, field
from typing import Any, Literal

from graph.loader import EdgeRecord, GraphState
from simulation.engine import TransitStop

logger = logging.getLogger(__name__)

PatchType = Literal[
    "edge_speed",
    "edge_capacity",
    "edge_lanes",
    "stop_add",
    "stop_remove",
    "stop_headway",
    "route_headway",
]


@dataclass
class Patch:
    type: PatchType
    # For edge patches: edge (u, v, key) tuple or edge simulation index
    edge_key: tuple[int, int, int] | None = None
    # For stop patches
    stop_id: str | None = None
    route_prefix: str | None = None
    # New value
    value: Any = None


@dataclass
class Scenario:
    id: str
    name: str
    patches: list[Patch] = field(default_factory=list)
    parent_id: str | None = None


def apply_scenario(
    graph: GraphState,
    transit_stops: list[TransitStop],
    scenario: Scenario,
) -> tuple[GraphState, list[TransitStop]]:
    """
    Apply *scenario* patches to deep copies of *graph* and *transit_stops*.

    Returns modified (patched_graph, patched_stops). The originals are
    untouched — baseline state is preserved.
    """
    patched_graph = copy.deepcopy(graph)
    patched_stops = copy.deepcopy(transit_stops)

    for patch in scenario.patches:
        _apply_patch(patched_graph, patched_stops, patch)

    return patched_graph, patched_stops


def _apply_patch(
    graph: GraphState,
    stops: list[TransitStop],
    patch: Patch,
) -> None:
    if patch.type == "edge_speed":
        edge = _resolve_edge(graph, patch)
        if edge:
            edge.speed_limit_ms = float(patch.value) / 3.6  # input in km/h
            edge.current_speed_ms = edge.speed_limit_ms * edge.congestion_factor

    elif patch.type == "edge_capacity":
        edge = _resolve_edge(graph, patch)
        if edge:
            edge.capacity = float(patch.value)

    elif patch.type == "edge_lanes":
        edge = _resolve_edge(graph, patch)
        if edge:
            edge.lanes = int(patch.value)
            edge.has_passing_lane = edge.lanes > 1

    elif patch.type == "stop_remove":
        stops[:] = [s for s in stops if s.stop_id != patch.stop_id]

    elif patch.type == "stop_add":
        # value should be a TransitStop dict or object
        if isinstance(patch.value, TransitStop):
            stops.append(patch.value)
        elif isinstance(patch.value, dict):
            stops.append(TransitStop(**patch.value))

    elif patch.type == "stop_headway":
        for s in stops:
            if s.stop_id == patch.stop_id:
                s.scheduled_interval_seconds = float(patch.value)

    elif patch.type == "route_headway":
        prefix = patch.route_prefix or ""
        count = 0
        for s in stops:
            if s.stop_id.startswith(prefix):
                s.scheduled_interval_seconds = float(patch.value)
                count += 1
        logger.debug("route_headway patch matched %d stops with prefix '%s'", count, prefix)

    else:
        logger.warning("Unknown patch type: %s", patch.type)


def _resolve_edge(graph: GraphState, patch: Patch) -> EdgeRecord | None:
    if patch.edge_key is None:
        logger.warning("Patch has no edge_key")
        return None
    key = tuple(patch.edge_key)
    # Single-element key → direct simulation index
    if len(key) == 1:
        idx = int(key[0])
        if 0 <= idx < len(graph.edges):
            return graph.edges[idx]
        logger.warning("Patch edge index %d out of range (%d edges)", idx, len(graph.edges))
        return None
    # Three-element key → OSM (u, v, key) tuple
    idx = graph.edge_index.get(key)
    if idx is not None:
        return graph.edges[idx]
    logger.warning("Patch references unknown edge: %s", patch.edge_key)
    return None
