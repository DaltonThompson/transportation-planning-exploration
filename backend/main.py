"""
Entry point: FastAPI application.

Start with:
  uvicorn main:app --reload --port 8000

On startup, loads the OSM graph for Albany, Rensselaer, and Schenectady
Counties and optionally syncs the CDTA GTFS feed. Both operations run in
background tasks so the server is immediately responsive.
"""

import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import db.store as _db
from api.routes import router, load_persisted_scenarios, load_persisted_runs
from api.state import app_state
from bike.loader import load_bike_infrastructure
from config import settings
from graph.loader import load_graph
from gtfs.loader import load_gtfs_stops

_scheduler = AsyncIOScheduler()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)

app = FastAPI(
    title="Transportation Policy Evaluation Engine",
    version="0.1.0",
    description="Deterministic dual-run traffic simulation for infrastructure policy comparison.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],       # tighten in production
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.on_event("startup")
async def startup() -> None:
    """
    Load persisted scenarios, load the OSM graph, then auto-sync CDTA GTFS feed.
    All operations run in background threads so the server is immediately responsive.
    """
    import asyncio
    import concurrent.futures

    # Initialize SQLite schema (idempotent)
    _db.init_db()

    # Restore scenarios and runs from DB before graph loads
    load_persisted_scenarios()
    load_persisted_runs()

    loop = asyncio.get_running_loop()
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        app_state.graph = await loop.run_in_executor(pool, load_graph)

    log = logging.getLogger(__name__)
    log.info(
        "Graph loaded: %d nodes, %d edges",
        len(app_state.graph.nodes),
        len(app_state.graph.edges),
    )

    # Graph fingerprint check: mark stored runs stale if graph changed
    new_fp = _db.compute_graph_fingerprint(app_state.graph.edges)
    stored_fp = _db.get_stored_fingerprint()
    if stored_fp is None:
        _db.set_graph_fingerprint(new_fp)
    elif stored_fp != new_fp:
        log.warning(
            "OSM graph fingerprint changed (%s → %s) — marking stored runs as stale",
            stored_fp, new_fp,
        )
        _db.mark_runs_stale()
        _db.set_graph_fingerprint(new_fp)
        for rr in app_state.runs.values():
            rr.stale = True

    # Auto-sync CDTA GTFS so bus routes are available without manual curl
    async def _auto_sync_feed(slug: str) -> None:
        from gtfs.loader import load_gtfs_stops
        from api.state import app_state as _state
        url = settings.GTFS_FEED_URLS[slug]
        try:
            log.info("Auto-syncing '%s' GTFS feed on startup …", slug)
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                result = await loop.run_in_executor(
                    pool,
                    lambda: load_gtfs_stops(_state.graph, url, slug, force=False),
                )
            transit_stops, stop_records, route_shapes, route_details, stop_schedules, changed = result
            if changed:
                _state.transit_stops = transit_stops
                _state.stop_records = [r for r in _state.stop_records if r.feed_slug != slug] + stop_records
                _state.route_shapes = [r for r in _state.route_shapes if r.feed_slug != slug] + route_shapes
                _state.route_details = {k: v for k, v in _state.route_details.items() if not k.startswith(f"{slug}:")}
                for rid, detail in route_details.items():
                    _state.route_details[f"{slug}:{rid}"] = detail
                _state.stop_schedules.update(stop_schedules)
                if slug not in _state.feed_slugs:
                    _state.feed_slugs.append(slug)
            log.info(
                "'%s' GTFS auto-sync complete: %d stops, %d route shapes (changed=%s)",
                slug, len(stop_records), len(route_shapes), changed,
            )
        except Exception as exc:
            log.warning("'%s' GTFS auto-sync failed (non-fatal): %s", slug, exc)

    # Sync all configured feeds in parallel so a slow feed (e.g. Amtrak) doesn't
    # delay a fast one (e.g. CDTA).
    if not settings.DISABLE_GTFS_SYNC:
        asyncio.ensure_future(asyncio.gather(*[
            _auto_sync_feed(slug) for slug in settings.GTFS_FEED_URLS
        ]))
    else:
        log.info("GTFS sync disabled via DISABLE_GTFS_SYNC")

    # Pre-bake bike infrastructure so /api/bike-infra is ready without
    # browsers hitting Overpass themselves.
    async def _load_bike_infra() -> None:
        try:
            log.info("Loading bike infrastructure on startup …")
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                app_state.bike_infra = await loop.run_in_executor(
                    pool, lambda: load_bike_infrastructure(force=False)
                )
            log.info(
                "Bike infra ready: %d features (source=%s)",
                len(app_state.bike_infra.features),
                app_state.bike_infra.source,
            )
        except Exception as exc:
            log.warning("Bike infrastructure load failed (non-fatal): %s", exc)

    if not settings.DISABLE_BIKE_INFRA:
        asyncio.ensure_future(_load_bike_infra())
    else:
        log.info("Bike infra load disabled via DISABLE_BIKE_INFRA")

    # Schedule GTFS syncs: daily at 03:00 for CDTA, weekly on Sunday 03:30 for others
    async def _scheduled_sync(slug: str) -> None:
        if app_state.graph is None or app_state.gtfs_syncing:
            return
        await _auto_sync_feed(slug)

    if not settings.DISABLE_GTFS_SYNC:
        for _slug in settings.GTFS_FEED_URLS:
            if _slug == "cdta":
                _scheduler.add_job(_scheduled_sync, "cron", hour=3, minute=0, args=[_slug], id=f"gtfs_{_slug}_daily")
            else:
                _scheduler.add_job(_scheduled_sync, "cron", day_of_week="sun", hour=3, minute=30, args=[_slug], id=f"gtfs_{_slug}_weekly")
        _scheduler.start()
        log.info("Scheduled GTFS sync jobs started")
