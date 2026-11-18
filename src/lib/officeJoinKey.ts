import { createHmac, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import type { Db } from "./db";

// A DB-only backup contains the verifier and nonce, not an enrollment credential.
// Only machine join keys are reproducible. Never use this for private agent credentials.
const memoryKeys = new WeakMap<Db, Buffer>();
export function officeJoinKey(db: Db, office: string, nonce: string, issue: boolean) {
  const database = db
    .prepare("PRAGMA database_list")
    .all<{ name: string; file: string }>()
    .find((row) => row.name === "main");
  if (!database) throw Error("Cannot locate database");
  let key: Buffer;
  if (!database.file) {
    key = memoryKeys.get(db) ?? randomBytes(32);
    memoryKeys.set(db, key);
  } else {
    const path = `${database.file}.join-secret`;
    if (issue) {
      // One collector per database. Never overwrite an existing installation key.
      try {
        writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600, flush: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (
        !st.isFile() ||
        st.size !== 32 ||
        (process.getuid && (st.uid !== process.getuid() || (st.mode & 0o077) !== 0))
      )
        throw Error("Unsafe join secret file");
      key = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  return `amo_join_${createHmac("sha256", key).update(`${office}:${nonce}`).digest("base64url")}`;
}
