"""
FY2025 CDTA on-time performance data.

Mirrors frontend/src/utils/cdtaRoutes.ts FY2025_PERFORMANCE. Keyed by
route_short_name (stringified route number). Frozen historical dataset —
static duplication is intentional per Phase 12D.

Routes with no OTP entry have no CAD/AVL installed (402, 404, 405, 407,
411, 412, 419) and the 800-series school trips are also excluded. Routes
905 and 910 are headway-managed — their OTP methodology is not directly
comparable to fixed-schedule routes.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class OnTimePerformance:
    on_time: int   # percent on time
    early: int     # percent early
    late: int      # percent late
    headway_managed: bool = False


@dataclass(frozen=True)
class RoutePerformance:
    total_rides: int
    revenue_hours: int
    productivity: float
    otp: OnTimePerformance | None = None
    note: str = ""


def _p(rides: int, hours: int, prod: float,
       otp: tuple[int, int, int] | None = None,
       managed: bool = False, note: str = "") -> RoutePerformance:
    return RoutePerformance(
        total_rides=rides,
        revenue_hours=hours,
        productivity=prod,
        otp=OnTimePerformance(on_time=otp[0], early=otp[1], late=otp[2],
                              headway_managed=managed) if otp else None,
        note=note,
    )


FY2025_PERFORMANCE: dict[str, RoutePerformance] = {
    "1":   _p(1_357_926, 37_556, 36.2, (68, 10, 22)),
    "10":  _p(  560_943, 28_383, 19.8, (71,  6, 23)),
    "12":  _p(1_117_949, 33_548, 33.3, (70,  6, 24)),
    "13":  _p(  289_232, 16_701, 17.3, (72,  7, 21)),
    "18":  _p(  346_696, 16_718, 20.7, (67,  6, 27)),
    "22":  _p(  505_116, 25_372, 19.9, (79,  3, 18)),
    "85":  _p(  629_575, 22_755, 27.7, (72,  6, 22)),
    "87":  _p(  551_923, 23_443, 23.5, (76,  4, 20)),
    "100": _p(1_116_839, 36_996, 30.2, (61, 14, 25)),
    "106": _p(  703_227, 28_916, 24.3, (56, 11, 33)),
    "107": _p(  264_834, 10_195, 26.0, (72,  7, 21)),
    "111": _p(   14_335,  1_387, 10.3, (64, 13, 23), note="Eliminated Aug 2024"),
    "114": _p(  559_804, 31_810, 17.6, (68,  4, 28)),
    "117": _p(   50_848,  4_090, 12.4, (69, 14, 17)),
    "125": _p(  162_305,  8_169, 19.9, (68,  5, 27)),
    "155": _p(      908,    341,  2.7, (63, 17, 21)),
    "182": _p(  518_991, 30_283, 17.1, (70,  6, 25)),
    "190": _p(   32_442,  2_503, 13.0, (85,  6,  8)),
    "214": _p(  209_967, 11_009, 19.1, (77,  9, 14)),
    "224": _p(  200_422,  9_032, 22.2, (77,  6, 17)),
    "233": _p(   93_304,  4_077, 22.9, (76,  5, 20)),
    "286": _p(   57_857,  4_820, 12.0, (78,  7, 15)),
    "289": _p(   71_206,  5_625, 12.7, (69,  5, 25)),
    "351": _p(  335_079, 14_177, 23.6, (81,  3, 16)),
    "352": _p(   25_508,  2_219, 11.5, (80,  8, 12)),
    "353": _p(  589_487, 24_799, 23.8, (77,  1, 22)),
    "354": _p(   64_922,  3_831, 16.9, (80,  2, 18)),
    "355": _p(  544_111, 22_003, 24.7, (67,  8, 25)),
    "370": _p(  603_633, 27_952, 21.6, (71,  6, 23)),
    "402": _p(    5_514,  2_683,  2.1),
    "404": _p(   51_499,  5_764,  8.9),
    "405": _p(    6_571,  1_500,  4.4),
    "407": _p(    6_372,  1_254,  5.1),
    "411": _p(   14_717,  3_005,  4.9),
    "412": _p(    8_049,  2_096,  3.8),
    "419": _p(    4_197,  1_165,  3.6),
    "450": _p(  336_223, 29_789, 11.3, (67,  5, 29)),
    "451": _p(   19_223,  4_507,  4.3, (75, 10, 16)),
    "452": _p(   54_819,  9_625,  5.7, (78,  8, 14)),
    "519": _p(   13_495,  1_554,  8.7, (69, 13, 17)),
    "524": _p(   85_388,  3_054, 28.0, (80,  5, 15)),
    "540": _p(   79_357,  6_044, 13.1, (57, 25, 18)),
    "560": _p(   27_687,  3_178,  8.7, (65, 27,  9)),
    "600": _p(  107_936,  9_631, 11.2, (80,  9, 10)),
    "601": _p(   58_150,  7_974,  7.3, (86,  7,  8)),
    "602": _p(   51_719,  7_794,  6.6, (82,  9,  9)),
    "605": _p(   17_240,  2_018,  8.5, (59,  3, 38), note="Established Jun 2024"),
    "712": _p(   24_653,  1_443, 17.1, (74,  9, 17)),
    "737": _p(   52_059,  5_125, 10.2, (71, 10, 19)),
    "763": _p(   34_846,  2_597, 13.4, (70,  3, 27)),
    "905": _p(2_028_159, 62_580, 32.4, (66, 17, 17), managed=True),
    "910": _p(1_142_000, 48_760, 23.4, (71, 12, 18), managed=True),
    "922": _p(1_480_063, 63_620, 23.3, (70,  3, 26), note="Combined 922/923 figure"),
    "923": _p(1_480_063, 63_620, 23.3, (70,  3, 26), note="Combined 922/923 figure"),
}

# Routes whose OTP is missing because CAD/AVL isn't installed.
NO_CAD_AVL_ROUTES: frozenset[str] = frozenset({
    "402", "404", "405", "407", "411", "412", "419",
})


def reliability_annotation(route_short_name: str) -> dict:
    """
    Build the reliability annotation block for a route. Always returns a
    dict with a `source` field so callers can attach it verbatim to
    schedule responses. See Phase 12D for labeling rules.
    """
    key = (route_short_name or "").strip()
    entry = FY2025_PERFORMANCE.get(key)

    base = {"source": "FY2025 actuals (CDTA)", "route_short_name": key}

    if entry is None:
        if key in NO_CAD_AVL_ROUTES:
            return {**base, "available": False,
                    "reason": "No reliability data — CAD/AVL not installed on this route"}
        return {**base, "available": False,
                "reason": "No FY2025 performance data for this route"}

    if entry.otp is None:
        return {**base, "available": False,
                "reason": "No reliability data — CAD/AVL not installed on this route",
                "note": entry.note or None}

    if entry.otp.headway_managed:
        return {
            **base,
            "available": False,
            "headway_managed": True,
            "reason": ("This route operates on managed headway — buses run at "
                       "regular intervals rather than fixed arrival times"),
        }

    out = {
        **base,
        "available": True,
        "on_time_pct": entry.otp.on_time,
        "early_pct": entry.otp.early,
        "late_pct": entry.otp.late,
    }
    if entry.note:
        out["note"] = entry.note
        if "Eliminated" in entry.note:
            out["historical_only"] = True
    return out
