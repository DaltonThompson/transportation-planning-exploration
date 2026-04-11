/** Basemap tile swap and population-density WMS overlay (F1). */

import { useEffect } from "react";
import L from "leaflet";
import { BASEMAP_TILES, POPULATION_WMS } from "../utils/mapGeometry";

export function useBasemap(
  mapRef:        React.RefObject<L.Map | null>,
  tileLayerRef:  React.RefObject<L.TileLayer | null>,
  basemap: string,
) {
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const cfg = BASEMAP_TILES[basemap] ?? BASEMAP_TILES.dark;
    tileLayerRef.current?.remove();
    const tl = L.tileLayer(cfg.url, { attribution: cfg.attribution, maxZoom: 19 });
    tl.addTo(map);
    tl.bringToBack();
    (tileLayerRef as React.MutableRefObject<L.TileLayer | null>).current = tl;
  }, [basemap, mapRef, tileLayerRef]);
}

export function usePopulationWMS(
  mapRef:      React.RefObject<L.Map | null>,
  wmsLayerRef: React.RefObject<L.TileLayer.WMS | null>,
  enabled: boolean,
) {
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    wmsLayerRef.current?.remove();
    (wmsLayerRef as React.MutableRefObject<L.TileLayer.WMS | null>).current = null;
    if (!enabled) return;
    (wmsLayerRef as React.MutableRefObject<L.TileLayer.WMS | null>).current =
      L.tileLayer.wms(POPULATION_WMS, {
        layers: "Census Tracts", format: "image/png",
        transparent: true, opacity: 0.4, attribution: "US Census Bureau",
      }).addTo(map);
  }, [enabled, mapRef, wmsLayerRef]);
}
