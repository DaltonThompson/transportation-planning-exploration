/**
 * Bike infrastructure overlays (E2):
 *   - Capital NY ArcGIS bike layer
 *   - OSM bike infra (legacy)
 *   - Bike amenities (parking, shops, repair, restrooms, caution)
 */

import { useEffect } from "react";
import L from "leaflet";
import type { BikePointType } from "./useArcGISBikeLayer";
import { useSelectionStore } from "../store/useSelectionStore";
import { placeDirMarkers, nearestEdgeAt } from "../utils/mapGeometry";
import type { EdgeGeometry } from "../components/MapRenderer";

type BikeFeatureProps = Record<string, unknown>;

interface BikeLayerResult {
  features: { geometry: { type: string; coordinates: unknown }; properties: BikeFeatureProps }[];
  pointFeatures: {
    layerType: BikePointType;
    lat: number; lng: number;
    name?: string; address?: string; description?: string;
    cautionType?: string; notes?: string;
  }[];
  source?: string;
}

interface BikeOSMData {
  status: string;
  features: { geometry: { type: string; coordinates: unknown }; properties: BikeFeatureProps | null }[];
}

const CONDITION_META: Record<string, { key: string; color: string }> = {
  "On-Street Bike Lane":   { key: "lane",        color: "#339af0" },
  "Bike Pedestrian Path":  { key: "path",        color: "#00d084" },
  "Unpaved":               { key: "unpaved",     color: "#ff922b" },
  "Sidewalk":              { key: "sidewalk",    color: "#adb5bd" },
  "Light Traffic Street":  { key: "sharedLight", color: "#cc5de8" },
  "Light Traffic One Way": { key: "sharedLight", color: "#cc5de8" },
  "Heavy Traffic Street":  { key: "sharedHeavy", color: "#ff6b6b" },
  "Heavy Traffic One Way": { key: "sharedHeavy", color: "#ff6b6b" },
};

const AMENITY_STYLE: Record<BikePointType, { color: string; label: string }> = {
  parking:  { color: "#339af0", label: "Bike parking"        },
  shop:     { color: "#00d084", label: "Bike shop"           },
  repair:   { color: "#ff922b", label: "Self-service repair" },
  restroom: { color: "#adb5bd", label: "Restroom"            },
  caution:  { color: "#ffd43b", label: "Caution"             },
};

