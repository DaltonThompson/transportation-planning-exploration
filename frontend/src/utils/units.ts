export const kphToMph = (kph: number): number => kph * 0.621371;
export const mphToKph = (mph: number): number => mph / 0.621371;
export const metersToFeet = (m: number): number => m * 3.28084;
export const metersToMiles = (m: number): number => m / 1609.34;

export function formatSpeed(kph: number): string {
  return `${Math.round(kphToMph(kph))} mph`;
}

export function formatDistance(meters: number): string {
  const feet = metersToFeet(meters);
  if (feet < 1000) return `${Math.round(feet)} ft`;
  return `${metersToMiles(meters).toFixed(2)} mi`;
}
