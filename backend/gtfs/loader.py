"""
GTFS feed loader.

Downloads a static GTFS zip, computes stop headways, snaps stops to OSM nodes,
and builds TransitStop objects for the simulation engine.

Also parses routes.txt, trips.txt, and shapes.txt to produce route shape
GeoJSON for the bus routes map overlay.

SHA-256 deduplication: if the feed hash matches the last-seen hash,
loading is skipped (override with force=True).
"""

import hashlib
import logging
import math
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import gtfs_kit as gk
import httpx
import osmnx as ox

from config import settings
from graph.loader import GraphState
from simulation.engine import TransitStop

logger = logging.getLogger(__name__)

# In-memory cache of last feed hash per slug
_feed_hashes: dict[str, str] = {}

# Disk cache directory for downloaded GTFS zips
_GTFS_CACHE_DIR = Path(__file__).parent.parent / ".gtfs_cache"
_GTFS_CACHE_DIR.mkdir(exist_ok=True)

_TRANSIT_FLOW_INJECTION = 1.2  # PCU equivalent of one bus


@dataclass
class RouteRef:
    """Minimal route descriptor attached to a stop."""
    route_id: str
    route_short_name: str
    route_long_name: str
    route_color: str   # hex, e.g. "0055A5"
    route_type: int
    feed_slug: str = ""


@dataclass
class StopRecord:
    """Snapped stop with position and headway — for the /api/stops endpoint."""
    stop_id: str
    stop_name: str
    lat: float
    lng: float
    headway_s: float
    feed_slug: str = ""
    routes_serving: list[RouteRef] = field(default_factory=list)


@dataclass
class StopSequenceItem:
    """One stop in a route's canonical trip, in order."""
    stop_id: str
    stop_name: str
    lat: float
    lng: float


# Time-of-day periods (hour ranges, inclusive start / exclusive end, 24h clock)
PERIODS: list[tuple[str, int, int]] = [
    ("Early morning", 4, 7),
    ("AM peak",       7, 9),
    ("Midday",        9, 15),
    ("PM peak",      15, 18),
    ("Evening",      18, 21),
    ("Night",        21, 28),   # GTFS allows >24 for post-midnight runs
]


@dataclass
class TripStopTime:
    """One stop within a timetable trip."""
    stop_name: str
    departure: str   # formatted "H:MM AM/PM"


@dataclass
class TimetableTrip:
    """A single scheduled trip (used for rail / low-frequency routes)."""
    headsign: str
    stops: list[TripStopTime]


@dataclass
class RouteAtStop:
    """Departure data for one route at one stop."""
    route_id: str
    route_short_name: str
    route_color: str          # hex without '#'
    headsigns: list[str]      # distinct headsigns seen at this stop
    departure_secs: list[int] # sorted seconds-from-midnight for every departure


@dataclass
class StopSchedule:
    """All routes' departure schedules at a single stop."""
    stop_id: str
    routes: list[RouteAtStop]


@dataclass
class RouteDetail:
    """Enriched per-route data computed once at GTFS load time."""
    route_id: str
    route_short_name: str
    route_long_name: str
    route_color: str
    route_type: int
    feed_slug: str
    stop_sequence: list[StopSequenceItem]   # ordered stops for the canonical trip
    headway_by_period: dict[str, float]     # period label → avg headway in seconds (bus)
    trip_count: int                         # total number of trips in the feed
    avg_speed_kmh: float | None = None      # mean scheduled speed across direction-0 trips
    route_length_m: float | None = None     # haversine distance along canonical stop sequence
    avg_trip_duration_s: float | None = None  # mean end-to-end trip time in seconds
    timetable: list[TimetableTrip] = field(default_factory=list)  # rail / low-freq only


