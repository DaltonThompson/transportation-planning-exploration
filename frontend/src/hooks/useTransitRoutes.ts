/**
 * Transit route rendering — bus (D2) + rail (J4) unified.
 *
 * Handles:
 *  - CDTA division filtering
 *  - Category co-location & canonical color resolution
 *  - Per-route lateral offset (miter/bevel geometry)
 *  - Casing / color / corridor-hit polylines
 *  - Corridor background stripe (zoom-adaptive width)
 *  - Rail viewport clipping (125% of current bounds)
 *  - Click → route selection; mousemove → dynamic tooltip
 */

import { useEffect } from "react";
import L from "leaflet";
import { useSelectionStore } from "../store/useSelectionStore";
import { cdtaServiceType, routeLineStyle } from "../utils/cdtaRoutes";
import {
  nearestEdgeAt, nearbyBikeFeatures,
  clipPolylineToBbox, expandBbox, offsetPolylineGeo,
  fineCell, cdtaRouteCategory, categoryCanonicalColorFrom,
  corridorHitWeight, corridorBgWeight, pxPerMeter,
  ROUTE_COLOR_WEIGHT, ROUTE_CASING_WEIGHT, OFFSET_M,
} from "../utils/mapGeometry";
import type { EdgeGeometry } from "../components/MapRenderer";

interface RouteShapesData {
  features: Array<{
    geometry: { type: string; coordinates: unknown };
    properties: Record<string, unknown>;
  }>;
}

type CorridorBg = { pl: L.Polyline; nLines: number };

