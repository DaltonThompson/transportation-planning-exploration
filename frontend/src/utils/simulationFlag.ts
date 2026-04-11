// Simulation UI gate: exposed only when `?dev=true` query param is present
// or `VITE_SHOW_SIMULATION=true` env flag is set at build time.
//
// Why: the simulation model's outputs don't meet the analytical bar implied
// by the UI, so the simulation controls are hidden from default operation.

const _params = new URLSearchParams(window.location.search);

export const SIMULATION_ENABLED: boolean =
  _params.get("dev") === "true" ||
  import.meta.env.VITE_SHOW_SIMULATION === "true";
