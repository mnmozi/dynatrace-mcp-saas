import { z } from "zod";

/**
 * A single criteria entry for an SLO.
 *
 * Based on the platform SLO v1 spec `Criteria` schema (which allOf: Timeframe + target/warning).
 * Typed leniently: all fields optional, passthrough for any extra properties.
 */
const criteriaSchema = z
  .object({
    timeframeFrom: z
      .string()
      .optional()
      .describe(
        "Start of the evaluation timeframe. Supports relative time expressions (e.g. 'now-7d') " +
          "and ISO 8601 timestamps.",
      ),
    timeframeTo: z
      .string()
      .optional()
      .describe(
        "End of the evaluation timeframe. Defaults to 'now' when omitted.",
      ),
    target: z
      .number()
      .optional()
      .describe("The target SLO compliance percentage (0–100)."),
    warning: z
      .number()
      .optional()
      .describe("Optional warning threshold percentage (0–100)."),
  })
  .passthrough();

/**
 * SLO definition object per the platform SLO v1 spec (`SloConfig` schema).
 *
 * Required by spec: `name`, `criteria`.
 * All other fields are optional. `.passthrough()` forwards any extra fields to the API.
 *
 * Note: exactly one of `sliReference` or `customSli` must be provided (validated server-side).
 */
export const sloSchema = z
  .object({
    name: z
      .string()
      .describe("The name of the service-level objective (required)."),
    description: z
      .string()
      .optional()
      .describe("An optional description of the SLO (max 250 chars)."),
    criteria: z
      .array(criteriaSchema)
      .optional()
      .describe(
        "Exactly one criteria entry is required by the spec, defining the evaluation timeframe " +
          "and target compliance percentage.",
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        "A list of tags for this SLO. Tags can be plain strings (e.g. 'myTag') or " +
          "key-value pairs separated by a colon (e.g. 'Stage:DEV').",
      ),
    externalId: z
      .string()
      .optional()
      .describe(
        "An optional user-provided external identifier for the SLO. Must be unique across all SLOs.",
      ),
    sliReference: z
      .record(z.unknown())
      .optional()
      .describe(
        "Reference to an objective template SLI definition. " +
          "Provide either this or customSli, not both.",
      ),
    customSli: z
      .record(z.unknown())
      .optional()
      .describe(
        "Custom SLI definition with an `indicator` DQL expression. " +
          "Provide either this or sliReference, not both.",
      ),
  })
  .passthrough();
