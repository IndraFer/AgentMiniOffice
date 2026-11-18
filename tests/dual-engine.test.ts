import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/**
 * Dual runtime support is a property, not a claim. The moment a runtime specific API leaks
 * into a random module, the project runs on one runtime only and nobody notices for weeks.
 * This test is the guard.
 */

const BUN_ALLOWED = new Set(["src/index.ts", "src/lib/runtime.ts", "src/lib/db.ts"]);
const NODE_SQLITE_ALLOWED = new Set(["src/lib/db.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function relative(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

describe("dual runtime discipline", () => {
  const files = walk(path.resolve("src")).map(relative);

  test("there are source files to scan", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  test("runtime specific APIs stay in the adapter files", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");

      const usesBun =
        /\bBun\./.test(source) ||
        /from\s+['"]bun:/.test(source) ||
        /import\(\s*['"]bun:/.test(source);

      if (usesBun && !BUN_ALLOWED.has(file)) {
        offenders.push(`${file} uses a Bun specific API`);
      }

      if (/['"]node:sqlite['"]/.test(source) && !NODE_SQLITE_ALLOWED.has(file)) {
        offenders.push(`${file} imports node:sqlite`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the database adapter really covers both runtimes", () => {
    const source = fs.readFileSync(path.resolve("src/lib/db.ts"), "utf8");
    expect(source).toContain("bun:sqlite");
    expect(source).toContain("node:sqlite");
    expect(source).toContain("foreign_keys = ON");
  });
});
