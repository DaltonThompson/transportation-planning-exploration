/**
 * Edge click/hover interactions:
 *   - Normal mode: segment selection popup (G1)
 *   - selectingEdge mode: single-edge pick for patch editor (G2)
 *   - selectingCorridorEdges mode: multi-select + rubber-band (G3)
 */

import { useEffect } from "react";
import L from "leaflet";
import { useLayerStore } from "../store/useLayerStore";
import { useSelectionStore } from "../store/useSelectionStore";
import { useSimStore } from "../store/useSimStore";
import { congestionColor } from "../utils/mapColors";
import { nearbyBikeFeatures } from "../utils/mapGeometry";
import type { EdgeGeometry } from "../components/MapRenderer";

export function useEdgeInteraction(
  mapRef: React.RefObject<L.Map | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  polylineRef: React.RefObject<Map<number, L.Polyline>>,
  geomRef: React.RefObject<Map<number, EdgeGeometry>>,
  rubberBandRef: React.RefObject<L.Rectangle | null>,
  dragStartRef: React.RefObject<L.LatLng | null>,
  isDraggingRef: React.RefObject<boolean>,
  bikeDataRef: React.RefObject<{ geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }[]>,
  applyGlows: (sources: L.Path[]) => void,
) {
  const edgeState = useSimStore((s) => s.edgeState);
  const {
    selectingEdge, setSelectedEdgeId,
    selectingCorridorEdges, corridorEdgeSelection, toggleCorridorEdge,
  } = useLayerStore();
  const { setSelection } = useSelectionStore();

  // ── Click/hover handlers ────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current) return;

    if (!polylineRef.current) return;
    for (const [edgeId, pl] of polylineRef.current) {
      pl.off();

      if (selectingCorridorEdges) {
        const inSel = corridorEdgeSelection.has(edgeId);
        pl.setStyle({ color: inSel ? "#facc15" : "#666", weight: inSel ? 4 : 2, opacity: inSel ? 1 : 0.5 });
        pl.on("click", (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          toggleCorridorEdge(edgeId);
        });
        pl.on("mouseover", () => { if (!corridorEdgeSelection.has(edgeId)) pl.setStyle({ color: "#aaa", weight: 3 }); });
        pl.on("mouseout",  () => { if (!corridorEdgeSelection.has(edgeId)) pl.setStyle({ color: "#666", weight: 2 }); });

      } else if (selectingEdge) {
        pl.on("mouseover", () => pl.setStyle({ color: "#fff", weight: 4, opacity: 1 }));
        pl.on("mouseout",  () => {
          const state = edgeState[edgeId];
          pl.setStyle({ color: state ? congestionColor(state.c) : "#555", weight: state ? 2 + state.c * 2 : 2 });
        });
        pl.on("click", (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          setSelectedEdgeId(edgeId);
          pl.setStyle({ color: "#ffffff", weight: 5 });
          setTimeout(() => {
            const s = edgeState[edgeId];
            pl.setStyle({ color: s ? congestionColor(s.c) : "#555", weight: s ? 2 + s.c * 2 : 2 });
          }, 600);
        });

      } else {
        pl.on("click", (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          const geom = geomRef.current?.get(edgeId);
          applyGlows([pl]);
          const bikeFeatures = nearbyBikeFeatures(e.latlng, bikeDataRef.current ?? []);
          setSelection({
            kind: "segment",
            edgeId,
            roadName: geom?.road_name || undefined,
            roadHighway: geom?.highway || undefined,
            bikeFeatures: bikeFeatures.length ? bikeFeatures : undefined,
          });
        });
      }
    }
  }, [selectingEdge, selectingCorridorEdges, corridorEdgeSelection, edgeState, applyGlows,
      mapRef, polylineRef, geomRef, bikeDataRef, setSelectedEdgeId, toggleCorridorEdge, setSelection]);

  // ── Cursor mode ─────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.style.cursor = (selectingEdge || selectingCorridorEdges) ? "crosshair" : "";
  }, [selectingEdge, selectingCorridorEdges, containerRef]);

  // ── Rubber-band corridor selection (G3) ─────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!selectingCorridorEdges) {
      map.dragging.enable();
      rubberBandRef.current?.remove();
      (rubberBandRef as React.MutableRefObject<L.Rectangle | null>).current = null;
      (dragStartRef as React.MutableRefObject<L.LatLng | null>).current = null;
      (isDraggingRef as React.MutableRefObject<boolean>).current = false;
      return;
    }

    map.dragging.disable();
    const mapInstance = map;

    function onMouseDown(e: L.LeafletMouseEvent) {
      (dragStartRef as React.MutableRefObject<L.LatLng | null>).current = e.latlng;
      (isDraggingRef as React.MutableRefObject<boolean>).current = false;
      rubberBandRef.current?.remove();
    }
    function onMouseMove(e: L.LeafletMouseEvent) {
      if (!dragStartRef.current) return;
      (isDraggingRef as React.MutableRefObject<boolean>).current = true;
      const bounds = L.latLngBounds(dragStartRef.current, e.latlng);
      if (rubberBandRef.current) {
        rubberBandRef.current.setBounds(bounds);
      } else {
        (rubberBandRef as React.MutableRefObject<L.Rectangle | null>).current = L.rectangle(bounds, {
          color: "#a78bfa", weight: 1, fill: true,
          fillColor: "#a78bfa", fillOpacity: 0.1,
          dashArray: "4 4", interactive: false,
        }).addTo(mapInstance);
      }
    }
    function onMouseUp(e: L.LeafletMouseEvent) {
      if (!dragStartRef.current || !isDraggingRef.current) {
        (dragStartRef as React.MutableRefObject<L.LatLng | null>).current = null;
        (isDraggingRef as React.MutableRefObject<boolean>).current = false;
        return;
      }
      const bounds = L.latLngBounds(dragStartRef.current, e.latlng);
      for (const [edgeId, pl] of (polylineRef.current ?? [])) {
        const lls = pl.getLatLngs() as L.LatLng[];
        const mid = lls[Math.floor(lls.length / 2)];
        if (bounds.contains(mid) && !corridorEdgeSelection.has(edgeId)) {
          toggleCorridorEdge(edgeId);
        }
      }
      rubberBandRef.current?.remove();
      (rubberBandRef as React.MutableRefObject<L.Rectangle | null>).current = null;
      (dragStartRef as React.MutableRefObject<L.LatLng | null>).current = null;
      (isDraggingRef as React.MutableRefObject<boolean>).current = false;
    }

    map.on("mousedown", onMouseDown);
    map.on("mousemove", onMouseMove);
    map.on("mouseup",   onMouseUp);
    return () => {
      map.off("mousedown", onMouseDown);
      map.off("mousemove", onMouseMove);
      map.off("mouseup",   onMouseUp);
      rubberBandRef.current?.remove();
      (rubberBandRef as React.MutableRefObject<L.Rectangle | null>).current = null;
    };
  }, [selectingCorridorEdges, corridorEdgeSelection, mapRef, polylineRef, rubberBandRef,
      dragStartRef, isDraggingRef, toggleCorridorEdge]);

  // Re-enable dragging when corridor mode turns off
  useEffect(() => {
    if (!selectingCorridorEdges) mapRef.current?.dragging.enable();
  }, [selectingCorridorEdges, mapRef]);
}
