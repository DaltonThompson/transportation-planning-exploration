/**
 * Pure geometry helpers for map operations.
 * No React or Leaflet dependencies — only math.
 */

import L from "leaflet";

// ─── Distance helpers ────────────────────────────────────────────────────────

export function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function edgeLengthMeters(coords: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversineMeters(coords[i - 1], coords[i]);
  return total;
}

/** Compass bearing (degrees, 0=N, clockwise) from point a to point b. */
export function bearingDeg(a: [number, number], b: [number, number]): number {
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ─── Point-to-segment distance ───────────────────────────────────────────────

/** Minimum distance (meters) from a point to a polyline segment [a, b]. */
export function pointSegDistM(p: [number, number], a: [number, number], b: [number, number]): number {
  const dlat = b[0] - a[0], dlng = b[1] - a[1];
  const len2 = dlat * dlat + dlng * dlng;
  if (len2 === 0) return haversineMeters(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dlat + (p[1] - a[1]) * dlng) / len2));
  return haversineMeters(p, [a[0] + t * dlat, a[1] + t * dlng]);
}

// ─── Direction markers ───────────────────────────────────────────────────────

/**
 * Place small directional triangle markers at regular intervals along a polyline.
 * Triangles are DivIcon SVGs rotated to the local bearing, so they always face
 * the direction of travel regardless of map rotation or zoom.
 * @param spacing  Distance between triangles in meters (default 120 m)
 */
export function placeDirMarkers(
  coords: [number, number][],
  layer: L.LayerGroup,
  color: string,
  spacing = 120,
) {
  if (coords.length < 2) return;

  // Build cumulative distance lookup table
  const cumDist: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    cumDist.push(cumDist[i - 1] + haversineMeters(coords[i - 1], coords[i]));
  }
  const total = cumDist[cumDist.length - 1];
  if (total < spacing) return; // too short for even one marker

  // Walk placement positions starting at spacing/2 from the start
  let target = spacing / 2;
  let seg = 0;

  while (target < total) {
    // Advance segment pointer
    while (seg < cumDist.length - 2 && cumDist[seg + 1] < target) seg++;

    const segLen = cumDist[seg + 1] - cumDist[seg];
    const t = segLen > 0 ? (target - cumDist[seg]) / segLen : 0;
    const a = coords[seg], b = coords[seg + 1];
    const lat = a[0] + t * (b[0] - a[0]);
    const lng = a[1] + t * (b[1] - a[1]);
    const deg = bearingDeg(a, b);

    // Triangle SVG: equilateral pointing up (north), rotated to bearing
    const icon = L.divIcon({
      className: "",
      html: `<svg width="10" height="12" viewBox="0 0 10 12"
               style="transform:rotate(${deg}deg);display:block;overflow:visible">
               <polygon points="5,0 10,12 0,12"
                 fill="${color}" stroke="rgba(0,0,0,0.4)" stroke-width="0.8"/>
             </svg>`,
      iconSize: [10, 12],
      iconAnchor: [5, 6],
    });

    L.marker([lat, lng], { icon, interactive: false, pane: "routePane" }).addTo(layer);
    target += spacing;
  }
}

// ─── Nearest edge lookup ─────────────────────────────────────────────────────

import type { EdgeGeometry } from "../components/MapRenderer";

export function nearestEdgeAt(
  latlng: L.LatLng,
  geomRef: React.RefObject<Map<number, EdgeGeometry>>,
): EdgeGeometry | null {
  const pt: [number, number] = [latlng.lat, latlng.lng];
  let best: EdgeGeometry | null = null;
  let bestDist = Infinity;
  for (const geom of geomRef.current!.values()) {
    for (let i = 0; i < geom.coords.length - 1; i++) {
      const d = pointSegDistM(pt, geom.coords[i], geom.coords[i + 1]);
      if (d < bestDist) { bestDist = d; best = geom; }
    }
  }
  return best;
}

// ─── Nearby bike features ────────────────────────────────────────────────────

type BikeFeatureProps = Record<string, unknown>;

export function nearbyBikeFeatures(
  latlng: { lat: number; lng: number },
  features: { geometry: { type: string; coordinates: unknown }; properties: BikeFeatureProps }[],
  thresholdM = 40,
): BikeFeatureProps[] {
  const pt: [number, number] = [latlng.lat, latlng.lng];
  const hits: { props: BikeFeatureProps; dist: number }[] = [];

  for (const f of features) {
    let minDist = Infinity;
    const checkLine = (line: number[][]) => {
      for (let i = 0; i < line.length - 1; i++) {
        const a: [number, number] = [line[i][1], line[i][0]];
        const b: [number, number] = [line[i + 1][1], line[i + 1][0]];
        const d = pointSegDistM(pt, a, b);
        if (d < minDist) minDist = d;
      }
    };
    if (f.geometry.type === "LineString") {
      checkLine(f.geometry.coordinates as number[][]);
    } else if (f.geometry.type === "MultiLineString") {
      for (const line of f.geometry.coordinates as number[][][]) checkLine(line);
    }
    if (minDist <= thresholdM) hits.push({ props: f.properties, dist: minDist });
  }

  hits.sort((a, b) => a.dist - b.dist);
  // Deduplicate by name+highway, keep up to 3
  const seen = new Set<string>();
  const result: BikeFeatureProps[] = [];
  for (const { props } of hits) {
    const key = String(props.name || props.highway || "");
    if (!seen.has(key)) { seen.add(key); result.push(props); }
    if (result.length >= 3) break;
  }
  return result;
}

