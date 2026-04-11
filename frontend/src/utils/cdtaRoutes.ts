/**
 * CDTA route service type classification and FY2025 performance data.
 * Source: CDTA Route Performance Report, Fiscal Year 2025 (April 2024 – March 2025).
 */

export type CdtaServiceType =
  | "brt"
  | "trunk"
  | "neighborhood"
  | "express"
  | "commuter"
  | "800series"
  | "flex"
  | "unknown";

// BRT routes — BusPlus branded rapid transit
const BRT_ROUTES    = new Set(["905", "910", "922", "923"]);
// Trunk routes — high-frequency urban corridors
const TRUNK_ROUTES  = new Set(["1", "10", "12", "22", "114", "182"]);
// Express routes — limited-stop, largely peak-period
const EXPRESS_ROUTES = new Set(["519", "524", "540", "560"]);
// Commuter routes — peak-oriented service to employment centers
const COMMUTER_ROUTES = new Set([
  "190", "224", "402", "404", "405", "407", "411", "412", "419",
  "451", "452", "601", "602", "712", "737", "763",
]);

/**
 * Return the CDTA service type for a given route short name.
 * For non-CDTA feeds, call site should gate on feedSlug === "cdta".
 */
export function cdtaServiceType(routeShortName: string): CdtaServiceType {
  const n = routeShortName.trim();
  if (BRT_ROUTES.has(n))      return "brt";
  if (TRUNK_ROUTES.has(n))    return "trunk";
  if (EXPRESS_ROUTES.has(n))  return "express";
  if (COMMUTER_ROUTES.has(n)) return "commuter";
  const num = parseInt(n, 10);
  if (!isNaN(num) && num >= 800 && num < 900) return "800series";
  if (isNaN(num)) return "flex";
  return "neighborhood";
}

// ─── Service type thresholds ──────────────────────────────────────────────────
// From CDTA Transit Development Plan (TDP), as published in the FY2025 RPR.

export interface ServiceTypeThresholds {
  label: string;
  minBoardings: number;      // annual
  minRidersPerHour: number;  // productivity threshold
}

export const SERVICE_TYPE_THRESHOLDS: Record<string, ServiceTypeThresholds> = {
  brt:          { label: "BRT (BusPlus)",  minBoardings: 250_000, minRidersPerHour: 25 },
  trunk:        { label: "Trunk",          minBoardings: 250_000, minRidersPerHour: 25 },
  neighborhood: { label: "Neighborhood",   minBoardings: 100_000, minRidersPerHour: 20 },
  express:      { label: "Express",        minBoardings:  30_000, minRidersPerHour: 15 },
  commuter:     { label: "Commuter",       minBoardings:  16_000, minRidersPerHour: 12 },
};

// ─── Line rendering styles ────────────────────────────────────────────────────

export interface RouteLineStyle {
  colorWeight: number;
  casingWeight: number;
  dashArray?: string;
}

/**
 * Per-service-type Leaflet polyline weights.
 * Casing is always colorWeight + 5 so the white border is a consistent 2.5 px each side.
 */
export function routeLineStyle(serviceType: CdtaServiceType): RouteLineStyle {
  switch (serviceType) {
    case "brt":
      return { colorWeight: 7, casingWeight: 12 };
    case "trunk":
      return { colorWeight: 5, casingWeight: 10 };
    case "neighborhood":
      return { colorWeight: 4, casingWeight: 9 };
    case "express":
      return { colorWeight: 3, casingWeight: 8, dashArray: "10 5" };
    case "commuter":
      return { colorWeight: 3, casingWeight: 8, dashArray: "4 4" };
    case "800series":
    case "flex":
      return { colorWeight: 3, casingWeight: 8 };
    default:
      return { colorWeight: 4, casingWeight: 9 };
  }
}

// ─── FY2025 performance data ──────────────────────────────────────────────────

export interface OnTimePerformance {
  onTime: number;   // percent on time
  early: number;    // percent early
  late: number;     // percent late
  /** True for headway-managed routes (905, 910) — OTP methodology differs */
  headwayManaged?: boolean;
}

export interface RoutePerformance {
  totalRides: number;
  revenueHours: number;
  productivity: number;  // rides per revenue hour
  otp?: OnTimePerformance;
  note?: string;         // e.g. "eliminated FY25", "combined 922/923"
}

