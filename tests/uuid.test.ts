import { describe, expect, test } from "bun:test";
import { isUuidv7, uuidv7 } from "../src/lib/uuid";

describe("uuidv7", () => {
  test("has the v7 shape and variant", () => {
    const id = uuidv7();
    expect(id).toHaveLength(36);
    expect(id[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(id[19]);
    expect(isUuidv7(id)).toBe(true);
  });

  test("sorts by creation millisecond across different milliseconds", () => {
    const earlier = uuidv7(1_700_000_000_000);
    const later = uuidv7(1_700_000_001_000);
    expect(earlier < later).toBe(true);
  });

  test("rejects a v4 id", () => {
    expect(isUuidv7("2f1c8b9e-4a3d-4b2e-8f11-0123456789ab")).toBe(false);
  });

  test("rejects uppercase", () => {
    expect(isUuidv7(uuidv7().toUpperCase())).toBe(false);
  });
});
