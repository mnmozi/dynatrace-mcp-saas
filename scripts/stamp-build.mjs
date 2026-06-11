import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
let gitCommit = "unknown";
try { gitCommit = execSync("git rev-parse --short HEAD", { cwd: new URL("..", import.meta.url).pathname }).toString().trim(); } catch {}
const info = { gitCommit, buildTime: new Date().toISOString() };
writeFileSync(new URL("../dist/build-info.json", import.meta.url), JSON.stringify(info, null, 2) + "\n");
console.error(`build stamped: ${gitCommit} @ ${info.buildTime}`);
