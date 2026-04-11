/** LODES jobs layer (M2). */

import { useEffect } from "react";
import L from "leaflet";
import type { LodesFeature } from "../api/client";

interface LodesResponse {
  status: string;
  features: LodesFeature[];
}

export function useLodesLayer(
  lodesLayerRef: React.RefObject<L.LayerGroup | null>,
  enabled: boolean,
  lodesData: LodesResponse | undefined,
) {
  useEffect(() => {
    const layer = lodesLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!enabled || !lodesData) return;
    if (lodesData.status === "not_imported") return;

    for (const pt of lodesData.features) {
      if (!pt.jobs || pt.jobs < 1) continue;
      const r = Math.max(3, Math.min(20, Math.log(pt.jobs) * 2));
      L.circleMarker([pt.lat, pt.lng], {
        radius: r,
        color: "#b45309",
        weight: 1,
        fillColor: "#ffd43b",
        fillOpacity: 0.7,
      })
        .bindTooltip(`${pt.jobs.toLocaleString()} jobs`, { sticky: true })
        .addTo(layer);
    }
  }, [enabled, lodesData, lodesLayerRef]);
}