export function useTransitRoutes(
  busRouteLayerRef:  React.RefObject<L.LayerGroup | null>,
  railRouteLayerRef: React.RefObject<L.LayerGroup | null>,
  casingLayerRef:    React.RefObject<L.LayerGroup | null>,
  mapRef:            React.RefObject<L.Map | null>,
  railBoundsRef:     React.MutableRefObject<[number, number, number, number] | null>,
  corridorBgRef:     React.MutableRefObject<CorridorBg[]>,
  busVisualRef:      React.MutableRefObject<Map<string, L.Polyline>>,
  railVisualRef:     React.MutableRefObject<Map<string, L.Polyline>>,
  geomRef:           React.MutableRefObject<Map<number, EdgeGeometry>>,
  bikeDataRef:       React.MutableRefObject<{ geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }[]>,
  busRoutesOn:       boolean,
  railRoutesOn:      boolean,
  cdtaDivisions:     Record<string, boolean>,
  routeShapes:       RouteShapesData | undefined,
  applyGlows:        (sources: L.Path[]) => void,
) {
  const { setSelection } = useSelectionStore();

  useEffect(() => {
    const busLayer  = busRouteLayerRef.current;
    const railLayer = railRouteLayerRef.current;
    if (!busLayer || !railLayer) return;

    busLayer.clearLayers();
    railLayer.clearLayers();
    busVisualRef.current.clear();
    railVisualRef.current.clear();
    corridorBgRef.current = [];
    const casingLayer = casingLayerRef.current;
    casingLayer?.clearLayers();

    const features = routeShapes?.features ?? [];

    // ── Bus routes (route_type === 3) ──────────────────────────────────────
    if (busRoutesOn && features.length > 0) {
      const normColor = (c: string) => (c.startsWith("#") ? c : `#${c}`).toLowerCase();

      const busRouteInfo = new Map<string, {
        routeId: string; color: string; feedSlug: string; routeType: number; category: string;
      }>();
      const busFeatures: Array<{
        coords: [number, number][]; name: string; rawColor: string;
        routeId: string; feedSlug: string; category: string;
      }> = [];
      const categoryColorVotes = new Map<string, string[]>();

      for (const feature of features) {
        const props = feature.properties;
        if (Number(props.route_type ?? 3) !== 3) continue;
        if (feature.geometry.type !== "LineString") continue;

        // CDTA division filter
        if (String(props.feed_slug ?? "") === "cdta") {
          const routeNum = parseInt(String(props.route_short_name ?? ""), 10);
          if (!isNaN(routeNum) && routeNum > 0) {
            const divPrefix = String(Math.max(1, Math.floor(routeNum / 100)));
            if (!cdtaDivisions[divPrefix]) continue;
          }
        }

        const rawCoords = feature.geometry.coordinates as number[][];
        const routeId  = String(props.route_id ?? "");
        const name     = String(props.route_short_name || props.route_long_name || routeId);
        const rawColor = normColor(String(props.route_color ?? "#4444ff"));
        const feedSlug = String(props.feed_slug ?? "");
        const category = cdtaRouteCategory(name, feedSlug);
        const coords   = rawCoords.map(([lon, lat]) => [lat, lon] as [number, number]);

        busFeatures.push({ coords, name, rawColor, routeId, feedSlug, category });
        busRouteInfo.set(name, { routeId, color: rawColor, feedSlug, routeType: 3, category });
        if (!categoryColorVotes.has(category)) categoryColorVotes.set(category, []);
        categoryColorVotes.get(category)!.push(rawColor);
      }

      // Resolve canonical color per category (majority vote)
      const categoryColor = new Map<string, string>();
      for (const [cat, votes] of categoryColorVotes) {
        categoryColor.set(cat, categoryCanonicalColorFrom(votes));
      }
      for (const [, info] of busRouteInfo) {
        info.color = categoryColor.get(info.category) ?? info.color;
      }

      // Spatial index: fine-grid cells → route names + categories
      const cellRouteNames = new Map<string, Set<string>>();
      const cellCategories = new Map<string, Set<string>>();

      for (const { coords, name, category } of busFeatures) {
        for (let i = 0; i < coords.length - 1; i++) {
          const [lat1, lng1] = coords[i], [lat2, lng2] = coords[i + 1];
          const dlat = lat2 - lat1, dlon = lng2 - lng1;
          const steps = Math.max(1, Math.ceil((Math.abs(dlat) + Math.abs(dlon)) / 0.0002));
          let lastCell = "";
          for (let s = 0; s <= steps; s++) {
            const t    = s / steps;
            const cell = fineCell(lat1 + t * dlat, lng1 + t * dlon);
            if (cell === lastCell) continue;
            lastCell = cell;
            if (!cellRouteNames.has(cell)) cellRouteNames.set(cell, new Set());
            cellRouteNames.get(cell)!.add(name);
            if (!cellCategories.has(cell)) cellCategories.set(cell, new Set());
            cellCategories.get(cell)!.add(category);
          }
        }
      }

      // Corridor hit factory — invisible wide polyline for hover/click
      const newCorridorBgs: CorridorBg[] = [];

      const makeCorridorHit = (segCoords: [number, number][], segRouteNames: string[]) => {
        const segCategories = new Set(segRouteNames.map(n => busRouteInfo.get(n)?.category ?? n));

        // Background stripe for multi-category corridors
        if (segCategories.size > 1 && casingLayer && mapRef.current) {
          const nLines = segCategories.size;
          const bgPl = L.polyline(segCoords, {
            color: "#ffffff",
            weight: corridorBgWeight(nLines, pxPerMeter(mapRef.current)),
            opacity: 0.95, pane: "casingPane", interactive: false, className: "route-line",
          }).addTo(casingLayer);
          newCorridorBgs.push({ pl: bgPl, nLines });
        }

        const weight = corridorHitWeight(segCategories.size);
        const pl = L.polyline(segCoords, { color: "#000", weight, opacity: 0, pane: "routePane" })
          .bindTooltip(segRouteNames.join(", "), { sticky: true })
          .addTo(busLayer);

        pl.on("mousemove", (e: L.LeafletMouseEvent) => {
          const names = [...(cellRouteNames.get(fineCell(e.latlng.lat, e.latlng.lng)) ?? new Set())].sort();
          pl.setTooltipContent(names.length ? names.join(", ") : segRouteNames.join(", "));
        });
        pl.on("click", (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          const cellNames = [...(cellRouteNames.get(fineCell(e.latlng.lat, e.latlng.lng)) ?? new Set())].sort();
          const allNames  = cellNames.length ? cellNames : segRouteNames;
          const routes = allNames.map((n) => {
            const info = busRouteInfo.get(n);
            return { routeId: info?.routeId ?? n, name: n, color: info?.color ?? "#4444ff", feedSlug: info?.feedSlug ?? "", routeType: info?.routeType ?? 3 };
          });
          const edge      = nearestEdgeAt(e.latlng, geomRef);
          const bikeFeats = nearbyBikeFeatures(e.latlng, bikeDataRef.current ?? []);
          const glowTargets = allNames.flatMap((n) => { const v = busVisualRef.current.get(n); return v ? [v] : []; });
          applyGlows(glowTargets);
          setSelection({ kind: "route", routes, edgeId: edge?.id, roadName: edge?.road_name || undefined, roadHighway: edge?.highway || undefined, bikeFeatures: bikeFeats.length ? bikeFeats : undefined });
        });
      };

      // Draw pass: casing then color, with modal-rank lateral offset
      for (const { coords, name, category, feedSlug } of busFeatures) {
        const visColor  = categoryColor.get(category) ?? busRouteInfo.get(name)!.color;
        const svcType   = feedSlug === "cdta" ? cdtaServiceType(name) : "unknown";
        const lineStyle = routeLineStyle(svcType);

        // Modal category rank across all vertices
        const rankCounts = new Map<string, number>();
        for (const [lat, lng] of coords) {
          const cats = [...(cellCategories.get(fineCell(lat, lng)) ?? new Set())].sort();
          const rank = cats.indexOf(category), total = cats.length;
          if (rank < 0) continue;
          const key = `${rank}:${total}`;
          rankCounts.set(key, (rankCounts.get(key) ?? 0) + 1);
        }
        let bestKey = "0:1", bestCount = 0;
        for (const [k, c] of rankCounts) { if (c > bestCount) { bestCount = c; bestKey = k; } }
        const [rank, total] = bestKey.split(":").map(Number);
        const offsetted = offsetPolylineGeo(coords, (rank - (total - 1) / 2) * OFFSET_M);

        if (casingLayer) {
          L.polyline(offsetted, {
            color: "#ffffff", weight: lineStyle.casingWeight, opacity: 0.95,
            pane: "casingPane", interactive: false, className: "route-line",
          }).addTo(casingLayer);
        }

        const vis = L.polyline(offsetted, {
          color: visColor, weight: lineStyle.colorWeight, opacity: 0.95,
          dashArray: lineStyle.dashArray,
          pane: "routePane", interactive: false, className: "route-line",
        }).addTo(busLayer);
        if (!busVisualRef.current.has(name)) busVisualRef.current.set(name, vis);

        // Corridor hit — only drawn by the alphabetically-first route in each cell signature
        let segStart = 0, curSig = "";
        const flushSeg = (end: number, sig: string) => {
          const routeNames = sig ? sig.split("|") : [name];
          const sorted = [...routeNames].sort((a, b) => {
            const ca = busRouteInfo.get(a)?.category ?? a;
            const cb = busRouteInfo.get(b)?.category ?? b;
            return ca !== cb ? ca.localeCompare(cb) : a.localeCompare(b);
          });
          if (sorted[0] !== name) return;
          const segCoords = coords.slice(segStart, end + 1);
          if (segCoords.length >= 2) makeCorridorHit(segCoords, routeNames);
        };
        for (let i = 0; i < coords.length; i++) {
          const colocated = [...(cellRouteNames.get(fineCell(coords[i][0], coords[i][1])) ?? new Set())].sort();
          const sig = colocated.join("|") || name;
          if (i === 0) { curSig = sig; continue; }
          if (sig !== curSig) { flushSeg(i, curSig); segStart = i; curSig = sig; }
        }
        flushSeg(coords.length - 1, curSig);
      }

      // Persist new corridor bg entries so zoom handler can resize them
      corridorBgRef.current.push(...newCorridorBgs);
    }

    // ── Rail routes (route_type !== 3) ────────────────────────────────────
    if (railRoutesOn && features.length > 0) {
      const clipBbox = railBoundsRef.current ? expandBbox(railBoundsRef.current, 1.25) : null;

      const railCellNames = new Map<string, Set<string>>();
      const railRouteInfo = new Map<string, { routeId: string; color: string; feedSlug: string; routeType: number }>();
      const railFeatures: Array<{ coords: [number, number][]; name: string; color: string }> = [];

      for (const feature of features) {
        if (Number(feature.properties.route_type ?? 3) === 3) continue;
        if (feature.geometry.type !== "LineString") continue;

        const rawCoords = feature.geometry.coordinates as number[][];
        const routeId   = String(feature.properties.route_id ?? "");
        const name      = String(feature.properties.route_short_name || feature.properties.route_long_name || routeId);
        const routeType = Number(feature.properties.route_type ?? 2);
        const feedSlug  = String(feature.properties.feed_slug ?? "");
        const rawColor  = String(feature.properties.route_color ?? "#eeeeee");
        const color     = rawColor.startsWith("#") ? rawColor : `#${rawColor}`;
        const allCoords = rawCoords.map(([lon, lat]) => [lat, lon] as [number, number]);

        const coordSegments = clipBbox
          ? clipPolylineToBbox(allCoords, clipBbox.minLat, clipBbox.maxLat, clipBbox.minLon, clipBbox.maxLon)
          : [allCoords];

        if (coordSegments.length === 0) continue;
        railRouteInfo.set(name, { routeId, color, feedSlug, routeType });
        for (const coords of coordSegments) railFeatures.push({ coords, name, color });

        for (const coords of coordSegments) {
          for (let i = 0; i < coords.length - 1; i++) {
            const [lat1, lon1] = coords[i], [lat2, lon2] = coords[i + 1];
            const dlat = lat2 - lat1, dlon = lon2 - lon1;
            const steps = Math.max(1, Math.ceil((Math.abs(dlat) + Math.abs(dlon)) / 0.0002));
            let lastCell = "";
            for (let s = 0; s <= steps; s++) {
              const cell = fineCell(lat1 + (s / steps) * dlat, lon1 + (s / steps) * dlon);
              if (cell === lastCell) continue;
              lastCell = cell;
              if (!railCellNames.has(cell)) railCellNames.set(cell, new Set());
              railCellNames.get(cell)!.add(name);
            }
          }
        }
      }

      const newRailBgs: CorridorBg[] = [];

      const makeRailCorridorHit = (coords: [number, number][], routeNames: string[]) => {
        if (routeNames.length > 1 && casingLayer && mapRef.current) {
          const nLines = routeNames.length;
          const bgPl = L.polyline(coords, {
            color: "#ffffff",
            weight: corridorBgWeight(nLines, pxPerMeter(mapRef.current)),
            opacity: 0.95, pane: "casingPane", interactive: false, className: "route-line",
          }).addTo(casingLayer);
          newRailBgs.push({ pl: bgPl, nLines });
        }
        const pl = L.polyline(coords, {
          color: "#000", weight: corridorHitWeight(routeNames.length), opacity: 0, pane: "routePane",
        })
          .bindTooltip(routeNames.join(", "), { sticky: true })
          .addTo(railLayer);

        pl.on("mousemove", (e: L.LeafletMouseEvent) => {
          const names = [...(railCellNames.get(fineCell(e.latlng.lat, e.latlng.lng)) ?? new Set())].sort();
          pl.setTooltipContent(names.length ? names.join(", ") : routeNames.join(", "));
        });
        pl.on("click", (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          const cellNames = [...(railCellNames.get(fineCell(e.latlng.lat, e.latlng.lng)) ?? new Set())].sort();
          const allNames  = cellNames.length ? cellNames : routeNames;
          const routes = allNames.map((n) => {
            const info = railRouteInfo.get(n);
            return { routeId: info?.routeId ?? n, name: n, color: info?.color ?? "#cccccc", feedSlug: info?.feedSlug ?? "", routeType: info?.routeType ?? 2 };
          });
          const edge      = nearestEdgeAt(e.latlng, geomRef);
          const bikeFeats = nearbyBikeFeatures(e.latlng, bikeDataRef.current ?? []);
          applyGlows(allNames.flatMap((n) => { const v = railVisualRef.current.get(n); return v ? [v] : []; }));
          setSelection({ kind: "route", routes, edgeId: edge?.id, roadName: edge?.road_name || undefined, roadHighway: edge?.highway || undefined, bikeFeatures: bikeFeats.length ? bikeFeats : undefined });
        });
      };

      for (const { coords, name, color } of railFeatures) {
        const rankCounts = new Map<string, number>();
        for (const [lat, lng] of coords) {
          const sorted = [...(railCellNames.get(fineCell(lat, lng)) ?? new Set())].sort();
          const rank = sorted.indexOf(name), total = sorted.length;
          if (rank < 0) continue;
          const key = `${rank}:${total}`;
          rankCounts.set(key, (rankCounts.get(key) ?? 0) + 1);
        }
        let bestKey = "0:1", bestCount = 0;
        for (const [k, c] of rankCounts) { if (c > bestCount) { bestCount = c; bestKey = k; } }
        const [rank, total] = bestKey.split(":").map(Number);
        const offsetted = offsetPolylineGeo(coords, (rank - (total - 1) / 2) * OFFSET_M);

        if (casingLayer) {
          L.polyline(offsetted, {
            color: "#ffffff", weight: ROUTE_CASING_WEIGHT, opacity: 0.95,
            pane: "casingPane", interactive: false, className: "route-line",
          }).addTo(casingLayer);
        }
        const railVis = L.polyline(offsetted, {
          color, weight: ROUTE_COLOR_WEIGHT, opacity: 0.95, dashArray: "10 5",
          pane: "routePane", interactive: false, className: "route-line",
        }).addTo(railLayer);
        if (!railVisualRef.current.has(name)) railVisualRef.current.set(name, railVis);

        let segStart = 0, curSig = "";
        const flushRailSeg = (end: number, sig: string) => {
          const routeNames = sig ? sig.split("|") : [name];
          if (routeNames[0] !== name) return;
          const segCoords = coords.slice(segStart, end + 1);
          if (segCoords.length >= 2) makeRailCorridorHit(segCoords, routeNames);
        };
        for (let i = 0; i < coords.length; i++) {
          const colocated = [...(railCellNames.get(fineCell(coords[i][0], coords[i][1])) ?? new Set())].sort();
          const sig = colocated.join("|") || name;
          if (i === 0) { curSig = sig; continue; }
          if (sig !== curSig) { flushRailSeg(i, curSig); segStart = i; curSig = sig; }
        }
        flushRailSeg(coords.length - 1, curSig);
      }

      corridorBgRef.current.push(...newRailBgs);
    }

  }, [busRoutesOn, railRoutesOn, routeShapes, cdtaDivisions, applyGlows,
      busRouteLayerRef, railRouteLayerRef, casingLayerRef, mapRef,
      railBoundsRef, corridorBgRef, busVisualRef, railVisualRef,
      geomRef, bikeDataRef, setSelection]);
}
