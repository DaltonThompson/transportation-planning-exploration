/**
 * Play/pause/scrub timeline and playback speed control.
 */

import { useEffect, useRef } from "react";
import { useSimStore } from "../store/useSimStore";

export function TimelineController() {
  const {
    frames,
    currentFrameIndex,
    isPlaying,
    playbackSpeed,
    play,
    pause,
    setFrameIndex,
    setPlaybackSpeed,
    advance,
  } = useSimStore();

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (isPlaying) {
      const ms = 500 / playbackSpeed;
      intervalRef.current = setInterval(advance, ms);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying, playbackSpeed, advance]);

  const currentTimestamp = frames[currentFrameIndex]?.t ?? 0;
  const totalTimestamp = frames[frames.length - 1]?.t ?? 0;
  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  if (frames.length === 0) return null;

  return (
    <div style={{ padding: "8px 16px", background: "#1a1a2e", color: "#eee", display: "flex", alignItems: "center", gap: 12 }}>
      <button onClick={isPlaying ? pause : play} style={{ minWidth: 60 }}>
        {isPlaying ? "⏸ Pause" : "▶ Play"}
      </button>

      <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 100 }}>
        {formatTime(currentTimestamp)} / {formatTime(totalTimestamp)}
      </span>

      <input
        type="range"
        min={0}
        max={frames.length - 1}
        value={currentFrameIndex}
        onChange={(e) => setFrameIndex(Number(e.target.value))}
        style={{ flex: 1 }}
      />

      <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
        Speed:
        <select
          value={playbackSpeed}
          onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
        >
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
          <option value={4}>4×</option>
        </select>
      </label>
    </div>
  );
}
