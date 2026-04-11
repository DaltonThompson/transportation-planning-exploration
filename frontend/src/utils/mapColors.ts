/** Color scale functions for map overlays. */

export function congestionColor(factor: number): string {
  const t = Math.max(0, Math.min(1, (factor - 0.2) / 0.8));
  return `rgb(${Math.round(255 * (1 - t))},${Math.round(255 * t)},0)`;
}

export function speedColor(kph: number): string {
  // 15 kph (residential) → dark blue; 105 kph (motorway) → bright cyan
  const t = Math.max(0, Math.min(1, (kph - 15) / 90));
  const r = Math.round(20 + 80 * (1 - t));
  const g = Math.round(100 + 155 * t);
  const b = Math.round(200 + 55 * t);
  return `rgb(${r},${g},${b})`;
}

export function headwayColor(headway_s: number): string {
  if (headway_s <= 300)  return "#4dabf7";   // ≤5 min  → blue
  if (headway_s <= 600)  return "#69db7c";   // ≤10 min → green
  if (headway_s <= 1800) return "#ffd43b";   // ≤30 min → yellow
  return "#ff6b6b";                          // >30 min → red
}

export function throughVsLocalColor(ratio: number): string {
  // ratio: 0 = all local, 1 = all through
  const t = Math.max(0, Math.min(1, ratio));
  return `rgb(${Math.round(255 * t)},${Math.round(80 * (1 - t))},${Math.round(200 * (1 - t))})`;
}
