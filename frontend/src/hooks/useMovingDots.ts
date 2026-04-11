/**
 * Moving vehicle dot animation (H1).
 * Manages animation state (simHour, isWeekend, showDots) and the rAF loop.
 * Returns state + setters so AnimationControls can render the controls.
 */

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { useSimStore } from "../store/useSimStore";
import { haversineMeters, edgeLengthMeters, DIURNAL_FACTORS, WEEKEND_SCALE } from "../utils/mapGeometry";
import type { EdgeGeometry } from "../components/MapRenderer";

export function useMovingDots(
  dotLayerRef: React.RefObject<L.LayerGroup | null>,
  edgeGeometries: EdgeGeometry[],
) {
  const [simHour, setSimHour]     = useState(8);
  const [isWeekend, setIsWeekend] = useState(false);
  const [showDots, setShowDots]   = useState(false);

  const animFrameRef = useRef<number | null>(null);
  const dotStateRef  = useRef<Map<number, { pos: number; lat: number; lng: number }>>(new Map());

  const edgeState = useSimStore((s) => s.edgeState);

  useEffect(() => {
    const dotLayer = dotLayerRef.current;
    if (!dotLayer || !showDots || edgeGeometries.length === 0) {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      dotLayer?.clearLayers();
      return;
    }

    const diurnalScale = DIURNAL_FACTORS[simHour] * (isWeekend ? WEEKEND_SCALE : 1.0);

    dotStateRef.current.clear();
    const dotMarkers = new Map<number, L.CircleMarker>();

    for (const eg of edgeGeometries) {
      const state = edgeState[eg.id];
      if (!state) continue;
      const flowFraction = state.c;
      if (flowFraction * diurnalScale < 0.15) continue;

      const nDots = Math.max(1, Math.round(flowFraction * diurnalScale * 3));
      for (let d = 0; d < nDots; d++) {
        const dotId = eg.id * 10 + d;
        const startPos = d / nDots;
        dotStateRef.current.set(dotId, { pos: startPos, lat: eg.coords[0][0], lng: eg.coords[0][1] });
        const marker = L.circleMarker([eg.coords[0][0], eg.coords[0][1]], {
          radius: 2.5,
          color: "#fff",
          weight: 0,
          fillColor: "#fff",
          fillOpacity: 0.7,
          interactive: false,
        }).addTo(dotLayer);
        dotMarkers.set(dotId, marker);
      }
    }

    let lastTime = performance.now();

    function animate(now: number) {
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      for (const eg of edgeGeometries) {
        const state = edgeState[eg.id];
        if (!state) continue;
        const speedMs = Math.max(1, state.c * (eg.speed_limit_kmh ?? 40) / 3.6);
        const lengthM = edgeLengthMeters(eg.coords);
        if (lengthM < 1) continue;
        const stepFrac = (speedMs * dt) / lengthM;

        const nDots = Math.max(1, Math.round(state.c * DIURNAL_FACTORS[simHour] * (isWeekend ? WEEKEND_SCALE : 1.0) * 3));
        for (let d = 0; d < nDots; d++) {
          const dotId = eg.id * 10 + d;
          const ds = dotStateRef.current.get(dotId);
          if (!ds) continue;

          ds.pos = (ds.pos + stepFrac) % 1;

          const totalLen = lengthM;
          let targetDist = ds.pos * totalLen;
          let lat = eg.coords[0][0];
          let lng = eg.coords[0][1];

          for (let i = 1; i < eg.coords.length; i++) {
            const segLen = haversineMeters(eg.coords[i - 1], eg.coords[i]);
            if (targetDist <= segLen) {
              const t = targetDist / segLen;
              lat = eg.coords[i - 1][0] + t * (eg.coords[i][0] - eg.coords[i - 1][0]);
              lng = eg.coords[i - 1][1] + t * (eg.coords[i][1] - eg.coords[i - 1][1]);
              break;
            }
            targetDist -= segLen;
          }

          ds.lat = lat;
          ds.lng = lng;
          dotMarkers.get(dotId)?.setLatLng([lat, lng]);
        }
      }

      animFrameRef.current = requestAnimationFrame(animate);
    }

    animFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      dotLayer.clearLayers();
    };
  }, [showDots, simHour, isWeekend, edgeState, edgeGeometries, dotLayerRef]);

  return { simHour, setSimHour, isWeekend, setIsWeekend, showDots, setShowDots };
}
