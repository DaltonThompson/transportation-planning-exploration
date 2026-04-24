/**
 * Layer control panel — floats top-right inside the map container.
 *
 * Road coloring is an exclusive radio group (one mode at a time).
 * All other overlays are independent checkboxes grouped by category.
 */

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { FeedInfo } from "../api/client";
import { useLayerStore, CDTA_DIVISIONS, CAPITAL_NY_BIKE_LAYERS } from "../store/useLayerStore";
import type { Basemap, OverlayState, RoadColorMode } from "../store/useLayerStore";
import { SIMULATION_ENABLED } from "../utils/simulationFlag";
// RoadColorMode without "none" — used to type lastRoadMode
type NonNoneRoadMode = Exclude<RoadColorMode, "none">;

const BASEMAPS: { key: Basemap; label: string }[] = [
  { key: "dark",      label: "Dark"      },
  { key: "osm",       label: "Street"    },
  { key: "satellite", label: "Satellite" },
  { key: "terrain",   label: "Terrain"   },
];

const ROAD_COLOR_MODES: { key: RoadColorMode; label: string }[] = [
  ...(SIMULATION_ENABLED
    ? ([{ key: "congestion", label: "Congestion" }] as { key: RoadColorMode; label: string }[])
    : []),
  { key: "roadSpeed",      label: "Speed limits"      },
  { key: "throughVsLocal", label: "Through vs local"  },
  { key: "collisions",     label: "Collision intensity" },
];

// Overlays listed after Transit, rendered flat (no sub-headings)
const FLAT_OVERLAYS: { key: keyof OverlayState; label: string }[] = [
  { key: "bikeInfraOSM",       label: "Bike infrastructure (OSM)" },
  { key: "walkToBusStop",      label: "Walk to bus stop"    },
  { key: "collisionJunctions", label: "Collision hotspots"  },
  { key: "populationDensity",  label: "Population density"  },
  { key: "zoning",             label: "Zoning"              },
  { key: "economicActivity",   label: "Economic activity"   },
  { key: "jobs",               label: "Jobs"                },
];

// ─── Shared styles ────────────────────────────────────────────────────────────

const sectionHeading: React.CSSProperties = {
  color: "var(--purple)",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 1,
  textTransform: "uppercase",
  marginBottom: 5,
  marginTop: 10,
};

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  cursor: "pointer",
  padding: "2px 0",
};

function FeedSyncButton({ feed }: { feed: FeedInfo }) {
  const [status, setStatus] = useState<string | null>(null);
  const sync = useMutation({
    mutationFn: () => api.syncFeed(feed.slug),
    onSuccess: () => { setStatus("Syncing…"); setTimeout(() => setStatus(null), 6000); },
    onError:   () => { setStatus("Error");    setTimeout(() => setStatus(null), 4000); },
  });
  const label = feed.slug.charAt(0).toUpperCase() + feed.slug.slice(1);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button
        onClick={() => sync.mutate()}
        disabled={sync.isPending}
        title={`Sync ${label} GTFS feed`}
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          color: sync.isPending ? "var(--text-muted)" : "var(--text-primary)",
          borderRadius: "var(--radius)",
          padding: "2px 7px",
          fontSize: 10,
          cursor: sync.isPending ? "not-allowed" : "pointer",
          fontFamily: "var(--font-sans)",
        }}
      >
        {sync.isPending ? "Syncing…" : `↺ Sync ${label}`}
      </button>
      {feed.synced && !status && (
        <span style={{ fontSize: 9, color: "var(--green)" }}>✓</span>
      )}
      {status && (
        <span style={{ fontSize: 10, color: status === "Error" ? "var(--red)" : "var(--purple)" }}>
          {status}
        </span>
      )}
    </div>
  );
}

