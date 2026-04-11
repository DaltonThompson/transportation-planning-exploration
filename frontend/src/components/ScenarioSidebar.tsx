/**
 * Left sidebar: scenario list, patch editor, corridor management, and run trigger.
 *
 * Supported patch types:
 *   route_headway  — change headway for all stops matching a route prefix (minutes)
 *   edge_capacity  — multiply a road segment's capacity by a factor
 *   edge_speed     — set a road segment's speed limit (mph → converted to km/h for API)
 *
 * Corridor patches expand to individual edge patches before sending to the API.
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ScenarioSummary, PatchIn } from "../api/client";
import { useLayerStore } from "../store/useLayerStore";
import { mphToKph } from "../utils/units";

interface Props {
  selectedScenarioId: string | null;
  onSelect: (id: string) => void;
  onRunStarted: (runId: string) => void;
}

type PatchType = "route_headway" | "edge_capacity" | "edge_speed";

const PATCH_LABELS: Record<PatchType, string> = {
  route_headway: "Route headway",
  edge_capacity: "Road segment capacity ×",
  edge_speed:    "Road segment speed (mph)",
};

// ─── Shared styles ────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  background: "var(--bg-primary)",
  border: "1px solid var(--border)",
  color: "var(--text-primary)",
  padding: "4px 8px",
  borderRadius: "var(--radius)",
  width: "100%",
  fontSize: 12,
  fontFamily: "var(--font-sans)",
};

const inputErrorStyle: React.CSSProperties = {
  ...inputStyle,
  border: "1px solid var(--red)",
};

const btnStyle = (active = true): React.CSSProperties => ({
  background: active ? "var(--purple-dark)" : "#2a2a4a",
  color: active ? "var(--text-primary)" : "var(--text-muted)",
  border: "none",
  padding: "6px 0",
  borderRadius: "var(--radius)",
  cursor: active ? "pointer" : "not-allowed",
  fontWeight: 600,
  fontSize: 12,
  width: "100%",
  fontFamily: "var(--font-sans)",
});

const smallBtnStyle = (variant: "default" | "danger" | "ghost" = "default"): React.CSSProperties => ({
  background: variant === "danger" ? "#7f1d1d" : variant === "ghost" ? "transparent" : "var(--bg-surface)",
  color: variant === "danger" ? "#fca5a5" : variant === "ghost" ? "var(--text-muted)" : "var(--text-primary)",
  border: variant === "ghost" ? "none" : "1px solid var(--border)",
  padding: "3px 7px",
  borderRadius: "var(--radius)",
  cursor: "pointer",
  fontSize: 11,
  fontFamily: "var(--font-sans)",
});

function ErrorMsg({ msg }: { msg: string }) {
  if (!msg) return null;
  return <div style={{ color: "var(--red)", fontSize: 10, marginTop: 2 }}>{msg}</div>;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validatePatch(type: PatchType, target: string, value: string) {
  const errors: { target?: string; value?: string } = {};
  const numVal = parseFloat(value);

  if (type === "route_headway") {
    if (!target.trim()) errors.target = "Route prefix is required.";
    if (!value.trim() || isNaN(numVal) || numVal <= 0)
      errors.value = "Headway must be > 0 minutes.";
  } else if (type === "edge_capacity") {
    if (!target.trim() || isNaN(parseInt(target, 10)) || parseInt(target, 10) < 0)
      errors.target = "Must be a non-negative road segment ID.";
    if (!value.trim() || isNaN(numVal) || numVal <= 0)
      errors.value = "Capacity multiplier must be > 0.";
  } else if (type === "edge_speed") {
    if (!target.trim() || isNaN(parseInt(target, 10)) || parseInt(target, 10) < 0)
      errors.target = "Must be a non-negative road segment ID.";
    if (!value.trim() || isNaN(numVal) || numVal <= 0 || numVal > 100)
      errors.value = "Speed must be 1–100 mph.";
  }

  return errors;
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function Tooltip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <span
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        style={{ color: "var(--text-muted)", cursor: "help", marginLeft: 4, fontSize: 11 }}
      >?</span>
      {show && (
        <div style={{
          position: "absolute",
          bottom: "120%",
          left: "50%",
          transform: "translateX(-50%)",
          background: "#222",
          color: "var(--text-primary)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "6px 10px",
          fontSize: 11,
          lineHeight: 1.5,
          width: 220,
          boxShadow: "var(--shadow)",
          zIndex: 9999,
          pointerEvents: "none",
        }}>
          {text}
        </div>
      )}
    </span>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ScenarioSidebar({ selectedScenarioId, onSelect, onRunStarted }: Props) {
  const qc = useQueryClient();

  // Scenario CRUD state
  const [newName, setNewName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Run state
  const [durationMin, setDurationMin] = useState(60);

  // Patch form state
  const [patchType, setPatchType] = useState<PatchType>("route_headway");
  const [patchTarget, setPatchTarget] = useState("");
  const [patchValue, setPatchValue] = useState("");
  const [targetMode, setTargetMode] = useState<"single" | "corridor">("single");
  const [selectedCorridorId, setSelectedCorridorId] = useState<string | null>(null);
  const [corridorName, setCorridorName] = useState("");
  const [showCorridorNameInput, setShowCorridorNameInput] = useState(false);
  const [showValidationErrors, setShowValidationErrors] = useState(false);

  // Layer store for edge selection + corridors
  const {
    selectingEdge, selectedEdgeId, setSelectingEdge,
    selectingCorridorEdges, corridorEdgeSelection,
    corridors, startCorridorSelection, toggleCorridorEdge,
    confirmCorridor, cancelCorridorSelection, deleteCorridor,
  } = useLayerStore();

  // When a map edge is selected, populate the target field
  useEffect(() => {
    if (selectedEdgeId !== null && !selectingEdge) {
      setPatchTarget(String(selectedEdgeId));
    }
  }, [selectedEdgeId, selectingEdge]);

  const { data: scenarios = [], isLoading } = useQuery({
    queryKey: ["scenarios"],
    queryFn: api.listScenarios,
    refetchInterval: 10_000,
  });

  const { data: selectedScenario } = useQuery({
    queryKey: ["scenario", selectedScenarioId],
    queryFn: () => api.getScenario(selectedScenarioId!),
    enabled: !!selectedScenarioId,
  });

  const createMutation = useMutation({
    mutationFn: () => api.createScenario({ name: newName.trim(), patches: [] }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["scenarios"] });
      setNewName("");
      setShowCreate(false);
      onSelect(data.id);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ name, patches }: { name: string; patches: PatchIn[] }) =>
      api.updateScenario(selectedScenarioId!, { name, patches }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scenario", selectedScenarioId] });
      qc.invalidateQueries({ queryKey: ["scenarios"] });
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.updateScenario(id, {
        name,
        patches: scenarios.find((s) => s.id === id) ? (selectedScenario?.patches ?? []) : [],
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scenarios"] });
      qc.invalidateQueries({ queryKey: ["scenario", selectedScenarioId] });
      setRenamingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/scenarios/${id}`, { method: "DELETE" }).then((r) => {
        if (!r.ok && r.status !== 204) throw new Error(`Delete failed: ${r.status}`);
      }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["scenarios"] });
      if (selectedScenarioId === id) onSelect("");
      setConfirmDeleteId(null);
    },
  });

  const runMutation = useMutation({
    mutationFn: () =>
      api.createRun({ scenario_id: selectedScenarioId!, duration_minutes: durationMin }),
    onSuccess: (data) => onRunStarted(data.run_id),
  });

  // Sync state
  const [forceSync, setForceSync] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const syncMutation = useMutation({
    mutationFn: ({ slug, force }: { slug: string; force: boolean }) => api.syncFeed(slug, force),
    onSuccess: () => {
      setSyncStatus("Feed syncing in background.");
      setTimeout(() => setSyncStatus(null), 5000);
    },
    onError: (err) => {
      setSyncStatus(`Error: ${String(err)}`);
      setTimeout(() => setSyncStatus(null), 8000);
    },
  });

  function addPatch() {
    if (!selectedScenario) return;
    setShowValidationErrors(true);

    const isEdgePatch = patchType === "edge_capacity" || patchType === "edge_speed";

    if (targetMode === "corridor" && isEdgePatch) {
      // Expand corridor to individual edge patches
      const corridor = corridors.find((c) => c.id === selectedCorridorId);
      if (!corridor || !patchValue.trim()) return;
      const numVal = parseFloat(patchValue);
      if (isNaN(numVal)) return;
      const newPatches: PatchIn[] = corridor.edge_ids.map((idx) => ({
        type: patchType,
        edge_key: [idx],
        value: patchType === "edge_speed" ? mphToKph(numVal) : numVal,
      }));
      updateMutation.mutate({
        name: selectedScenario.name,
        patches: [...(selectedScenario.patches ?? []), ...newPatches],
      });
      setPatchValue("");
      setShowValidationErrors(false);
      return;
    }

    const errors = validatePatch(patchType, patchTarget, patchValue);
    if (errors.target || errors.value) return;

    const numVal = parseFloat(patchValue);
    let patch: PatchIn;

    if (patchType === "route_headway") {
      patch = { type: "route_headway", route_prefix: patchTarget.trim(), value: numVal * 60 };
    } else if (patchType === "edge_capacity") {
      patch = { type: "edge_capacity", edge_key: [parseInt(patchTarget, 10)], value: numVal };
    } else {
      // edge_speed: user enters mph, API expects km/h
      patch = { type: "edge_speed", edge_key: [parseInt(patchTarget, 10)], value: mphToKph(numVal) };
    }

    updateMutation.mutate({
      name: selectedScenario.name,
      patches: [...(selectedScenario.patches ?? []), patch],
    });
    setPatchTarget("");
    setPatchValue("");
    setShowValidationErrors(false);
  }

  function removePatch(index: number) {
    if (!selectedScenario) return;
    updateMutation.mutate({
      name: selectedScenario.name,
      patches: selectedScenario.patches.filter((_, i) => i !== index),
    });
  }

  function forkScenario(s: ScenarioSummary) {
    api.forkScenario(s.id).then((created) => {
      qc.invalidateQueries({ queryKey: ["scenarios"] });
      onSelect(created.id);
    });
  }

  function handleConfirmCorridor() {
    if (!corridorName.trim() || corridorEdgeSelection.size === 0) return;
    confirmCorridor(corridorName.trim());
    setCorridorName("");
    setShowCorridorNameInput(false);
  }

  const patches = selectedScenario?.patches ?? [];
  const isEdgePatchType = patchType === "edge_capacity" || patchType === "edge_speed";
  const validationErrors = showValidationErrors ? validatePatch(patchType, patchTarget, patchValue) : {};
  const patchIsValid = Object.keys(validatePatch(patchType, patchTarget, patchValue)).length === 0;

  return (
    <div style={{
      width: 252,
      background: "var(--bg-primary)",
      color: "var(--text-primary)",
      display: "flex",
      flexDirection: "column",
      padding: 12,
      gap: 8,
      borderRight: "1px solid var(--border)",
      fontFamily: "var(--font-sans)",
      fontSize: 12,
      overflowY: "auto",
    }}>
      {/* ── Scenarios ── */}
      <div style={{ color: "var(--purple)", fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>SCENARIOS</div>

      {isLoading ? (
        <div style={{ color: "var(--text-muted)" }}>Loading…</div>
      ) : scenarios.length === 0 ? (
        <div style={{ color: "var(--text-muted)" }}>No scenarios yet.</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {scenarios.map((s: ScenarioSummary) => (
            <li key={s.id} style={{
              padding: "5px 8px",
              borderRadius: "var(--radius)",
              background: s.id === selectedScenarioId ? "var(--surface-hover)" : "transparent",
              marginBottom: 2,
            }}>
              {renamingId === s.id ? (
                <div style={{ display: "flex", gap: 4 }}>
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") renameMutation.mutate({ id: s.id, name: renameValue });
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    autoFocus
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button onClick={() => renameMutation.mutate({ id: s.id, name: renameValue })} style={smallBtnStyle()}>✓</button>
                  <button onClick={() => setRenamingId(null)} style={smallBtnStyle("ghost")}>✕</button>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
                  <div onClick={() => onSelect(s.id)} style={{ cursor: "pointer", flex: 1, minWidth: 0 }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
                    <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                      {s.patch_count} patch{s.patch_count !== 1 ? "es" : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                    <button
                      onClick={() => { setRenamingId(s.id); setRenameValue(s.name); }}
                      title="Rename"
                      style={smallBtnStyle("ghost")}
                    >✎</button>
                    <button
                      onClick={() => forkScenario(s)}
                      title="Fork (copy with parent link)"
                      style={smallBtnStyle("ghost")}
                    >⧉</button>
                    {confirmDeleteId === s.id ? (
                      <>
                        <button onClick={() => deleteMutation.mutate(s.id)} style={smallBtnStyle("danger")}>Del?</button>
                        <button onClick={() => setConfirmDeleteId(null)} style={smallBtnStyle("ghost")}>✕</button>
                      </>
                    ) : (
                      <button onClick={() => setConfirmDeleteId(s.id)} title="Delete" style={smallBtnStyle("ghost")}>🗑</button>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {showCreate ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Scenario name"
            style={inputStyle}
            onKeyDown={(e) => e.key === "Enter" && newName.trim() && createMutation.mutate()}
          />
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={() => createMutation.mutate()} disabled={!newName.trim()} style={btnStyle(!!newName.trim())}>
              Create
            </button>
            <button onClick={() => { setShowCreate(false); setNewName(""); }} style={{ ...smallBtnStyle(), padding: "6px 10px" }}>✕</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowCreate(true)} style={btnStyle()}>+ New scenario</button>
      )}

      {/* ── Patches ── */}
      {selectedScenarioId && (
        <>
          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "2px 0" }} />
          <div style={{ color: "var(--purple)", fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>
            PATCHES — <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>{selectedScenario?.name ?? "…"}</span>
          </div>

          {patches.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>No patches. Add one below.</div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 3 }}>
              {patches.map((p, i) => (
                <li key={i} style={{
                  background: "var(--bg-secondary)",
                  borderRadius: "var(--radius)",
                  padding: "4px 8px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: 4,
                }}>
                  <div>
                    <div style={{ color: "var(--purple)", fontSize: 11 }}>{p.type}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
                      {p.route_prefix && `route: ${p.route_prefix}`}
                      {p.stop_id && `stop: ${p.stop_id}`}
                      {p.edge_key && `segment: ${p.edge_key[0]}`}
                      {" → "}
                      {p.type === "route_headway" || p.type === "stop_headway"
                        ? `${((Number(p.value)) / 60).toFixed(1)} min`
                        : p.type === "edge_speed"
                          ? `${Math.round(Number(p.value) * 0.621371)} mph`
                          : `${p.value}×`}
                    </div>
                  </div>
                  <button
                    onClick={() => removePatch(i)}
                    style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: 0, flexShrink: 0 }}
                  >✕</button>
                </li>
              ))}
            </ul>
          )}

          {/* Add patch form */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <select
              value={patchType}
              onChange={(e) => { setPatchType(e.target.value as PatchType); setPatchTarget(""); setTargetMode("single"); setShowValidationErrors(false); }}
              style={inputStyle}
            >
              {(Object.keys(PATCH_LABELS) as PatchType[]).map((t) => (
                <option key={t} value={t}>{PATCH_LABELS[t]}</option>
              ))}
            </select>

            {/* Target — single or corridor */}
            {isEdgePatchType && (
              <div style={{ display: "flex", gap: 4, marginBottom: 2 }}>
                <button
                  onClick={() => setTargetMode("single")}
                  style={{ ...smallBtnStyle(targetMode === "single" ? "default" : "ghost"), flex: 1 }}
                >Single</button>
                <button
                  onClick={() => setTargetMode("corridor")}
                  style={{ ...smallBtnStyle(targetMode === "corridor" ? "default" : "ghost"), flex: 1 }}
                >Corridor</button>
              </div>
            )}

            {(!isEdgePatchType || targetMode === "single") && (
              <div>
                <div style={{ display: "flex", gap: 4 }}>
                  <input
                    value={patchTarget}
                    onChange={(e) => setPatchTarget(e.target.value)}
                    placeholder={
                      patchType === "route_headway" ? "Route prefix (e.g. CDTA_)" : "Road segment ID"
                    }
                    style={validationErrors.target ? inputErrorStyle : inputStyle}
                  />
                  {isEdgePatchType && (
                    <button
                      onClick={() => setSelectingEdge(!selectingEdge)}
                      title="Click a road segment on the map"
                      style={{
                        ...smallBtnStyle(selectingEdge ? "default" : "ghost"),
                        flexShrink: 0,
                        padding: "3px 8px",
                        background: selectingEdge ? "var(--accent)" : undefined,
                      }}
                    >
                      {selectingEdge ? "…" : "📍"}
                    </button>
                  )}
                </div>
                <ErrorMsg msg={validationErrors.target ?? ""} />
              </div>
            )}

            {isEdgePatchType && targetMode === "corridor" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {corridors.length > 0 ? (
                  <select
                    value={selectedCorridorId ?? ""}
                    onChange={(e) => setSelectedCorridorId(e.target.value || null)}
                    style={inputStyle}
                  >
                    <option value="">Select corridor…</option>
                    {corridors.map((c) => (
                      <option key={c.id} value={c.id}>{c.name} ({c.edge_ids.length} segments)</option>
                    ))}
                  </select>
                ) : (
                  <div style={{ color: "var(--text-muted)", fontSize: 11 }}>No corridors yet.</div>
                )}

                {selectingCorridorEdges ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ color: "var(--text-primary)", fontSize: 11 }}>
                      Click segments on the map ({corridorEdgeSelection.size} selected). Hold Shift to add; drag to rubber-band select.
                    </div>
                    {showCorridorNameInput ? (
                      <>
                        <input
                          value={corridorName}
                          onChange={(e) => setCorridorName(e.target.value)}
                          placeholder="Corridor name"
                          style={inputStyle}
                          autoFocus
                        />
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            onClick={handleConfirmCorridor}
                            disabled={!corridorName.trim() || corridorEdgeSelection.size === 0}
                            style={btnStyle(!!corridorName.trim() && corridorEdgeSelection.size > 0)}
                          >Save corridor</button>
                          <button onClick={() => setShowCorridorNameInput(false)} style={{ ...smallBtnStyle("ghost"), width: "auto" }}>Back</button>
                        </div>
                      </>
                    ) : (
                      <div style={{ display: "flex", gap: 4 }}>
                        <button
                          onClick={() => setShowCorridorNameInput(true)}
                          disabled={corridorEdgeSelection.size === 0}
                          style={btnStyle(corridorEdgeSelection.size > 0)}
                        >Name & save</button>
                        <button onClick={cancelCorridorSelection} style={{ ...smallBtnStyle("ghost"), width: "auto" }}>Cancel</button>
                      </div>
                    )}
                  </div>
                ) : (
                  <button onClick={startCorridorSelection} style={btnStyle()}>+ New corridor</button>
                )}
              </div>
            )}

            <div>
              <input
                value={patchValue}
                onChange={(e) => setPatchValue(e.target.value)}
                placeholder={
                  patchType === "route_headway" ? "Headway (minutes)" :
                  patchType === "edge_capacity" ? "Capacity multiplier" : "Speed (mph)"
                }
                type="number"
                min={0}
                style={validationErrors.value ? inputErrorStyle : inputStyle}
              />
              <ErrorMsg msg={validationErrors.value ?? ""} />
            </div>

            <button
              onClick={addPatch}
              disabled={
                updateMutation.isPending ||
                (targetMode === "corridor" && !selectedCorridorId) ||
                (targetMode === "single" && !patchIsValid)
              }
              style={btnStyle(
                !updateMutation.isPending &&
                !(targetMode === "corridor" && !selectedCorridorId) &&
                !(targetMode === "single" && showValidationErrors && !patchIsValid)
              )}
            >
              + Add patch
            </button>
          </div>

          {/* ── Corridors ── */}
          {corridors.length > 0 && (
            <>
              <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "2px 0" }} />
              <div style={{ color: "var(--purple)", fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>CORRIDORS</div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                {corridors.map((c) => (
                  <li key={c.id} style={{
                    background: "var(--bg-secondary)",
                    borderRadius: "var(--radius)",
                    padding: "4px 8px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 4,
                  }}>
                    <div>
                      <div style={{ color: "var(--text-primary)", fontSize: 11 }}>{c.name}</div>
                      <div style={{ color: "var(--text-muted)", fontSize: 10 }}>{c.edge_ids.length} segment{c.edge_ids.length !== 1 ? "s" : ""}</div>
                    </div>
                    <button
                      onClick={() => deleteCorridor(c.id)}
                      title="Delete corridor"
                      style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: 0 }}
                    >✕</button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "2px 0" }} />

      {/* Duration + run */}
      <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ color: "var(--text-muted)", fontSize: 11, display: "flex", alignItems: "center" }}>
          Duration (minutes)
          <Tooltip text="Simulation runs for this many minutes of simulated time. The right duration depends on your network size and the type of intervention: longer runs reveal whether congestion compounds or stabilizes. Experiment with different durations and check whether your metrics have levelled off by the end of the run." />
        </span>
        <input
          type="number"
          min={5}
          max={120}
          value={durationMin}
          onChange={(e) => setDurationMin(Number(e.target.value))}
          style={inputStyle}
        />
      </label>

      <button
        onClick={() => runMutation.mutate()}
        disabled={!selectedScenarioId || runMutation.isPending}
        style={btnStyle(!!selectedScenarioId && !runMutation.isPending)}
      >
        {runMutation.isPending ? "Starting…" : "▶ Run simulation"}
      </button>

      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "2px 0" }} />

      {/* ── GTFS Sync ── */}
      <div style={{ color: "var(--purple)", fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>GTFS FEED</div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)", cursor: "pointer", userSelect: "none" }}>
        <input
          type="checkbox"
          checked={forceSync}
          onChange={(e) => setForceSync(e.target.checked)}
          style={{ accentColor: "var(--purple)", margin: 0 }}
        />
        Force re-download
      </label>
      <button
        onClick={() => syncMutation.mutate({ slug: "cdta", force: forceSync })}
        disabled={syncMutation.isPending}
        style={btnStyle(!syncMutation.isPending)}
      >
        {syncMutation.isPending ? "Syncing…" : "↺ Sync CDTA feed"}
      </button>
      {syncStatus && (
        <div style={{ fontSize: 11, color: syncStatus.startsWith("Error") ? "var(--red)" : "var(--green)" }}>
          {syncStatus}
        </div>
      )}
    </div>
  );
}