@dataclass
class RouteShapeRecord:
    """GeoJSON-ready route polyline with metadata."""
    route_id: str
    route_short_name: str
    route_long_name: str
    route_color: str          # hex colour from GTFS, e.g. "FF0000"
    route_type: int           # GTFS route_type (0=tram,3=bus,etc.)
    coordinates: list[list[float]]  # [[lon, lat], ...] in GeoJSON order
    feed_slug: str = ""       # which GTFS feed this came from (e.g. "cdta", "amtrak")


def _clean_str(val: object) -> str:
    """Convert a pandas cell to str, treating NaN/None/empty as empty string."""
    import math
    if val is None:
        return ""
    try:
        if math.isnan(float(val)):  # type: ignore[arg-type]
            return ""
    except (TypeError, ValueError):
        pass
    return str(val).strip()


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _compute_headway_seconds(feed: gk.Feed, stop_id: str) -> float:
    """Mean headway at stop_id in seconds. Falls back to 900 s (15 min)."""
    try:
        st = feed.stop_times
        if st is None or "stop_id" not in st.columns:
            return 900.0
        times = (
            st[st["stop_id"] == stop_id]["departure_time"]
            .dropna()
            .sort_values()
            .tolist()
        )
        if len(times) < 2:
            return 900.0

        def to_s(t: str) -> int:
            parts = t.split(":")
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])

        secs = sorted(set(to_s(t) for t in times if isinstance(t, str)))
        if len(secs) < 2:
            return 900.0
        gaps = [secs[i + 1] - secs[i] for i in range(len(secs) - 1)]
        return float(sum(gaps) / len(gaps))
    except Exception:
        return 900.0


def _parse_route_shapes(feed: gk.Feed, slug: str = "") -> list[RouteShapeRecord]:
    """
    Build one representative polyline per route by joining routes → trips → shapes.
    Picks the shape_id that appears most frequently for each route (most representative).
    Returns an empty list if shapes.txt is absent.
    """
    try:
        routes_df = feed.routes
        trips_df  = feed.trips
        shapes_df = feed.shapes
    except AttributeError:
        return []

    if routes_df is None or trips_df is None or shapes_df is None:
        return []
    if routes_df.empty or trips_df.empty or shapes_df.empty:
        return []

    # Map route_id → most common shape_id
    route_shape_map: dict[str, str] = {}
    try:
        merged = trips_df[["route_id", "shape_id"]].dropna()
        for route_id, grp in merged.groupby("route_id"):
            best_shape = grp["shape_id"].value_counts().idxmax()
            route_shape_map[str(route_id)] = str(best_shape)
    except Exception as exc:
        logger.warning("Failed to map routes to shapes: %s", exc)
        return []

    # Build shape_id → sorted coordinate list
    shape_coords: dict[str, list[list[float]]] = {}
    try:
        for shape_id, grp in shapes_df.groupby("shape_id"):
            grp_sorted = grp.sort_values("shape_pt_sequence")
            coords = [
                [float(row["shape_pt_lon"]), float(row["shape_pt_lat"])]
                for _, row in grp_sorted.iterrows()
            ]
            shape_coords[str(shape_id)] = coords
    except Exception as exc:
        logger.warning("Failed to parse shape coordinates: %s", exc)
        return []

    records: list[RouteShapeRecord] = []
    for _, row in routes_df.iterrows():
        route_id = str(row["route_id"])
        shape_id = route_shape_map.get(route_id)
        if shape_id is None or shape_id not in shape_coords:
            continue

        color = str(row.get("route_color") or "4444FF").strip().lstrip("#") or "4444FF"
        try:
            route_type = int(row.get("route_type", 3))
        except (ValueError, TypeError):
            route_type = 3

        records.append(RouteShapeRecord(
            route_id=route_id,
            route_short_name=_clean_str(row.get("route_short_name")),
            route_long_name=_clean_str(row.get("route_long_name")),
            route_color=color,
            route_type=route_type,
            coordinates=shape_coords[shape_id],
            feed_slug=slug,
        ))

    logger.info("Parsed %d route shapes", len(records))
    return records