export function LayerPanel() {
  const [open, setOpen] = useState(false);
  const { basemap, roadColoring, overlays, cdtaDivisions, capitalNYBikeLayers, setBasemap, setRoadColoring, toggleOverlay, toggleCdtaDivision, setAllCdtaDivisions, toggleCapitalNYBikeLayer, setAllCapitalNYBikeLayers } = useLayerStore();

  // Track last non-none road mode so toggling "Road segments" off and back on restores it
  const [lastRoadMode, setLastRoadMode] = useState<NonNoneRoadMode>(SIMULATION_ENABLED ? "congestion" : "roadSpeed");
  const roadSegmentsOn = roadColoring !== "none";
  const handleRoadSegmentsToggle = () => {
    if (roadSegmentsOn) {
      setLastRoadMode(roadColoring as NonNoneRoadMode);
      setRoadColoring("none");
    } else {
      setRoadColoring(lastRoadMode);
    }
  };

  const { data: feeds } = useQuery({
    queryKey: ["feeds"],
    queryFn: api.listFeeds,
    staleTime: 30_000,
  });

  const { data: serverStatus } = useQuery({
    queryKey: ["status"],
    queryFn: api.getStatus,
    staleTime: 30_000,
  });
  const demoMode = !!serverStatus?.gtfs_disabled;

  // Overlays disabled in demo deployment (no data source available).
  const DEMO_UNSUPPORTED_OVERLAYS: ReadonlySet<keyof OverlayState> = new Set([
    "bikeInfraOSM",
    "walkToBusStop",
    "collisionJunctions",
    "populationDensity",
    "zoning",
    "economicActivity",
    "jobs",
    "capitalNYBikeMap",
  ] as const);

  return (
    <div style={{
      position: "absolute",
      top: 12,
      right: 12,
      zIndex: 1000,
      fontFamily: "var(--font-sans)",
      fontSize: 12,
    }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Toggle layer panel"
        style={{
          background: "var(--bg-primary)",
          border: "1px solid var(--border)",
          color: "var(--text-primary)",
          borderRadius: "var(--radius)",
          padding: "6px 10px",
          cursor: "pointer",
          boxShadow: "var(--shadow)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span>⚙ Layers</span>
        <span style={{ color: "var(--text-muted)" }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{
          marginTop: 6,
          background: "var(--bg-primary)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "10px 12px",
          boxShadow: "var(--shadow)",
          width: 210,
          maxHeight: "calc(100vh - 120px)",
          overflowY: "auto",
        }}>

          {/* ── Basemap ── */}
          <div style={sectionHeading}>Basemap</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 8 }}>
            {BASEMAPS.map(({ key, label }) => (
              <label key={key} style={itemStyle}>
                <input
                  type="radio"
                  name="basemap"
                  checked={basemap === key}
                  onChange={() => setBasemap(key)}
                  style={{ accentColor: "var(--purple)", margin: 0 }}
                />
                <span style={{ color: basemap === key ? "var(--text-primary)" : "var(--text-muted)" }}>
                  {label}
                </span>
              </label>
            ))}
          </div>

          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "8px 0" }} />

          {/* ── Road segments — checkbox with nested coloring modes ── */}
          <div style={{ marginBottom: 8 }}>
            <label
              style={{ ...itemStyle, cursor: demoMode ? "not-allowed" : "pointer", opacity: demoMode ? 0.4 : 1 }}
              title={demoMode ? "Not available in demo" : undefined}
            >
              <input
                type="checkbox"
                checked={!demoMode && roadSegmentsOn}
                disabled={demoMode}
                onChange={() => !demoMode && handleRoadSegmentsToggle()}
                style={{ accentColor: "var(--purple)", margin: 0, flexShrink: 0 }}
              />
              <span style={{ color: roadSegmentsOn && !demoMode ? "var(--text-primary)" : "var(--text-muted)" }}>
                Road segments
              </span>
            </label>
            {!demoMode && roadSegmentsOn && (
              <div style={{ paddingLeft: 22, display: "flex", flexDirection: "column", gap: 2, marginTop: 2 }}>
                {ROAD_COLOR_MODES.map(({ key, label }) => (
                  <label key={key} style={{ ...itemStyle, padding: "1px 0" }}>
                    <input
                      type="radio"
                      name="roadColoring"
                      checked={roadColoring === key}
                      onChange={() => setRoadColoring(key)}
                      style={{ accentColor: "var(--purple)", margin: 0 }}
                    />
                    <span style={{ fontSize: 11, color: roadColoring === key ? "var(--text-primary)" : "var(--text-muted)" }}>
                      {label}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* ── Transit ── */}
          <div style={sectionHeading}>Transit</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 }}>

            {/* Bus routes — operator tree */}
            <label style={itemStyle}>
              <input
                type="checkbox"
                checked={overlays.busRoutes}
                onChange={() => toggleOverlay("busRoutes")}
                style={{ accentColor: "var(--purple)", margin: 0, flexShrink: 0 }}
              />
              <span style={{ color: overlays.busRoutes ? "var(--text-primary)" : "var(--text-muted)", lineHeight: 1.3 }}>
                Bus routes
              </span>
            </label>

            {/* CDTA operator + divisions (visible when bus routes is on) */}
            {overlays.busRoutes && (() => {
              const allOn  = CDTA_DIVISIONS.every((d) => cdtaDivisions[d.prefix]);
              const anyOn  = CDTA_DIVISIONS.some((d)  => cdtaDivisions[d.prefix]);
              return (
                <div style={{ paddingLeft: 16, display: "flex", flexDirection: "column", gap: 2 }}>
                  {/* CDTA operator row (indeterminate when some divisions off) */}
                  <label style={{ ...itemStyle, gap: 5 }}>
                    <input
                      type="checkbox"
                      checked={allOn}
                      ref={(el) => { if (el) el.indeterminate = !allOn && anyOn; }}
                      onChange={() => setAllCdtaDivisions(!allOn)}
                      style={{ accentColor: "var(--purple)", margin: 0, flexShrink: 0 }}
                    />
                    <span style={{ color: anyOn ? "var(--text-primary)" : "var(--text-muted)", fontSize: 11, fontWeight: 600, letterSpacing: "0.03em" }}>
                      CDTA
                    </span>
                  </label>
                  {/* Division rows */}
                  {CDTA_DIVISIONS.map(({ prefix, label }) => (
                    <label key={prefix} style={{ ...itemStyle, paddingLeft: 14, gap: 5 }}>
                      <input
                        type="checkbox"
                        checked={!!cdtaDivisions[prefix]}
                        onChange={() => toggleCdtaDivision(prefix)}
                        style={{ accentColor: "var(--purple)", margin: 0, flexShrink: 0 }}
                      />
                      <span style={{ color: cdtaDivisions[prefix] ? "var(--text-primary)" : "var(--text-muted)", fontSize: 11, lineHeight: 1.3 }}>
                        {label}
                      </span>
                    </label>
                  ))}
                </div>
              );
            })()}

            <label style={itemStyle}>
              <input
                type="checkbox"
                checked={overlays.busStops}
                onChange={() => toggleOverlay("busStops")}
                style={{ accentColor: "var(--purple)", margin: 0, flexShrink: 0 }}
              />
              <span style={{ color: overlays.busStops ? "var(--text-primary)" : "var(--text-muted)", lineHeight: 1.3 }}>
                Bus stops
              </span>
            </label>
            <label style={itemStyle}>
              <input
                type="checkbox"
                checked={overlays.railRoutes}
                onChange={() => toggleOverlay("railRoutes")}
                style={{ accentColor: "var(--purple)", margin: 0, flexShrink: 0 }}
              />
              <span style={{ color: overlays.railRoutes ? "var(--text-primary)" : "var(--text-muted)", flex: 1, lineHeight: 1.3 }}>
                Rail routes
              </span>
            </label>
            {/* Dynamic sync buttons for all configured feeds — hidden in demo */}
            {!demoMode && (feeds ?? []).map((feed) => (
              <div key={feed.slug} style={{ paddingLeft: 20 }}>
                <FeedSyncButton feed={feed} />
              </div>
            ))}
          </div>

          {/* ── Capital NY Bike Map ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 }}>
            <label style={itemStyle}>
              <input
                type="checkbox"
                checked={overlays.capitalNYBikeMap}
                onChange={() => toggleOverlay("capitalNYBikeMap")}
                style={{ accentColor: "var(--purple)", margin: 0, flexShrink: 0 }}
              />
              <span style={{ color: overlays.capitalNYBikeMap ? "var(--text-primary)" : "var(--text-muted)", lineHeight: 1.3 }}>
                Capital NY Bike Map
              </span>
            </label>

            {overlays.capitalNYBikeMap && (() => {
              const allOn = CAPITAL_NY_BIKE_LAYERS.every((l) => capitalNYBikeLayers[l.key]);
              const anyOn = CAPITAL_NY_BIKE_LAYERS.some((l) => capitalNYBikeLayers[l.key]);
              const groups = ["Infrastructure", "Amenities"] as const;
              return (
                <div style={{ paddingLeft: 16, display: "flex", flexDirection: "column", gap: 2 }}>
                  {/* All sub-layers master toggle */}
                  <label style={{ ...itemStyle, gap: 5 }}>
                    <input
                      type="checkbox"
                      checked={allOn}
                      ref={(el) => { if (el) el.indeterminate = !allOn && anyOn; }}
                      onChange={() => setAllCapitalNYBikeLayers(!allOn)}
                      style={{ accentColor: "var(--purple)", margin: 0, flexShrink: 0 }}
                    />
                    <span style={{ color: anyOn ? "var(--text-primary)" : "var(--text-muted)", fontSize: 11, fontWeight: 600, letterSpacing: "0.03em" }}>
                      All layers
                    </span>
                  </label>

                  {groups.map((group) => {
                    const groupLayers = CAPITAL_NY_BIKE_LAYERS.filter((l) => l.group === group);
                    const groupAllOn = groupLayers.every((l) => capitalNYBikeLayers[l.key]);
                    const groupAnyOn = groupLayers.some((l) => capitalNYBikeLayers[l.key]);
                    return (
                      <div key={group} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        {/* Group header */}
                        <label style={{ ...itemStyle, paddingLeft: 10, gap: 5 }}>
                          <input
                            type="checkbox"
                            checked={groupAllOn}
                            ref={(el) => { if (el) el.indeterminate = !groupAllOn && groupAnyOn; }}
                            onChange={() => groupLayers.forEach((l) => {
                              if (capitalNYBikeLayers[l.key] !== !groupAllOn)
                                toggleCapitalNYBikeLayer(l.key);
                            })}
                            style={{ accentColor: "var(--purple)", margin: 0, flexShrink: 0 }}
                          />
                          <span style={{ color: groupAnyOn ? "var(--text-primary)" : "var(--text-muted)", fontSize: 11, fontWeight: 600, letterSpacing: "0.03em" }}>
                            {group}
                          </span>
                        </label>
                        {/* Sub-layer rows */}
                        {groupLayers.map(({ key, label }) => (
                          <label key={key} style={{ ...itemStyle, paddingLeft: 22, gap: 5 }}>
                            <input
                              type="checkbox"
                              checked={!!capitalNYBikeLayers[key]}
                              onChange={() => toggleCapitalNYBikeLayer(key)}
                              style={{ accentColor: "var(--purple)", margin: 0, flexShrink: 0 }}
                            />
                            <span style={{ color: capitalNYBikeLayers[key] ? "var(--text-primary)" : "var(--text-muted)", fontSize: 11, lineHeight: 1.3 }}>
                              {label}
                            </span>
                          </label>
                        ))}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>

          {/* ── Remaining overlays — flat, no sub-headings ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {FLAT_OVERLAYS.map(({ key, label }) => {
              const disabled = demoMode && DEMO_UNSUPPORTED_OVERLAYS.has(key);
              return (
                <label
                  key={key}
                  style={{ ...itemStyle, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1 }}
                  title={disabled ? "Not available in demo" : undefined}
                >
                  <input
                    type="checkbox"
                    checked={!disabled && overlays[key]}
                    disabled={disabled}
                    onChange={() => !disabled && toggleOverlay(key)}
                    style={{ accentColor: "var(--purple)", margin: 0, flexShrink: 0 }}
                  />
                  <span style={{ color: overlays[key] && !disabled ? "var(--text-primary)" : "var(--text-muted)", lineHeight: 1.3 }}>
                    {label}
                  </span>
                </label>
              );
            })}
          </div>

        </div>
      )}
    </div>
  );
}
