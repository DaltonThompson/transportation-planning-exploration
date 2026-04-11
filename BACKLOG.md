# Transportation Policy Evaluation Engine — Backlog

Post-MVP enhancements are sequenced in `ROADMAP.md`. This file holds
technical notes referenced from the roadmap that are too detailed to
inline there.

---

## Background Flow Seeder Limitation

`graph/loader.py` — `_seed_background_flow()` sets:

```python
edge.background_flow_rate = edge.flow_rate * settings.DECAY_FACTOR
```

This is designed to compensate for the decay each timestep so isolated edges
hold a steady-state flow level. However it does not account for upstream
inflow: on edges in a cycle, circulating inflow already provides the same
replenishment. Background injection is therefore double-counted on those
edges, causing flow to grow above the seeded level until edges saturate at
capacity.

**Symptoms:** In `test_flow_conservation_approximate`, the test had to zero
`background_flow_rate` to prevent unbounded growth in the cyclic test graph.
In the real Albany network, most edges are in a connected graph, so the same
over-injection occurs. The practical effect is muted because flow is capped at
`capacity`, but steady-state congestion levels are higher than intended.

**Fix:** The seeder should estimate expected upstream inflow for each edge
(from its `turn_weights` and the flow of predecessor edges) and set
`background_flow_rate = max(0, flow_rate * DECAY_FACTOR - expected_inflow)`.
This requires one additional traversal over the graph after the initial
`_compute_turn_weights` pass. Alternatively, zero `background_flow_rate` for
edges that have upstream neighbours, and only inject on true source edges
(entry points to the network with no in-edges). Either approach requires
validation against the real Albany graph to confirm steady-state levels are
reasonable.

**Priority:** Low. The current behavior produces plausible-looking congestion
maps and the simulation's purpose is comparing deltas, not absolute values.
The bug affects both baseline and scenario runs equally, so the delta is
unaffected unless a patch changes the topology (adds/removes nodes). Fix
before using absolute congestion values for any external reporting.

---

## Smooth Animation Rationale

Keyframes are emitted every 30 simulated seconds. The current timeline steps
discretely between them — no interpolation of intermediate states.

**Where interpolation would be meaningless:** The simulation's fundamental unit
is aggregate edge flow, not vehicles. Between keyframes the model says nothing
about intermediate states — they're not computed, stored, or meaningful.
Interpolating `congestion_factor` from 0.6 at t=30s to 0.7 at t=60s doesn't
describe what the model says happened at t=45s; it describes what a lerp
*guesses*. For a policy evaluation tool, manufactured data presented as
simulation output is a liability, not a feature.

**Where interpolation would be valuable:** Purely as visual presentation. When
presenting findings to stakeholders — walking through how a scenario change
builds congestion on a corridor over 60 minutes — abrupt 30-second frame jumps
are visually jarring and undermine the narrative. A smooth animation conveys
the *sense* of gradual change, which is accurate even if the exact intermediate
values aren't. Interpolation as a rendering artifact is fine; interpolation
represented as simulation precision is not.

**Decision:** Opt-in toggle in `TimelineController` — "Smooth animation" vs.
the default "Exact keyframes." Off by default so the standard presentation is
honest about model resolution. When enabled, lerp `congestion_factor` and
`flow_rate` per edge between consecutive keyframe values using
`requestAnimationFrame`.
