/**
 * Leaflet map orchestrator.
 *
 * Responsibilities kept here:
 *  - Map + pane creation, layer-group wiring, bounds tracking
 *  - Glow helper (shared by multiple hooks via applyGlows callback)
 *
 * Everything else is delegated to hooks in src/hooks/.
 */

import { useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useSimStore } from "../store/useSimStore";
import { useLayerStore } from "../store/useLayerStore";
import { useSelectionStore } from "../store/useSelectionStore";
import { useArcGISBikeLayer } from "../hooks/useArcGISBikeLayer";
import { useZoningLayer } from "../hooks/useZoningLayer";
import { corridorBgWeight, pxPerMeter, BASEMAP_TILES } from "../utils/mapGeometry";

import { useBasemap, usePopulationWMS } from "../hooks/useMapOverlays";
import { useEdgeLayer }       from "../hooks/useEdgeLayer";
import { useTransitRoutes }   from "../hooks/useTransitRoutes";
import { useSelectedRoute }   from "../hooks/useSelectedRoute";
import { useBusStops }        from "../hooks/useBusStops";
import { useWalkChoropleth }  from "../hooks/useWalkChoropleth";
import { useBikeOverlays }    from "../hooks/useBikeOverlays";
import { useZoningOverlay }   from "../hooks/useZoningOverlay";
import { useLodesLayer }      from "../hooks/useLodesLayer";
import { useCollisionOverlay } from "../hooks/useCollisionOverlay";
import { useMovingDots }      from "../hooks/useMovingDots";
import { useEdgeInteraction } from "../hooks/useEdgeInteraction";
import { AnimationControls }  from "./AnimationControls";

export interface EdgeGeometry {
  id: number;
  coords: [number, number][];
  highway?: string;
  road_name?: string;
  speed_limit_kmh?: number;
  aadt_count?: number;
}

interface Props {
  center: [number, number];
  zoom: number;
  edgeGeometries: EdgeGeometry[];
}

