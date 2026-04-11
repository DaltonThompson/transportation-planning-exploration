/** Collision junction overlay (F4). */

import { useEffect } from "react";
import L from "leaflet";
import type { CollisionJunction } from "../api/client";

export function useCollisionOverlay(
  junctionLayerRef: React.RefObject<L.LayerGroup | null>,
  enabled: boolean,
  collisionData: { junctions: CollisionJunction[] } | undefined,
) {
  useEffect(() => {
    const jLayer = junctionLayerRef.current;
    if (!jLayer) return;
    jLayer.clearLayers();
    if (!enabled || !collisionData) return;

    for (const junc of collisionData.junctions) {
      const r = Math.min(20, 4 + junc.count * 1.5);
      L.circleMarker([junc.lat, junc.lng], {
        radius: r,
        color: junc.high_collision ? "#ff0000" : "#ff8800",
        weight: junc.high_collision ? 2 : 1,
        fillColor: junc.high_collision ? "#ff000066" : "#ff880044",
        fillOpacity: 0.6,
      })
        .bindTooltip(
          `${junc.count} crashes<br>${junc.killed} killed / ${junc.injured} injured${junc.high_collision ? "<br><b>⚠ High collision</b>" : ""}`,
          { sticky: true }
        )
        .addTo(jLayer);
    }
  }, [enabled, collisionData, junctionLayerRef]);
}
