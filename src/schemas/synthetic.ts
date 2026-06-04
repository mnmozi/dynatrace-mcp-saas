import { z } from "zod";

/**
 * Synthetic monitor definition object per the platform Synthetic v1 spec.
 *
 * The API accepts a `oneOf` union of:
 *   - `SyntheticBrowserMonitorRequest` (required: configuration, locations, name, steps, type)
 *   - `SyntheticMultiProtocolMonitorRequest` (required: locations, name, steps, type)
 *
 * Because these are polymorphic and very large, we only type the safe common top-level fields
 * that appear in BOTH variants. All fields are optional here (validation is server-side).
 * `.passthrough()` forwards polymorphic fields (steps, configuration, script, requests, etc.)
 * to the API without loss.
 */
export const syntheticMonitorSchema = z
  .object({
    name: z
      .string()
      .describe(
        "The name of the monitor (required by the API for both browser and multi-protocol monitors).",
      ),
    type: z
      .string()
      .optional()
      .describe(
        "Monitor type: 'BROWSER', 'HTTP', or 'MULTI_PROTOCOL'.",
      ),
    description: z
      .string()
      .optional()
      .describe("Monitor description."),
    enabled: z
      .boolean()
      .optional()
      .describe("If true, the monitor is enabled. Defaults to true."),
    frequencyMin: z
      .number()
      .optional()
      .describe(
        "The frequency of the monitor, in minutes. Default depends on type " +
          "(1 min for MULTI_PROTOCOL/HTTP, 15 min for BROWSER).",
      ),
    locations: z
      .array(z.string())
      .optional()
      .describe(
        "The entity IDs of the synthetic locations the monitor is assigned to " +
          "(e.g. 'SYNTHETIC_LOCATION-D3A5BFD8676A4F19').",
      ),
    tags: z
      .array(z.record(z.unknown()))
      .optional()
      .describe(
        "A set of tags assigned to the monitor. Each tag is a SyntheticTagWithSourceDto object " +
          "or may be a plain string context tag.",
      ),
    primaryGrailTags: z
      .array(z.record(z.unknown()))
      .optional()
      .describe(
        "Primary Grail tags as a list of key-value pairs. Up to 10 tags. SaaS only.",
      ),
    securityContext: z
      .array(z.string())
      .optional()
      .describe(
        "[FEATURE DISABLED] Security context as a list of strings. Up to 10 values. SaaS only.",
      ),
    manuallyAssignedEntities: z
      .array(z.string())
      .optional()
      .describe("Manually assigned entities (browser monitors only)."),
  })
  .passthrough();
