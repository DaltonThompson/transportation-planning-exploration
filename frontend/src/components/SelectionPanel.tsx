/**
 * Slide-in side panel that shows context for whatever the user clicked:
 *   - Stop:    name, headway, serving routes
 *   - Route:   name(s), type, feed
 *   - Segment: edge id, congestion, speed, road class
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { RouteDetail, StopScheduleRoute } from "../api/client";
import { useSelectionStore } from "../store/useSelectionStore";
import type { SelectedRoute } from "../store/useSelectionStore";
import { useSimStore } from "../store/useSimStore";
import {
  cdtaServiceType,
  SERVICE_TYPE_THRESHOLDS,
  FY2025_PERFORMANCE,
} from "../utils/cdtaRoutes";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract a short city/origin label from a full station name.
 *  "Albany-Rensselaer Amtrak Station" → "Albany"
 *  "New York Penn Station"            → "New York"
 *  "Chicago Union Station"            → "Chicago"
 *  Falls back to the original name if no pattern matches.
 */
function cityFromStopName(name: string): string {
  return name
    .replace(/\s+Amtrak\s+Station\s*$/i, "")
    .replace(/\s+(Train|Rail|Bus)?\s*Station\s*$/i, "")
    .replace(/\s+(Union|Penn|Central|Terminal|Airport)\s*$/i, "")
    .split(/\s*[-–,]\s*/)[0]
    .trim() || name;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const PANEL: React.CSSProperties = {
  position: "absolute",
  top: 0,
  right: 0,
  width: 340,
  height: "100%",
  background: "var(--bg-primary)",
  borderLeft: "1px solid var(--border)",
  boxShadow: "-4px 0 16px rgba(0,0,0,0.4)",
  display: "flex",
  flexDirection: "column",
  zIndex: 1000,
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--text-primary)",
  overflowY: "auto",
};

const HEADER: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 14px 10px",
  borderBottom: "1px solid var(--border)",
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  flexShrink: 0,
};

const CLOSE_BTN: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 16,
  lineHeight: 1,
  padding: "2px 4px",
};

const BODY: React.CSSProperties = {
  padding: "14px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const LABEL: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  marginBottom: 2,
};

const VALUE: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
};


const DIVIDER: React.CSSProperties = {
  borderBottom: "1px solid var(--border)",
  margin: "4px 0",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtDist(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

function headwayLabel(s: number): string {
  if (s < 60)  return `${Math.round(s)}s`;
  return `${Math.round(s / 60)} min`;
}

function routePillColor(hex: string): string {
  return hex.startsWith("#") ? hex : `#${hex}`;
}

function pillTextColor(hex: string): string {
  const c = hex.replace("#", "").padEnd(6, "0");
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.45 ? "#111" : "#fff";
}

function RoutePill({ route, onClick }: { route: SelectedRoute; onClick?: () => void }) {
  const bg = routePillColor(route.color);
  const fg = pillTextColor(bg.replace("#", ""));
  return (
    <span
      onClick={onClick}
      title={onClick ? "Open route details" : undefined}
      style={{
        background: bg, color: fg,
        borderRadius: 999, padding: "4px 13px",
        fontWeight: 700, fontSize: 14,
        letterSpacing: "0.02em", whiteSpace: "nowrap",
        boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
        cursor: onClick ? "pointer" : "default",
        transition: "opacity 0.1s",
        userSelect: "none",
      }}
      onMouseEnter={(e) => { if (onClick) (e.currentTarget as HTMLElement).style.opacity = "0.8"; }}
      onMouseLeave={(e) => { if (onClick) (e.currentTarget as HTMLElement).style.opacity = "1"; }}
    >
      {route.name}
    </span>
  );
}

// ─── Shared sections ──────────────────────────────────────────────────────────

function CongestionGauge({ value }: { value: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{
        flex: 1, height: 6, borderRadius: 3,
        background: "linear-gradient(to right, #00c853 0%, #ffea00 50%, #ff1744 100%)",
        position: "relative",
      }}>
        <div style={{
          position: "absolute",
          left: `${Math.round(value * 100)}%`,
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: 10, height: 10,
          borderRadius: "50%",
          background: "#fff",
          border: "2px solid #333",
        }} />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, minWidth: 36 }}>
        {(value * 100).toFixed(0)}%
      </span>
    </div>
  );
}

