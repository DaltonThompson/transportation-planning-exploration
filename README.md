# Transportation Policy Evaluation Engine

A deterministic dual-run traffic simulator for evaluating transit and road policy changes on a live map. Define a scenario patch (change a bus route's headway, reduce a road's capacity, add or remove a stop), run baseline and scenario simulations back-to-back, and compare congestion deltas across the network with timeline playback.

Built around real Albany County, NY data — OpenStreetMap road network, CDTA bus GTFS feeds, Amtrak rail shapes.

![Screenshot](docs/screenshot.png)

## What it does

- Loads the Albany County road graph from OSM (~30–60s cached after first run).
- Pulls live GTFS feeds for CDTA buses and Amtrak; snaps stops and route shapes to OSM edges.
- Runs a deterministic flow-propagation simulation with configurable decay, congestion floor, and turn weights.
- Encodes results as keyframes + diffs (full snapshot at t=0, edges-only deltas every 30s) so the frontend can scrub through a 60-minute simulation smoothly.
- Lets you author scenario patches (`route_headway`, `stop_headway`, `edge_capacity`, `edge_speed`, `stop_add`, `stop_remove`), runs baseline and scenario in parallel, and renders the delta as a heatmap overlay.

## Stack

- **Backend:** Python 3.12, FastAPI, osmnx, NetworkX, pandas. In-process state (no DB).
- **Frontend:** React 18, TypeScript, Vite, Zustand, Leaflet.
- **Data:** OpenStreetMap (via osmnx), CDTA GTFS, Amtrak GTFS, Overpass API for bike infrastructure.

## Status

MVP — locally runnable end-to-end. Scenario authoring, dual-run comparison, timeline playback, and CDTA division filtering all work. All 8 backend unit tests pass. Frontend production build is clean.

Known limitations:
- No persistence — state lives in memory and resets on server restart.
- Edge geometry renders as straight u→v lines rather than curved OSM road shapes.
- Background flow seeder over-injects on edges in cycles.

See `BACKLOG.md` for the full post-MVP list.

## Running locally

**Backend** (port 8000):

```bash
cd backend
/opt/homebrew/bin/python3.12 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Python 3.12 specifically — 3.14 lacks wheels for osmnx/numpy.

**Frontend** (port 3000, proxies `/api` → backend):

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000.

## Repository layout

```
├── backend/      FastAPI simulation server
├── frontend/     React/TypeScript SPA
├── MVP.md        Locked MVP feature list
└── BACKLOG.md    Post-MVP enhancements
```
