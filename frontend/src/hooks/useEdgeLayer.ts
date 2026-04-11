/**
 * Manages road-edge polylines on the Leaflet map:
 *   - Creates/removes polylines when edgeGeometries changes
 *   - Recolors them when roadColoring mode or edgeState changes
 */

import { useEffect } from "react";
import L from "leaflet";
import { useSimStore } from "../store/useSimStore";
import { useLayerStore } from "../store/useLayerStore";
import { congestionColor, speedColor, throughVsLocalColor } from "../utils/mapColors";
import { THROUGH_HIGHWAY_TYPES } from "../utils/mapGeometry";
import type { EdgeGeometry } from "../components/MapRenderer";
import type { CollisionSegment } from "../api/client";

export function useEdgeLayer(
  mapRef:       React.RefObject<L.Map | null>,
  polylineRef:  React.MutableRefObject<Map<number, L.Polyline>>,
  geomRef:      React.MutableRefObject<Map<number, EdgeGeometry>>,
  edgeGeometries: EdgeGeometry[],
  collisionData: { segments: CollisionSegment[] } | undefined,
) {
  const edgeState    = useSimStore((s) => s.edgeState);
  const { roadColoring } = useLayerStore();

  // ── Draw polylines ─────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || edgeGeometries.length === 0) return;
    polylineRef.current.forEach((pl) => pl.remove());
    polylineRef.current.clear();
    geomRef.current.clear();
    for (const eg of edgeGeometries) {
      geomRef.current.set(eg.id, eg);
      const pl = L.polyline(eg.coords, { color: "#555", weight: 2, opacity: 0.7 }).addTo(map);
      polylineRef.current.set(eg.id, pl);
    }
  }, [edgeGeometries, mapRef, polylineRef, geomRef]);

  // ── Recolor polylines ──────────────────────────────────────────────────
  useEffect(() => {
    for (const [edgeId, pl] of polylineRef.current) {
      const geom  = geomRef.current.get(edgeId);
      const state = edgeState[edgeId];

      switch (roadColoring) {
        case "roadSpeed":
          pl.setStyle(geom?.speed_limit_kmh
            ? { color: speedColor(geom.speed_limit_kmh), weight: 3, opacity: 0.85, dashArray: undefined }
            : { color: "#444", weight: 2, opacity: 0.5, dashArray: undefined });
          break;

        case "throughVsLocal": {
          const ratio = geom?.aadt_count != null
            ? Math.min(1, geom.aadt_count / 50000)
            : (THROUGH_HIGHWAY_TYPES.has(geom?.highway ?? "") ? 0.8 : 0.2);
          pl.setStyle({
            color: throughVsLocalColor(ratio), weight: 3, opacity: 0.85,
            dashArray: geom?.aadt_count != null ? undefined : "4 3",
          });
          break;
        }

        case "collisions": {
          const seg = collisionData?.segments.find((s) => s.edge_id === edgeId);
          if (seg) {
            const intensity = Math.min(1, seg.count / 20);
            pl.setStyle({
              color: `rgb(${Math.round(255 * intensity)},${Math.round(60 * (1 - intensity))},0)`,
              weight: 2 + intensity * 4, opacity: 0.9, dashArray: undefined,
            });
          } else {
            pl.setStyle({ color: "#333", weight: 2, opacity: 0.4, dashArray: undefined });
          }
          break;
        }

        case "congestion":
          pl.setStyle(state
            ? { color: congestionColor(state.c), weight: 2 + state.c * 2, opacity: 0.9, dashArray: undefined }
            : { color: "#555", weight: 2, opacity: 0.7, dashArray: undefined });
          break;

        case "none":
          pl.setStyle({ opacity: 0, weight: 0 });
          break;

        default:
          pl.setStyle({ color: "#555", weight: 2, opacity: 0.7, dashArray: undefined });
      }
    }
  }, [edgeState, roadColoring, collisionData, polylineRef, geomRef]);
}
