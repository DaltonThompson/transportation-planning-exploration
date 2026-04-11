# Transportation Policy Evaluation Engine — Roadmap

> **Core principle:**
> A tool for exploring what happens to bus service when routes, stops, or
> schedules change.
>
> Simulation of traffic dynamics is deferred until the model can account for
> behavioral response — mode shift, induced demand, and network effects — without
> which the numbers mislead more than they inform.

---

## Current State (Phases 9A, 9B, 9C & 10 complete)

Phases 1–10 of `MVP.md §18` are built and running:

- OSM graph loaded for Albany, Rensselaer, and Schenectady Counties
- CDTA and Amtrak GTFS feeds loaded; stops snapped to OSM nodes; daily/weekly scheduled re-sync via APScheduler
- Dual-run deterministic simulation (baseline → scenario → delta)
- Keyframe export (30s interval, diff-encoded)
- Scenario CRUD with patch editor; soft-delete and fork endpoints implemented; `parent_id` tracked
- Metric deltas: travel time, congestion, transit dwell, **excess delay** (all four metrics complete)
- Concurrent run guard: `POST /api/runs` returns 409 if a run is already active
- Frontend: Leaflet edge heatmap with OSM curved geometry, timeline playback, comparison panel
- Comparison panel: all four metrics displayed; model scope disclaimer (mode shift / induced demand not modeled)
- Changelog panel: accessible via collapsible "RUN HISTORY" in comparison panel
- Layer overlays: bus routes + CDTA divisions, rail, bike infrastructure, stops,
  walking isochrones, collisions, zoning, jobs/LODES, population density
- SQLite persistence: scenarios, runs, and zlib-compressed keyframes survive server restart; one-time migration from legacy JSON
- LRU keyframe eviction: max 3 runs in memory (`LRU_MAX_RUNS`); frames lazy-loaded from SQLite on cache miss
- Graph fingerprint: stale runs flagged on startup if OSM graph changes; `stale` field on `GET /api/runs/{id}`
- Read-only scenario sharing: `GET /api/share/{run_id}` → shareable URL (`/?run=<id>`); frontend read-only view hides scenario editor
- Unit tests: 24/24 passing (8 original + 4 regression + 11 contract + 1 fixture)
- CI: `.github/workflows/ci.yml` — `backend-tests` and `frontend-build` jobs run in parallel on every push

Known open issues are tracked in `BACKLOG.md`. The sections below sequence
what to build next and why.

---

## Phase 9A — Correctness Fixes ✓ Complete

| Item | Status |
| --- | --- |
| **Concurrent run guard** | `run_in_progress` flag on `AppState`; 409 on contention; cleared in `finally` |
| **`run_id` on changelog entries** | Was already present — confirmed |
| **`parent_id` on scenarios** | Added to `Scenario` dataclass; persisted to JSON; fork endpoint added |
| **Delay delta metric** | `mean_excess_delay` in engine; `delay_delta_pct` in `MetricDeltas` and all API responses |
| **Scheduled GTFS Sync** | APScheduler: CDTA daily 03:00, other feeds weekly Sunday 03:30 |

---

## Phase 9B — MVP Polish ✓ Complete

| Item | Status |
| --- | --- |
| **OSM curved road geometry** | `e.coords_latlon` path in `/api/graph/edges`; straight-line fallback removed |
| **Changelog panel wired into layout** | `ChangelogPanel` renders inside `ComparisonPanel` as collapsible "RUN HISTORY" |
| **Scenario forking** | `POST /api/scenarios/{id}/fork`; `api.forkScenario()` client method; `⧉` button in sidebar |
| **Unit tests against installed environment** | 9/9 pass (`pytest tests/` in venv) |
| **Mode shift scope disclaimer** | Visible notice box in `ComparisonPanel` below metrics |

---

## Phase 9C — CI & Test Foundation ✓ Complete

