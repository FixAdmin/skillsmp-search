import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isMainModule(importMetaUrl, argvEntry = process.argv[1]) {
  if (!argvEntry) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) ===
      realpathSync(resolve(argvEntry));
  } catch {
    return false;
  }
}
