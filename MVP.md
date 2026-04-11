# Transportation Policy Evaluation Engine — MVP Architecture (LOCKED)

---

# 1. System Overview

A deterministic, sequential dual-run simulation system that:

- Loads a real city road graph (OSM-derived via osmnx)
- Loads transit network from GTFS feeds
- Runs baseline simulation, then scenario simulation independently
- Models traffic as aggregate edge flow with congestion and transit effects
- Emits keyframes every 30 seconds for frontend playback
- Computes comparative mobility deltas
- Syncs GTFS feeds and reports metric changes to a changelog

---

# 2. Core Architecture

```
OSM Data + GTFS Feeds
         ↓
Graph Builder (nodes / edges) + Transit Network Loader
         ↓
Scenario Patcher (deterministic patches)
         ↓
  Baseline Simulation  →  Scenario Simulation  (sequential)
         ↓                        ↓
         └────────────┬───────────┘
                      ↓
           Metrics Engine + Comparison
                      ↓
           Keyframe Exporter + Changelog
                      ↓
           Frontend Playback UI
```

---

# 3. Simulation Core (LOCKED)

## Time Model

- Fixed timestep: 5 seconds (internal)
- Keyframe output: every 30 seconds
- Default duration: 60 minutes (configurable up to 120 minutes)
- Deterministic updates

---

## Simulation Mode

- Sequential dual-run:
  - Run A = baseline (runs to completion first)
  - Run B = scenario (runs after baseline, using same initial conditions)
- No shared runtime state between runs

---

## Flow Model

Traffic is modeled as aggregate flow rates on edges, not individual vehicles.
All simulation state is held in memory. No database queries during the timestep loop.

**Constants:**
```
DECAY_FACTOR = 0.95       # per 5-second timestep; flow exits edges naturally
CONGESTION_FLOOR = 0.2    # minimum speed = 20% of speed_limit
```

**Per timestep, per edge:**
```
turn_weight(e) = cos(angle_to_e / 2), normalized across downstream edges
inflow         = Σ outflow(upstream_edge) × turn_weight(this_edge)
outflow        = min(flow_rate, capacity) × DECAY_FACTOR
flow_rate      = flow_rate + inflow − outflow + transit_injection
congestion_factor = max(CONGESTION_FLOOR, 1 − flow_rate / capacity)
current_speed  = speed_limit × congestion_factor
```

**Turn probability heuristic:**
Weight each downstream edge by `cos(turn_angle / 2)`, normalized to sum to 1.
Straight-ahead (~0°) receives ~2x the weight of a 90° turn.
U-turns excluded. No external turning count data required.

**Initial flow seeding:**
At simulation start, assign background traffic to each edge:
```
flow_rate = capacity × 0.15 × road_class_factor
```
Road class factors: motorway=0.60, trunk=0.50, primary=0.40,
secondary=0.25, tertiary=0.15, residential=0.10.
Represents off-peak background traffic. Ensures baseline and scenario diverge meaningfully.

---

## Scale Constraints

- Nodes: 5,000 – 50,000
- Edges: proportional to node count
- Timestep: 5 seconds (internal), 30-second keyframes
- Duration: 60 minutes default (configurable)
- Expected runtime: ~2 seconds total for both runs at 10k edges

---

# 4. Data Model

## Graph

- Nodes = intersections / stops
- Edges = road segments

Edge fields:
- `osmid` — OSM way ID
- `length` — meters
- `speed_limit` — km/h (from OSM maxspeed tag, or OSRM class default)
- `capacity` — vehicles/timestep (estimated from lanes and road class)
- `has_passing_lane` — boolean
- `highway` — OSM highway class (motorway, primary, residential, etc.)
- `flow_rate` — simulation state
- `congestion_factor` — simulation state
- `current_speed` — simulation state

---

## Stop

- node-based (snapped to nearest OSM node within 100m)
- `dwell_base` — seconds
- `scheduled_interval_seconds` — derived from GTFS headway
- `load_factor_modifier` — synthetic passenger load effect on dwell

Transit stops inject flow onto adjacent edges at each scheduled interval.
During dwell, outflow on the adjacent edge is temporarily reduced.

---

## Scenario

A deterministic set of patches applied to the base graph and transit network before simulation.

**Graph patches:**
- edge speed change
- edge capacity change
- lane toggle (`has_passing_lane`)

**Transit infrastructure patches:**
- add / remove / modify bus or rail route
- add / remove / modify stop location
- change headway or service frequency
- change route type (e.g. local → BRT)

Patches are stored as an ordered list. Applied sequentially at scenario load time.

---

# 5. Simulation Behavior

## Flow Propagation Model

