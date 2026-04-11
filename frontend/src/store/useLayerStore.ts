import { create } from "zustand";
import { SIMULATION_ENABLED } from "../utils/simulationFlag";

export interface Corridor {
  id: string;
  name: string;
  edge_ids: number[];
}

export type Basemap = "dark" | "osm" | "satellite" | "terrain";

/**
 * Exclusive road-segment coloring modes.
 * Only one can be active at a time; they all drive the same edge polyline color.
 */
export type RoadColorMode =
  | "none"
  | "congestion"
  | "roadSpeed"
  | "throughVsLocal"
  | "collisions";

/**
 * Independent overlay toggles — each adds its own geometry layer(s) on top of
 * the road network and does not conflict with other overlays or road coloring.
 */
export interface OverlayState {
  // Transit
  busRoutes: boolean;
  busStops: boolean;
  railRoutes: boolean;
  // Active transport
  capitalNYBikeMap: boolean;
  bikeInfraOSM: boolean;
  walkToBusStop: boolean;
  // External data
  collisionJunctions: boolean;   // junction hotspot circles (separate from road coloring)
  populationDensity: boolean;
  zoning: boolean;
  economicActivity: boolean;
  jobs: boolean;
}

export interface CapitalNYBikeLayer {
  key: string;
  label: string;
  group: "Infrastructure" | "Amenities";
}

export const CAPITAL_NY_BIKE_LAYERS: CapitalNYBikeLayer[] = [
  // Infrastructure (line layers)
  { key: "lane",        label: "On-street bike lane",       group: "Infrastructure" },
  { key: "path",        label: "Bike / pedestrian path",    group: "Infrastructure" },
  { key: "unpaved",     label: "Unpaved path",              group: "Infrastructure" },
  { key: "sidewalk",    label: "Sidewalk",                  group: "Infrastructure" },
  { key: "sharedLight", label: "Shared street — light",     group: "Infrastructure" },
  { key: "sharedHeavy", label: "Shared street — heavy",     group: "Infrastructure" },
  // Amenities (point layers)
  { key: "parking",     label: "Bike parking",              group: "Amenities" },
  { key: "shop",        label: "Bike shop",                 group: "Amenities" },
  { key: "repair",      label: "Self-service repair",       group: "Amenities" },
  { key: "restroom",    label: "Restroom",                  group: "Amenities" },
  { key: "caution",     label: "Caution area",              group: "Amenities" },
];

const DEFAULT_CAPITAL_NY_BIKE_LAYERS: Record<string, boolean> = Object.fromEntries(
  CAPITAL_NY_BIKE_LAYERS.map((l) => [l.key, true])
);

export const CDTA_DIVISIONS: { prefix: string; label: string }[] = [
  { prefix: "1", label: "Albany (100s)"           },
  { prefix: "2", label: "Troy (200s)"             },
  { prefix: "3", label: "Schenectady (300s)"      },
  { prefix: "4", label: "Saratoga & Glens Falls (400s)" },
  { prefix: "5", label: "Express (500s)"          },
  { prefix: "6", label: "Amsterdam (600s)"        },
  { prefix: "7", label: "Commuter (700s)"         },
  { prefix: "8", label: "School & Shuttles (800s)"},
  { prefix: "9", label: "Bus Rapid Transit (900s)"},
];

// All divisions enabled by default
const DEFAULT_CDTA_DIVISIONS: Record<string, boolean> = Object.fromEntries(
  CDTA_DIVISIONS.map((d) => [d.prefix, true])
);

interface LayerStore {
  basemap: Basemap;
  roadColoring: RoadColorMode;
  overlays: OverlayState;
  cdtaDivisions: Record<string, boolean>;
  capitalNYBikeLayers: Record<string, boolean>;

  // Single edge selection (G2)
  selectingEdge: boolean;
  selectedEdgeId: number | null;

  // Corridor multi-select (G3)
  selectingCorridorEdges: boolean;
  corridorEdgeSelection: Set<number>;

  // Saved corridors
  corridors: Corridor[];