/**
 * FY2025 per-route performance.
 * Key is CDTA route_short_name (the number as a string).
 * Routes 922 and 923 share the Blue Line combined figure.
 * Route 111 was eliminated mid-year; data covers its partial-year operation.
 * Route 605 was established mid-year; data covers its partial-year operation.
 * 800 Series is aggregated only — individual school routes are not listed.
 */
// OTP not reported for:
//   - 800 Series (school trips begin when school lets out, not schedule-based)
//   - Glens Falls routes 402/404/405/407/411/412/419 (CAD/AVL not yet installed)
// Routes 905 and 910 are headway-managed; OTP methodology differs from fixed-schedule routes.
export const FY2025_PERFORMANCE: Record<string, RoutePerformance> = {
  "1":   { totalRides: 1_357_926, revenueHours: 37_556, productivity: 36.2, otp: { onTime: 68, early: 10, late: 22 } },
  "10":  { totalRides:   560_943, revenueHours: 28_383, productivity: 19.8, otp: { onTime: 71, early:  6, late: 23 } },
  "12":  { totalRides: 1_117_949, revenueHours: 33_548, productivity: 33.3, otp: { onTime: 70, early:  6, late: 24 } },
  "13":  { totalRides:   289_232, revenueHours: 16_701, productivity: 17.3, otp: { onTime: 72, early:  7, late: 21 } },
  "18":  { totalRides:   346_696, revenueHours: 16_718, productivity: 20.7, otp: { onTime: 67, early:  6, late: 27 } },
  "22":  { totalRides:   505_116, revenueHours: 25_372, productivity: 19.9, otp: { onTime: 79, early:  3, late: 18 } },
  "85":  { totalRides:   629_575, revenueHours: 22_755, productivity: 27.7, otp: { onTime: 72, early:  6, late: 22 } },
  "87":  { totalRides:   551_923, revenueHours: 23_443, productivity: 23.5, otp: { onTime: 76, early:  4, late: 20 } },
  "100": { totalRides: 1_116_839, revenueHours: 36_996, productivity: 30.2, otp: { onTime: 61, early: 14, late: 25 } },
  "106": { totalRides:   703_227, revenueHours: 28_916, productivity: 24.3, otp: { onTime: 56, early: 11, late: 33 } },
  "107": { totalRides:   264_834, revenueHours: 10_195, productivity: 26.0, otp: { onTime: 72, early:  7, late: 21 } },
  "111": { totalRides:    14_335, revenueHours:  1_387, productivity: 10.3, otp: { onTime: 64, early: 13, late: 23 }, note: "Eliminated Aug 2024" },
  "114": { totalRides:   559_804, revenueHours: 31_810, productivity: 17.6, otp: { onTime: 68, early:  4, late: 28 } },
  "117": { totalRides:    50_848, revenueHours:  4_090, productivity: 12.4, otp: { onTime: 69, early: 14, late: 17 } },
  "125": { totalRides:   162_305, revenueHours:  8_169, productivity: 19.9, otp: { onTime: 68, early:  5, late: 27 } },
  "155": { totalRides:       908, revenueHours:    341, productivity:  2.7, otp: { onTime: 63, early: 17, late: 21 } },
  "182": { totalRides:   518_991, revenueHours: 30_283, productivity: 17.1, otp: { onTime: 70, early:  6, late: 25 } },
  "190": { totalRides:    32_442, revenueHours:  2_503, productivity: 13.0, otp: { onTime: 85, early:  6, late:  8 } },
  "214": { totalRides:   209_967, revenueHours: 11_009, productivity: 19.1, otp: { onTime: 77, early:  9, late: 14 } },
  "224": { totalRides:   200_422, revenueHours:  9_032, productivity: 22.2, otp: { onTime: 77, early:  6, late: 17 } },
  "233": { totalRides:    93_304, revenueHours:  4_077, productivity: 22.9, otp: { onTime: 76, early:  5, late: 20 } },
  "286": { totalRides:    57_857, revenueHours:  4_820, productivity: 12.0, otp: { onTime: 78, early:  7, late: 15 } },
  "289": { totalRides:    71_206, revenueHours:  5_625, productivity: 12.7, otp: { onTime: 69, early:  5, late: 25 } },
  "351": { totalRides:   335_079, revenueHours: 14_177, productivity: 23.6, otp: { onTime: 81, early:  3, late: 16 } },
  "352": { totalRides:    25_508, revenueHours:  2_219, productivity: 11.5, otp: { onTime: 80, early:  8, late: 12 } },
  "353": { totalRides:   589_487, revenueHours: 24_799, productivity: 23.8, otp: { onTime: 77, early:  1, late: 22 } },
  "354": { totalRides:    64_922, revenueHours:  3_831, productivity: 16.9, otp: { onTime: 80, early:  2, late: 18 } },
  "355": { totalRides:   544_111, revenueHours: 22_003, productivity: 24.7, otp: { onTime: 67, early:  8, late: 25 } },
  "370": { totalRides:   603_633, revenueHours: 27_952, productivity: 21.6, otp: { onTime: 71, early:  6, late: 23 } },
  "402": { totalRides:     5_514, revenueHours:  2_683, productivity:  2.1 },  // no OTP — no CAD/AVL
  "404": { totalRides:    51_499, revenueHours:  5_764, productivity:  8.9 },  // no OTP — no CAD/AVL
  "405": { totalRides:     6_571, revenueHours:  1_500, productivity:  4.4 },  // no OTP — no CAD/AVL
  "407": { totalRides:     6_372, revenueHours:  1_254, productivity:  5.1 },  // no OTP — no CAD/AVL
  "411": { totalRides:    14_717, revenueHours:  3_005, productivity:  4.9 },  // no OTP — no CAD/AVL
  "412": { totalRides:     8_049, revenueHours:  2_096, productivity:  3.8 },  // no OTP — no CAD/AVL
  "419": { totalRides:     4_197, revenueHours:  1_165, productivity:  3.6 },  // no OTP — no CAD/AVL
  "450": { totalRides:   336_223, revenueHours: 29_789, productivity: 11.3, otp: { onTime: 67, early:  5, late: 29 } },
  "451": { totalRides:    19_223, revenueHours:  4_507, productivity:  4.3, otp: { onTime: 75, early: 10, late: 16 } },
  "452": { totalRides:    54_819, revenueHours:  9_625, productivity:  5.7, otp: { onTime: 78, early:  8, late: 14 } },
  "519": { totalRides:    13_495, revenueHours:  1_554, productivity:  8.7, otp: { onTime: 69, early: 13, late: 17 } },
  "524": { totalRides:    85_388, revenueHours:  3_054, productivity: 28.0, otp: { onTime: 80, early:  5, late: 15 } },
  "540": { totalRides:    79_357, revenueHours:  6_044, productivity: 13.1, otp: { onTime: 57, early: 25, late: 18 } },
  "560": { totalRides:    27_687, revenueHours:  3_178, productivity:  8.7, otp: { onTime: 65, early: 27, late:  9 } },
  "600": { totalRides:   107_936, revenueHours:  9_631, productivity: 11.2, otp: { onTime: 80, early:  9, late: 10 } },
  "601": { totalRides:    58_150, revenueHours:  7_974, productivity:  7.3, otp: { onTime: 86, early:  7, late:  8 } },
  "602": { totalRides:    51_719, revenueHours:  7_794, productivity:  6.6, otp: { onTime: 82, early:  9, late:  9 } },
  "605": { totalRides:    17_240, revenueHours:  2_018, productivity:  8.5, otp: { onTime: 59, early:  3, late: 38 }, note: "Established Jun 2024" },
  "712": { totalRides:    24_653, revenueHours:  1_443, productivity: 17.1, otp: { onTime: 74, early:  9, late: 17 } },
  "737": { totalRides:    52_059, revenueHours:  5_125, productivity: 10.2, otp: { onTime: 71, early: 10, late: 19 } },
  "763": { totalRides:    34_846, revenueHours:  2_597, productivity: 13.4, otp: { onTime: 70, early:  3, late: 27 } },
  "905": { totalRides: 2_028_159, revenueHours: 62_580, productivity: 32.4, otp: { onTime: 66, early: 17, late: 17, headwayManaged: true } },
  "910": { totalRides: 1_142_000, revenueHours: 48_760, productivity: 23.4, otp: { onTime: 71, early: 12, late: 18, headwayManaged: true } },
  "922": { totalRides: 1_480_063, revenueHours: 63_620, productivity: 23.3, otp: { onTime: 70, early:  3, late: 26 }, note: "Combined 922/923 figure" },
  "923": { totalRides: 1_480_063, revenueHours: 63_620, productivity: 23.3, otp: { onTime: 70, early:  3, late: 26 }, note: "Combined 922/923 figure" },
};