```
per timestep, per edge:
  turn_weight(e) = cos(angle_to_e / 2), normalized across downstream edges of junction
  inflow         = Σ outflow(upstream) × turn_weight(this_edge)
  outflow        = min(flow_rate, capacity) × DECAY_FACTOR
  flow_rate      = flow_rate + inflow − outflow + transit_injection
  congestion_factor = max(0.2, 1 − flow_rate / capacity)
  current_speed  = speed_limit × congestion_factor
```

Implemented as vectorized numpy operations over all edges simultaneously.

---

## Congestion Model

- Edge flow tracked per timestep via numpy arrays
- `congestion_factor` slows all flow on edge
- Hard floor: 0.2 (no edge drops below 20% of speed limit)

---

## Transit Model

```
dwell_time = dwell_base + load_factor_modifier
```

- Fixed routes loaded from GTFS
- At each `scheduled_interval_seconds`, stop injects `transit_flow_injection` onto adjacent edges
- During `dwell_time`, adjacent edge `outflow` is reduced by `dwell_reduction_factor`
- `has_passing_lane = true` bypasses dwell reduction (vehicles pass the stopped bus)
- No demand simulation in MVP

---

## Lane Model (Minimal)

- `has_passing_lane` boolean per edge
- When true: transit dwell does not reduce edge outflow
- Represents dedicated bus lanes, turning lanes, or parallel travel paths

---

# 6. Output System

## Keyframe Export

Emitted every 30 seconds of simulated time. Diff-encoded: only edges that changed
beyond a threshold from the previous keyframe are included.

```
keyframe:
  t              — simulated timestamp (seconds from start)
  edges[]        — only edges with |delta| > 0.01 since last keyframe
    id           — edge index
    f            — flow_rate (3 decimal places)
    c            — congestion_factor (3 decimal places)
    s            — current_speed (1 decimal place)
  transit[]      — active stop states
    stop_id
    dwell_active
    next_departure_seconds
```

First keyframe is always a full snapshot (no diff). Frontend reconstructs full state
by applying diffs sequentially from the initial full frame.

---

## Metrics Output

```
metrics:
  travel_time_delta    — % change in mean edge travel time (scenario vs baseline)
  congestion_delta     — % change in mean congestion_factor
  transit_time_delta   — % change in cumulative dwell time on transit edges
  delay_delta          — % change in edges operating below 50% of speed_limit
```

---

## Changelog Output

```
changelog_entry:
  timestamp
  trigger          — 'gtfs_sync' | 'manual_scenario_edit'
  feed_slug        — GTFS source slug (if sync-triggered)
  affected_routes  — route IDs impacted
  metric_deltas    — before/after for each metric per affected scenario
  summary          — human-readable description of what changed
```

---

## Comparison Rule

```
delta = scenario_metric − baseline_metric
```

---

# 7. Frontend Architecture

## Responsibilities

Frontend ONLY:
- renders keyframes as edge flow heatmap
- interpolates between keyframes for smooth playback
- plays timeline
- shows metric deltas
- compares baseline vs scenario side-by-side

---

## Components

- **Map Renderer** — Leaflet edge heatmap, color-coded by `congestion_factor`
- **Timeline Controller** — play/pause/scrub/speed; interpolates between 30s keyframes
- **Comparison Panel** — baseline vs scenario metric deltas
- **Particle Layer** (optional) — synthetic particles moving along edges proportional to flow, for visual effect only; not tied to simulation state

---

## Forbidden in Frontend

- simulation logic
- flow computation
- congestion modeling
- routing of any kind

---

# 8. Scenario System

Pipeline:
```
Base Graph + Live GTFS Network
→ Apply Scenario Patches (graph topology + transit infrastructure)
→ Run Baseline Simulation (flow model, sequential first)
→ Run Scenario Simulation (flow model, sequential second)
→ Compute Deltas
→ Store Keyframes
→ Append to Changelog
```

Scenarios are named, stored, and forkable. Each scenario stores its patch list;
the resolved network is computed at run time, not stored.

---

# 9. GTFS Sync

## Purpose

Keeps the simulation's transit network current with real-world feed data.
When a feed updates, affected scenarios are automatically re-simulated
and metric changes are reported to the changelog.

## Pipeline

1. Download GTFS zip from configured feed URL
2. SHA-256 hash — skip if feed unchanged since last sync
3. Diff routes and stops against current network state
4. Apply changes to base network (feed-sourced entities only)
5. Snap new/moved stops to nearest OSM node (100m threshold)
6. Identify all scenarios whose patches touch affected routes or stops
7. Re-run baseline + scenario simulations for each affected scenario
8. Compute new deltas; compare to previous run's deltas
9. Append changelog entry for each scenario with changed outcomes

## Schedule