  // Actions
  setBasemap: (b: Basemap) => void;
  setRoadColoring: (mode: RoadColorMode) => void;
  toggleOverlay: (key: keyof OverlayState) => void;
  toggleCdtaDivision: (prefix: string) => void;
  setAllCdtaDivisions: (enabled: boolean) => void;
  toggleCapitalNYBikeLayer: (key: string) => void;
  setAllCapitalNYBikeLayers: (enabled: boolean) => void;

  setSelectingEdge: (v: boolean) => void;
  setSelectedEdgeId: (id: number | null) => void;

  startCorridorSelection: () => void;
  toggleCorridorEdge: (id: number) => void;
  confirmCorridor: (name: string) => string;
  cancelCorridorSelection: () => void;
  deleteCorridor: (id: string) => void;
}

export const useLayerStore = create<LayerStore>((set, get) => ({
  basemap: "dark",
  roadColoring: SIMULATION_ENABLED ? "congestion" : "roadSpeed",
  cdtaDivisions: { ...DEFAULT_CDTA_DIVISIONS },
  capitalNYBikeLayers: { ...DEFAULT_CAPITAL_NY_BIKE_LAYERS },
  overlays: {
    busRoutes: true,
    busStops: false,
    railRoutes: false,
    capitalNYBikeMap: false,
    bikeInfraOSM: false,
    walkToBusStop: false,
    collisionJunctions: false,
    populationDensity: false,
    zoning: false,
    economicActivity: false,
    jobs: false,
  },

  selectingEdge: false,
  selectedEdgeId: null,

  selectingCorridorEdges: false,
  corridorEdgeSelection: new Set<number>(),

  corridors: [],

  setBasemap: (b) => set({ basemap: b }),

  setRoadColoring: (mode) => set({ roadColoring: mode }),

  toggleOverlay: (key) =>
    set((s) => ({
      overlays: { ...s.overlays, [key]: !s.overlays[key] },
    })),

  toggleCdtaDivision: (prefix) =>
    set((s) => ({
      cdtaDivisions: { ...s.cdtaDivisions, [prefix]: !s.cdtaDivisions[prefix] },
    })),

  setAllCdtaDivisions: (enabled) =>
    set({ cdtaDivisions: Object.fromEntries(CDTA_DIVISIONS.map((d) => [d.prefix, enabled])) }),

  toggleCapitalNYBikeLayer: (key) =>
    set((s) => ({ capitalNYBikeLayers: { ...s.capitalNYBikeLayers, [key]: !s.capitalNYBikeLayers[key] } })),

  setAllCapitalNYBikeLayers: (enabled) =>
    set({ capitalNYBikeLayers: Object.fromEntries(CAPITAL_NY_BIKE_LAYERS.map((l) => [l.key, enabled])) }),

  setSelectingEdge: (v) =>
    set({ selectingEdge: v, selectedEdgeId: v ? null : get().selectedEdgeId }),

  setSelectedEdgeId: (id) => set({ selectedEdgeId: id, selectingEdge: false }),

  startCorridorSelection: () =>
    set({ selectingCorridorEdges: true, corridorEdgeSelection: new Set<number>() }),

  toggleCorridorEdge: (id) => {
    const sel = new Set(get().corridorEdgeSelection);
    if (sel.has(id)) sel.delete(id);
    else sel.add(id);
    set({ corridorEdgeSelection: sel });
  },

  confirmCorridor: (name) => {
    const id = crypto.randomUUID();
    const edge_ids = Array.from(get().corridorEdgeSelection);
    set((s) => ({
      corridors: [...s.corridors, { id, name, edge_ids }],
      selectingCorridorEdges: false,
      corridorEdgeSelection: new Set<number>(),
    }));
    return id;
  },

  cancelCorridorSelection: () =>
    set({ selectingCorridorEdges: false, corridorEdgeSelection: new Set<number>() }),

  deleteCorridor: (id) =>
    set((s) => ({ corridors: s.corridors.filter((c) => c.id !== id) })),
}));