| Item | Status |
| --- | --- |
| **CI workflow** | `.github/workflows/ci.yml`: `backend-tests` + `frontend-build` run in parallel on every push; hard-block on failure |
| **Synthetic graph fixture** | `tests/fixtures/__init__.py`: 6-edge cyclic graph; no network calls; shared by all test files |
| **Simulation regression tests** | `tests/test_regression.py`: 4 tests pinning exact delta values (to `1e-9`), keyframe structure, dual-run determinism, zero-delta for no-op scenarios |
| **API contract tests** | `tests/test_api_contracts.py`: 11 tests covering `GET /api/graph/edges`, scenario CRUD, `POST /api/runs`, `GET /api/runs/{id}` metrics keys; `TestClient` with pre-populated `app_state` — no OSM/GTFS I/O |
| **Total passing tests** | 24/24 in 2.33 s |

---

## Phase 10 — Persistence ✓ Complete

### 10A. SQLite Persistence ✓

| Item | Status |
| --- | --- |
| **`db/store.py`** | WAL-mode SQLite; `meta`, `scenarios`, `runs`, `keyframes` tables; `zlib.compress` on keyframe payloads (level 6) |
| **Schema deviation from spec** | `keyframes` PK is `(run_id, run_type, t)` — stores both `baseline` and `scenario` frames in one table |
| **`config.DB_PATH`** | Configurable file path (default `transport.db`); overridable via env var |
| **Startup load** | `init_db()` → `load_persisted_scenarios()` → `load_persisted_runs()`; run metadata rehydrated, keyframes not loaded until requested |
| **JSON migration** | On first run with empty DB and existing `data/scenarios.json`, scenarios are imported and the JSON file renamed to `.migrated` |

### 10B. LRU Keyframe Eviction ✓

| Item | Status |
| --- | --- |
| **`LRU_MAX_RUNS`** | Configurable (default 3); tracks which runs have frames in memory via `OrderedDict` |
| **Eviction** | Least-recently-used run's `baseline`/`scenario_result` set to `None`; `frames_in_db=True` preserved for reload |
| **Lazy load** | `GET /api/runs/{id}/frames` rehydrates both sides from SQLite on cache miss, then touches LRU |
| **`frames_available`** | New boolean field on `GET /api/runs/{id}` response |

### 10C. Read-Only Scenario Sharing ✓

| Item | Status |
| --- | --- |
| **`GET /api/share/{run_id}`** | Returns `{ run_id, scenario_name, share_url, stale, metrics }` |
| **`FRONTEND_URL`** | Configurable (default `http://localhost:3000`); used to build `share_url` |
| **Share URL format** | `{FRONTEND_URL}/?run={run_id}` |
| **Frontend read-only mode** | `App.tsx` reads `?run=` param on load; fetches run + frames + share descriptor; hides `ScenarioSidebar` |
| **Shared view banner** | "Shared view / scenario name / Copy link / Edit mode" — copy button uses Clipboard API; "Edit mode" strips `?run=` from URL |
| **Copy link in normal mode** | "Copy link" button appears in status bar once a run completes |
| **`stale` field** | Graph fingerprint stored in `meta` table; if fingerprint changes on restart, all complete runs marked stale; `stale: bool` exposed on `GET /api/runs/{id}` and share descriptor |

---

## Phase 11 — Hide Simulation UI

The simulation backend is preserved intact. No code is deleted. What changes is
exposure in the UI.

| Item | Notes |
| --- | --- |
| **Gate simulation controls** | `ScenarioSidebar`, `TimelineController`, `ComparisonPanel`, and the congestion heatmap hidden unless `?dev=true` query param is present or `VITE_SHOW_SIMULATION=true` env flag is set |
| **Remove from default nav** | "Run Simulation" button and scenario patch editor not visible in normal operation |
| **Status bar notice** | Single line: "Simulation features are under development" — no link required |

**Why:** The simulation UI currently implies analytical credibility the model
has not earned. Hiding it stops that implication without losing the work.

**Acceptance criteria:** Default load (no `?dev=true`, no env flag) shows no simulation controls in the DOM.

---

## Phase 12 — Schedule Arithmetic

> Answers: how long does this trip take, and how does that change if the
> proposal is adopted?

This phase operates entirely within GTFS and OSM geometry. No flow propagation.
No simulation run required. Every response surfaces its assumptions explicitly.

### 12A. Trip Time Estimation

Given a route and direction, compute end-to-end trip time and per-segment
travel time:

- **Segment travel time**: OSM edge speed × shape geometry distance between
  consecutive stops
