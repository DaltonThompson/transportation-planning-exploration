/**
 * Root application component.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────┐
 *   │ status bar                                  │
 *   ├───────────────┬─────────────────┬───────────┤
 *   │ ScenarioSidebar│  MapRenderer   │ CompPanel │
 *   │               │  [LayerPanel]  │           │
 *   │               ├────────────────┤           │
 *   │               │ TimelineCtrl   │           │
 *   └───────────────┴────────────────┴───────────┘
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api/client";
import type { MetricDeltas } from "./api/client";
import { MapRenderer } from "./components/MapRenderer";
import { TimelineController } from "./components/TimelineController";
import { ComparisonPanel } from "./components/ComparisonPanel";
import { ScenarioSidebar } from "./components/ScenarioSidebar";
import { LayerPanel } from "./components/LayerPanel";
import { MapLegend } from "./components/MapLegend";
import { SelectionPanel } from "./components/SelectionPanel";
import { useSimStore } from "./store/useSimStore";
import { useLayerStore } from "./store/useLayerStore";
import { SIMULATION_ENABLED } from "./utils/simulationFlag";

// Geographic center of Albany + Rensselaer + Schenectady Counties
const MAP_CENTER: [number, number] = [42.72, -73.85];
const MAP_ZOOM = 12;

// Detect ?run=<run_id> in the URL for read-only shared view
const _sharedRunId = new URLSearchParams(window.location.search).get("run");

export default function App() {
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId]               = useState<string | null>(null);
  const [metrics, setMetrics]                       = useState<MetricDeltas | null>(null);
  const [scenarioName, setScenarioName]             = useState("");
  const [readOnly, setReadOnly]                     = useState(!!_sharedRunId);
  const [copyLabel, setCopyLabel]                   = useState("Copy link");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadFrames = useSimStore((s) => s.loadFrames);
  const corridors  = useLayerStore((s) => s.corridors);

  const { data: graphInfo } = useQuery({
    queryKey: ["graph"],
    queryFn: api.getGraph,
    refetchInterval: 30_000,
  });

  const { data: serverStatus } = useQuery({
    queryKey: ["status"],
    queryFn: api.getStatus,
    // Poll every 2s until stops are loaded, then drop to 30s
    refetchInterval: (query) => {
      const d = query.state.data;
      return d?.stops_loaded || d?.gtfs_disabled ? 30_000 : 2_000;
    },
  });

  const { data: edgesData } = useQuery({
    queryKey: ["graph-edges"],
    queryFn: () => fetch("/api/graph/edges").then((r) => r.json()),
    enabled: graphInfo?.loaded === true,
    staleTime: Infinity,
  });
  const edgeGeometries = edgesData?.edges ?? [];

  // Run polling
  useEffect(() => {
    if (!activeRunId) return;
    pollRef.current = setInterval(async () => {
      try {
        const run = await api.getRun(activeRunId);
        if (run.status === "complete") {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          const frameResp = await api.getRunFrames(activeRunId, false);
          loadFrames(frameResp.frames, activeRunId, false);
          if (run.metrics) setMetrics(run.metrics);
        } else if (run.status === "failed") {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          console.error("Run failed:", run.error);
        }
      } catch (e) {
        console.error("Polling error:", e);
      }
    }, 500);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeRunId, loadFrames]);

  useEffect(() => {
    if (!selectedScenarioId) return;
    api.getScenario(selectedScenarioId).then((s) => setScenarioName(s.name)).catch(() => {});
  }, [selectedScenarioId]);

  // Load shared run on mount (read-only mode)
  useEffect(() => {
    if (!_sharedRunId) return;
    (async () => {
      try {
        const run = await api.getRun(_sharedRunId);
        if (run.status === "complete") {
          const frameResp = await api.getRunFrames(_sharedRunId, false);
          loadFrames(frameResp.frames, _sharedRunId, false);
          if (run.metrics) setMetrics(run.metrics);
          const share = await api.getShare(_sharedRunId);
          setScenarioName(share.scenario_name);
          setActiveRunId(_sharedRunId);
        }
      } catch (e) {
        console.error("Failed to load shared run:", e);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCopyLink = useCallback(() => {
    const url = `${window.location.origin}/?run=${activeRunId ?? _sharedRunId}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopyLabel("Copied!");
      setTimeout(() => setCopyLabel("Copy link"), 2000);
    });
  }, [activeRunId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0a0a18", color: "var(--text-primary)", fontFamily: "var(--font-sans)" }}>
      {/* Read-only shared view banner */}
      {readOnly && (
        <div style={{ padding: "6px 12px", background: "#1a1a2e", borderBottom: "1px solid #3b3b6b", fontSize: 12, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: "#a78bfa", fontWeight: 600 }}>Shared view</span>
          {scenarioName && <span style={{ color: "var(--text-muted)" }}>— {scenarioName}</span>}
          <button
            onClick={handleCopyLink}
            style={{ marginLeft: "auto", padding: "2px 10px", background: "var(--purple)", border: "none", borderRadius: 4, color: "#fff", fontSize: 11, cursor: "pointer" }}
          >
            {copyLabel}
          </button>
          <button
            onClick={() => { setReadOnly(false); window.history.replaceState({}, "", window.location.pathname); }}
            style={{ padding: "2px 10px", background: "transparent", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}
          >
            Edit mode
          </button>
        </div>
      )}
      {/* Status bar */}
      <div style={{ padding: "4px 12px", background: "var(--bg-primary)", fontSize: 11, color: "var(--text-muted)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
        {graphInfo?.loaded ? (
          <span>{graphInfo.place} — {graphInfo.node_count?.toLocaleString()} nodes / {graphInfo.edge_count?.toLocaleString()} road segments / {graphInfo.stop_count ?? 0} transit stops</span>
        ) : (
          <>
            <span style={{ display: "inline-block", width: 12, height: 12, border: "2px solid var(--purple)", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
            <span>Loading OSM graph…</span>
          </>
        )}
        {graphInfo?.loaded && !serverStatus?.stops_loaded && !serverStatus?.gtfs_disabled && (
          <>
            <span style={{ display: "inline-block", width: 10, height: 10, border: "2px solid #f59e0b", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
            <span style={{ color: "#f59e0b" }}>Syncing GTFS…</span>
          </>
        )}
        {activeRunId && !readOnly && SIMULATION_ENABLED && <span style={{ marginLeft: 8, color: "var(--purple)" }}>Run {activeRunId.slice(0, 8)}…</span>}
        {!SIMULATION_ENABLED && (
          <span style={{ marginLeft: 8, color: "var(--text-muted)", fontStyle: "italic" }}>
            Simulation features are under development
          </span>
        )}
        {activeRunId && !readOnly && SIMULATION_ENABLED && metrics && (
          <button
            onClick={handleCopyLink}
            style={{ marginLeft: "auto", padding: "2px 8px", background: "transparent", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}
          >
            {copyLabel}
          </button>
        )}
      </div>
      {/* Indeterminate progress bar while graph is loading */}
      {!graphInfo?.loaded && (
        <div style={{ height: 3, background: "var(--bg-surface)", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", height: "100%", background: "var(--purple)", animation: "indeterminate 1.4s ease infinite" }} />
        </div>
      )}

      {/* Main area */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {!readOnly && SIMULATION_ENABLED && (
          <ScenarioSidebar
            selectedScenarioId={selectedScenarioId}
            onSelect={setSelectedScenarioId}
            onRunStarted={(runId) => { setActiveRunId(runId); setMetrics(null); }}
          />
        )}

        <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative" }}>
          <div style={{ flex: 1, position: "relative" }}>
            <MapRenderer
              center={MAP_CENTER}
              zoom={MAP_ZOOM}
              edgeGeometries={edgeGeometries}
            />
            <LayerPanel />
            <MapLegend />
            <SelectionPanel />
          </div>
          {SIMULATION_ENABLED && <TimelineController />}
        </div>

        {SIMULATION_ENABLED && (
          <ComparisonPanel
            metrics={metrics}
            scenarioName={scenarioName}
            runId={activeRunId ?? _sharedRunId}
            corridors={corridors}
          />
        )}
      </div>
    </div>
  );
}
