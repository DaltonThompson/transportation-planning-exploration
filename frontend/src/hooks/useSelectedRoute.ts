/**
 * Selected-route highlight (always visible even when bus overlay is off).
 * Draws casing + color line for the active selection and applies a glow.
 */

import { useEffect } from "react";
import L from "leaflet";
import type { Selection } from "../store/useSelectionStore";

interface RouteShapesData {
  features: Array<{
    geometry: { type: string; coordinates: unknown };
    properties: Record<string, unknown>;
  }>;
}

export function useSelectedRoute(
  selRouteLayerRef: React.RefObject<L.LayerGroup | null>,
  busRoutesOverlayOn: boolean,
  selection: Selection | null,
  routeShapes: RouteShapesData | undefined,
  applyGlows: (sources: L.Path[]) => void,
) {
  useEffect(() => {
    const layer = selRouteLayerRef.current;
    if (!layer) return;
    layer.clearLayers();

    if (busRoutesOverlayOn || selection?.kind !== "route" || !selection.routes?.length) return;

    const features = routeShapes?.features ?? [];
    const selectedNames = new Set(selection.routes.map((r) => r.name));

    for (const feature of features) {
      if (feature.geometry.type !== "LineString") continue;
      const props = feature.properties;
      const name = String(props.route_short_name || props.route_long_name || props.route_id || "");
      if (!selectedNames.has(name)) continue;

      const coords = (feature.geometry.coordinates as number[][]).map(
        ([lon, lat]) => [lat, lon] as [number, number]
      );
      const color = String(props.route_color ?? "#4488ff");

      L.polyline(coords, {
        color: "#ffffff", weight: 11, opacity: 0.95,
        pane: "casingPane", interactive: false, className: "route-line",
      }).addTo(layer);

      const pl = L.polyline(coords, {
        color, weight: 6, opacity: 0.95,
        pane: "routePane", interactive: false, className: "route-line",
      }).addTo(layer);

      applyGlows([pl]);
    }
  }, [selection, busRoutesOverlayOn, routeShapes, applyGlows, selRouteLayerRef]);
}