- **Turn geometry correction**: at each vertex in the route shape, compute the
  interior angle between incoming and outgoing vectors. Sharper angles reduce
  speed. Severity tiers (< 90° severe, 90–135° moderate, > 135° gentle) map to
  speed reduction factors derived from TRB/TCRP literature on bus curve speeds.
  The correction is added to segment travel time and surfaced as a separate
  field so the contribution is visible.
- **Route comfort index**: aggregate of turn severities along a route (count by
  tier, mean angle). Useful for comparing a proposed reroute against the
  existing alignment — a reroute through a tighter street grid will show a
  worse comfort index even if the distance is similar.
- **Dwell time**: configurable constant per stop (default 30s); overridable per
  stop type
- **Cumulative trip time**: sum of segments + turn corrections + dwells from
  first to last stop

New endpoint: `GET /api/schedule/trip_time?route_id=&direction_id=`

Returns:
```json
{
  "stops": [{ "stop_id": "", "name": "", "cumulative_minutes": 0 }],
  "total_minutes": 0,
  "turn_penalty_minutes": 0,
  "comfort_index": { "severe": 0, "moderate": 0, "gentle": 0, "mean_angle_deg": 0 },
  "assumptions": { "dwell_seconds": 30, "speed_source": "osm_maxspeed", "turn_model": "tcrp_lookup" }
}
```

All estimates are labeled "geometry-based" in the UI. Turn model does not
account for signal timing, stop placement relative to intersections, or driver
behavior.

### 12B. Headway Impact

Given a headway change, compute:

- **Wait time delta**: `(new_headway - old_headway) / 2` — standard expected
  wait time formula
- **Total journey time delta**: wait delta + any dwell changes from stop
  additions

New endpoint: `GET /api/schedule/headway_impact?route_id=&new_headway_minutes=`

### 12C. Stop Addition / Removal Impact

Given a proposed stop insertion between two existing stops:

- Estimated added dwell time (configurable)
- Estimated added travel time from shape geometry detour (if reroute) or zero
  (if on-path)
- Turn geometry re-evaluated for any new shape segments introduced by the detour
- Impact on all downstream stops reported

New endpoint: `POST /api/schedule/stop_impact`. Request body (single stop op):

```json
{
  "route_id": "",
  "direction_id": 0,
  "action": "insert",
  "after_stop_id": "",
  "stop_id": "",
  "new_stop": { "lat": 0, "lon": 0, "name": "" }
}
```

`action` is `"insert"` or `"remove"`. For `insert`, provide either `stop_id`
(existing stop) or `new_stop` (ad-hoc location). For `remove`, provide
`stop_id`. Batch operations are out of scope — use Phase 13 proposal import
for multi-stop changes.

### 12D. Reliability Annotation from FY2025 Performance Data

Route-level on-time performance is already structured in
`frontend/src/utils/cdtaRoutes.ts` as `FY2025_PERFORMANCE`, keyed by
`route_short_name`. Each entry carries `otp: { onTime, early, late }` as
percentages. This is the data source — no ingestion step required.

**What it provides:**

Because the data is percentages only (not average minutes late), this cannot
revise published times. What it can do is annotate every schedule estimate with
a reliability profile drawn from observed FY2025 behavior:

- Trip time estimates from 12A display: "on-time 70% / early 6% / late 24%"
  sourced from FY2025 actuals
- Headway impact estimates from 12B carry the same annotation
- Routes with no OTP data (402, 404, 405, 407, 411, 412, 419 — no CAD/AVL
  installed) display: "No reliability data — CAD/AVL not installed on this
  route"
- Route 111 displays its note ("Eliminated Aug 2024") and annotation is shown
  as historical only

**Managed headway routes (905 & 910):**

Both routes carry `headwayManaged: true` in the existing data. For these routes:

- Do not display on-time/early/late percentages — the metric measures headway
  adherence, not schedule adherence, and is not comparable to fixed-schedule
  figures
- Display instead: "This route operates on managed headway — buses run at
  regular intervals rather than fixed arrival times"
- Schedule arithmetic reports expected wait time from headway only; no OTP
  annotation shown

**Backend exposure:**

The `FY2025_PERFORMANCE` data lives in the frontend utility file. For the
backend schedule endpoints (12A–12C) to include reliability annotations in
their responses, the data needs a backend representation. Options:

