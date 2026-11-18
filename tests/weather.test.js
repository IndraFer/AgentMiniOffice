import { describe, expect, test } from "bun:test";
import { precipitationPosition, precipitationSample, weatherAt } from "../public/office-weather.js";

const start = Date.UTC(2026, 10, 17);
describe("illustrative office weather", () => {
  test("precipitation surrounds all four sides at depth without entering the dry office column", () => {
    const sides = new Set();
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity,
      maxY = 0;
    for (let index = 0; index < 512; index++) {
      const sample = precipitationSample("/office-a", index);
      expect(sample).toEqual(precipitationSample("/office-a", index));
      sides.add(sample.side);
      for (const time of [0, 0.1, 10, 10000]) {
        for (const wind of [-1, 0, 1]) {
          for (const snow of [false, true]) {
            const p = precipitationPosition(sample, time, wind, snow);
            // The entire rain segment (including its windward tip) must miss the footprint.
            for (const x of [p.x, p.x + wind * 0.2])
              expect(x < 0 || x > 20 || p.z < 0 || p.z > 14).toBe(true);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeLessThan(20);
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minZ = Math.min(minZ, p.z);
            maxZ = Math.max(maxZ, p.z);
            maxY = Math.max(maxY, p.y);
          }
        }
      }
    }
    expect(sides.size).toBe(4);
    expect(minX).toBeLessThan(-10);
    expect(maxX).toBeGreaterThan(30);
    expect(minZ).toBeLessThan(-10);
    expect(maxZ).toBeGreaterThan(24);
    expect(maxY).toBeGreaterThan(18);
  });
  test("is reproducible per office with variable 5–15 minute periods and all conditions", () => {
    const kinds = new Set(),
      durations = new Set(),
      winds = new Set();
    let now = start;
    for (let i = 0; i < 150; i++) {
      const value = weatherAt(now + 10000, "/office-a");
      expect(value).toEqual(weatherAt(now + 10000, "/office-a"));
      const duration = value.until - value.since;
      expect(duration).toBeGreaterThanOrEqual(300000);
      expect(duration).toBeLessThanOrEqual(900000);
      kinds.add(value.kind);
      durations.add(duration);
      winds.add(value.wind > 0.65);
      now = value.until;
    }
    expect(kinds).toEqual(new Set(["clear", "cloudy", "rain", "snow", "thunderstorm"]));
    expect(durations.size).toBeGreaterThan(10);
    expect(winds.size).toBe(2);
    expect(weatherAt(start + 12345, "/office-a")).not.toEqual(
      weatherAt(start + 12345, "/office-b"),
    );
  });
  test("actual time shares, next distinct forecast and wind persist across period boundaries", () => {
    const weights = { clear: 30, cloudy: 25, rain: 20, thunderstorm: 10, snow: 15 };
    const allowed = {
      clear: ["cloudy"],
      cloudy: ["clear", "rain", "snow"],
      rain: ["cloudy", "thunderstorm"],
      thunderstorm: ["rain"],
      snow: ["cloudy"],
    };
    const totals = new Map();
    let t = start,
      duration = 0,
      flips = 0,
      holds = 0;
    for (let i = 0; i < 1200; i++) {
      const w = weatherAt(t + 10000, "/office-a"),
        next = weatherAt(w.until + 10000, "/office-a");
      const span = w.until - w.since;
      totals.set(w.kind, (totals.get(w.kind) ?? 0) + span);
      duration += span;
      expect(allowed[w.kind]).toContain(w.forecast.kind);
      expect(weatherAt(w.forecast.at, "/office-a").kind).toBe(w.forecast.kind);
      if (w.kind === next.kind) {
        holds++;
        expect(w.forecast.at).toBe(next.forecast.at);
      } else expect(w.forecast.at).toBe(w.until);
      if (Math.sign(w.windX) !== Math.sign(next.windX)) flips++;
      t = w.until;
    }
    expect(holds).toBeGreaterThan(200);
    expect(flips / 1200).toBeCloseTo(0.2, 1);
    for (const [k, p] of Object.entries(weights))
      expect(Math.abs((100 * totals.get(k)) / duration - p)).toBeLessThan(2);
  });
  test("storms reuse rain with isolated, reproducible pulses and leave ordinary rain alone", () => {
    let now = start,
      storms = 0;
    for (let i = 0; i < 90; i++) {
      const period = weatherAt(now + 10000, "/office-a");
      if (period.kind === "thunderstorm") {
        storms++;
        expect(period.rain).toBe(1);
        expect(period.snow).toBe(0);
        let count = 0,
          lastStart = -Infinity,
          active = false;
        for (let t = period.since; t < period.until; t += 250) {
          const level = weatherAt(t, "/office-a").lightning;
          expect(level >= 0 && level <= 0.85).toBe(true);
          if (t - period.since < 10000 || period.until - t < 1500) expect(level).toBe(0);
          if (level > 0 && !active) {
            expect(t - lastStart).toBeGreaterThan(30000);
            expect(weatherAt(t, "/office-a").lightning).toBe(level);
            lastStart = t;
            count++;
          }
          if (level > 0) expect(t - lastStart).toBeLessThan(1500);
          active = level > 0;
        }
        expect(count).toBeGreaterThan(2);
      } else expect(period.lightning).toBe(0);
      now = period.until;
    }
    expect(storms).toBeGreaterThan(0);
  });
  test("blends across changes and block boundaries without abrupt lighting or precipitation", () => {
    let now = start;
    for (let i = 0; i < 150; i++) {
      const before = weatherAt(now - 1, "/office-a"),
        after = weatherAt(now + 1, "/office-a");
      for (const key of ["cloud", "rain", "snow", "wind"]) {
        expect(Math.abs(before[key] - after[key])).toBeLessThan(0.00001);
        expect(after[key]).toBeGreaterThanOrEqual(0);
        expect(after[key]).toBeLessThanOrEqual(1);
      }
      now = after.until;
    }
  });
});
