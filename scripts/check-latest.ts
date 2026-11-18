/**
 * Report newer versions for every dependency in package.json.
 *
 * "Check latest terus" is a habit that rots. This makes it one command.
 */
import fs from "node:fs";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as PackageJson;
const entries = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies });

const stripRange = (range: string): string => range.replace(/^[\^~>=<\s]+/, "");

async function latest(name: string): Promise<string> {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`;
  const response = await fetch(url);
  if (!response.ok) return "?";
  const body = (await response.json()) as { version?: string };
  return body.version ?? "?";
}

const rows = await Promise.all(
  entries.map(async ([name, range]) => {
    const current = stripRange(range);
    const next = await latest(name);
    const status = next === "?" ? "unknown" : next === current ? "current" : "outdated";
    return { name, current, next, status };
  }),
);

const width = Math.max(...rows.map((row) => row.name.length));
for (const row of rows) {
  const mark = row.status === "outdated" ? "!" : " ";
  console.log(
    `${mark} ${row.name.padEnd(width)}  ${row.current.padEnd(12)} -> ${row.next.padEnd(12)} ${row.status}`,
  );
}

const outdated = rows.filter((row) => row.status === "outdated").length;
console.log(`\n${outdated} outdated of ${rows.length}.`);
