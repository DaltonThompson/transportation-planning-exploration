/** Bus stop circle markers (D2b). */

import { useEffect } from "react";
import L from "leaflet";
import type { StopRecord } from "../api/client";
import { useSelectionStore } from "../store/useSelectionStore";
import { headwayColor } from "../utils/mapColors";
import { nearbyBikeFeatures } from "../utils/mapGeometry";

export function useBusStops(
  busStopLayerRef: React.RefObject<L.LayerGroup | null>,
  stopMarkerRef: React.RefObject<Map<string, L.CircleMarker>>,
  enabled: boolean,
  stopsData: StopRecord[] | undefined,
  applyGlows: (sources: L.Path[]) => void,
  bikeDataRef: React.RefObject<{ geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }[]>,
) {
  const { setSelection } = useSelectionStore();

  useEffect(() => {
    const stopLayer = busStopLayerRef.current;
    if (!stopLayer) return;
    stopLayer.clearLayers();
    if (!stopMarkerRef.current) return;
    stopMarkerRef.current.clear();
    if (!enabled || !stopsData) return;

    const sortedStops = [...stopsData].sort((a, b) => b.headway_s - a.headway_s);
    for (const stop of sortedStops) {
      const marker = L.circleMarker([stop.lat, stop.lng], {
        radius: 6,
        color: "#222",
        weight: 1,
        fillColor: headwayColor(stop.headway_s),
        fillOpacity: 0.85,
      })
        .bindTooltip(
          `${stop.name ? stop.name + "<br>" : ""}Stop ${stop.id}<br>${Math.round(stop.headway_s / 60)} min headway`,
          { sticky: true }
        )
        .addTo(stopLayer);

      stopMarkerRef.current.set(stop.id, marker);

      marker.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        applyGlows([marker]);
        const bikeFeatures = nearbyBikeFeatures(e.latlng, bikeDataRef.current ?? []);
        setSelection({
          kind: "stop", stopId: stop.id,
          bikeFeatures: bikeFeatures.length ? bikeFeatures : undefined,
        });
      });
    }
  }, [enabled, stopsData, applyGlows, busStopLayerRef, stopMarkerRef, bikeDataRef, setSelection]);
}