function RoadMetrics({ edgeId }: { edgeId: number }) {
  const edgeState = useSimStore((s) => s.edgeState);
  const state = edgeState[edgeId];
  if (!state) {
    return (
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Run a scenario to see live road metrics.
      </div>
    );
  }
  return (
    <>
      <div>
        <div style={LABEL}>Congestion</div>
        <CongestionGauge value={state.c} />
      </div>
      <div style={{ display: "flex", gap: 16 }}>
        <div>
          <div style={LABEL}>Flow</div>
          <div style={VALUE}>{state.f.toFixed(1)} PCU/s</div>
        </div>
        <div>
          <div style={LABEL}>Speed</div>
          <div style={VALUE}>{(state.s * 2.237).toFixed(0)} mph</div>
        </div>
      </div>
    </>
  );
}

function RoadSegmentSection({ edgeId, roadName, roadHighway }: {
  edgeId: number;
  roadName?: string;
  roadHighway?: string;
}) {
  return (
    <>
      <div style={DIVIDER} />
      <div>
        <div style={LABEL}>Road</div>
        <div style={{ ...VALUE, fontSize: 15 }}>{roadName || "Unnamed road"}</div>
        {roadHighway && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, textTransform: "capitalize" }}>
            {roadHighway.replace(/_/g, " ")}
          </div>
        )}
      </div>
      <RoadMetrics edgeId={edgeId} />
    </>
  );
}

