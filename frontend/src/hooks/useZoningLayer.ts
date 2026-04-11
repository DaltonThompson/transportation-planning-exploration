/**
 * Fetches Albany County zoning polygons from ArcGIS FeatureService.
 * Returns GeoJSON features for rendering in MapRenderer.
 * Cache: responses are keyed by bounding box (rounded to 3 decimal degrees).
 */

import { useEffect, useRef, useState } from "react";

export interface ZoningFeature {
  type: "Feature";
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
  properties: Record<string, unknown>;
}

export interface ZoningLayer {
  features: ZoningFeature[];
  loading: boolean;
  error: string | null;
}

// Albany County zoning FeatureService candidates (try in order)
const ZONING_ENDPOINTS = [
  "https://services1.arcgis.com/vdNDkVykv9vEWFX4/arcgis/rest/services/Albany_County_Zoning/FeatureServer/0",
  "https://services2.arcgis.com/De7UYsGjMj62YBTB/arcgis/rest/services/Zoning/FeatureServer/0",
];

const _cache = new Map<string, ZoningFeature[]>();

function bboxKey(bounds: [number, number, number, number]) {
  return bounds.map((v) => Math.round(v * 1000) / 1000).join(",");
}

async function fetchZoning(
  endpoint: string,
  bounds: [number, number, number, number],
): Promise<ZoningFeature[] | null> {
  const [minLon, minLat, maxLon, maxLat] = bounds;
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "ZONE_CLASS,ZONE_DESC",
    f: "geojson",
    geometry: `${minLon},${minLat},${maxLon},${maxLat}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    returnGeometry: "true",
  });
  const url = `${endpoint}/query?${params}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data.features || !Array.isArray(data.features)) return null;
  return data.features as ZoningFeature[];
}

export function useZoningLayer(
  bounds: [number, number, number, number] | null,
  enabled: boolean,
): ZoningLayer {
  const [state, setState] = useState<ZoningLayer>({
    features: [],
    loading: false,
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled || !bounds) {
      setState((s) => ({ ...s, features: [] }));
      return;
    }

    const key = bboxKey(bounds);
    if (_cache.has(key)) {
      setState({ features: _cache.get(key)!, loading: false, error: null });
      return;
    }

    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));

    (async () => {
      for (const endpoint of ZONING_ENDPOINTS) {
        try {
          const features = await fetchZoning(endpoint, bounds);
          if (features !== null) {
            _cache.set(key, features);
            setState({ features, loading: false, error: null });
            return;
          }
        } catch {
          // try next
        }
      }
      setState({ features: [], loading: false, error: "Zoning service unavailable" });
    })();

    return () => abortRef.current?.abort();
  }, [enabled, bounds ? bboxKey(bounds) : null]);

  return state;
}

// Zoning color map: keyed by zone class prefix
const ZONE_COLORS: [string, string][] = [
  ["R",  "#69db7c44"],  // Residential
  ["C",  "#ffd43b44"],  // Commercial
  ["I",  "#ff6b6b44"],  // Industrial
  ["M",  "#a78bfa44"],  // Mixed use
  ["AG", "#74c69d44"],  // Agricultural
  ["A",  "#74c69d44"],  // Agricultural (alternate)
  ["PK", "#2d6a4f44"],  // Parks
  ["P",  "#2d6a4f44"],  // Parks (alternate)
];

export function zoningColor(zoneClass: string): string {
  const cls = String(zoneClass ?? "").toUpperCase().trim();
  for (const [prefix, color] of ZONE_COLORS) {
    if (cls.startsWith(prefix)) return color;
  }
  return "#aaaaaa22";
}