- Duplicate as a static Python dict in `schedule/performance.py` — simple,
  no sync risk since FY2025 is a fixed historical dataset
- Serve from the frontend file via a new `GET /api/schedule/reliability`
  endpoint that the frontend calls once and caches — avoids duplication

Prefer the static Python dict. FY2025 is frozen; it will not change. Sync
risk only exists for live data.

**Honest labeling:**

All reliability annotations must be visibly attributed: "FY2025 actuals
(CDTA)". Do not present them as predictive. A proposal that changes a route's
headway does not inherit the existing OTP figure — the annotation is for the
current route's historical performance, not a forecast of the proposed route's
performance.

### 12E. Schedule Arithmetic Tests

Unit tests for all three endpoints against the synthetic fixture graph. No
network calls. Results are deterministic given fixed dwell, speed, and turn
model assumptions.

---

## Phase 13 — Proposal Import

> Answers: what does this proposal actually look like on the map?

Transit agencies publish proposals in varying formats. This phase builds a
structured import pipeline that renders a proposed change as a distinct visual
layer — separate from the live GTFS feed.

### 13A. Generalize Share Infrastructure

Phase 10C's share table keys on `run_id`. Before proposal sharing (14A),
migrate to a unified `shares` table with a `kind` column (`run` | `proposal`)
and a generic `target_id`. Existing run shares migrated in place. All share
endpoints (`/api/share/{run_id}`, forthcoming `/api/proposals/{id}/share`)
read from the same table.

### 13B. GTFS Proposal Feed

Accept a GTFS zip upload (or URL) representing a proposed network state. Parse
it identically to the live feed loader but store under a `proposed` feed slug.
Does not overwrite the live feed.

- `POST /api/proposals` — accepts multipart GTFS zip or URL
- Proposal stored in SQLite with `proposal_id`, upload timestamp, name
- Routes, shapes, and stops parsed; stops snapped to OSM nodes
- `GET /api/proposals` — list proposals
- `DELETE /api/proposals/{id}` — soft delete

### 13C. Proposal Layer on Map

Render the proposed feed as a distinct overlay in `LayerPanel`:

- Proposed routes drawn in a visually distinct style (dashed, offset, or
  distinct color palette)
- Proposed stops marked differently from live stops (hollow circle vs filled)
- Toggle independently from live GTFS layers
- Clicking a proposed route shows: route name, stop count, estimated trip time
  (from 12A), comfort index

### 13D. Diff View: Proposed vs Live

Highlight what changed between the live feed and the proposal:

- **New stops**: green markers
- **Removed stops**: red markers with strikethrough label
- **New route segments**: green polyline
- **Removed route segments**: red dashed polyline
- **Modified headways**: amber indicator on affected routes

Diff is computed from GTFS data alone — no simulation.

### 13E. Proposal Schedule Summary

When a proposal is selected, show a summary panel:

- Routes added / removed / modified
- Net stop count change
- Estimated trip time delta for affected routes (from 12A/12B)
- Comfort index delta: does the proposal introduce more severe turns?
- Coverage change: stops within 400m of Census block centroids

---

## Phase 14 — Public Comment Surface

> Answers: how do members of the public engage with a proposal before it's
> adopted?

### 14A. Read-Only Proposal Share URL

A shareable URL that loads a specific proposal layer in read-only mode:

- `GET /api/proposals/{id}/share` → `{ proposal_id, name, share_url }`
- Frontend read-only view: map + proposal layer + schedule summary; no editor
  controls
- Reuses the generalized share table from Phase 13A (`kind='proposal'`)

**Abuse controls (14A–14D) deferred post-MVP.** Ship comment surface as
specified; add rate limiting, CAPTCHA, or verification only if spam
materializes.

### 14B. Spatial Annotation

Allow a viewer of a shared proposal to drop a pin with a text comment:

- Click anywhere on the map → comment input appears
- Comment stored with: lat/lon, free text, optional email, timestamp
- `POST /api/proposals/{id}/comments`, `GET /api/proposals/{id}/comments`
- Comments rendered as numbered markers on the map for the proposal owner

### 14C. Comment Export

Proposal owner can download all comments as CSV: lat, lon, text, timestamp,
email (if provided). One-click. No account system required.

### 14D. Comment Moderation

