import { z } from "zod";

/** Scope of a Settings 2.0 read. Tools that summarise one scope default to the whole environment. */
export const settingsScopeSchema = z
  .string()
  .min(1)
  .default("environment")
  .describe("Settings scope: 'environment' (default) or an entity id such as HOST-… / PROCESS_GROUP-….");
