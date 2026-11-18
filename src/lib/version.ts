import fs from "node:fs";
import path from "node:path";

export function readVersion(): string {
  try {
    const raw = fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string") return version;
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}
