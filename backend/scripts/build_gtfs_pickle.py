"""
Pre-bake GTFS outputs into a single pickle so the server can display bus
routes / stops without running the live GTFS sync pipeline at startup.

Usage:
    python scripts/build_gtfs_pickle.py [OUTPUT_PATH]

Runs each feed in settings.GTFS_FEED_URLS through load_gtfs_stops() using
the committed graph pickle for stop snapping. The resulting in-memory state
is merged across feeds and pickled to backend/cache/gtfs.pkl by default.
"""

import os
import pickle
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Point the graph loader at the committed pickle so we don't re-fetch OSM.
os.environ.setdefault("GRAPH_PICKLE_PATH", "cache/graph.pkl")

from config import settings
from graph.loader import load_graph
from gtfs.loader import load_gtfs_stops


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("cache/gtfs.pkl")
    out.parent.mkdir(parents=True, exist_ok=True)

    graph = load_graph()

    merged = {
        "transit_stops": [],
        "stop_records": [],
        "route_shapes": [],
        "route_details": {},
        "stop_schedules": {},
        "feed_slugs": [],
    }

    for slug, url in settings.GTFS_FEED_URLS.items():
        print(f"Fetching '{slug}' from {url} ...")
        transit_stops, stop_records, route_shapes, route_details, stop_schedules, _ = (
            load_gtfs_stops(graph, url, slug, force=True)
        )
        merged["transit_stops"].extend(transit_stops)
        merged["stop_records"].extend(stop_records)
        merged["route_shapes"].extend(route_shapes)
        for rid, detail in route_details.items():
            merged["route_details"][f"{slug}:{rid}"] = detail
        merged["stop_schedules"].update(stop_schedules)
        merged["feed_slugs"].append(slug)
        print(f"  {slug}: {len(stop_records)} stops, {len(route_shapes)} shapes")

    with open(out, "wb") as f:
        pickle.dump(merged, f, protocol=pickle.HIGHEST_PROTOCOL)

    size_mb = out.stat().st_size / (1024 * 1024)
    print(
        f"Wrote {out} ({size_mb:.1f} MB, "
        f"{len(merged['stop_records'])} total stops, "
        f"{len(merged['route_shapes'])} total shapes, "
        f"{len(merged['feed_slugs'])} feeds)"
    )


if __name__ == "__main__":
    main()
