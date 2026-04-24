"""
Pre-build a GraphState pickle so the server can skip the osmnx fetch on cold start.

Usage:
    python scripts/build_graph_pickle.py [OUTPUT_PATH]

Reads OSM_PLACE from env (defaults to settings.OSM_PLACE). Writes to
backend/cache/graph.pkl by default.
"""

import os
import pickle
import sys
from pathlib import Path

# Ensure GRAPH_PICKLE_PATH doesn't short-circuit the load we're trying to build.
os.environ.pop("GRAPH_PICKLE_PATH", None)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from graph.loader import load_graph


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("cache/graph.pkl")
    out.parent.mkdir(parents=True, exist_ok=True)

    state = load_graph()

    with open(out, "wb") as f:
        pickle.dump(state, f, protocol=pickle.HIGHEST_PROTOCOL)

    size_mb = out.stat().st_size / (1024 * 1024)
    print(f"Wrote {out} ({size_mb:.1f} MB, {len(state.edges)} edges)")


if __name__ == "__main__":
    main()
