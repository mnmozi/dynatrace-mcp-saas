import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DynatraceClient } from "../http/client.js";
import type { Config } from "../types.js";
import { registerDqlTools } from "./dql.js";
import { registerMetricsTools } from "./metrics.js";
import { registerEntitiesTools } from "./entities.js";
import { registerProblemsTools } from "./problems.js";
import { registerLogsTools } from "./logs.js";
import { registerTracesTools } from "./traces.js";
import { registerVulnerabilitiesTools } from "./vulnerabilities.js";
import { registerSettingsTools } from "./settings.js";
import { registerDashboardTools } from "./dashboards.js";
import { registerNotebookTools } from "./notebooks.js";
import { registerSloTools } from "./slos.js";
import { registerSyntheticTools } from "./synthetic.js";
import { registerConfigV1Tools } from "./config-v1.js";
import { registerOpenPipelineTools } from "./openpipeline.js";
import { registerDriftTools } from "./drift.js";

export interface ToolDeps { client: DynatraceClient; config: Config }

// Tool registrations are added here by Tasks 8–19.
export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  registerDqlTools(server, deps);
  registerMetricsTools(server, deps);
  registerEntitiesTools(server, deps);
  registerProblemsTools(server, deps);
  registerLogsTools(server, deps);
  registerTracesTools(server, deps);
  registerVulnerabilitiesTools(server, deps);
  registerSettingsTools(server, deps);
  registerDashboardTools(server, deps);
  registerNotebookTools(server, deps);
  registerSloTools(server, deps);
  registerSyntheticTools(server, deps);
  registerConfigV1Tools(server, deps);
  registerOpenPipelineTools(server, deps);
  registerDriftTools(server, deps);
}
