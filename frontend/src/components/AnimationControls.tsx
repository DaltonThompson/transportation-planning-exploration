/** Animation controls UI (H1) — shown only when a simulation has run. */

interface Props {
  showDots: boolean;
  setShowDots: (v: boolean) => void;
  simHour: number;
  setSimHour: (v: number) => void;
  isWeekend: boolean;
  setIsWeekend: (v: boolean) => void;
}

export function AnimationControls({
  showDots, setShowDots,
  simHour, setSimHour,
  isWeekend, setIsWeekend,
}: Props) {
  return (
    <div style={{
      position: "absolute",
      bottom: 48,
      left: "50%",
      transform: "translateX(-50%)",
      background: "var(--bg-primary)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius)",
      padding: "8px 14px",
      display: "flex",
      alignItems: "center",
      gap: 12,
      zIndex: 900,
      fontFamily: "var(--font-sans)",
      fontSize: 12,
      boxShadow: "var(--shadow)",
      color: "var(--text-primary)",
    }}>
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="checkbox"
          checked={showDots}
          onChange={(e) => setShowDots(e.target.checked)}
          style={{ accentColor: "var(--purple)" }}
        />
        <span>Vehicle animation</span>
      </label>

      {showDots && (
        <>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--text-muted)" }}>Hour:</span>
            <input
              type="range"
              min={0} max={23} value={simHour}
              onChange={(e) => setSimHour(Number(e.target.value))}
              style={{ width: 100, accentColor: "var(--purple)" }}
            />
            <span style={{ minWidth: 32, fontFamily: "var(--font-mono)" }}>
              {String(simHour).padStart(2, "0")}:00
            </span>
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={isWeekend}
              onChange={(e) => setIsWeekend(e.target.checked)}
              style={{ accentColor: "var(--purple)" }}
            />
            <span>Weekend</span>
          </label>
        </>
      )}
    </div>
  );
}