def _fmt_time(secs: int) -> str:
    """Format seconds-from-midnight as 'H:MM AM/PM'. Wraps values ≥ 86400 (GTFS allows >24 h)."""
    secs = secs % 86400
    h, rem = divmod(secs, 3600)
    m = rem // 60
    ampm = "AM" if h < 12 else "PM"
    h12 = h % 12 or 12
    return f"{h12}:{m:02d} {ampm}"


def _to_seconds(t: str) -> int:
    """Parse a GTFS HH:MM:SS time string (hour may be ≥24) to seconds."""
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def _compute_stop_schedules(feed: "gk.Feed", slug: str) -> dict[str, "StopSchedule"]:
    """
    For every stop, build a list of RouteAtStop objects containing sorted
    departure times (as seconds from midnight) per route.  Keyed by stop_id.
    """
    schedules: dict[str, StopSchedule] = {}
    try:
        st_df = feed.stop_times
        tr_df = feed.trips
        ro_df = feed.routes
    except AttributeError:
        return schedules

    if any(df is None or df.empty for df in [st_df, tr_df, ro_df]):
        return schedules

    try:
        # Columns we need; stop_headsign is optional
        st_cols = ["stop_id", "trip_id", "departure_time"]
        if "stop_headsign" in st_df.columns:
            st_cols.append("stop_headsign")

        tr_cols = ["trip_id", "route_id"]
        if "trip_headsign" in tr_df.columns:
            tr_cols.append("trip_headsign")

        ro_cols = ["route_id", "route_short_name", "route_color"]

        merged = (
            st_df[st_cols]
            .merge(tr_df[tr_cols], on="trip_id")
            .merge(ro_df[ro_cols], on="route_id")
        )
    except Exception as exc:
        logger.warning("stop schedule merge failed (%s): %s", slug, exc)
        return schedules

    for (stop_id, route_id), grp in merged.groupby(["stop_id", "route_id"]):
        stop_id  = str(stop_id)
        route_id = str(route_id)

        # Parse departure times → sorted seconds list
        dep_secs: list[int] = []
        for dep in grp["departure_time"].dropna():
            if isinstance(dep, str):
                try:
                    dep_secs.append(_to_seconds(dep))
                except Exception:
                    pass
        dep_secs.sort()
        if not dep_secs:
            continue

        # Collect distinct headsigns (stop_headsign takes priority over trip_headsign)
        headsigns: list[str] = []
        for col in ("stop_headsign", "trip_headsign"):
            if col in grp.columns:
                for h in grp[col].dropna().unique():
                    s = _clean_str(h)
                    if s and s not in headsigns:
                        headsigns.append(s)
                        if len(headsigns) >= 3:
                            break
            if len(headsigns) >= 3:
                break

        row0 = grp.iloc[0]
        short_name = _clean_str(row0.get("route_short_name", ""))
        color      = _clean_str(row0.get("route_color", "")) or "888888"

        entry = RouteAtStop(
            route_id=route_id,
            route_short_name=short_name,
            route_color=color,
            headsigns=headsigns,
            departure_secs=dep_secs,
        )

        if stop_id not in schedules:
            schedules[stop_id] = StopSchedule(stop_id=stop_id, routes=[])
        schedules[stop_id].routes.append(entry)

    logger.info("Computed stop schedules for %d stops (feed '%s')", len(schedules), slug)
    return schedules


