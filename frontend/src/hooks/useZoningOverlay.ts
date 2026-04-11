/** Zoning overlay (L1). */

import { useEffect } from "react";
import L from "leaflet";
import { zoningColor } from "./useZoningLayer";
import type { ZoningFeature } from "./useZoningLayer";

interface ZoningLayerResult {
  features: ZoningFeature[];
}

export function useZoningOverlay(
  zoningLayerRef: React.RefObject<L.LayerGroup | null>,
  enabled: boolean,
  zoningLayer: ZoningLayerResult,
) {
  useEffect(() => {
    const layer = zoningLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!enabled || zoningLayer.features.length === 0) return;

    L.geoJSON(
      { type: "FeatureCollection", features: zoningLayer.features } as GeoJSON.FeatureCollection,
      {
        style: (feature) => {
          const cls = String(feature?.properties?.ZONE_CLASS ?? "");
          return { color: "none", weight: 0, fillColor: zoningColor(cls), fillOpacity: 1 };
        },
        onEachFeature: (feature, lyr) => {
          const cls  = feature.properties?.ZONE_CLASS ?? "?";
          const desc = feature.properties?.ZONE_DESC ?? "";
          lyr.bindTooltip(`${cls}${desc ? ` — ${desc}` : ""}`, { sticky: true });
        },
      }
    ).addTo(layer);
  }, [enabled, zoningLayer.features, zoningLayerRef]);
}
