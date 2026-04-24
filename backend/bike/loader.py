"""
Bike infrastructure loader.

Downloads OSM bike infrastructure (cycleways, designated bike routes,
shared paths) for the configured OSM_PLACE once and caches the result to
disk as GeoJSON. Serves as the authoritative source for /api/bike-infra,
replacing per-session Overpass calls from the browser.

Why this module exists:
    Before this, the frontend called the public Overpass API directly on
    every pan/zoom. Queries routinely hit the 15s client timeout and the
    layer would load inconsistently. Moving the fetch server-side means
    one query per deploy (or forced refresh), shared across all users.
"""

import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

from config import settings

logger = logging.getLogger(__name__)

_CACHE_DIR = Path(__file__).parent.parent / "cache"
_CACHE_TTL_SECONDS = 7 * 24 * 3600  # 7 days — OSM bike infra changes slowly

# OSM tag filters. `True` as a value means "tag present with any value",
# which is what we want for cycleway=* (lane, track, shared, etc.).
_BIKE_TAGS: dict[str, object] = {
    "highway": "cycleway",
    "cycleway": True,
    "bicycle": "designated",
}


@dataclass
class BikeInfraResult:
    features: list[dict] = field(default_factory=list)  # GeoJSON Feature dicts
    fetched_at: float = 0.0                              # unix timestamp
    place_hash: str = ""
    source: str = "osmnx"                                # "osmnx" or "cache"


def _place_hash(place: str | list[str]) -> str:
    payload = json.dumps(place, sort_keys=True).encode()
    return hashlib.sha256(payload).hexdigest()[:16]


def _cache_path(place_hash: str) -> Path:
    return _CACHE_DIR / f"bike_infra_{place_hash}.json"


def _read_cache(path: Path) -> BikeInfraResult | None:
    if not path.exists():
        return None
    try:
        with path.open() as f:
            payload = json.load(f)
        if time.time() - payload.get("fetched_at", 0) > _CACHE_TTL_SECONDS:
            return None
        return BikeInfraResult(
            features=payload.get("features", []),
            fetched_at=payload.get("fetched_at", 0.0),
            place_hash=payload.get("place_hash", ""),
            source="cache",
        )
    except (OSError, json.JSONDecodeError, KeyError) as exc:
        logger.warning("Could not read bike cache at %s: %s", path, exc)
        return None


def _write_cache(path: Path, result: BikeInfraResult) -> None:
    _CACHE_DIR.mkdir(exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with tmp.open("w") as f:
        json.dump(
            {
                "fetched_at": result.fetched_at,
                "place_hash": result.place_hash,
                "features":   result.features,
            },
            f,
        )
    tmp.replace(path)


def _geom_to_geojson(geom) -> dict | None:
    """Convert a shapely geometry to a GeoJSON geometry dict we can ship."""
    gt = geom.geom_type
    if gt == "LineString":
        return {
            "type": "LineString",
            "coordinates": [[x, y] for x, y in geom.coords],
        }
    if gt == "MultiLineString":
        return {
            "type": "MultiLineString",
            "coordinates": [[[x, y] for x, y in part.coords] for part in geom.geoms],
        }
    # cycleway=* occasionally lands on polygon plaza geometries — skip
    return None


def _extract_features(gdf) -> list[dict]:
    """Convert an osmnx features GeoDataFrame into GeoJSON Feature dicts."""
    features: list[dict] = []
    # Keep a compact set of properties — everything the frontend might style by.
    prop_keys = ("highway", "cycleway", "bicycle", "name", "surface", "lit")

    for idx, row in gdf.iterrows():
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue
        geojson_geom = _geom_to_geojson(geom)
        if geojson_geom is None:
            continue

        # idx is a (element_type, osmid) tuple in osmnx 2.x
        osm_id = idx[1] if isinstance(idx, tuple) and len(idx) >= 2 else idx
        props: dict = {"osm_id": osm_id}
        for k in prop_keys:
            v = row.get(k)
            if v is not None and str(v) != "nan":
                props[k] = v

        features.append({
            "type": "Feature",
            "geometry": geojson_geom,
            "properties": props,
        })
    return features


def load_bike_infrastructure(
    place: str | list[str] | None = None,
    *,
    force: bool = False,
) -> BikeInfraResult:
    """
    Load bike infrastructure for *place* (defaults to settings.OSM_PLACE).

    Reads from the disk cache if fresh (<7 days) and `force` is False;
    otherwise queries OSM via osmnx.features_from_place and writes the
    result to disk. The on-disk payload is the GeoJSON the API serves.
    """
    place = place or settings.OSM_PLACE
    ph = _place_hash(place)
    cache_file = _cache_path(ph)

    if not force:
        cached = _read_cache(cache_file)
        if cached is not None:
            logger.info("Bike infra cache hit (%d features, age %.0fs)",
                        len(cached.features), time.time() - cached.fetched_at)
            return cached

    logger.info("Fetching bike infrastructure from OSM for %s …", place)
    import osmnx as ox  # lazy: heavy import only when bike infra is actually fetched
    t0 = time.time()
    gdf = ox.features_from_place(place, tags=_BIKE_TAGS)
    features = _extract_features(gdf)
    logger.info("Bike infra fetch complete: %d features in %.1fs",
                len(features), time.time() - t0)

    result = BikeInfraResult(
        features=features,
        fetched_at=time.time(),
        place_hash=ph,
        source="osmnx",
    )
    _write_cache(cache_file, result)
    return result
