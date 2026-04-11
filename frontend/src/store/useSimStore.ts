/**
 * Zustand store for simulation playback state.
 * Reconstructs edge state from diff-encoded frames.
 */

import { create } from "zustand";
import type { EdgeFrame, Frame } from "../api/client";

interface EdgeState {
  [edgeId: number]: EdgeFrame;
}

interface SimStore {
  // Playback
  frames: Frame[];
  currentFrameIndex: number;
  isPlaying: boolean;
  playbackSpeed: number;    // 1x, 2x, 4x

  // Reconstructed edge state at currentFrameIndex
  edgeState: EdgeState;

  // Run metadata
  runId: string | null;
  isBaseline: boolean;

  // Actions
  loadFrames: (frames: Frame[], runId: string, isBaseline: boolean) => void;
  setFrameIndex: (index: number) => void;
  play: () => void;
  pause: () => void;
  setPlaybackSpeed: (speed: number) => void;
  advance: () => void;      // called by playback interval
}

function applyFrame(current: EdgeState, frame: Frame): EdgeState {
  if (frame.full) {
    const next: EdgeState = {};
    for (const e of frame.edges) next[e.id] = e;
    return next;
  }
  const next = { ...current };
  for (const e of frame.edges) next[e.id] = e;
  return next;
}

function buildStateAtIndex(frames: Frame[], targetIndex: number): EdgeState {
  let state: EdgeState = {};
  for (let i = 0; i <= targetIndex; i++) {
    state = applyFrame(state, frames[i]);
  }
  return state;
}

export const useSimStore = create<SimStore>((set, get) => ({
  frames: [],
  currentFrameIndex: 0,
  isPlaying: false,
  playbackSpeed: 1,
  edgeState: {},
  runId: null,
  isBaseline: false,

  loadFrames: (frames, runId, isBaseline) => {
    const edgeState = frames.length > 0 ? buildStateAtIndex(frames, 0) : {};
    set({ frames, runId, isBaseline, currentFrameIndex: 0, edgeState, isPlaying: false });
  },

  setFrameIndex: (index) => {
    const { frames } = get();
    if (index < 0 || index >= frames.length) return;
    const edgeState = buildStateAtIndex(frames, index);
    set({ currentFrameIndex: index, edgeState });
  },

  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),

  advance: () => {
    const { frames, currentFrameIndex } = get();
    const next = currentFrameIndex + 1;
    if (next >= frames.length) {
      set({ isPlaying: false });
      return;
    }
    const edgeState = applyFrame(get().edgeState, frames[next]);
    set({ currentFrameIndex: next, edgeState });
  },
}));
