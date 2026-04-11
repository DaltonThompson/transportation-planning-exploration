/**
 * Phase 11B: Corridor Dashboard.
 *
 * Shows aggregate congestion deltas and a baseline vs scenario time-series
 * for a user-selected corridor of edges, derived from the active run's
 * delta index and frame data.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Corridor } from "../store/useLayerStore";

interface Props {
  runId: string;
  corridors: Corridor[];
}

// Reconstruct final edge-congestion map from frames (full + diff replayed).
function buildStateAtFrames(frames: { t: number; full: boolean; edges: { id: number; c: number }[] }[]) {
  const byTime: { t: number; state: Record<number, number> }[] = [];
  const current: Record<number, number> = {};
  for (const frame of frames) {
    for (const e of frame.edges) current[e.id] = e.c;
    byTime.push({ t: frame.t, state: { ...current } });
  }
  return byTime;
}

function meanForEdges(state: Record<number, number>, edgeIds: number[]): number {
  if (edgeIds.length === 0) return 0;
  let sum = 0;
  let count = 0;
  for (const id of edgeIds) {
    if (id in state) { sum += state[id]; count++; }
  }
  return count > 0 ? sum / count : 0;
}

function SparkChart({
  baselineSeries,
  scenarioSeries,
}: {
  baselineSeries: { t: number; v: number }[];
  scenarioSeries: { t: number; v: number }[];
}) {
  const W = 228, H = 70;
  const allV = [...baselineSeries.map((d) => d.v), ...scenarioSeries.map((d) => d.v)];
  const minV = Math.min(...allV, 0);
  const maxV = Math.max(...allV, 0.01);
  const allT = [...baselineSeries.map((d) => d.t), ...scenarioSeries.map((d) => d.t)];
  const minT = Math.min(...allT);
  const maxT = Math.max(...allT, minT + 1);

  const toX = (t: number) => ((t - minT) / (maxT - minT)) * W;
  const toY = (v: number) => H - ((v - minV) / (maxV - minV)) * H;

  const polyline = (series: { t: number; v: number }[]) =>
    series.map((d) => `${toX(d.t).toFixed(1)},${toY(d.v).toFixed(1)}`).join(" ");

  return (
    <svg
      width={W}
      height={H}
      style={{ display: "block", overflow: "visible", marginTop: 6 }}
      aria-label="Baseline vs scenario congestion time-series"
    >
      {/* Zero line */}
      <line x1={0} y1={toY(0)} x2={W} y2={toY(0)} stroke="var(--border)" strokeWidth={0.5} />
      {/* Baseline */}
      {baselineSeries.length > 1 && (
        <polyline points={polyline(baselineSeries)} fill="none" stroke="var(--text-muted)" strokeWidth={1.5} />
      )}
      {/* Scenario */}
      {scenarioSeries.length > 1 && (
        <polyline points={polyline(scenarioSeries)} fill="none" stroke="var(--purple)" strokeWidth={1.5} />
      )}
    </svg>
  );
}

export function CorridorDashboard({ runId, corridors }: Props) {
  const activeCorridor = corridors[0] ?? null;
  const edgeSet = useMemo(
    () => new Set(activeCorridor?.edge_ids ?? []),
    [activeCorridor],
  );

  const { data: deltaIndex } = useQuery({
    queryKey: ["delta_index", runId],
    queryFn: () => api.getRunDeltaIndex(runId),
    enabled: !!runId,
    staleTime: Infinity,
  });

  const { data: baselineFrameResp } = useQuery({
    queryKey: ["frames", runId, "baseline"],
    queryFn: () => api.getRunFrames(runId, true),
    enabled: !!runId,
    staleTime: Infinity,
  });

  const { data: scenarioFrameResp } = useQuery({
    queryKey: ["frames", runId, "scenario"],
    queryFn: () => api.getRunFrames(runId, false),
    enabled: !!runId,
    staleTime: Infinity,
  });

  const corridorDeltas = useMemo(() => {
    if (!deltaIndex || edgeSet.size === 0) return null;
    const entries = Object.entries(deltaIndex.deltas)
      .filter(([id]) => edgeSet.has(Number(id)))
      .map(([, vals]) => vals[0]);
    if (entries.length === 0) return null;
    const mean = entries.reduce((a, b) => a + b, 0) / entries.length;
    const improved = entries.filter((v) => v < 0).length;
    const worsened = entries.filter((v) => v > 0).length;
    return { mean, improved, worsened, total: entries.length };
  }, [deltaIndex, edgeSet]);

  const { baselineSeries, scenarioSeries } = useMemo(() => {
    if (!baselineFrameResp || !scenarioFrameResp || edgeSet.size === 0) {
      return { baselineSeries: [], scenarioSeries: [] };
    }
    const edgeIds = Array.from(edgeSet);
    const bFrames = buildStateAtFrames(baselineFrameResp.frames as any);
    const sFrames = buildStateAtFrames(scenarioFrameResp.frames as any);
    // Sample every 6th keyframe (every ~3 minutes) for readability
    const sample = (arr: typeof bFrames) =>
      arr.filter((_, i) => i % 6 === 0 || i === arr.length - 1);
    return {
      baselineSeries: sample(bFrames).map((f) => ({ t: f.t, v: meanForEdges(f.state, edgeIds) })),
      scenarioSeries: sample(sFrames).map((f) => ({ t: f.t, v: meanForEdges(f.state, edgeIds) })),
    };
  }, [baselineFrameResp, scenarioFrameResp, edgeSet]);

  if (!activeCorridor) return null;

  const sign = corridorDeltas && corridorDeltas.mean > 0 ? "+" : "";
  const deltaColor =
    !corridorDeltas ? "var(--text-muted)"
    : Math.abs(corridorDeltas.mean) < 0.005 ? "var(--text-muted)"
    : corridorDeltas.mean > 0 ? "var(--red)"
    : "var(--green)";

  return (
    <div style={{
      marginTop: 14,
      borderTop: "1px solid var(--border)",
      paddingTop: 10,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--purple)", letterSpacing: 1, marginBottom: 6 }}>
        CORRIDOR: {activeCorridor.name.toUpperCase()}
      </div>
      <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>
        {activeCorridor.edge_ids.length} edges
      </div>

      {corridorDeltas ? (
        <div style={{ fontSize: 11, display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-primary)" }}>Mean congestion Δ</span>
            <span style={{ color: deltaColor, fontFamily: "var(--font-mono)", fontWeight: 600 }}>
              {sign}{(corridorDeltas.mean * 100).toFixed(1)} pp
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-muted)" }}>Improved / worsened</span>
            <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              <span style={{ color: "var(--green)" }}>{corridorDeltas.improved}</span>
              {" / "}
              <span style={{ color: "var(--red)" }}>{corridorDeltas.worsened}</span>
            </span>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
          {deltaIndex ? "No change detected on corridor edges." : "Loading…"}
        </div>
      )}

      {baselineSeries.length > 1 && (
        <>
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 8, marginBottom: 2, display: "flex", gap: 10 }}>
            <span>
              <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>— </span>baseline
            </span>
            <span>
              <span style={{ color: "var(--purple)", fontWeight: 600 }}>— </span>scenario
            </span>
          </div>
          <SparkChart baselineSeries={baselineSeries} scenarioSeries={scenarioSeries} />
          <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 3 }}>
            Mean congestion factor · 0 = free-flow · 1 = full stop
          </div>
        </>
      )}
    </div>
  );
}