Anonymous flag mechanism: viewers flag a comment as inappropriate. Flagged
comments hidden from public view pending owner review. Owner sees flag count.

---

## Phase 15 — Network Scores

> Static network quality scores independent of any scenario run. Build these
> when a UI consumer is designed to display them — not before.

### 15A. Frequency & Interchange Scores

- **Frequency score**: mean headway across all stops, weighted by route count.
  Computable from `stop_records` and `headway_by_period`.
- **Interchange score**: fraction of stops served by 2+ routes.
  Computable from `routes_serving` on each `StopDetail`.

New endpoint: `GET /api/network/scores`. Surface in the status bar or a
collapsible network summary panel.

### 15B. Coverage Score

Fraction of population within 400m of a stop. Spatial join between stop
locations and Census block population centroids. Uses the Census TIGERweb
infrastructure already in place from the LODES importer.

### 15C. Route Visual Hierarchy

CDTA publishes all bus routes as `route_type=3`. Visual hierarchy (BRT
heavier, express dashed) requires CDTA-specific name pattern matching.
Builds on the division-based checkbox filtering already implemented.

### Blocked: Ridership Score

CDTA does not publish passenger load in GTFS. Cannot be computed.

---

## Phase 16 — Search

Client-side fuzzy search over bus stops and routes.

### 16A. Stop & Route Search

A single input that searches stop names/IDs and route short/long names.
Results grouped by type; clicking pans/zooms to the feature.

- Client-side fuzzy match against in-memory data (no round-trip)
- Debounce at 200ms
- Keyboard navigable (↑/↓, Enter, Escape)

### Deferred search features

Build when a concrete user need arises:

- Address geocoding (Nominatim)
- Road segment search by name
- Bike amenity search
- Layer attribute filters (headway tier, service type, speed range)
- Saved filter presets
- OSM gap analysis with configurable proximity threshold

---

## Deferred: Full Simulation

The simulation backend (flow propagation, dual-run, keyframe export) is
preserved and accessible behind `?dev=true`. It is not sequenced for active
development until:

- A mode shift elasticity model is implemented and calibrated against observed
  ridership data
- Induced demand response is modeled for road capacity changes
- Network rerouting behavior (drivers shifting to parallel streets) is accounted
  for
- Results are validated against at least one observed before/after scenario

Without these, simulation outputs are not defensible for planning decisions.
Schedule arithmetic (Phase 12) provides honest, clearly-scoped estimates in
the interim.

---

## Deferred: Other Items

| Item | Precondition missing |
| --- | --- |
| **On-time performance delta** | Requires GTFS-RT trip updates for calibration. |
| **Accessibility metrics (jobs within N minutes)** | Requires trip-level routing, not edge-level flow. |
| **Confidence scoring on metrics** | Meaningful only once model is calibrated against real observations. |
| **Scenario cost annotation** | Spatially joining CIP data against patched edges is a research task with uncertain data quality. Defer until a planner requests it and data join feasibility is validated. |
| **Public scenario sharing with accounts** | Requires auth, user model, ownership, moderation. |
| **Community voting / advocacy** | Separate product layer. Deferred indefinitely. |
| **Ridership data** | Blocked on CDTA publishing passenger load. |
| **GTFS-RT live vehicle positions** | Treat as validation tool first, not user-facing. |
| **3D / digital twin rendering** | No evidence it improves planning decisions at this scale. |

---

## Sequencing Summary

```text
Phase 9A  ✓ Correctness fixes
Phase 9B  ✓ MVP polish
Phase 9C  ✓ CI & test foundation (24/24 passing)
Phase 10  ✓ Persistence (SQLite, LRU eviction, read-only sharing)
Phase 11  — Hide simulation UI (gate behind ?dev=true; no code deleted)
Phase 12  — Schedule arithmetic (trip time, turn geometry, headway/stop impact, reliability annotation)
Phase 13  — Proposal import (GTFS upload, diff view, schedule summary)
Phase 14  — Public comment surface (share URL, spatial annotation, export)
Phase 15  — Network scores (frequency, interchange, coverage)
Phase 16  — Search (stop/route only; defer geocoding and filters)
Deferred  — Full simulation (requires mode shift, induced demand, calibration)
```

Each phase builds on what the previous phase produces. No phase assumes
infrastructure or data that doesn't exist when the phase begins.