function BikeInfraSection({ features }: { features: Array<Record<string, unknown>> }) {
  if (!features.length) return null;
  return (
    <>
      <div style={DIVIDER} />
      <div>
        <div style={LABEL}>Nearby bike infrastructure</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
          {features.map((props, i) => {
            const name = String(props.name || props.highway || "Bike path");
            const surface = props.surface ? String(props.surface) : null;
            const cycleway = props.cycleway ? String(props.cycleway) : null;
            const detail = [cycleway, surface].filter(Boolean).join(" · ");
            return (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span style={{
                  marginTop: 3, flexShrink: 0,
                  width: 18, borderTop: "2.5px solid #00d084",
                }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{name}</div>
                  {detail && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{detail}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ─── Sub-panels ───────────────────────────────────────────────────────────────

// ── Headway color ─────────────────────────────────────────────────────────────
function headwayBadgeColor(s: number): string {
  if (s <= 600)  return "#69db7c";
  if (s <= 1800) return "#ffd43b";
  return "#ff6b6b";
}

// ── Stop schedule sub-component ───────────────────────────────────────────────
const PERIOD_ORDER = ["Early morning", "AM peak", "Midday", "PM peak", "Evening", "Night"];

function RouteScheduleBlock({ r }: { r: StopScheduleRoute }) {
  const [expanded, setExpanded] = useState(false);
  const bg = r.route_color.startsWith("#") ? r.route_color : `#${r.route_color}`;
  const fg = pillTextColor(bg.replace("#", ""));
  const periods = PERIOD_ORDER.filter((p) => r.departures_by_period[p]?.length);

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{
          background: bg, color: fg,
          borderRadius: 999, padding: "2px 10px",
          fontWeight: 700, fontSize: 12, flexShrink: 0,
        }}>
          {r.route_short_name || r.route_id}
        </span>
        {r.headsigns.length > 0 && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            → {r.headsigns[0]}
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, paddingLeft: 2 }}>
        First {r.first_departure} · Last {r.last_departure} · {r.total_departures} trips/day
      </div>
      {periods.length > 0 && (
        <div>
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{ background: "none", border: "none", color: "var(--purple)", cursor: "pointer", fontSize: 11, padding: 0, marginBottom: 4 }}
          >
            {expanded ? "Hide departures" : "Show departures"}
          </button>
          {expanded && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {periods.map((period) => {
                const times = r.departures_by_period[period];
                const total = r.total_departures;
                // Approximate count in this period
                const shown = times.length;
                return (
                  <div key={period}>
                    <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>
                      {period}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 6px" }}>
                      {times.map((t, i) => (
                        <span key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-primary)" }}>{t}</span>
                      ))}
                      {shown >= 10 && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>+more</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StopPanel({ stopId, bikeFeatures }: { stopId: string; bikeFeatures?: Array<Record<string, unknown>> }) {
  const { setSelection } = useSelectionStore();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["stop-detail", stopId],
    queryFn: () => api.getStopDetail(stopId),
    staleTime: 5 * 60_000,
  });

  const { data: schedule, isLoading: schedLoading } = useQuery({
    queryKey: ["stop-schedule", stopId],
    queryFn: () => api.getStopSchedule(stopId),
    staleTime: 10 * 60_000,
    retry: 1,
  });

  if (isLoading) return <div style={{ padding: 14, color: "var(--text-muted)" }}>Loading…</div>;
  if (isError || !data) return <div style={{ padding: 14, color: "#f87171" }}>Failed to load stop.</div>;

  return (
    <div style={BODY}>
      {/* Name + ID */}
      <div>
        <div style={{ ...VALUE, fontSize: 16 }}>{data.name || `Stop ${data.id}`}</div>
        <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 2 }}>
          Stop {data.id} · {data.lat.toFixed(5)}, {data.lng.toFixed(5)}
        </div>
      </div>

      <div style={DIVIDER} />

      {/* Average headway */}
      <div style={{ display: "flex", gap: 24 }}>
        <div>
          <div style={LABEL}>Avg headway</div>
          <div style={{ ...VALUE, color: headwayBadgeColor(data.headway_s) }}>
            {headwayLabel(data.headway_s)}
          </div>
        </div>
        {schedule && (
          <div>
            <div style={LABEL}>Routes</div>
            <div style={VALUE}>{schedule.routes.length}</div>
          </div>
        )}
      </div>

      {/* Serving routes (pills) */}
      {data.routes_serving && data.routes_serving.length > 0 && (
        <div>
          <div style={LABEL}>Serving routes</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            {data.routes_serving.map((r) => {
              const route: SelectedRoute = {
                routeId: r.route_id,
                name: r.route_short_name || r.route_long_name || r.route_id,
                color: r.route_color ? `#${r.route_color.replace("#", "")}` : "#888888",
                feedSlug: r.feed_slug ?? "",
                routeType: r.route_type,
              };
              return (
                <RoutePill
                  key={r.route_id}
                  route={route}
                  onClick={() => setSelection({ kind: "route", routes: [route] })}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Per-route departure schedule */}
      <div style={DIVIDER} />
      <div>
        <div style={{ ...LABEL, marginBottom: 8 }}>Departure schedule</div>
        {schedLoading && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading schedule…</div>}
        {!schedLoading && (!schedule || schedule.routes.length === 0) && (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No schedule data — sync the GTFS feed.</div>
        )}
        {schedule?.routes.map((r) => (
          <RouteScheduleBlock key={r.route_id} r={r} />
        ))}
      </div>

      {bikeFeatures && <BikeInfraSection features={bikeFeatures} />}
    </div>
  );
}

// ── Route type labels ─────────────────────────────────────────────────────────
const ROUTE_TYPE_LABELS: Record<number, string> = {
  0: "Tram / Light rail",
  1: "Subway / Metro",
  2: "Rail",
  3: "Bus",
  4: "Ferry",
  700: "Bus",
};

function routeTypeLabel(t: number): string {
  return ROUTE_TYPE_LABELS[t] ?? `Type ${t}`;
}

// ── FY2025 performance section ────────────────────────────────────────────────

function ThresholdBar({ value, min, max }: { value: number; min: number; max: number }) {
  // Bar spans 0 → max; a marker at min shows the threshold; fill is capped at max.
  const fillPct  = Math.min(100, (value / max) * 100);
  const minPct   = Math.min(100, (min   / max) * 100);
  const meetsMin = value >= min;
  const fillColor = meetsMin ? "#69db7c" : value >= min * 0.8 ? "#ffd43b" : "#ff6b6b";

  return (
    <div style={{ position: "relative", height: 6, borderRadius: 3, background: "var(--border)", overflow: "visible" }}>
      {/* Fill */}
      <div style={{
        position: "absolute", left: 0, top: 0, bottom: 0,
        width: `${fillPct}%`, background: fillColor, borderRadius: 3,
      }} />
      {/* Minimum threshold tick */}
      <div style={{
        position: "absolute", top: -3, bottom: -3, width: 2,
        left: `${minPct}%`, background: "var(--text-muted)", borderRadius: 1,
        zIndex: 1,
      }} title={`Minimum: ${min.toLocaleString()}`} />
    </div>
  );
}

function RoutePerformanceSection({ routeName }: { routeName: string }) {
  const perf = FY2025_PERFORMANCE[routeName];
  if (!perf) return null;

  const svcType  = cdtaServiceType(routeName);
  const thresh   = SERVICE_TYPE_THRESHOLDS[svcType] ?? null;

  const boardingsPct  = thresh ? Math.round((perf.totalRides   / thresh.minBoardings)    * 100) : null;
  const productivePct = thresh ? Math.round((perf.productivity / thresh.minRidersPerHour) * 100) : null;

  // Cap bar at 3× minimum for readability
  const boardingMax    = thresh ? thresh.minBoardings    * 3 : perf.totalRides;
  const productiveMax  = thresh ? thresh.minRidersPerHour * 3 : perf.productivity;

  const SERVICE_TYPE_LABELS: Record<string, string> = {
    brt:          "BRT (BusPlus)",
    trunk:        "Trunk",
    neighborhood: "Neighborhood",
    express:      "Express",
    commuter:     "Commuter",
    "800series":  "800 Series",
    flex:         "Flex / Microtransit",
    unknown:      "Unknown",
  };

  return (
    <>
      <div style={DIVIDER} />
      <div>
        <div style={{ ...LABEL, marginBottom: 6 }}>FY2025 Performance</div>

        {/* Service type badge */}
        <div style={{ marginBottom: 10 }}>
          <span style={{
            fontSize: 11, fontWeight: 600,
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "2px 8px",
            color: "var(--text-muted)",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}>
            {SERVICE_TYPE_LABELS[svcType] ?? svcType}
          </span>
          {perf.note && (
            <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 8, fontStyle: "italic" }}>
              {perf.note}
            </span>
          )}
        </div>

        {/* Rides */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
            <div style={LABEL}>Annual rides</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
              {perf.totalRides.toLocaleString()}
              {boardingsPct !== null && (
                <span style={{
                  marginLeft: 6,
                  color: boardingsPct >= 100 ? "#69db7c" : boardingsPct >= 80 ? "#ffd43b" : "#ff6b6b",
                }}>
                  {boardingsPct}% of min
                </span>
              )}
            </div>
          </div>
          {thresh && (
            <ThresholdBar
              value={perf.totalRides}
              min={thresh.minBoardings}
              max={boardingMax}
            />
          )}
          {thresh && (
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3 }}>
              Min: {thresh.minBoardings.toLocaleString()} annual boardings
            </div>
          )}
        </div>

        {/* Revenue hours */}
        <div style={{ marginBottom: 10 }}>
          <div style={LABEL}>Revenue hours</div>
          <div style={{ ...VALUE, fontSize: 13 }}>{perf.revenueHours.toLocaleString()} hrs</div>
        </div>

        {/* Productivity */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
            <div style={LABEL}>Riders / hour</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
              {perf.productivity.toFixed(1)}
              {productivePct !== null && (
                <span style={{
                  marginLeft: 6,
                  color: productivePct >= 100 ? "#69db7c" : productivePct >= 80 ? "#ffd43b" : "#ff6b6b",
                }}>
                  {productivePct}% of min
                </span>
              )}
            </div>
          </div>
          {thresh && (
            <ThresholdBar
              value={perf.productivity}
              min={thresh.minRidersPerHour}
              max={productiveMax}
            />
          )}
          {thresh && (
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3 }}>
              Min: {thresh.minRidersPerHour} riders/hr
            </div>
          )}
        </div>

        {/* On-time performance */}
        {perf.otp ? (
          <div style={{ marginTop: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <div style={LABEL}>On-time performance</div>
              {perf.otp.headwayManaged && (
                <span style={{ fontSize: 10, color: "var(--text-muted)", fontStyle: "italic" }}>headway-managed</span>
              )}
            </div>
            {/* Stacked bar: on-time (green) | early (yellow) | late (red) */}
            <div style={{ display: "flex", height: 10, borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
              <div style={{ width: `${perf.otp.onTime}%`, background: "#69db7c" }} title={`On time: ${perf.otp.onTime}%`} />
              <div style={{ width: `${perf.otp.early}%`, background: "#ffd43b" }} title={`Early: ${perf.otp.early}%`} />
              <div style={{ width: `${perf.otp.late}%`,  background: "#ff6b6b" }} title={`Late: ${perf.otp.late}%`} />
            </div>
            <div style={{ display: "flex", gap: 14, fontSize: 11 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: "#69db7c", flexShrink: 0 }} />
                <span style={{ color: "var(--text-muted)" }}>On time</span>
                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{perf.otp.onTime}%</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: "#ffd43b", flexShrink: 0 }} />
                <span style={{ color: "var(--text-muted)" }}>Early</span>
                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{perf.otp.early}%</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: "#ff6b6b", flexShrink: 0 }} />
                <span style={{ color: "var(--text-muted)" }}>Late</span>
                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{perf.otp.late}%</span>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
            On-time performance not reported for this route.
          </div>
        )}
      </div>
    </>
  );
}

// ── Single-route detail view ──────────────────────────────────────────────────
function SingleRouteDetail({
  route, edgeId, roadName, roadHighway, bikeFeatures,
}: {
  route: SelectedRoute;
  edgeId?: number;
  roadName?: string;
  roadHighway?: string;
  bikeFeatures?: Array<Record<string, unknown>>;
}) {
  const [showAllStops, setShowAllStops] = useState(false);
  const { setSelection } = useSelectionStore();

  const { data, isLoading, isError } = useQuery<RouteDetail>({
    queryKey: ["route-detail", route.routeId, route.feedSlug],
    queryFn: () => api.getRouteDetail(route.routeId, route.feedSlug || undefined),
    staleTime: 10 * 60_000,
    retry: 1,
  });

  const STOPS_PREVIEW = 6;
  const stops = data?.stop_sequence ?? [];
  const visibleStops = showAllStops ? stops : stops.slice(0, STOPS_PREVIEW);

  return (
    <div style={BODY}>
      {/* Route pill + name */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <RoutePill route={route} />
        {data?.route_long_name && (
          <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.3 }}>
            {data.route_long_name}
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", gap: 10 }}>
          {data && <span>{routeTypeLabel(data.route_type)}</span>}
          {data && <span>·</span>}
          {data && <span>{data.feed_slug.toUpperCase()}</span>}
          {data?.trip_count != null && <span>·</span>}
          {data?.trip_count != null && <span>{data.trip_count} trips/day</span>}
        </div>
      </div>

      {/* Route geometry metrics */}
      {data && (data.route_length_m != null || data.avg_trip_duration_s != null || data.avg_speed_kmh != null) && (
        <>
          <div style={DIVIDER} />
          <div style={{ display: "flex", gap: 0, flexWrap: "wrap" }}>
            {data.route_length_m != null && (
              <div style={{ flex: "1 1 80px", minWidth: 80 }}>
                <div style={LABEL}>Route length</div>
                <div style={VALUE}>{(data.route_length_m / 1609.34).toFixed(1)} mi</div>
              </div>
            )}
            {data.avg_trip_duration_s != null && (
              <div style={{ flex: "1 1 80px", minWidth: 80 }}>
                <div style={LABEL}>End-to-end time</div>
                <div style={VALUE}>
                  {data.avg_trip_duration_s >= 3600
                    ? `${Math.floor(data.avg_trip_duration_s / 3600)}h ${Math.round((data.avg_trip_duration_s % 3600) / 60)}m`
                    : `${Math.round(data.avg_trip_duration_s / 60)} min`}
                </div>
              </div>
            )}
            {data.avg_speed_kmh != null && (
              <div style={{ flex: "1 1 80px", minWidth: 80 }}>
                <div style={LABEL}>Avg speed</div>
                <div style={VALUE}>{(data.avg_speed_kmh * 0.621371).toFixed(1)} mph</div>
              </div>
            )}
          </div>
        </>
      )}

      {/* FY2025 performance — CDTA routes only */}
      {route.feedSlug === "cdta" && (
        <RoutePerformanceSection routeName={route.name} />
      )}

      {/* Schedule: frequency bars for bus; timetable for rail */}
      {isLoading && (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading schedule…</div>
      )}
      {isError && (
        <div style={{ fontSize: 12, color: "#f87171" }}>Schedule not available.</div>
      )}

      {/* Bus: frequency by period */}
      {data && data.route_type === 3 && Object.keys(data.headway_by_period).length > 0 && (
        <>
          <div style={DIVIDER} />
          <div>
            <div style={LABEL}>Frequency by time of day</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 6 }}>
              {Object.entries(data.headway_by_period).map(([period, secs]) => (
                <div key={period} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 90, fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
                    {period}
                  </div>
                  <div style={{
                    flex: 1, height: 4, borderRadius: 2,
                    background: "var(--border)", position: "relative", overflow: "hidden",
                  }}>
                    <div style={{
                      position: "absolute", left: 0, top: 0, bottom: 0,
                      width: `${Math.min(100, (secs / 3600) * 100)}%`,
                      background: headwayBadgeColor(secs),
                      borderRadius: 2,
                    }} />
                  </div>
                  <div style={{
                    fontFamily: "var(--font-mono)", fontSize: 12,
                    minWidth: 48, textAlign: "right",
                    color: headwayBadgeColor(secs),
                  }}>
                    {headwayLabel(secs)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Rail: full timetable */}
      {data && data.route_type !== 3 && data.timetable.length > 0 && (
        <>
          <div style={DIVIDER} />
          <div>
            <div style={LABEL}>Timetable ({data.timetable.length} {data.timetable.length === 1 ? "trip" : "trips"})</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
              {data.timetable.map((trip, ti) => (
                <div key={ti} style={{
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  overflow: "hidden",
                }}>
                  <div style={{
                    padding: "6px 10px",
                    background: "var(--bg-surface)",
                    fontSize: 12, fontWeight: 600,
                    display: "flex", alignItems: "center", gap: 6,
                  }}>
                    <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
                      {trip.stops[0] ? cityFromStopName(trip.stops[0].stop_name) : "—"}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--text-muted)" }}>→</span>
                    {trip.headsign
                      ? cityFromStopName(trip.headsign)
                      : trip.stops[trip.stops.length - 1]
                        ? cityFromStopName(trip.stops[trip.stops.length - 1].stop_name)
                        : "Unknown"}
                  </div>
                  <div style={{ padding: "6px 0" }}>
                    {trip.stops.map((s, si) => (
                      <div key={si} style={{
                        display: "flex", alignItems: "center",
                        padding: "3px 10px", gap: 10,
                        background: si % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)",
                      }}>
                        <div style={{
                          fontFamily: "var(--font-mono)", fontSize: 11,
                          color: "var(--purple)", minWidth: 68, flexShrink: 0,
                        }}>
                          {s.departure}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-primary)" }}>
                          {s.stop_name}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Rail with no timetable data */}
      {data && data.route_type !== 3 && data.timetable.length === 0 && !isLoading && (
        <>
          <div style={DIVIDER} />
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No timetable data available.</div>
        </>
      )}

      {/* Stop sequence */}
      {stops.length > 0 && (
        <>
          <div style={DIVIDER} />
          <div>
            <div style={{ ...LABEL, marginBottom: 6 }}>
              Stops ({data?.stop_count ?? stops.length})
            </div>
            <div style={{ position: "relative" }}>
              {/* Vertical spine */}
              <div style={{
                position: "absolute", left: 7, top: 8,
                bottom: showAllStops || stops.length <= STOPS_PREVIEW ? 8 : 0,
                width: 2, background: routePillColor(route.color), opacity: 0.5,
              }} />
              <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                {visibleStops.map((s, i) => {
                  const prev = stops[i - 1];
                  const distKm = prev ? haversineKm(prev.lat, prev.lng, s.lat, s.lng) : null;
                  return (
                    <div
                      key={s.stop_id}
                      onClick={() => setSelection({ kind: "stop", stopId: s.stop_id })}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", cursor: "pointer" }}
                    >
                      <div style={{
                        width: 16, height: 16, borderRadius: "50%", flexShrink: 0,
                        border: `2px solid ${routePillColor(route.color)}`,
                        background: i === 0 || i === stops.length - 1 ? routePillColor(route.color) : "var(--bg-primary)",
                      }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {s.stop_name || s.stop_id}
                        </div>
                        {distKm !== null && (
                          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{fmtDist(distKm)}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            {stops.length > STOPS_PREVIEW && (
              <button
                onClick={() => setShowAllStops((v) => !v)}
                style={{
                  background: "none", border: "none", color: "var(--purple)",
                  cursor: "pointer", fontSize: 12, padding: "4px 0 0 26px",
                }}
              >
                {showAllStops
                  ? "Show fewer stops"
                  : `Show all ${stops.length} stops`}
              </button>
            )}
          </div>
        </>
      )}

      {edgeId !== undefined && (
        <RoadSegmentSection edgeId={edgeId} roadName={roadName} roadHighway={roadHighway} />
      )}

      {bikeFeatures && <BikeInfraSection features={bikeFeatures} />}
    </div>
  );
}

function RoutePanel({
  routes, edgeId, roadName, roadHighway, bikeFeatures,
}: {
  routes: SelectedRoute[] | undefined;
  edgeId?: number;
  roadName?: string;
  roadHighway?: string;
  bikeFeatures?: Array<Record<string, unknown>>;
}) {
  const { setSelection } = useSelectionStore();
  if (!routes || routes.length === 0) return null;

  // Single route: show full detail view
  if (routes.length === 1) {
    return (
      <SingleRouteDetail
        route={routes[0]}
        edgeId={edgeId}
        roadName={roadName}
        roadHighway={roadHighway}
        bikeFeatures={bikeFeatures}
      />
    );
  }

  // Multiple co-located routes: show pills; clicking one drills in
  return (
    <div style={BODY}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {routes.map((r, i) => (
          <RoutePill
            key={r.routeId + i}
            route={r}
            onClick={() => setSelection({ kind: "route", routes: [r], edgeId, roadName, roadHighway, bikeFeatures })}
          />
        ))}
      </div>

      {edgeId !== undefined && (
        <RoadSegmentSection edgeId={edgeId} roadName={roadName} roadHighway={roadHighway} />
      )}

      {bikeFeatures && <BikeInfraSection features={bikeFeatures} />}
    </div>
  );
}

// Friendly labels for common OSM bike tags
const BIKE_TAG_LABELS: Record<string, string> = {
  highway: "Road class",
  name: "Name",
  surface: "Surface",
  cycleway: "Cycleway type",
  bicycle: "Bicycle access",
  oneway: "One-way",
  width: "Width",
  maxspeed: "Max speed",
  lit: "Lit",
  segregated: "Segregated",
  smoothness: "Smoothness",
  access: "Access",
};

const BIKE_TAG_ORDER = Object.keys(BIKE_TAG_LABELS);

function BikePanel({ bikeProps, edgeId, roadName, roadHighway }: {
  bikeProps: Record<string, unknown>;
  edgeId?: number;
  roadName?: string;
  roadHighway?: string;
}) {
  const entries = BIKE_TAG_ORDER
    .filter((k) => bikeProps[k] != null && bikeProps[k] !== "")
    .map((k) => ({ key: k, label: BIKE_TAG_LABELS[k], value: String(bikeProps[k]) }));

  const extra = Object.entries(bikeProps)
    .filter(([k, v]) => !BIKE_TAG_ORDER.includes(k) && v != null && v !== "" && !k.startsWith("osmid"))
    .slice(0, 8);

  return (
    <div style={BODY}>
      <div>
        <div style={LABEL}>Infrastructure type</div>
        <div style={{ ...VALUE, fontSize: 15 }}>
          {String(bikeProps.name || bikeProps.highway || "Bike path")}
        </div>
      </div>

      <div style={DIVIDER} />

      {entries.map(({ key, label, value }) => (
        <div key={key}>
          <div style={LABEL}>{label}</div>
          <div style={{ fontSize: 13 }}>{value}</div>
        </div>
      ))}

      {extra.length > 0 && (
        <>
          <div style={DIVIDER} />
          {extra.map(([k, v]) => (
            <div key={k}>
              <div style={{ ...LABEL, fontFamily: "var(--font-mono)" }}>{k}</div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{String(v)}</div>
            </div>
          ))}
        </>
      )}

      {edgeId !== undefined && (
        <RoadSegmentSection edgeId={edgeId} roadName={roadName} roadHighway={roadHighway} />
      )}
    </div>
  );
}

function SegmentPanel({ edgeId, roadName, roadHighway, bikeFeatures }: {
  edgeId: number;
  roadName?: string;
  roadHighway?: string;
  bikeFeatures?: Array<Record<string, unknown>>;
}) {
  return (
    <div style={BODY}>
      <div>
        <div style={{ ...VALUE, fontSize: 16 }}>{roadName || "Unnamed road"}</div>
        {roadHighway && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, textTransform: "capitalize" }}>
            {roadHighway.replace(/_/g, " ")}
          </div>
        )}
      </div>
      <div style={DIVIDER} />
      <RoadMetrics edgeId={edgeId} />
      {bikeFeatures && <BikeInfraSection features={bikeFeatures} />}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function SelectionPanel() {
  const { selection, clearSelection } = useSelectionStore();

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") clearSelection(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [clearSelection]);

  if (!selection) return null;

  const title =
    selection.kind === "stop"    ? "Bus Stop" :
    selection.kind === "route"   ? (selection.routes && selection.routes.length > 1 ? "Co-located Routes" : "Route") :
    selection.kind === "bike"    ? "Bike Infrastructure" :
    "Road Segment";  // road name shown in body

  return (
    <div style={PANEL}>
      <div style={HEADER}>
        <span>{title}</span>
        <button style={CLOSE_BTN} onClick={clearSelection} title="Close (Esc)">✕</button>
      </div>

      {selection.kind === "stop" && selection.stopId && (
        <StopPanel stopId={selection.stopId} bikeFeatures={selection.bikeFeatures} />
      )}

      {selection.kind === "route" && (
        <RoutePanel
          routes={selection.routes}
          edgeId={selection.edgeId}
          roadName={selection.roadName}
          roadHighway={selection.roadHighway}
          bikeFeatures={selection.bikeFeatures}
        />
      )}

      {selection.kind === "segment" && selection.edgeId !== undefined && (
        <SegmentPanel
          edgeId={selection.edgeId}
          roadName={selection.roadName}
          roadHighway={selection.roadHighway}
          bikeFeatures={selection.bikeFeatures}
        />
      )}

      {selection.kind === "bike" && selection.bikeProps && (
        <BikePanel
          bikeProps={selection.bikeProps}
          edgeId={selection.edgeId}
          roadName={selection.roadName}
          roadHighway={selection.roadHighway}
        />
      )}
    </div>
  );
}