- Configurable per feed: daily (4am ET) or weekly (Sunday 3am ET)
- Manual trigger: `POST /api/feeds/{slug}/sync`

## Changelog entry fields

See Section 6 — Changelog Output

---

# 10. Metrics System

## Operational Metrics

- travel time (mean edge travel time = edge length / current_speed)
- delay (deviation from free-flow: travel_time / (length / speed_limit) − 1)
- congestion (mean congestion_factor across all non-residential edges)
- transit travel time (cumulative dwell time on transit-adjacent edges)
- dwell contribution (isolated impact: transit run minus equivalent non-transit run)

---

## Comparative Metrics

- % change per metric (scenario vs baseline)
- per-edge flow delta (for heatmap diff view)
- system-wide aggregates

---

# 11. Performance Constraints

Simulation target: **O(E) per timestep** — edge state updates only, no routing.

With numpy vectorized operations over 10k edges:
- ~0.3–1ms per timestep
- 720 timesteps (60 min at 5s) ≈ 0.7–1 second per run
- Both runs complete in ~2 seconds total

Constraints:
- No per-edge database queries during timestep loop
- No graph rebuilding per frame
- No shared state between baseline and scenario runs
- All simulation state held in memory; database accessed only at load time and output time

---

# 12. MVP Success Criteria

The MVP is successful if:

- City graph loads from OSM via osmnx for Albany County, NY
- CDTA GTFS feed loads and populates transit routes and stops
- GTFS stops snap to OSM nodes correctly (>90% within 100m)
- Baseline simulation runs with flow propagation; initial seeding produces non-zero flow
- Scenario patches modify graph topology and/or transit infrastructure
- Scenario simulation differs measurably from baseline
- Meaningful metric deltas are produced
- Frontend visualizes edge flow heatmap with 30-second keyframe playback
- GTFS sync updates base network and triggers re-simulation of affected scenarios
- Changelog records metric changes from feed updates and manual edits
- All unit tests pass (see Section 14)

---

# 13. Core Principle

It is a tool for exploring what happens to bus service when routes, stops, or schedules change.

---

# 14. Testing Suite

## Unit tests (simulation correctness)

- **Flow conservation**: total `outflow` across all edges per timestep ≈ total `inflow` + seeded background − decayed flow. No phantom flow created or destroyed.
- **Congestion floor**: assert no edge's `congestion_factor` ever falls below 0.2 at any timestep.
- **Determinism**: two runs with identical graph and scenario inputs produce bit-identical keyframe arrays.
- **Dwell impact**: a stop added to an edge reduces mean `outflow` on that edge during dwell windows vs the same edge without the stop.
- **Scenario isolation**: modifying the scenario graph object does not alter the baseline graph object (deep copy verification).
- **Turn weight normalization**: for any junction, sum of turn weights across all downstream edges = 1.0.
- **Initial seeding**: after seeding, all edges have `flow_rate > 0`; motorway edges have higher flow than residential edges.

## Integration tests

- Full simulation run completes without error on Albany OSM extract + CDTA GTFS
- `POST /api/runs` returns `{run_id, status: "running"}`; polling `GET /api/runs/{id}` reaches `status: "complete"` within 30 seconds
- Frame diff reconstruction: applying all diff keyframes sequentially to the initial full frame produces the correct final state
- GTFS sync: syncing CDTA feed with a known stop change updates stop count and marks affected scenarios for re-simulation

## Snapshot tests

- Keyframe output schema is stable across refactors (required keys: `t`, `edges`, `transit`)
- Metrics output always includes all four delta fields

---

# 15. Data Sources

## OSM Road Graph

- **Source**: `osmnx.graph_from_place("Albany County, New York, USA", network_type="drive")`
- **Fallback**: Geofabrik NY state extract filtered to Albany County bbox (`https://download.geofabrik.de/north-america/us/new-york.html`)
- **Edge speed defaults** (when OSM `maxspeed` absent): OSRM car.lua profile values:

| Road class | Speed (km/h) |
| ---------- | ------------ |
| motorway   | 90           |
| trunk      | 85           |
| primary    | 65           |
| secondary  | 55           |
| tertiary   | 40           |
| residential | 25          |
| living_street | 10        |

## Transit Feeds

| Feed | URL | Sync schedule |
| ---- | --- | ------------- |
| CDTA static GTFS | https://www.cdta.org/schedules/google_transit.zip | Weekly |
| CDTA GTFS-RT vehicles | http://gtfs.cdta.org:8080/gtfsrealtime/VehiclePositions | Real-time (validation only) |
| CDTA GTFS-RT trips | http://gtfs.cdta.org:8080/gtfsrealtime/TripUpdates | Real-time (validation only) |

## Traffic Flow Calibration (optional, for validation)

