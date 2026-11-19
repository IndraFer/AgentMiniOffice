import manifest from "../../package.json" with { type: "json" };

/** Resolved with the source (or embedded by the bundler), never from the caller's cwd. */
export function readVersion(): string {
  return manifest.version;
}
