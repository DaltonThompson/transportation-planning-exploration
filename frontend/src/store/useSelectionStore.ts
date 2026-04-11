import { create } from "zustand";

export interface SelectedRoute {
  routeId: string;
  name: string;
  color: string;
  feedSlug: string;
  routeType: number;
}

export type SelectionKind = "stop" | "route" | "segment" | "bike";

export interface Selection {
  kind: SelectionKind;
  // stop
  stopId?: string;
  // route(s) — co-located routes shown together
  routes?: SelectedRoute[];
  // road segment
  edgeId?: number;
  roadName?: string;
  roadHighway?: string;
  // bike infrastructure feature properties (raw OSM) — for bike kind
  bikeProps?: Record<string, unknown>;
  // nearby bike features — attached to route/segment/stop kinds
  bikeFeatures?: Array<Record<string, unknown>>;
}

interface SelectionStore {
  selection: Selection | null;
  setSelection: (s: Selection | null) => void;
  clearSelection: () => void;
}

export const useSelectionStore = create<SelectionStore>((set) => ({
  selection: null,
  setSelection: (s) => set({ selection: s }),
  clearSelection: () => set({ selection: null }),
}));