export function useBikeOverlays(
  bikeLayerRef: React.RefObject<L.LayerGroup | null>,
  bikeOSMLayerRef: React.RefObject<L.LayerGroup | null>,
  bikeAmenityLayerRef: React.RefObject<L.LayerGroup | null>,
  capitalNYEnabled: boolean,
  bikeInfraOSMEnabled: boolean,
  capitalNYBikeLayers: Record<string, boolean>,
  bikeLayer: BikeLayerResult,
  bikeOSMData: BikeOSMData | undefined,
  geomRef: React.RefObject<Map<number, EdgeGeometry>>,
  bikeDataRef: React.RefObject<BikeLayerResult["features"]>,
  applyGlows: (sources: L.Path[]) => void,
) {
  const { setSelection } = useSelectionStore();

  // ── Capital NY ArcGIS bike lines ─────────────────────────────────────────
  useEffect(() => {
    const layer = bikeLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!capitalNYEnabled || bikeLayer.features.length === 0) return;

    const addBikeLine = (coords: [number, number][], props: BikeFeatureProps) => {
      const conditions = String(props.conditions ?? "");
      const meta = CONDITION_META[conditions] ?? { key: "path", color: "#00d084" };
      if (!capitalNYBikeLayers[meta.key]) return;
      const color = meta.color;
      const label = String(props.name ?? conditions ?? "Bike path");
      const pl = L.polyline(coords, { color, weight: 3, opacity: 0.9, pane: "routePane" })
        .bindTooltip(label, { sticky: true })
        .addTo(layer);
      pl.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        applyGlows([pl]);
        const edge = nearestEdgeAt(e.latlng, geomRef);
        setSelection({
          kind: "bike", bikeProps: props,
          edgeId: edge?.id,
          roadName: edge?.road_name || undefined,
          roadHighway: edge?.highway || undefined,
        });
      });

      const onewayVal = String(props.oneway ?? "").toLowerCase();
      const isOneWay =
        conditions.endsWith("One Way") ||
        onewayVal === "y" || onewayVal === "yes" || onewayVal === "1" || onewayVal === "true";
      if (isOneWay) placeDirMarkers(coords, layer, color);
    };

    for (const feature of bikeLayer.features) {
      const props = feature.properties as BikeFeatureProps;
      if (feature.geometry.type === "LineString") {
        const coords = (feature.geometry.coordinates as number[][]).map(
          ([lon, lat]) => [lat, lon] as [number, number]
        );
        addBikeLine(coords, props);
      } else if (feature.geometry.type === "MultiLineString") {
        for (const line of feature.geometry.coordinates as number[][][]) {
          addBikeLine(line.map(([lon, lat]) => [lat, lon] as [number, number]), props);
        }
      }
    }
  }, [capitalNYEnabled, capitalNYBikeLayers, bikeLayer.features, bikeLayer.source, applyGlows,
      bikeLayerRef, geomRef, bikeDataRef, setSelection]);

  // ── OSM bike infrastructure (legacy) ────────────────────────────────────
  useEffect(() => {
    const layer = bikeOSMLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    const features = bikeOSMData?.status === "ready" ? bikeOSMData.features : [];
    if (!bikeInfraOSMEnabled || features.length === 0) return;

    const addLine = (coords: [number, number][], props: BikeFeatureProps) => {
      const label = String(props.name ?? props.highway ?? props.cycleway ?? "OSM bike path");
      const pl = L.polyline(coords, { color: "#51cf66", weight: 2, opacity: 0.8, pane: "routePane" })
        .bindTooltip(label, { sticky: true })
        .addTo(layer);
      pl.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        applyGlows([pl]);
        const edge = nearestEdgeAt(e.latlng, geomRef);
        setSelection({
          kind: "bike", bikeProps: props,
          edgeId: edge?.id,
          roadName: edge?.road_name || undefined,
          roadHighway: edge?.highway || undefined,
        });
      });
    };

    for (const feature of features) {
      const props = (feature.properties ?? {}) as BikeFeatureProps;
      if (feature.geometry.type === "LineString") {
        addLine((feature.geometry.coordinates as number[][]).map(([lon, lat]) => [lat, lon] as [number, number]), props);
      } else if (feature.geometry.type === "MultiLineString") {
        for (const line of feature.geometry.coordinates as number[][][]) {
          addLine(line.map(([lon, lat]) => [lat, lon] as [number, number]), props);
        }
      }
    }
  }, [bikeInfraOSMEnabled, bikeOSMData, applyGlows, bikeOSMLayerRef, geomRef, setSelection]);

  // ── Bike amenities ───────────────────────────────────────────────────────
  useEffect(() => {
    const layer = bikeAmenityLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!capitalNYEnabled || bikeLayer.pointFeatures.length === 0) return;

    for (const pt of bikeLayer.pointFeatures) {
      if (!capitalNYBikeLayers[pt.layerType]) continue;
      const { color, label } = AMENITY_STYLE[pt.layerType];
      const tipLines = [pt.name ?? label, pt.address, pt.description, pt.cautionType, pt.notes]
        .filter(Boolean).join("<br>");

      L.circleMarker([pt.lat, pt.lng], {
        radius: 6, color: "#222", weight: 1,
        fillColor: color, fillOpacity: 0.9,
      })
        .bindTooltip(tipLines, { sticky: true })
        .addTo(layer);
    }
  }, [capitalNYEnabled, capitalNYBikeLayers, bikeLayer.pointFeatures, bikeAmenityLayerRef]);
}