def _compute_route_details(feed: "gk.Feed", slug: str, route_shape_map: dict[str, str]) -> dict[str, "RouteDetail"]:
    """
    For each route, build a RouteDetail with:
    - Ordered stop sequence (from the canonical trip / shape)
    - Headway by time-of-day period (from departures at the first stop)
    - Total trip count

    Returns dict keyed by route_id.
    """
    details: dict[str, RouteDetail] = {}

    try:
        routes_df = feed.routes
        trips_df  = feed.trips
        st_df     = feed.stop_times
        stops_df  = feed.stops
    except AttributeError:
        return details

    if any(df is None or df.empty for df in [routes_df, trips_df, st_df, stops_df]):
        return details

    # Build stop_id → (name, lat, lng) lookup
    stop_info: dict[str, tuple[str, float, float]] = {}
    for _, row in stops_df.iterrows():
        sid = str(row["stop_id"])
        stop_info[sid] = (
            _clean_str(row.get("stop_name")),
            float(row.get("stop_lat", 0)),
            float(row.get("stop_lon", 0)),
        )

    # Build route_id → [trip_id, ...] and trip_id → direction_id (0/1)
    route_trips: dict[str, list[str]] = {}
    trip_direction: dict[str, int] = {}
    has_direction = "direction_id" in trips_df.columns
    for _, row in trips_df.iterrows():
        rid = str(row["route_id"])
        tid = str(row["trip_id"])
        route_trips.setdefault(rid, []).append(tid)
        if has_direction:
            try:
                trip_direction[tid] = int(row.get("direction_id") or 0)
            except (ValueError, TypeError):
                trip_direction[tid] = 0

    # For each route pick the canonical trip (same shape as route_shape_map)
    # Fall back to most-occurring shape_id if trips don't have shape_id.
    canonical_trip: dict[str, str] = {}
    if "shape_id" in trips_df.columns:
        for rid, shape_id in route_shape_map.items():
            subset = trips_df[(trips_df["route_id"] == rid) & (trips_df["shape_id"] == shape_id)]
            if not subset.empty:
                canonical_trip[rid] = str(subset.iloc[0]["trip_id"])
    # Fallback: first trip
    for rid, tids in route_trips.items():
        if rid not in canonical_trip and tids:
            canonical_trip[rid] = tids[0]

    # Index stop_times by trip_id
    st_by_trip: dict[str, list] = {}
    for _, row in st_df.iterrows():
        tid = str(row["trip_id"])
        st_by_trip.setdefault(tid, []).append(row)

    for _, row in routes_df.iterrows():
        route_id = str(row["route_id"])
        trips = route_trips.get(route_id, [])
        trip_count = len(trips)

        # ── Ordered stop sequence from canonical trip ──
        stop_sequence: list[StopSequenceItem] = []
        canon_tid = canonical_trip.get(route_id)
        if canon_tid and canon_tid in st_by_trip:
            try:
                rows_sorted = sorted(st_by_trip[canon_tid], key=lambda r: int(r.get("stop_sequence", 0)))
                for r in rows_sorted:
                    sid = str(r["stop_id"])
                    info = stop_info.get(sid)
                    if info:
                        stop_sequence.append(StopSequenceItem(
                            stop_id=sid,
                            stop_name=info[0] or sid,
                            lat=info[1],
                            lng=info[2],
                        ))
            except Exception:
                pass

        # ── Headway by period ─────────────────────────────────────────────────
        # For each trip in direction 0 (or all trips if no direction_id), take
        # the departure time at that trip's own first stop (min stop_sequence).
        # This correctly captures the service pattern for one direction without
        # conflating inbound and outbound, and without depending on a single
        # fixed stop that may not be the origin for many trips.
        headway_by_period: dict[str, float] = {}
        if trips:
            # Prefer direction 0; fall back to all trips
            if trip_direction:
                dir0 = [t for t in trips if trip_direction.get(t, 0) == 0]
                use_trips = dir0 if dir0 else trips
            else:
                use_trips = trips

            all_departures: list[int] = []
            for tid in use_trips:
                rows = st_by_trip.get(tid, [])
                if not rows:
                    continue
                first_row = min(rows, key=lambda r: int(r.get("stop_sequence", 0)))
                dep = first_row.get("departure_time")
                if dep and isinstance(dep, str):
                    try:
                        all_departures.append(_to_seconds(dep))
                    except Exception:
                        pass

            all_departures.sort()

            for label, h_start, h_end in PERIODS:
                window_start = h_start * 3600
                window_end   = h_end   * 3600
                in_window = [d for d in all_departures if window_start <= d < window_end]
                if len(in_window) >= 2:
                    gaps = [in_window[i + 1] - in_window[i] for i in range(len(in_window) - 1)]
                    headway_by_period[label] = float(sum(gaps) / len(gaps))
                # 1 trip in window → omit (can't compute headway from a single departure)
                # 0 trips → omit (no service)

        color = _clean_str(row.get("route_color")) or "4444FF"
        try:
            rtype = int(row.get("route_type", 3))
        except (ValueError, TypeError):
            rtype = 3

        # ── Timetable (rail / low-frequency routes only) ──────────────────────
        # For bus (rtype == 3) we use frequency bars; for rail we build a full
        # trip-by-trip timetable so users can see actual departure times.
        timetable: list[TimetableTrip] = []
        if rtype != 3:
            # Build (first_dep_secs, trip_id) so we can sort chronologically
            trip_dep_secs: list[tuple[int, str]] = []
            for tid in trips[:30]:
                trip_rows = st_by_trip.get(tid, [])
                if not trip_rows:
                    continue
                first_row = min(trip_rows, key=lambda r: int(r.get("stop_sequence", 0)))
                dep_str = first_row.get("departure_time")
                try:
                    dep_secs = _to_seconds(dep_str) if dep_str and isinstance(dep_str, str) else 99999
                except Exception:
                    dep_secs = 99999
                trip_dep_secs.append((dep_secs, tid))

            # Sort trips chronologically by first departure
            trip_dep_secs.sort(key=lambda x: x[0])

            for _, tid in trip_dep_secs:
                trip_rows = st_by_trip.get(tid, [])
                rows_sorted = sorted(trip_rows, key=lambda r: int(r.get("stop_sequence", 0)))
                stop_times_out: list[TripStopTime] = []
                for r in rows_sorted:
                    sid = str(r["stop_id"])
                    sname = stop_info.get(sid, (sid, 0.0, 0.0))[0] or sid
                    dep = r.get("departure_time")
                    if dep and isinstance(dep, str):
                        try:
                            dep_fmt = _fmt_time(_to_seconds(dep))
                        except Exception:
                            dep_fmt = str(dep)
                    else:
                        dep_fmt = "—"
                    stop_times_out.append(TripStopTime(stop_name=sname, departure=dep_fmt))

                # Headsign: prefer trip_headsign from trips_df
                headsign = ""
                if "trip_headsign" in trips_df.columns:
                    th_rows = trips_df[trips_df["trip_id"] == tid]
                    if not th_rows.empty:
                        headsign = _clean_str(th_rows.iloc[0].get("trip_headsign", ""))
                if not headsign and stop_times_out:
                    headsign = stop_times_out[-1].stop_name  # destination as fallback

                timetable.append(TimetableTrip(headsign=headsign, stops=stop_times_out))

        # ── Average scheduled speed ───────────────────────────────────────────
        # For each direction-0 trip: speed = route_distance / travel_time.
        # Route distance is the haversine sum along the canonical stop sequence.
        # Travel time is last_departure − first_departure for that trip.
        avg_speed_kmh: float | None = None
        route_length_m: float | None = None
        avg_trip_duration_s: float | None = None
        if stop_sequence and len(stop_sequence) >= 2:
            route_dist_m = sum(
                _haversine_m(stop_sequence[i - 1].lat, stop_sequence[i - 1].lng,
                             stop_sequence[i].lat, stop_sequence[i].lng)
                for i in range(1, len(stop_sequence))
            )
            route_length_m = route_dist_m
            if route_dist_m > 0:
                speeds: list[float] = []
                durations: list[float] = []
                for tid in (use_trips if trips else []):
                    rows = st_by_trip.get(tid, [])
                    if len(rows) < 2:
                        continue
                    sorted_rows = sorted(rows, key=lambda r: int(r.get("stop_sequence", 0)))
                    dep_first = sorted_rows[0].get("departure_time")
                    dep_last  = sorted_rows[-1].get("departure_time")
                    if not dep_first or not dep_last:
                        continue
                    try:
                        travel_s = _to_seconds(dep_last) - _to_seconds(dep_first)
                        if travel_s > 0:
                            kmh = (route_dist_m / 1000.0) / (travel_s / 3600.0)
                            if 1.0 < kmh < 200.0:   # sanity bounds
                                speeds.append(kmh)
                                durations.append(travel_s)
                    except Exception:
                        pass
                if speeds:
                    avg_speed_kmh = sum(speeds) / len(speeds)
                if durations:
                    avg_trip_duration_s = sum(durations) / len(durations)

        details[route_id] = RouteDetail(
            route_id=route_id,
            route_short_name=_clean_str(row.get("route_short_name")),
            route_long_name=_clean_str(row.get("route_long_name")),
            route_color=color,
            route_type=rtype,
            feed_slug=slug,
            stop_sequence=stop_sequence,
            headway_by_period=headway_by_period,
            trip_count=trip_count,
            avg_speed_kmh=avg_speed_kmh,
            route_length_m=route_length_m,
            avg_trip_duration_s=avg_trip_duration_s,
            timetable=timetable,
        )

    logger.info("Computed route details for %d routes (feed '%s')", len(details), slug)
    return details