- **NY State DOT Traffic Data Viewer** (`https://www.dot.ny.gov/tdv`) — free AADT per road for New York; use to validate that seeded flow rates are plausible on Albany corridors.
- **FHWA HPMS** (`https://data.transportation.gov`) — national NHS AADT, free; use for major highway calibration.
- **NPMRDS** (`npmrds.ritis.org`) — 5-minute speed intervals, free with Data Sharing Agreement; use to validate simulated congestion patterns against real time-of-day speed profiles.

## Turning Movement Counts

No free national dataset available. REPLICA and StreetLight Data provide turning movement counts commercially. MVP uses angle-continuity heuristic (see Section 3). Document this as a known approximation in simulation output.

---

# 16. Technology Stack

| Component | Choice | Version |
| --------- | ------ | ------- |
| OSM graph loading | `osmnx` | 2.0+ |
| GTFS parsing | `gtfs-kit` | 12.0+ |
| Flow simulation | `numpy` | 1.26+ |
| REST API | `FastAPI` | 0.110+ |
| ASGI server | `uvicorn` | 0.29+ |
| Frontend map | `Leaflet` + React 18 | — |
| Frontend state | Zustand | 4+ |
| Frontend data fetching | React Query | 3+ |

**Why Python for backend**: osmnx has no Node.js equivalent; numpy provides ~150x speedup over Python loops for vectorized edge updates; gtfs-kit is the most actively maintained GTFS parser.

**Why FastAPI**: Built-in `BackgroundTasks` for non-blocking simulation runs; automatic OpenAPI docs; async-native for I/O; cleaner than Flask for this use case.

**Simulation performance**: With numpy, both runs complete in ~2 seconds. No job queue (Celery, Redis) needed for MVP.

---

# 17. API Spec

```
# Graph
GET  /api/graph                     node/edge counts, bbox, osm_loaded_at
POST /api/graph/reload              re-import from OSM (admin)

# GTFS feeds
GET  /api/feeds                     list configured feeds + last_sync_at
POST /api/feeds/{slug}/sync         manual sync trigger → { job_id }

# Scenarios
GET  /api/scenarios                 list scenarios (name, patch_count, last_run_at)
POST /api/scenarios                 create { name, patches[] }
GET  /api/scenarios/{id}            scenario detail + full patch list
PATCH /api/scenarios/{id}           update name or patches
DELETE /api/scenarios/{id}          soft delete

# Simulation runs
POST /api/runs                      trigger { scenario_id }
                                    → { run_id, status: "running" }
GET  /api/runs/{id}                 { status, progress_pct, started_at, metrics? }
GET  /api/runs/{id}/frames          all keyframes, diff-encoded
                                    ?baseline=true  returns baseline frames
GET  /api/runs/{id}/metrics         { travel_time_delta, congestion_delta,
                                      transit_time_delta, delay_delta }
GET  /api/runs/{id}/changelog       changelog entries produced by this run

# Changelog
GET  /api/changelog                 all entries, newest first
                                    ?trigger=gtfs_sync|manual_scenario_edit
                                    ?scenario_id={id}
```

All mutation endpoints return the updated resource. Errors return `{ error, request_id }`.

---

# 18. Build Phases

### Phase 1 — Graph loading
- osmnx graph extraction for Albany County
- Edge attribute normalization (speed, capacity from road class)
- Background flow seeding
- Unit: seeding produces plausible flow values per road class

### Phase 2 — GTFS loading + stop snapping
- gtfs-kit GTFS parse
- Stop → OSM node snapping via `nearest_nodes()` with 100m threshold
- Headway → `scheduled_interval_seconds` computation
- Unit: >90% of CDTA stops snap within 100m

### Phase 3 — Flow simulation engine
- numpy edge state arrays
- Timestep loop with turn-weighted inflow, decay outflow, congestion
- Transit injection and dwell reduction
- Unit: all simulation correctness tests pass

### Phase 4 — Keyframe export + diff encoding
- 30-second keyframe emission
- Diff encoding against previous keyframe
- Initial full-snapshot frame
- Unit: diff reconstruction test passes

### Phase 5 — Scenario patch engine
- Patch data model (graph patches + transit patches)
- Deep copy of base graph before applying patches
- Unit: scenario isolation test passes

### Phase 6 — Dual sequential runner + metrics
- Baseline run → scenario run → delta computation
- `POST /api/runs` + background thread + in-process state store
- Unit: determinism test passes; metrics computed correctly

### Phase 7 — GTFS sync + changelog
- SHA-256 dedup, diff-and-apply pipeline
- Affected scenario detection and re-simulation
- Changelog entry generation

### Phase 8 — Frontend
- React + Leaflet edge heatmap
- 30-second keyframe playback with interpolation
- Timeline controller
- Metric delta comparison panel
