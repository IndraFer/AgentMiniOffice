// Cosmetic accents for prolonged, stationary actions. No simulation, clock or network side effects.
const standingAttention = ["hop", "tilt", "stamp"];
const attention = ["tilt", "nod"];
const focused = ["lean", "nod"];
const scanning = ["glance", "lean"];
const listening = ["nod", "tilt"];
const work = new Map([
  ['station-wait', ['glance','tilt']],
  ['error-rest', ['tilt', 'glance']],
  ["typing", focused],
  ["keyboard-active", ["mouse", "scan"]],
  ["bench-active", ["reach", "adjust"]],
  ["reading", scanning],
  ["output", scanning],
  ["tools", focused],
  ["planning", scanning],
  ["communication", listening],
  ["meeting", listening],
]);

// Each mesh owns one sampler and one reusable result. Time is visible scene time, not heartbeat age.
export function createPoseAccent(seed) {
  const result = { kind: null, amount: 0 };
  const delay = 10 + (seed % 7);
  const interval = 9 + ((seed >>> 3) % 7);
  let since = 0,
    lastAction,
    lastMode,
    lastRun,
    lastTask, lastOptions;
  return (time, action, mode, run, task, stationOptions) => {
    if (action !== lastAction || mode !== lastMode || run !== lastRun || task !== lastTask || stationOptions !== lastOptions) {
      lastOptions = stationOptions;
      since = time;
      lastAction = action;
      lastMode = mode;
      lastRun = run;
      lastTask = task;
    }
    result.kind = null;
    result.amount = 0;
    const elapsed = time - since - delay;
    if (elapsed < 0 || (mode !== "standing" && mode !== "seated")) return result;
    let options = stationOptions ?? work.get(action);
    if (action === "human-waiting") options = mode === "standing" ? standingAttention : attention;
    if (!options?.length) return result;
    const cycle = Math.floor(elapsed / interval);
    const kind = options[((seed >>> 12) + cycle) % options.length];
    const duration = kind === "hop" ? 0.65 : action.endsWith('-active') ? 2.6 : 1.4;
    const progress = (elapsed % interval) / duration;
    if (progress >= 1) return result;
    result.kind = kind;
    // A single springy hop, a double heel beat, or one slow look/nod. Start and end at rest.
    const pulse = Math.sin(Math.PI * progress);
    result.amount =
      kind === "stamp" ? pulse * Math.abs(Math.sin(2 * Math.PI * progress)) : pulse * pulse;
    return result;
  };
}
