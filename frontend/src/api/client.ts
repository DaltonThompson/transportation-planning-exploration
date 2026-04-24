const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface ServerStatus {
  graph_loaded: boolean;
  stops_loaded: boolean;
  stop_count: number;
  shape_count: number;
  feeds_synced: string[];
  gtfs_disabled?: boolean;
}

export const api = {
  getStatus:   () => apiFetch<ServerStatus>("/api/status"),
  getGraph:    () => apiFetch<GraphInfo>("/api/graph"),
  reloadGraph: () => apiFetch<{ status: string }>("/api/graph/reload", { method: "POST" }),

  listScenarios: () => apiFetch<ScenarioSummary[]>("/api/scenarios"),
  createScenario: (body: ScenarioIn) =>
    apiFetch<{ id: string; name: string }>("/api/scenarios", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getScenario: (id: string) => apiFetch<ScenarioDetail>(`/api/scenarios/${id}`),
  updateScenario: (id: string, body: ScenarioIn) =>
    apiFetch<{ id: string; name: string }>(`/api/scenarios/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  forkScenario: (id: string) =>
    apiFetch<{ id: string; name: string; parent_id: string }>(`/api/scenarios/${id}/fork`, {
      method: "POST",
    }),

  createRun: (body: RunRequest) =>
    apiFetch<{ run_id: string; status: string }>("/api/runs", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getRun:        (id: string)                => apiFetch<RunStatus>(`/api/runs/${id}`),
  getRunFrames:  (id: string, baseline = false) =>
    apiFetch<FrameResponse>(`/api/runs/${id}/frames?baseline=${baseline}`),
  getRunMetrics: (id: string) => apiFetch<MetricDeltas>(`/api/runs/${id}/metrics`),
  getShare:      (id: string) => apiFetch<ShareDescriptor>(`/api/share/${id}`),
  getRunDeltaIndex: (id: string) => apiFetch<DeltaIndexResponse>(`/api/runs/${id}/delta_index`),

  getChangelog: (trigger?: string) =>
    apiFetch<ChangelogEntry[]>(`/api/changelog${trigger ? `?trigger=${trigger}` : ""}`),

  listFeeds: () => apiFetch<FeedInfo[]>("/api/feeds"),

  syncFeed: (slug: string, force = false) =>
    apiFetch<{ slug: string; status: string }>(
      `/api/feeds/${slug}/sync${force ? "?force=true" : ""}`,
      { method: "POST" },
    ),

  // GTFS overlays
  getStops:       () => apiFetch<StopRecord[]>("/api/stops"),
  getStopDetail:  (id: string) => apiFetch<StopDetail>(`/api/stops/${id}`),
  getRouteShapes: () => apiFetch<GeoJSONFeatureCollection>("/api/routes/shapes"),
  getRouteDetail: (routeId: string, feedSlug?: string) =>
    apiFetch<RouteDetail>(`/api/routes/${encodeURIComponent(routeId)}${feedSlug ? `?feed=${feedSlug}` : ""}`),
  getStopSchedule: (stopId: string) =>
    apiFetch<StopScheduleResponse>(`/api/stops/${encodeURIComponent(stopId)}/schedule`),

  // External data
  getCollisions: () => apiFetch<CollisionResponse>("/api/external/collisions"),
  getLodes: (lat: number, lng: number, radiusKm: number) =>
    apiFetch<LodesResponse>(`/api/external/lodes?lat=${lat}&lng=${lng}&radius_km=${radiusKm}`),

  // Bike infrastructure (pre-baked on the backend; single call per session)
  getBikeInfra: () => apiFetch<BikeInfraResponse>("/api/bike-infra"),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface GraphInfo {
  loaded: boolean;
  place?: string;
  node_count?: number;
  edge_count?: number;
  bbox?: [number, number, number, number];
  stop_count?: number;
}

export interface StopRecord {
  id: string;
  name?: string;
  lat: number;
  lng: number;
  headway_s: number;
}

export interface RouteRef {
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_color: string;  // e.g. "#0055A5"
  route_type: number;
  feed_slug: string;
}

export interface StopDetail extends StopRecord {
  routes_serving: RouteRef[];
}

export interface StopSequenceItem {
  stop_id: string;
  stop_name: string;
  lat: number;
  lng: number;
}

export interface TimetableStop {
  stop_name: string;
  departure: string;  // "H:MM AM/PM"
}

export interface TimetableTrip {
  headsign: string;
  stops: TimetableStop[];
}

export interface RouteDetail {
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_color: string;
  route_type: number;
  feed_slug: string;
  trip_count: number;
  stop_count: number;
  stop_sequence: StopSequenceItem[];
  headway_by_period: Record<string, number>;  // period label → seconds
  route_length_m: number | null;
  avg_trip_duration_s: number | null;
  avg_speed_kmh: number | null;
  timetable: TimetableTrip[];                 // populated for rail; empty for bus
}

export interface StopScheduleRoute {
  route_id: string;
  route_short_name: string;
  route_color: string;
  headsigns: string[];
  first_departure: string | null;
  last_departure: string | null;
  total_departures: number;
  departures_by_period: Record<string, string[]>;  // period → ["6:05 AM", ...]
}

export interface StopScheduleResponse {
  stop_id: string;
  routes: StopScheduleRoute[];
}

export interface GeoJSONFeature {
  type: "Feature";
  geometry: { type: string; coordinates: number[][] | number[][][] };
  properties: Record<string, unknown>;
}

export interface GeoJSONFeatureCollection {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
}

export interface CollisionResponse {
  point_count: number;
  points:   CollisionPoint[];
  junctions: CollisionJunction[];
  segments:  CollisionSegment[];
}

export interface CollisionPoint {
  lat: number;
  lng: number;
  killed: number;
  injured: number;
  date: string;
}

export interface CollisionJunction {
  lat: number;
  lng: number;
  count: number;
  killed: number;
  injured: number;
  high_collision: boolean;
}

export interface CollisionSegment {
  edge_id: number;
  count: number;
  killed: number;
  injured: number;
}

export interface LodesFeature {
  lat: number;
  lng: number;
  jobs: number;
}

export interface LodesResponse {
  features: LodesFeature[];
  status: "ok" | "partial" | "not_imported";
}

export interface ScenarioSummary {
  id: string;
  name: string;
  patch_count: number;
  parent_id?: string | null;
}

export interface ScenarioDetail extends ScenarioSummary {
  patches: PatchIn[];
}

export interface PatchIn {
  type: string;
  edge_key?: number[] | null;
  stop_id?: string | null;
  route_prefix?: string | null;
  value?: unknown;
}

export interface ScenarioIn {
  name: string;
  patches: PatchIn[];
}

export interface RunRequest {
  scenario_id: string;
  duration_minutes?: number;
}

export interface RunStatus {
  run_id: string;
  scenario_id: string;
  status: "running" | "complete" | "failed";
  progress_pct: number;
  frames_available?: boolean;
  stale?: boolean;
  metrics?: MetricDeltas;
  error?: string;
}

export interface ShareDescriptor {
  run_id: string;
  scenario_id: string;
  scenario_name: string;
  share_url: string;
  stale: boolean;
  metrics?: MetricDeltas;
}

export interface MetricDeltas {
  travel_time_delta_pct: number;
  congestion_delta_pct: number;
  transit_time_delta_pct: number;
  delay_delta_pct: number;
}

export interface EdgeFrame {
  id: number;
  f: number;
  c: number;
  s: number;
}

export interface TransitFrame {
  id: string;
  dwell: boolean;
  next_dep_s: number;
}

export interface Frame {
  t: number;
  full: boolean;
  edges: EdgeFrame[];
  transit: TransitFrame[];
}

export interface FrameResponse {
  run_id: string;
  is_baseline: boolean;
  frame_count: number;
  frames: Frame[];
}

export interface BikeInfraResponse {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
  status: "loading" | "ready";
  fetched_at?: number;
  source?: "osmnx" | "cache";
}

export interface FeedInfo {
  slug: string;
  synced: boolean;
}

export interface ChangelogEntry {
  run_id: string;
  timestamp: string;
  trigger: string;
  scenario_id: string;
  scenario_name: string;
  feed_slug: string | null;
  summary: string;
  attribution_tags: string[];
}

export interface DeltaIndexResponse {
  run_id: string;
  edge_count: number;
  // edge_id (string) → [congestion_delta, speed_delta_ms]
  deltas: Record<string, [number, number]>;
}
