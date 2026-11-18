// A seeded, shuffled circuit through the transition counts. Each circuit starts and ends
// at Cloudy: block boundaries need no reset, invented transition or historical replay.
const kinds = ["clear", "cloudy", "rain", "thunderstorm", "snow"];
// 200 outgoing transitions. Row totals = 30%, 25%, 20%, 10%, 15% of all periods.
const edges = [
  [42, 18, 0, 0, 0],
  [18, 7, 10, 0, 15],
  [0, 10, 16, 14, 0],
  [0, 0, 14, 6, 0],
  [0, 15, 0, 0, 15],
];
const PERIOD = 600000,
  COUNT = 200,
  BLOCK = COUNT * PERIOD;
export function hash(text) {
  let n = 2166136261;
  for (const c of text) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  return n >>> 0;
}
function generator(seed) {
  let n = hash(seed);
  return () => {
    n = (n + 0x6d2b79f5) >>> 0;
    let t = Math.imul(n ^ (n >>> 15), n | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(a, rand) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const blocks = new Map();
function periods(block, seed) {
  const key = `${block}:${seed}`;
  if (blocks.has(key)) return blocks.get(key);
  const rand = generator(key);
  const outgoing = edges.map((row) =>
    shuffle(
      row.flatMap((count, id) => Array(count).fill(id)),
      rand,
    ),
  );
  const stack = [1],
    chain = [];
  while (stack.length) {
    const dest = outgoing[stack.at(-1)].pop();
    if (dest === undefined) chain.push(stack.pop());
    else stack.push(dest);
  }
  chain.reverse();
  // An even count of flips connects the last period to the next block's starting direction.
  const flips = shuffle(
    Array.from({ length: COUNT }, (_, i) => i < 40),
    rand,
  );
  let direction = hash(seed) & 1 ? 1 : -1;
  let since = block * BLOCK;
  const rows = [];
  for (let i = 0; i < COUNT; i++) {
    const until =
      (block * COUNT + i + 1) * PERIOD +
      (i === COUNT - 1 ? 0 : Math.floor(rand() * 300001) - 150000);
    const kind = kinds[chain[i]],
      windX = direction * (0.18 + rand() * 0.82);
    rows.push({ kind, windX, since, until });
    since = until;
    if (flips[i]) direction = -direction;
  }
  if (blocks.size >= 6) blocks.delete(blocks.keys().next().value);
  blocks.set(key, rows);
  return rows;
}
export function segmentAt(now, seed) {
  const rows = periods(Math.floor(now / BLOCK), seed);
  let lo = 0,
    hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (now < rows[mid].until) hi = mid;
    else lo = mid + 1;
  }
  return rows[lo];
}
export function nextChange(current, seed) {
  let next = segmentAt(current.until, seed);
  while (next.kind === current.kind) next = segmentAt(next.until, seed);
  return { kind: next.kind, at: next.since, direction: Math.sign(next.windX) };
}
