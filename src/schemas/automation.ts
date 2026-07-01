import { z } from "zod";

/**
 * Lenient typed passthrough schema for a workflow body (WorkflowCreate / WorkflowUpdate).
 * Top-level fields are from the spec's WorkflowCreate schema (required: title).
 * All other fields pass through via .passthrough().
 *
 * Spec-confirmed top-level fields:
 *   title (required string), description, tasks (record), trigger (record),
 *   isPrivate (bool), isDeployed (bool), actor (string), owner (string/uuid),
 *   ownerType (string), schemaVersion (int), result (string), type (string),
 *   input (record), hourlyExecutionLimit (int), guide (string),
 *   basedOnTemplate (record), throttle (record), id (uuid string).
 */
export const workflowSchema = z
  .object({
    title: z.string().min(1).max(200).describe("Workflow title (required, 1–200 chars)."),
    description: z.string().optional().describe("Human-readable description of the workflow."),
    tasks: z
      .record(z.unknown())
      .optional()
      .describe("Map of task names to task definitions. Each task is an object per the AutomationEngine spec."),
    trigger: z
      .record(z.unknown())
      .optional()
      .describe(
        "Trigger configuration object (e.g. schedule, event, on-demand). " +
          "See TriggerRequest in the AutomationEngine API spec.",
      ),
    isPrivate: z.boolean().optional().describe("Whether the workflow is private (default: true)."),
    isDeployed: z.boolean().optional().describe("Whether the workflow is deployed/active (default: true)."),
    actor: z.string().max(36).optional().nullable().describe("Service account or user running the workflow tasks."),
    owner: z.string().optional().describe("UUID of the owner (user or group) of this workflow."),
    ownerType: z.string().optional().describe("Owner type: 'USER' or 'GROUP'."),
    schemaVersion: z.number().int().optional().describe("Schema version integer."),
    type: z.string().optional().describe("Workflow type, e.g. 'simple' or 'standard'."),
    input: z.record(z.unknown()).optional().describe("Workflow-level input parameter definitions."),
    hourlyExecutionLimit: z
      .number()
      .int()
      .min(1)
      .optional()
      .nullable()
      .describe("Max executions per hour (default: 1000)."),
    guide: z
      .string()
      .max(10000)
      .optional()
      .nullable()
      .describe("Markdown guide text for the workflow (max 10 000 chars)."),
    result: z.string().optional().nullable().describe("DQL expression that produces the workflow result."),
    id: z.string().optional().describe("Workflow UUID (omit on create; required on update via path param)."),
  })
  .passthrough();

export type WorkflowInput = z.input<typeof workflowSchema>;
