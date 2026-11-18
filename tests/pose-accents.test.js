import { expect, test } from "bun:test";
import { createPoseAccent } from "../public/office-poses.js";

function sample(seed, action, mode) {
  const pose = createPoseAccent(seed);
  const names = new Set();
  const starts = [];
  let previous = null;
  for (let frame = 0; frame < 1200; frame++) {
    const time = frame / 10;
    const { kind, amount } = pose(time, action, mode, "run-a", "Draft");
    if (kind) {
      expect(amount >= 0 && amount <= 1).toBe(true);
      names.add(kind);
      if (!previous) starts.push(time);
    }
    previous = kind;
  }
  return { names: [...names].sort(), starts };
}

test("long standing attention alternates brief in-place accents with quiet intervals", () => {
  const timeline = sample(82, "human-waiting", "standing");
  expect(timeline.names).toEqual(["hop", "stamp", "tilt"]);
  expect(timeline.starts[0]).toBeGreaterThanOrEqual(10);
  expect(timeline.starts.every((t, i, all) => i === 0 || t - all[i - 1] >= 8)).toBe(true);
  expect(sample(82, "human-waiting", "standing")).toEqual(timeline);
  expect(sample(83, "human-waiting", "standing").starts).not.toEqual(timeline.starts);
});

test("chairs and ongoing work use restrained, prop-compatible accents only", () => {
  for (const action of [
    "human-waiting",
    "typing",
    "reading",
    "output",
    "tools",
    "planning",
    "communication",
    "meeting",
  ]) {
    const { names } = sample(29, action, action === "tools" ? "standing" : "seated");
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(names).not.toContain("hop");
    expect(names).not.toContain("stamp");
  }
});

test('sustained tool and keyboard poses vary their hands without a room change', () => {
  expect(sample(35, 'bench-active', 'standing').names).toEqual(['adjust', 'reach']);
  expect(sample(35, 'keyboard-active', 'seated').names).toEqual(['mouse', 'scan']);
  const pose = createPoseAccent(35);
  pose(0, 'bench-active','standing','call-1');
  expect(pose(10.8,'bench-active','standing','call-1').amount).toBeGreaterThan(0);
  expect(pose(10.9,'bench-active','standing','call-2').amount).toBe(0);
});

test('station-specific accent choices stay stable across frames and reset on a station change',()=>{
  const pose=createPoseAccent(35), allowed=['scan','lean'], other=['glance'];
  const seen=new Set();for(let n=0;n<600;n++) {const r=pose(n/10,'reading','standing','run','task',allowed);if(r.kind)seen.add(r.kind);}
  expect([...seen].sort()).toEqual(['lean','scan']);
  expect(pose(60,'reading','standing','run','task',other).kind).toBeNull();
  expect(pose(71,'reading','standing','run','task',other).kind).toBe('glance');
});

test("changing pose, run, task or eligibility immediately cancels an active accent", () => {
  const changes = [
    ["human-waiting", "walking", "r", "A"],
    ["error", "standing", "r", "A"],
    ["none", "standing", "r", "A"],
    ["human-waiting", "offline", "r", "A"],
    ["human-waiting", "stale", "r", "A"],
    ["human-waiting", "seated", "r", "A"],
    ["typing", "standing", "r", "A"],
    ["human-waiting", "standing", "s", "A"],
    ["human-waiting", "standing", "r", "B"],
  ];
  for (const args of changes) {
    const pose = createPoseAccent(17);
    const original = ["human-waiting", "standing", "r", "A"];
    let t = 0;
    while (!pose(t, ...original).kind && t < 25) t += 0.1;
    expect(t).toBeLessThan(25);
    expect(pose(t, ...args)).toMatchObject({ kind: null, amount: 0 });
    expect(pose(t + 0.1, ...original).kind).toBeNull();
  }
});
