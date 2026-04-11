/**
 * Bike infrastructure data from the Capital NY Bike Map ArcGIS FeatureServer.
 * https://experience.arcgis.com/experience/6c9840b8ed8642da8d536f29fd24c7d0/
 *
 * Line layers  → exported as `features` (backward-compatible with MapRenderer)
 * Point layers → exported as `pointFeatures` for the bike amenities overlay
 *
 * All layers are fetched in parallel on first enable, paginated until
 * exceededTransferLimit is false, and cached in localStorage for 24 hours.
 */

import { useEffect, useRef, useState } from "react";

// ── Public types ──────────────────────────────────────────────────────────────

export interface BikeFeature {
  type: "Feature";
  geometry: {
    type: "LineString" | "MultiLineString";
    coordinates: number[][] | number[][][];
  };
  properties: Record<string, unknown>;
}

export type BikePointType = "parking" | "shop" | "repair" | "restroom" | "caution";

export interface BikePointFeature {
  lat: number;
  lng: number;
  layerType: BikePointType;
  name?: string;
  address?: string;
  description?: string;
  notes?: string;
  cautionType?: string;
}

export interface BikeLayers {
  features: BikeFeature[];
  pointFeatures: BikePointFeature[];
  source: "arcgis" | "none";
  loading: boolean;
  error: string | null;
}

// ── ArcGIS FeatureServer endpoints ────────────────────────────────────────────

const BASE = "https://services5.arcgis.com/FJovPlQ2ySbNljwA/arcgis/rest/services";

const LINE_LAYERS = [
  `${BASE}/Bike_Lanes_and_Paths_2025_06_03/FeatureServer/0`,
  `${BASE}/Shared_Streets_2025_06_10/FeatureServer/0`,
] as const;

const POINT_LAYERS: { url: string; layerType: BikePointType }[] = [
  { url: `${BASE}/Parking_2025_07_18/FeatureServer/0`,        layerType: "parking"  },
  { url: `${BASE}/Bike_Shops_20251216/FeatureServer/0`,        layerType: "shop"     },
  { url: `${BASE}/Self_Service_Repair_20251216/FeatureServer/0`, layerType: "repair" },
  { url: `${BASE}/Restrooms_2025_07_18/FeatureServer/0`,       layerType: "restroom" },
  { url: `${BASE}/Caution_2025_11_17/FeatureServer/0`,         layerType: "caution"  },
];

// ── Pagination helper ─────────────────────────────────────────────────────────

const PAGE_SIZE = 2000;

async function fetchAllFeatures(layerUrl: string): Promise<GeoJSONFeature[]> {
  const all: GeoJSONFeature[] = [];
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url =
      `${layerUrl}/query?f=geojson&where=1%3D1&outFields=*&outSR=4326` +
      `&resultOffset=${offset}&resultRecordCount=${PAGE_SIZE}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ArcGIS ${layerUrl}: ${res.status}`);
    const json = (await res.json()) as { features: GeoJSONFeature[]; exceededTransferLimit?: boolean };
    all.push(...(json.features ?? []));
    if (!json.exceededTransferLimit || json.features.length === 0) break;
    offset += PAGE_SIZE;
  }
  return all;
}

// ── GeoJSON types (internal) ──────────────────────────────────────────────────

interface GeoJSONFeature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
}

// ── Cache (localStorage, 24-hour TTL) ────────────────────────────────────────

const CACHE_KEY = "bikeInfra_arcgis_v2";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  ts: number;
  features: BikeFeature[];
  pointFeatures: BikePointFeature[];
}

function readCache(): CacheEntry | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // quota exceeded — ignore
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────

let _cache: CacheEntry | null = readCache();
let _inflight: Promise<CacheEntry> | null = null;

async function fetchAll(): Promise<CacheEntry> {
  if (_cache) return _cache;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    // Fetch all line and point layers in parallel
    const [lineResults, pointResults] = await Promise.all([
      Promise.all(LINE_LAYERS.map(fetchAllFeatures)),
      Promise.all(POINT_LAYERS.map(({ url, layerType }) =>
        fetchAllFeatures(url).then((feats) => ({ feats, layerType }))
      )),
    ]);

    // Build line features
    const features: BikeFeature[] = [];
    for (const layerFeats of lineResults) {
      for (const f of layerFeats) {
        if (!f.geometry) continue;
        const gt = f.geometry.type;
        if (gt !== "LineString" && gt !== "MultiLineString") continue;
        features.push({
          type: "Feature",
          geometry: f.geometry as BikeFeature["geometry"],
          properties: f.properties ?? {},
        });
      }
    }

    // Build point features
    const pointFeatures: BikePointFeature[] = [];
    for (const { feats, layerType } of pointResults) {
      for (const f of feats) {
        if (!f.geometry || f.geometry.type !== "Point") continue;
        const coords = f.geometry.coordinates as number[];
        const p = f.properties ?? {};
        pointFeatures.push({
          lat: coords[1],
          lng: coords[0],
          layerType,
          name:        p.name        ? String(p.name)        : undefined,
          address:     p.address     ? String(p.address)     : undefined,
          description: p.descriptio  ? String(p.descriptio)  : undefined,
          notes:       p.notes       ? String(p.notes)       : undefined,
          cautionType: p.type        ? String(p.type)        : undefined,
        });
      }
    }

    const entry: CacheEntry = { ts: Date.now(), features, pointFeatures };
    _cache = entry;
    writeCache(entry);
    return entry;
  })();

  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

const EMPTY: BikeLayers = {
  features: [],
  pointFeatures: [],
  source: "none",
  loading: false,
  error: null,
};

export function useArcGISBikeLayer(
  _bounds: [number, number, number, number] | null,
  enabled: boolean,
): BikeLayers {
  const [state, setState] = useState<BikeLayers>(() =>
    _cache
      ? { features: _cache.features, pointFeatures: _cache.pointFeatures, source: "arcgis", loading: false, error: null }
      : EMPTY
  );
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    if (!enabled) return;

    if (_cache) {
      setState({ features: _cache.features, pointFeatures: _cache.pointFeatures, source: "arcgis", loading: false, error: null });
      return;
    }

    setState((s) => ({ ...s, loading: true, error: null }));
    fetchAll()
      .then((entry) => {
        if (cancelledRef.current) return;
        setState({ features: entry.features, pointFeatures: entry.pointFeatures, source: "arcgis", loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelledRef.current) return;
        setState({ ...EMPTY, error: err instanceof Error ? err.message : String(err) });
      });

    return () => {
      cancelledRef.current = true;
    };
  }, [enabled]);

  return state;
}
