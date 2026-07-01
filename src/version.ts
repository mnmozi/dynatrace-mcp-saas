import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const HERE = new URL(".", import.meta.url);

export interface BuildInfo {
  gitCommit: string;
  buildTime: string;
}

/** Version from package.json (one level above src/ or dist/). */
export async function getVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", HERE)), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Build stamp written next to the compiled module by the build script; absent in dev. */
export async function getBuildInfo(): Promise<BuildInfo> {
  try {
    const raw = JSON.parse(await readFile(fileURLToPath(new URL("./build-info.json", HERE)), "utf8"));
    return { gitCommit: raw.gitCommit ?? "unknown", buildTime: raw.buildTime ?? "unknown" };
  } catch {
    return { gitCommit: "dev (no build stamp)", buildTime: "dev" };
  }
}
