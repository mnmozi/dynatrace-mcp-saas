import type { Config } from "../types.js";

export function requireWrites(config: Config): void {
  if (!config.enableWrites) {
    throw new Error("Write blocked: set DT_ENABLE_WRITES=true to enable mutating operations (create/update/delete).");
  }
}
