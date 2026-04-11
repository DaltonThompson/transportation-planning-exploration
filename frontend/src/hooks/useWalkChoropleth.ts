/** Walking distance to bus stop choropleth (D3). */

import { useEffect } from "react";
import L from "leaflet";
import type { StopRecord } from "../api/client";

export function useWalkChoropleth(
  walkLayerRef: React.RefObject<L.LayerGroup | null>,
  mapRef: React.RefObject<L.Map | null>,
  enabled: boolean,
  stopsData: StopRecord[] | undefined,
) {
  useEffect(() => {
    const layer = walkLayerRef.current;
    const map   = mapRef.current;
    if (!layer || !map) return;
    layer.clearLayers();
    if (!enabled || !stopsData || stopsData.length === 0) return;

    const bounds  = map.getBounds();
    const latStep = 0.002;  // ~220m
    const lngStep = 0.003;  // ~220m at Albany latitude

    let lat = bounds.getSouth();
    while (lat < bounds.getNorth()) {
      let lng = bounds.getWest();
      while (lng < bounds.getEast()) {
        let minDist = Infinity;
        for (const s of stopsData) {
          const dlat = (s.lat - lat) * 111320;
          const dlng = (s.lng - lng) * 111320 * Math.cos((lat * Math.PI) / 180);
          const d = Math.sqrt(dlat * dlat + dlng * dlng);
          if (d < minDist) minDist = d;
        }

        let fillColor: string;
        let fillOpacity: number;
        if (minDist <= 400) {
          fillColor = "#69db7c"; fillOpacity = 0.25;
        } else if (minDist <= 800) {
          fillColor = "#ffd43b"; fillOpacity = 0.20;
        } else {
          fillColor = "#ff6b6b"; fillOpacity = 0.15;
        }

        L.rectangle(
          [[lat, lng], [lat + latStep, lng + lngStep]],
          { color: "none", weight: 0, fillColor, fillOpacity }
        ).addTo(layer);

        lng += lngStep;
      }
      lat += latStep;
    }
  }, [enabled, stopsData, walkLayerRef, mapRef]);
}