export function MapRenderer({ center, zoom, edgeGeometries }: Props) {
  // ── Core map refs ────────────────────────────────────────────────────────
  const mapRef       = useRef<L.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const wmsLayerRef  = useRef<L.TileLayer.WMS | null>(null);

  // Edge geometry refs (shared by useEdgeLayer, useEdgeInteraction, useTransitRoutes, etc.)
  const polylineRef = useRef<Map<number, L.Polyline>>(new Map());
  const geomRef     = useRef<Map<number, EdgeGeometry>>(new Map());

  // Overlay layer groups
  const busStopLayerRef     = useRef<L.LayerGroup | null>(null);
  const busRouteLayerRef    = useRef<L.LayerGroup | null>(null);
  const railRouteLayerRef   = useRef<L.LayerGroup | null>(null);
  const bikeLayerRef        = useRef<L.LayerGroup | null>(null);
  const bikeOSMLayerRef     = useRef<L.LayerGroup | null>(null);
  const bikeAmenityLayerRef = useRef<L.LayerGroup | null>(null);
  const walkLayerRef        = useRef<L.LayerGroup | null>(null);
  const collisionLayerRef   = useRef<L.LayerGroup | null>(null);
  const junctionLayerRef    = useRef<L.LayerGroup | null>(null);
  const zoningLayerRef      = useRef<L.LayerGroup | null>(null);
  const lodesLayerRef       = useRef<L.LayerGroup | null>(null);
  const selRouteLayerRef    = useRef<L.LayerGroup | null>(null);
  const casingLayerRef      = useRef<L.LayerGroup | null>(null);
  const glowLayerRef        = useRef<L.LayerGroup | null>(null);
  const glowPolylinesRef    = useRef<L.Polyline[]>([]);
  const dotLayerRef         = useRef<L.LayerGroup | null>(null);

  // Transit corridor refs (shared between useTransitRoutes and the zoom handler)
  type CorridorBg = { pl: L.Polyline; nLines: number };
  const corridorBgRef   = useRef<CorridorBg[]>([]);
  const busVisualRef    = useRef<Map<string, L.Polyline>>(new Map());
  const railVisualRef   = useRef<Map<string, L.Polyline>>(new Map());

  // Rubber-band refs (G3)
  const rubberBandRef = useRef<L.Rectangle | null>(null);
  const dragStartRef  = useRef<L.LatLng | null>(null);
  const isDraggingRef = useRef(false);

  // Per-stop marker ref
  const stopMarkerRef = useRef<Map<string, L.CircleMarker>>(new Map());

  // Viewport bounds refs (not state — no re-renders needed for hooks that read them)
  const mapBoundsRef  = useRef<[number, number, number, number] | null>(null);
  const railBoundsRef = useRef<[number, number, number, number] | null>(null);

  const { basemap, overlays, cdtaDivisions, capitalNYBikeLayers } = useLayerStore();
  const { selection, clearSelection } = useSelectionStore();
  const hasFrames = useSimStore((s) => s.frames.length > 0);

  // External data queries
  const { data: stopsData } = useQuery({
    queryKey: ["stops"],
    queryFn: api.getStops,
    enabled: overlays.busRoutes || overlays.busStops || overlays.walkToBusStop,
    staleTime: 0,
  });
  const { data: routeShapes } = useQuery({
    queryKey: ["route-shapes"],
    queryFn: api.getRouteShapes,
    enabled: overlays.busRoutes || overlays.railRoutes,
    staleTime: 0,
  });
  const { data: bikeOSMData } = useQuery({
    queryKey: ["bike-infra-osm"],
    queryFn: api.getBikeInfra,
    enabled: overlays.bikeInfraOSM,
    staleTime: Infinity,
  });
  const { data: lodesData } = useQuery({
    queryKey: ["lodes"],
    queryFn: () => api.getLodes(42.65, -73.76, 20),
    enabled: overlays.jobs || overlays.economicActivity,
    staleTime: 30 * 60_000,
  });
  const { data: collisionData } = useQuery({
    queryKey: ["collisions"],
    queryFn: api.getCollisions,
    enabled: overlays.collisionJunctions || useLayerStore.getState().roadColoring === "collisions",
    staleTime: 10 * 60_000,
  });

  const bikeLayer   = useArcGISBikeLayer(mapBoundsRef.current, overlays.capitalNYBikeMap);
  const zoningLayer = useZoningLayer(mapBoundsRef.current, overlays.zoning);

  // Bike data ref — keeps click-handler closures up to date without re-running effects
  const bikeDataRef = useRef<typeof bikeLayer.features>([]);
  useEffect(() => { bikeDataRef.current = bikeLayer.features; }, [bikeLayer.features]);

  // ── Glow helpers (shared callback passed into multiple hooks) ────────────
  const applyGlows = useCallback((sources: L.Path[]) => {
    glowPolylinesRef.current.forEach((p) => p.remove());
    glowPolylinesRef.current = [];
    const glowLayer = glowLayerRef.current;
    if (!glowLayer || sources.length === 0) return;

    for (const src of sources) {
      const style  = src.options as L.PathOptions & { weight?: number };
      const color  = style.color ?? "#ffffff";
      const weight = (style.weight ?? 3) + 8;
      const glow   = src instanceof L.CircleMarker
        ? L.circleMarker(src.getLatLng(), {
            radius: src.getRadius() + 5, color, weight: 0,
            fillColor: color, fillOpacity: 0.5,
            pane: "glowPane", interactive: false, className: "leaflet-glow-path",
          })
        : L.polyline((src as L.Polyline).getLatLngs() as L.LatLngExpression[], {
            color, weight, opacity: 0.5,
            pane: "glowPane", interactive: false, className: "leaflet-glow-path",
          });
      glow.addTo(glowLayer);
      glowPolylinesRef.current.push(glow as L.Polyline);
    }
  }, []);

  const clearGlows = useCallback(() => applyGlows([]), [applyGlows]);
  useEffect(() => { if (!selection) clearGlows(); }, [selection, clearGlows]);

  // ── Map initialization ───────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current).setView(center, zoom);

    // Custom panes: casing (448) → glow (449) → route lines (450)
    map.createPane("casingPane"); map.getPane("casingPane")!.style.zIndex = "448";
    map.createPane("glowPane");   map.getPane("glowPane")!.style.zIndex   = "449";
    map.createPane("routePane");  map.getPane("routePane")!.style.zIndex  = "450";

    const tl = L.tileLayer(BASEMAP_TILES.dark.url, {
      attribution: BASEMAP_TILES.dark.attribution, maxZoom: 19,
    }).addTo(map);
    tileLayerRef.current = tl;

    // Create all layer groups in render order
    selRouteLayerRef.current    = L.layerGroup().addTo(map);
    casingLayerRef.current      = L.layerGroup().addTo(map);
    glowLayerRef.current        = L.layerGroup().addTo(map);
    zoningLayerRef.current      = L.layerGroup().addTo(map);
    busStopLayerRef.current     = L.layerGroup().addTo(map);
    busRouteLayerRef.current    = L.layerGroup().addTo(map);
    railRouteLayerRef.current   = L.layerGroup().addTo(map);
    bikeLayerRef.current        = L.layerGroup().addTo(map);
    bikeOSMLayerRef.current     = L.layerGroup().addTo(map);
    bikeAmenityLayerRef.current = L.layerGroup().addTo(map);
    walkLayerRef.current        = L.layerGroup().addTo(map);
    collisionLayerRef.current   = L.layerGroup().addTo(map);
    junctionLayerRef.current    = L.layerGroup().addTo(map);
    lodesLayerRef.current       = L.layerGroup().addTo(map);
    dotLayerRef.current         = L.layerGroup().addTo(map);

    // Bounds tracking: railBounds immediate, mapBounds debounced 500ms
    let boundsTimer: ReturnType<typeof setTimeout> | null = null;
    const updateBounds = () => {
      const b = map.getBounds();
      const bbox: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      railBoundsRef.current = bbox;
      mapBoundsRef.current  = bbox;
    };
    map.on("moveend", () => {
      const b = map.getBounds();
      railBoundsRef.current = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      if (boundsTimer) clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        const b2 = map.getBounds();
        mapBoundsRef.current = [b2.getWest(), b2.getSouth(), b2.getEast(), b2.getNorth()];
      }, 500);
    });
    updateBounds();

    // Resize corridor background stripes on zoom
    map.on("zoomend", () => {
      const ppm = pxPerMeter(map);
      for (const { pl, nLines } of corridorBgRef.current) {
        pl.setStyle({ weight: corridorBgWeight(nLines, ppm) });
      }
    });

    map.on("click", () => clearSelection());

    mapRef.current = map;
    return () => {
      if (boundsTimer) clearTimeout(boundsTimer);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ── Delegated hooks ──────────────────────────────────────────────────────

  useBasemap(mapRef, tileLayerRef, basemap);

  usePopulationWMS(mapRef, wmsLayerRef, overlays.populationDensity);

  useEdgeLayer(mapRef, polylineRef, geomRef, edgeGeometries, collisionData);

  useTransitRoutes(
    busRouteLayerRef, railRouteLayerRef, casingLayerRef, mapRef, railBoundsRef,
    corridorBgRef, busVisualRef, railVisualRef, geomRef, bikeDataRef,
    overlays.busRoutes, overlays.railRoutes, cdtaDivisions, routeShapes, applyGlows,
  );

  useSelectedRoute(selRouteLayerRef, overlays.busRoutes, selection, routeShapes, applyGlows);

  useBusStops(busStopLayerRef, stopMarkerRef, overlays.busStops, stopsData, applyGlows, bikeDataRef);

  useWalkChoropleth(walkLayerRef, mapRef, overlays.walkToBusStop, stopsData);

  useBikeOverlays(
    bikeLayerRef, bikeOSMLayerRef, bikeAmenityLayerRef,
    overlays.capitalNYBikeMap, overlays.bikeInfraOSM,
    capitalNYBikeLayers, bikeLayer, bikeOSMData,
    geomRef, bikeDataRef, applyGlows,
  );

  useZoningOverlay(zoningLayerRef, overlays.zoning, zoningLayer);

  useLodesLayer(lodesLayerRef, overlays.jobs || overlays.economicActivity, lodesData);

  useCollisionOverlay(junctionLayerRef, overlays.collisionJunctions, collisionData);

  const dotControls = useMovingDots(dotLayerRef, edgeGeometries);

  useEdgeInteraction(
    mapRef, containerRef, polylineRef, geomRef,
    rubberBandRef, dragStartRef, isDraggingRef,
    bikeDataRef, applyGlows,
  );

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {(overlays.jobs || overlays.economicActivity) && lodesData?.status === "not_imported" && (
        <div style={{
          position: "absolute", top: 48, left: "50%", transform: "translateX(-50%)",
          background: "var(--bg-primary)", border: "1px solid var(--border)",
          borderRadius: "var(--radius)", padding: "6px 14px", zIndex: 900,
          fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-sans)",
          boxShadow: "var(--shadow)",
        }}>
          Jobs layer requires LODES import — run <code>POST /api/admin/import-lodes</code>
        </div>
      )}

      {hasFrames && <AnimationControls {...dotControls} />}
    </div>
  );
}
