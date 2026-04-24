from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Simulation constants
    DECAY_FACTOR: float = 0.95
    CONGESTION_FLOOR: float = 0.2
    TIMESTEP_SECONDS: int = 5
    KEYFRAME_INTERVAL_SECONDS: int = 30
    DEFAULT_DURATION_MINUTES: int = 60
    MAX_DURATION_MINUTES: int = 120

    # SQLite database file path (relative to working directory or absolute)
    DB_PATH: str = "transport.db"

    # Maximum number of runs whose keyframes are kept in memory simultaneously.
    # Older runs are evicted; frames are reloaded from SQLite on demand.
    LRU_MAX_RUNS: int = 3

    # Base URL of the frontend, used to generate shareable run links.
    FRONTEND_URL: str = "http://localhost:3000"

    # Initial flow seeding: background traffic fraction × road_class_factor
    BACKGROUND_FLOW_FRACTION: float = 0.15

    # GTFS stop snap rejection threshold (meters).
    # Set high: CDTA serves all three Capital District counties and some stops
    # near county boundaries need several km of tolerance.
    GTFS_SNAP_MAX_METERS: float = 5000.0

    # OSM graph area — list of place names passed directly to osmnx.
    # pydantic-settings parses this from a JSON array env var:
    #   OSM_PLACE='["Albany County, NY", "Rensselaer County, NY"]'
    OSM_PLACE: list[str] = [
        "Albany County, New York, USA",
        "Rensselaer County, New York, USA",
        "Schenectady County, New York, USA",
    ]
    OSM_NETWORK_TYPE: str = "drive"

    # Skip GTFS + bike-infra startup fetches. Used for memory-constrained demo
    # deployments (e.g. Render free tier, 512 MB cap).
    DISABLE_GTFS_SYNC: bool = False
    DISABLE_BIKE_INFRA: bool = False

    # CDTA GTFS feeds (kept for backward-compat; startup sync reads GTFS_FEED_URLS)
    CDTA_STATIC_URL: str = "https://www.cdta.org/schedules/google_transit.zip"
    CDTA_RT_VEHICLES_URL: str = (
        "http://gtfs.cdta.org:8080/gtfsrealtime/VehiclePositions"
    )
    CDTA_RT_TRIPS_URL: str = (
        "http://gtfs.cdta.org:8080/gtfsrealtime/TripUpdates"
    )

    # Configurable GTFS feed registry: slug → static zip URL.
    # Override via env var as JSON: GTFS_FEED_URLS='{"cdta":"...","mta":"..."}'
    # Any slug listed here can be synced via POST /api/feeds/{slug}/sync.
    GTFS_FEED_URLS: dict[str, str] = {
        "cdta":   "https://www.cdta.org/schedules/google_transit.zip",
        "amtrak": "https://content.amtrak.com/content/gtfs/GTFS.zip",
    }

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