// ─── Viewport clipping ──────────────────────────────────────────────────────

/**
 * Clips a [lat, lon] polyline to a bounding box, returning sub-segments that
 * lie inside it. Used to discard off-screen Amtrak geometry.
 */
export function clipPolylineToBbox(
  coords: [number, number][],
  minLat: number, maxLat: number, minLon: number, maxLon: number,
): [number, number][][] {
  const clipSeg = (
    p1: [number, number], p2: [number, number],
  ): [[number, number], [number, number]] | null => {
    let [lat1, lon1] = p1, [lat2, lon2] = p2;
    let tMin = 0, tMax = 1;
    const dlat = lat2 - lat1, dlon = lon2 - lon1;
    const clip = (num: number, den: number) => {
      if (Math.abs(den) < 1e-10) return num < 0;
      const t = num / den;
      if (den < 0) { if (t > tMax) return false; if (t > tMin) tMin = t; }
      else         { if (t < tMin) return false; if (t < tMax) tMax = t; }
      return true;
    };
    if (!clip(lat1 - minLat, -dlat)) return null;
    if (!clip(maxLat - lat1,  dlat)) return null;
    if (!clip(lon1 - minLon, -dlon)) return null;
    if (!clip(maxLon - lon1,  dlon)) return null;
    if (tMin > tMax) return null;
    return [
      [lat1 + tMin * dlat, lon1 + tMin * dlon],
      [lat1 + tMax * dlat, lon1 + tMax * dlon],
    ];
  };

  const segments: [number, number][][] = [];
  let current: [number, number][] = [];

  for (let i = 0; i < coords.length - 1; i++) {
    const clipped = clipSeg(coords[i], coords[i + 1]);
    if (!clipped) {
      if (current.length) { segments.push(current); current = []; }
      continue;
    }
    const [a, b] = clipped;
    if (!current.length) {
      current.push(a);
    } else {
      const prev = current[current.length - 1];
      if (Math.abs(prev[0] - a[0]) > 1e-8 || Math.abs(prev[1] - a[1]) > 1e-8) {
        segments.push(current);
        current = [a];
      }
    }
    current.push(b);
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

/** Expand [west, south, east, north] bounds by `factor` around their centre. */
export function expandBbox(
  bounds: [number, number, number, number],
  factor: number,
): { minLat: number; maxLat: number; minLon: number; maxLon: number } {
  const [west, south, east, north] = bounds;
  const dLat = (north - south) * (factor - 1) / 2;
  const dLon = (east  - west)  * (factor - 1) / 2;
  return { minLat: south - dLat, maxLat: north + dLat, minLon: west - dLon, maxLon: east + dLon };
}

// ─── Polyline offset geometry ────────────────────────────────────────────────

const R_LAT = 1 / 111320; // meters → degrees lat

function _segmentNormals(latLngs: [number, number][]): { ex: number; ey: number }[] {
  const normals: { ex: number; ey: number }[] = [];
  for (let i = 0; i < latLngs.length - 1; i++) {
    const [lat1, lng1] = latLngs[i], [lat2, lng2] = latLngs[i + 1];
    const cosLat = Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
    const dLngEq = (lng2 - lng1) * cosLat;
    const dLat   = lat2 - lat1;
    const len    = Math.hypot(dLngEq, dLat) || 1;
    normals.push({ ex: -dLat / len, ey: dLngEq / len });
  }
  return normals;
}

function _applyOffset(lat: number, lng: number, nx: number, ny: number, m: number): [number, number] {
  const cosLat = Math.cos(lat * (Math.PI / 180));
  return [lat + ny * m * R_LAT, lng + nx * m * R_LAT / cosLat];
}

/** Constant-offset polyline with miter/bevel joins. */
export function offsetPolylineGeo(
  latLngs: [number, number][],
  offsetMeters: number,
  miterLimit = 2.5,
): [number, number][] {
  if (latLngs.length < 2 || offsetMeters === 0) return latLngs;
  const normals = _segmentNormals(latLngs);
  const result: [number, number][] = [];
  for (let i = 0; i < latLngs.length; i++) {
    const [lat, lng] = latLngs[i];
    const m = offsetMeters;
    if (i === 0) {
      result.push(_applyOffset(lat, lng, normals[0].ex, normals[0].ey, m));
    } else if (i === latLngs.length - 1) {
      const n = normals[normals.length - 1];
      result.push(_applyOffset(lat, lng, n.ex, n.ey, m));
    } else {
      const n1 = normals[i - 1], n2 = normals[i];
      const dot = n1.ex * n2.ex + n1.ey * n2.ey;
      const denom = 1 + dot;
      if (Math.abs(denom) < 0.05) {
        result.push(_applyOffset(lat, lng, n1.ex, n1.ey, m));
        result.push(_applyOffset(lat, lng, n2.ex, n2.ey, m));
      } else {
        const mx = (n1.ex + n2.ex) / denom;
        const my = (n1.ey + n2.ey) / denom;
        if (Math.hypot(mx, my) > miterLimit) {
          result.push(_applyOffset(lat, lng, n1.ex, n1.ey, m));
          result.push(_applyOffset(lat, lng, n2.ex, n2.ey, m));
        } else {
          result.push(_applyOffset(lat, lng, mx, my, m));
        }
      }
    }
  }
  return result;
}

// ─── Spatial co-location helpers ─────────────────────────────────────────────

const FINE_GRID = 5000;
export function fineCell(lat: number, lng: number): string {
  return `${Math.floor(lat * FINE_GRID)},${Math.floor(lng * FINE_GRID)}`;
}

// ─── Corridor sizing ────────────────────────────────────────────────────────

export const ROUTE_COLOR_WEIGHT  = 4;
export const ROUTE_CASING_WEIGHT = 9;
export const OFFSET_M = 31;

export const THROUGH_HIGHWAY_TYPES = new Set(["motorway", "motorway_link", "trunk", "trunk_link", "primary", "secondary"]);

/** Hit-polyline weight wide enough to cover the full corridor stripe. */
export function corridorHitWeight(count: number): number {
  return Math.max(10, count * ROUTE_CASING_WEIGHT + 4);
}

/** Pixels per meter at the map's current center and zoom. */
export function pxPerMeter(map: L.Map): number {
  const center = map.getCenter();
  const p1 = map.latLngToContainerPoint(center);
  const p2 = map.latLngToContainerPoint(L.latLng(center.lat, center.lng + 0.001));
  const pixelDist = Math.abs(p2.x - p1.x);
  const meterDist = center.distanceTo(L.latLng(center.lat, center.lng + 0.001));
  return meterDist > 0 ? pixelDist / meterDist : 2.44;
}

/** Width of the background stripe for N co-located route lines. */
export function corridorBgWeight(nLines: number, ppm: number): number {
  return Math.ceil((nLines - 1) * OFFSET_M * ppm + ROUTE_CASING_WEIGHT);
}

// ─── CDTA route categorization ───────────────────────────────────────────────

export function cdtaRouteCategory(routeShortName: string, feedSlug: string): string {
  if (feedSlug !== "cdta") return `route:${routeShortName}`;
  const n = parseInt(routeShortName, 10);
  if (isNaN(n) || n <= 0) return `route:${routeShortName}`;
  if (n < 100) return "cdta:local";
  if (n === 922 || n === 923) return "cdta:brt-922-923";
  const century = Math.floor(n / 100);
  if (century === 9) return `cdta:brt-${n}`;
  return `cdta:${century}xx`;
}

/** Majority-vote canonical color for a category. Warns on inconsistency. */
export function categoryCanonicalColorFrom(colors: string[]): string {
  if (colors.length === 0) return "#4444ff";
  const freq = new Map<string, number>();
  for (const c of colors) freq.set(c, (freq.get(c) ?? 0) + 1);
  let best = colors[0], bestN = 0;
  for (const [c, n] of freq) { if (n > bestN) { best = c; bestN = n; } }
  const unique = [...freq.keys()];
  if (unique.length > 1) {
    console.warn(
      `[MapRenderer] CDTA category color inconsistency — using majority "${best}". ` +
      `All colors seen: ${unique.join(", ")}. ` +
      `This may indicate a GTFS update changed route branding.`
    );
  }
  return best;
}

// ─── Diurnal factors ─────────────────────────────────────────────────────────

export const DIURNAL_FACTORS: number[] = [
  0.20, 0.15, 0.12, 0.10, 0.12, 0.20,  // 0–5
  0.35, 0.65, 0.90, 0.80, 0.70, 0.65,  // 6–11
  0.70, 0.65, 0.60, 0.65, 0.75, 0.90,  // 12–17
  0.85, 0.70, 0.55, 0.45, 0.35, 0.25,  // 18–23
];

export const WEEKEND_SCALE = 0.65;

// ─── Basemap tiles ───────────────────────────────────────────────────────────

export const BASEMAP_TILES: Record<string, { url: string; attribution: string }> = {
  dark: {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/">CARTO</a>',
  },
  osm: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles © Esri",
  },
  terrain: {
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a>',
  },
};

export const POPULATION_WMS = "https://tigerweb.geo.census.gov/arcgis/services/TIGERweb/tigerWMS_Census2020/MapServer/WMSServer";
