/**
 * Dynamic map legend — floats bottom-left inside the map container.
 * Renders only the entries relevant to active layers / road coloring mode.
 */

import React from "react";
import { useLayerStore, CAPITAL_NY_BIKE_LAYERS } from "../store/useLayerStore";

// ── Shared primitives ─────────────────────────────────────────────────────────

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "2px 0" }}>
      {children}
    </div>
  );
}

function Swatch({ color, border }: { color: string; border?: string }) {
  return (
    <div style={{
      width: 14, height: 14, borderRadius: 2, flexShrink: 0,
      background: color,
      border: border ?? "1px solid rgba(255,255,255,0.15)",
    }} />
  );
}

function LineSwatch({ color, dashed, weight = 3 }: { color: string; dashed?: boolean; weight?: number }) {
  return (
    <svg width={28} height={14} style={{ flexShrink: 0 }}>
      <line
        x1={2} y1={7} x2={26} y2={7}
        stroke={color}
        strokeWidth={weight}
        strokeDasharray={dashed ? "6 3" : undefined}
        strokeLinecap="round"
      />
    </svg>
  );
}

function RailSwatch() {
  return (
    <svg width={28} height={14} style={{ flexShrink: 0 }}>
      <line x1={2} y1={7} x2={26} y2={7} stroke="#333" strokeWidth={7} strokeLinecap="round" />
      <line x1={2} y1={7} x2={26} y2={7} stroke="#eee" strokeWidth={2} strokeDasharray="6 3" strokeLinecap="round" />
    </svg>
  );
}

function GradientBar({ from, to, labelLeft, labelRight }: {
  from: string; to: string; labelLeft: string; labelRight: string;
}) {
  return (
    <div style={{ paddingTop: 1 }}>
      <div style={{
        width: 110,
        height: 10,
        borderRadius: 3,
        background: `linear-gradient(to right, ${from}, ${to})`,
        border: "1px solid rgba(255,255,255,0.1)",
      }} />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
        <span style={{ fontSize: 9, color: "var(--text-muted)" }}>{labelLeft}</span>
        <span style={{ fontSize: 9, color: "var(--text-muted)" }}>{labelRight}</span>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 9, fontWeight: 700, letterSpacing: 0.8,
      textTransform: "uppercase", color: "var(--purple)",
      marginTop: 7, marginBottom: 2,
    }}>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 11, color: "var(--text-primary)", lineHeight: 1.3 }}>{children}</span>;
}

// ── Legend entries per layer ──────────────────────────────────────────────────

function RoadColoringLegend({ mode }: { mode: string }) {
  if (mode === "none") return null;
  return (
    <>
      <SectionLabel>Road coloring</SectionLabel>
      {mode === "congestion" && (
        <GradientBar from="rgb(0,255,0)" to="rgb(255,0,0)" labelLeft="Free flow" labelRight="Congested" />
      )}
      {mode === "roadSpeed" && (
        <GradientBar from="rgb(20,100,200)" to="rgb(100,255,255)" labelLeft="15 kph" labelRight="105+ kph" />
      )}
      {mode === "throughVsLocal" && (
        <GradientBar from="rgb(0,80,200)" to="rgb(255,0,200)" labelLeft="Local" labelRight="Through" />
      )}
      {mode === "collisions" && (
        <GradientBar from="rgb(51,51,51)" to="rgb(255,60,0)" labelLeft="Few" labelRight="Many" />
      )}
    </>
  );
}

function BusRoutesLegend() {
  return (
    <>
      <SectionLabel>Bus routes</SectionLabel>
      <Row><LineSwatch color="#4488ff" /><Label>Bus routes</Label></Row>
    </>
  );
}

function BusStopsLegend() {
  return (
    <>
      <SectionLabel>Bus stops</SectionLabel>
      <Row><Swatch color="#4dabf7" /><Label>Stop — ≤ 5 min headway</Label></Row>
      <Row><Swatch color="#69db7c" /><Label>Stop — ≤ 10 min headway</Label></Row>
      <Row><Swatch color="#ffd43b" /><Label>Stop — ≤ 30 min headway</Label></Row>
      <Row><Swatch color="#ff6b6b" /><Label>Stop — &gt; 30 min headway</Label></Row>
    </>
  );
}

function RailRoutesLegend() {
  return (
    <>
      <SectionLabel>Rail</SectionLabel>
      <Row><RailSwatch /><Label>Rail route</Label></Row>
    </>
  );
}

const BIKE_LAYER_LEGEND: Record<string, { swatch: React.ReactNode; label: string }> = {
  lane:        { swatch: <LineSwatch color="#339af0" />, label: "On-street bike lane"     },
  path:        { swatch: <LineSwatch color="#00d084" />, label: "Bike / pedestrian path"  },
  unpaved:     { swatch: <LineSwatch color="#ff922b" />, label: "Unpaved path"            },
  sidewalk:    { swatch: <LineSwatch color="#adb5bd" />, label: "Sidewalk"                },
  sharedLight: { swatch: <LineSwatch color="#cc5de8" />, label: "Shared street — light"   },
  sharedHeavy: { swatch: <LineSwatch color="#ff6b6b" />, label: "Shared street — heavy"   },
  parking:     { swatch: <Swatch color="#339af0" />,     label: "Bike parking"            },
  shop:        { swatch: <Swatch color="#00d084" />,     label: "Bike shop"               },
  repair:      { swatch: <Swatch color="#ff922b" />,     label: "Self-service repair"     },
  restroom:    { swatch: <Swatch color="#adb5bd" />,     label: "Restroom"                },
  caution:     { swatch: <Swatch color="#ffd43b" />,     label: "Caution area"            },
};

