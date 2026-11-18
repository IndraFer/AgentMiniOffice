/**
 * The only place allowed to ask which runtime we are on.
 *
 * `typeof` on an undeclared identifier does not throw, so this is safe under Node
 * even though `Bun` is a global that no Node build defines.
 */
export const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export const runtimeName: "bun" | "node" = isBun ? "bun" : "node";
