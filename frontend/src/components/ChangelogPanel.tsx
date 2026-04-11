/**
 * Collapsible changelog drawer showing recent simulation runs.
 * Fetches GET /api/changelog and refreshes every 30s.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ChangelogEntry } from "../api/client";

function formatTs(iso: string): string {
  const d = new Date(iso);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${months[d.getMonth()]} ${d.getDate()}, ${hh}:${mm}`;
}

function TriggerBadge({ trigger }: { trigger: string }) {
  const isGtfs = trigger === "gtfs_sync";
  return (
    <span style={{
      fontSize: 9,
      padding: "1px 5px",
      borderRadius: 10,
      background: isGtfs ? "var(--bg-surface)" : "#2a2a4a",
      color: isGtfs ? "var(--purple)" : "var(--text-muted)",
      fontWeight: 600,
      letterSpacing: 0.5,
      textTransform: "uppercase",
      flexShrink: 0,
    }}>
      {isGtfs ? "gtfs" : "manual"}
    </span>
  );
}

export function ChangelogPanel() {
  const [open, setOpen] = useState(false);

  const { data: entries } = useQuery<ChangelogEntry[]>({
    queryKey: ["changelog"],
    queryFn: () => api.getChangelog(),
    refetchInterval: 30_000,
  });

  const recent = (entries ?? []).slice(0, 10);

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "none",
          border: "none",
          color: "var(--purple)",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 1,
          cursor: "pointer",
          padding: 0,
          width: "100%",
          textAlign: "left",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontFamily: "var(--font-sans)",
        }}
      >
        <span>RUN HISTORY</span>
        <span style={{ color: "var(--text-muted)", fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {recent.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>No runs yet.</div>
          ) : (
            recent.map((entry: ChangelogEntry) => (
              <div key={entry.run_id} style={{
                background: "var(--bg-secondary)",
                borderRadius: "var(--radius)",
                padding: "6px 8px",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4, marginBottom: 2 }}>
                  <span style={{ fontSize: 11, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {entry.scenario_name}
                  </span>
                  <TriggerBadge trigger={entry.trigger} />
                </div>
                <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{formatTs(entry.timestamp)}</div>
                {entry.attribution_tags && entry.attribution_tags.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 3 }}>
                    {entry.attribution_tags.map((tag) => (
                      <span key={tag} style={{
                        fontSize: 9,
                        padding: "1px 5px",
                        borderRadius: 10,
                        background: "var(--bg-primary)",
                        color: "var(--text-muted)",
                        border: "1px solid var(--border)",
                        letterSpacing: 0.3,
                      }}>
                        {tag.replace(/_/g, " ")}
                      </span>
                    ))}
                  </div>
                )}
                {entry.summary && (
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.4 }}>{entry.summary}</div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