function CapitalNYBikeMapLegend({ layers }: { layers: Record<string, boolean> }) {
  const active = CAPITAL_NY_BIKE_LAYERS.filter((l) => layers[l.key]);
  if (active.length === 0) return null;
  const infra    = active.filter((l) => l.group === "Infrastructure");
  const amenity  = active.filter((l) => l.group === "Amenities");
  return (
    <>
      <SectionLabel>Capital NY Bike Map</SectionLabel>
      {infra.length > 0 && infra.map(({ key }) => (
        <Row key={key}>{BIKE_LAYER_LEGEND[key].swatch}<Label>{BIKE_LAYER_LEGEND[key].label}</Label></Row>
      ))}
      {amenity.length > 0 && infra.length > 0 && (
        <div style={{ fontSize: 9, fontWeight: 600, color: "var(--text-muted)", marginTop: 4, marginBottom: 1 }}>Amenities</div>
      )}
      {amenity.map(({ key }) => (
        <Row key={key}>{BIKE_LAYER_LEGEND[key].swatch}<Label>{BIKE_LAYER_LEGEND[key].label}</Label></Row>
      ))}
    </>
  );
}

function BikeOSMLegend() {
  return (
    <>
      <SectionLabel>Bike infrastructure (OSM)</SectionLabel>
      <Row><LineSwatch color="#51cf66" /><Label>OSM cycleway / bike route</Label></Row>
    </>
  );
}

function WalkLegend() {
  return (
    <>
      <SectionLabel>Walk to bus stop</SectionLabel>
      <Row><Swatch color="#69db7c44" border="1px solid #69db7c88" /><Label>≤ 400 m walk</Label></Row>
      <Row><Swatch color="#ffd43b33" border="1px solid #ffd43b88" /><Label>≤ 800 m walk</Label></Row>
      <Row><Swatch color="#ff6b6b26" border="1px solid #ff6b6b88" /><Label>&gt; 800 m walk</Label></Row>
    </>
  );
}

function CollisionLegend() {
  return (
    <>
      <SectionLabel>Collision hotspots</SectionLabel>
      <Row><Swatch color="#ff880044" border="1px solid #ff8800" /><Label>Hotspot junction</Label></Row>
      <Row><Swatch color="#ff000066" border="1px solid #ff0000" /><Label>High-collision junction</Label></Row>
    </>
  );
}

function ZoningLegend() {
  return (
    <>
      <SectionLabel>Zoning</SectionLabel>
      <Row><Swatch color="#69db7c44" border="1px solid #69db7c88" /><Label>Residential</Label></Row>
      <Row><Swatch color="#ffd43b44" border="1px solid #ffd43b88" /><Label>Commercial</Label></Row>
      <Row><Swatch color="#ff6b6b44" border="1px solid #ff6b6b88" /><Label>Industrial</Label></Row>
      <Row><Swatch color="#a78bfa44" border="1px solid #a78bfa88" /><Label>Mixed use</Label></Row>
      <Row><Swatch color="#74c69d44" border="1px solid #74c69d88" /><Label>Agricultural</Label></Row>
      <Row><Swatch color="#2d6a4f44" border="1px solid #2d6a4f88" /><Label>Parks / open space</Label></Row>
    </>
  );
}

function JobsLegend() {
  return (
    <>
      <SectionLabel>Jobs concentration</SectionLabel>
      <Row>
        <svg width={18} height={18} style={{ flexShrink: 0 }}>
          <circle cx={9} cy={9} r={7} fill="#fff" fillOpacity={0.7} stroke="#fff" strokeWidth={1} />
        </svg>
        <Label>Block — size = job count</Label>
      </Row>
    </>
  );
}

function PopulationLegend() {
  return (
    <>
      <SectionLabel>Population density</SectionLabel>
      <Row>
        <Swatch color="linear-gradient(135deg,#aaa,#555)" border="1px solid #888" />
        <Label>Census tract density (WMS)</Label>
      </Row>
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function MapLegend() {
  const { roadColoring, overlays, capitalNYBikeLayers } = useLayerStore();

  const hasRoadColoring  = roadColoring !== "none";
  const anyOverlay       = Object.values(overlays).some(Boolean);
  const visible          = hasRoadColoring || anyOverlay;

  if (!visible) return null;

  return (
    <div style={{
      position: "absolute",
      bottom: 28,
      left: 12,
      zIndex: 1000,
      background: "var(--bg-primary)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius)",
      padding: "8px 11px 10px",
      boxShadow: "var(--shadow)",
      fontFamily: "var(--font-sans)",
      fontSize: 11,
      minWidth: 155,
      maxWidth: 210,
      maxHeight: "calc(100vh - 120px)",
      overflowY: "auto",
      pointerEvents: "none",   // don't block map interaction
    }}>
      <div style={{ fontWeight: 700, fontSize: 11, color: "var(--text-primary)", marginBottom: 4 }}>
        Legend
      </div>

      <RoadColoringLegend mode={roadColoring} />
      {overlays.busRoutes         && <BusRoutesLegend />}
      {overlays.busStops          && <BusStopsLegend />}
      {overlays.railRoutes        && <RailRoutesLegend />}
      {overlays.capitalNYBikeMap  && <CapitalNYBikeMapLegend layers={capitalNYBikeLayers} />}
      {overlays.bikeInfraOSM      && <BikeOSMLegend />}
      {overlays.walkToBusStop     && <WalkLegend />}
      {overlays.collisionJunctions && <CollisionLegend />}
      {overlays.zoning            && <ZoningLegend />}
      {(overlays.jobs || overlays.economicActivity) && <JobsLegend />}
      {overlays.populationDensity && <PopulationLegend />}
    </div>
  );
}
