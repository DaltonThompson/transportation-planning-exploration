/**
 * Side-by-side metric comparison: baseline vs scenario delta.
 * Phase 11B: includes CorridorDashboard when a run is complete and corridors exist.
 */

import type { MetricDeltas } from "../api/client";
import type { Corridor } from "../store/useLayerStore";
import { ChangelogPanel } from "./ChangelogPanel";
import { CorridorDashboard } from "./CorridorDashboard";

interface Props {
  metrics: MetricDeltas | null;
  scenarioName: string;
  runId?: string | null;
  corridors?: Corridor[];
}

function DeltaRow({
  label,
  value,
  unit = "%",
  positiveIsBad = true,
}: {
  label: string;
  value: number;
  unit?: string;
  positiveIsBad?: boolean;
}) {
  const isBad = positiveIsBad ? value > 0 : value < 0;
  const color = Math.abs(value) < 0.5 ? "var(--text-muted)" : isBad ? "var(--red)" : "var(--green)";
  const sign = value > 0 ? "+" : "";

  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
      <span style={{ color: "var(--text-primary)" }}>{label}</span>
      <span style={{ color, fontWeight: 600, fontVariantNumeric: "tabular-nums", fontFamily: "var(--font-mono)" }}>
        {sign}{value.toFixed(1)}{unit}
      </span>
    </div>
  );
}

export function ComparisonPanel({ metrics, scenarioName, runId, corridors = [] }: Props) {
  return (
    <div style={{
      background: "var(--bg-primary)",
      color: "var(--text-primary)",
      padding: 16,
      width: 260,
      borderLeft: "1px solid var(--border)",
      fontFamily: "var(--font-sans)",
      fontSize: 13,
    }}>
      <h3 style={{ margin: "0 0 12px", fontSize: 13, color: "var(--purple)", fontWeight: 700, letterSpacing: 1 }}>
        SCENARIO VS BASELINE
      </h3>
      <div style={{ marginBottom: 8, color: "var(--text-muted)", fontSize: 11 }}>
        {scenarioName || "—"}
      </div>

      {metrics ? (
        <>
          <DeltaRow label="Travel time"   value={metrics.travel_time_delta_pct}  positiveIsBad={true} />
          <DeltaRow label="Congestion"    value={metrics.congestion_delta_pct}   positiveIsBad={true} />
          <DeltaRow label="Transit dwell" value={metrics.transit_time_delta_pct} positiveIsBad={true} />
          <DeltaRow label="Excess delay"  value={metrics.delay_delta_pct}        positiveIsBad={true} />
          <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-muted)" }}>
            Negative = improvement
          </div>
          <div style={{
            marginTop: 10,
            padding: "6px 8px",
            background: "var(--bg-secondary)",
            borderRadius: "var(--radius)",
            fontSize: 10,
            color: "var(--text-muted)",
            lineHeight: 1.5,
          }}>
            Model scope: traffic flow and transit dwell only. Mode shift, induced demand, and ridership changes are not modeled.
          </div>
        </>
      ) : (
        <div style={{ color: "var(--text-muted)", marginTop: 16, fontSize: 12 }}>
          Run a simulation to see results.
        </div>
      )}

      {runId && metrics && corridors.length > 0 && (
        <CorridorDashboard runId={runId} corridors={corridors} />
      )}

      <ChangelogPanel />
    </div>
  );
}