def load_gtfs_stops(
    graph: GraphState,
    url: str,
    slug: str,
    force: bool = False,
) -> tuple[list[TransitStop], list[StopRecord], list[RouteShapeRecord], dict[str, "RouteDetail"], dict[str, "StopSchedule"], bool]:
    """
    Download and parse GTFS feed from *url*.

    Returns (transit_stops, stop_records, route_shapes, changed).
    *changed* is False when the feed hash matches the previous fetch.
    """
    logger.info("Fetching GTFS feed '%s' from %s", slug, url)

    cache_path = _GTFS_CACHE_DIR / f"{slug}.zip"

    try:
        response = httpx.get(url, timeout=60, follow_redirects=True)
        response.raise_for_status()
        raw = response.content
        # Persist to disk so restarts don't need to re-download
        cache_path.write_bytes(raw)
        logger.info("Feed '%s' downloaded and cached (%d bytes)", slug, len(raw))
    except Exception as exc:
        if cache_path.exists():
            logger.warning(
                "Feed '%s' download failed (%s); using cached zip from %s",
                slug, exc, cache_path,
            )
            raw = cache_path.read_bytes()
        else:
            raise

    digest = _sha256(raw)
    if not force and _feed_hashes.get(slug) == digest:
        logger.info("Feed '%s' unchanged (SHA-256 match); skipping reload.", slug)
        return [], [], [], {}, {}, False

    # NOTE: hash is only committed after successful parse (see bottom of function)

    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name
    feed = gk.read_feed(tmp_path, dist_units="m")
    Path(tmp_path).unlink(missing_ok=True)

    stops_df = feed.stops
    if stops_df is None or stops_df.empty:
        logger.warning("Feed '%s' has no stops.", slug)
        return [], [], [], {}, True

    # Rebuild minimal networkx graph for nearest_nodes
    import networkx as nx
    G = nx.MultiDiGraph()
    for osmid, nd in graph.nodes.items():
        G.add_node(osmid, x=nd["x"], y=nd["y"])
    for e in graph.edges:
        G.add_edge(e.u, e.v, key=e.key)
    G.graph["crs"] = "epsg:4326"

    transit_stops: list[TransitStop] = []
    stop_records: list[StopRecord] = []
    skipped = 0

    # Build stop_id → name lookup
    stop_name_map: dict[str, str] = {}
    if stops_df is not None and "stop_name" in stops_df.columns:
        for _, row in stops_df.iterrows():
            stop_name_map[str(row["stop_id"])] = _clean_str(row.get("stop_name"))

    # Build stop_id → list[RouteRef] from stop_times → trips → routes
    stop_routes_map: dict[str, list[RouteRef]] = {}
    try:
        st_df = feed.stop_times
        tr_df = feed.trips
        ro_df = feed.routes
        if st_df is not None and tr_df is not None and ro_df is not None:
            merged = (
                st_df[["stop_id", "trip_id"]]
                .merge(tr_df[["trip_id", "route_id"]], on="trip_id")
                .merge(ro_df[["route_id", "route_short_name", "route_long_name",
                               "route_color", "route_type"]], on="route_id")
                .drop_duplicates(subset=["stop_id", "route_id"])
            )
            for _, row in merged.iterrows():
                sid = str(row["stop_id"])
                ref = RouteRef(
                    route_id=str(row["route_id"]),
                    route_short_name=_clean_str(row.get("route_short_name")),
                    route_long_name=_clean_str(row.get("route_long_name")),
                    route_color=_clean_str(row.get("route_color")) or "888888",
                    route_type=int(row.get("route_type", 3)),
                    feed_slug=slug,
                )
                stop_routes_map.setdefault(sid, []).append(ref)
    except Exception as exc:
        logger.warning("Could not build stop→routes map: %s", exc)

    for _, row in stops_df.iterrows():
        stop_id = str(row["stop_id"])
        lat = float(row["stop_lat"])
        lon = float(row["stop_lon"])

        nearest_node = ox.nearest_nodes(G, lon, lat)
        nd = graph.nodes[nearest_node]
        dist = _haversine_m(lat, lon, nd["y"], nd["x"])

        if dist > settings.GTFS_SNAP_MAX_METERS:
            logger.warning(
                "Stop %s snapped %.0f m away from OSM node %d — skipping",
                stop_id, dist, nearest_node,
            )
            skipped += 1
            continue

        graph.stop_nodes[stop_id] = nearest_node

        out_edges = graph.node_out_edges.get(nearest_node, [])
        if not out_edges:
            skipped += 1
            continue
        edge_index = out_edges[0]

        headway_s = _compute_headway_seconds(feed, stop_id)

        transit_stops.append(TransitStop(
            stop_id=stop_id,
            edge_index=edge_index,
            dwell_base_seconds=30.0,
            scheduled_interval_seconds=headway_s,
            flow_injection_per_service=_TRANSIT_FLOW_INJECTION,
        ))

        # StopRecord for the /api/stops endpoint — use actual stop lat/lon
        stop_records.append(StopRecord(
            stop_id=stop_id,
            stop_name=stop_name_map.get(stop_id, ""),
            lat=lat,
            lng=lon,
            headway_s=headway_s,
            feed_slug=slug,
            routes_serving=stop_routes_map.get(stop_id, []),
        ))

    logger.info(
        "GTFS '%s' loaded: %d stops snapped, %d skipped",
        slug, len(transit_stops), skipped,
    )

    route_shapes = _parse_route_shapes(feed, slug)

    # Build route_id → canonical shape_id map for detail computation
    _route_shape_map: dict[str, str] = {}
    if feed.trips is not None and "shape_id" in feed.trips.columns:
        for rid, grp in feed.trips.dropna(subset=["shape_id"]).groupby("route_id"):
            _route_shape_map[str(rid)] = str(grp["shape_id"].value_counts().idxmax())
    route_details    = _compute_route_details(feed, slug, _route_shape_map)
    stop_schedules   = _compute_stop_schedules(feed, slug)

    # Commit hash only after successful parse so a mid-parse failure doesn't
    # poison subsequent non-forced syncs with a false "unchanged" result.
    _feed_hashes[slug] = digest
    return transit_stops, stop_records, route_shapes, route_details, stop_schedules, True
