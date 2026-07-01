import { z } from "zod";

/**
 * A single OpenPipeline processor. Common fields typed; type-specific fields
 * (fields, dqlScript, field mappings, etc.) pass through via .passthrough().
 *
 * Grounded in verified-live fieldsRename payload:
 * { type:"fieldsRename", enabled:false, editable:true, id:"hostname-field-normalizer",
 *   description:"...", matcher:'isNotNull("hostname")', sampleData:'{"hostname":"raspberry-pi 4"}',
 *   fields:[{fromName:"hostname",toName:"host.name"}] }
 */
export const openPipelineProcessorSchema = z
  .object({
    type: z
      .string()
      .describe(
        "Processor type, e.g. 'fieldsAdd', 'fieldsRename', 'fieldsRemove', 'dql', 'drop', 'geoLookup', 'technology'.",
      ),
    id: z.string().optional().describe("Stable processor id."),
    description: z.string().optional().describe("Human-readable description."),
    enabled: z.boolean().optional().describe("Whether the processor is enabled."),
    editable: z.boolean().optional(),
    matcher: z
      .string()
      .optional()
      .describe(
        "DQL matcher controlling which records this processor applies to, e.g. 'isNotNull(\"hostname\")' or 'true'.",
      ),
    sampleData: z
      .string()
      .optional()
      .describe(
        "JSON-encoded sample record (used only by preview tools; chained pipeline preview injects this automatically).",
      ),
    // type-specific fields like `fields` (fieldsAdd/fieldsRename), `dqlScript` (dql), etc. pass through.
  })
  .passthrough();

/**
 * Full OpenPipeline configuration object (for update). Kept lenient: the definition
 * tree is large and tenant/version-specific.
 */
export const openPipelineConfigurationSchema = z
  .object({
    id: z.string().optional().describe("Configuration / data-type id, e.g. 'logs'."),
    editable: z.boolean().optional(),
    definition: z
      .record(z.unknown())
      .optional()
      .describe(
        "The configuration definition tree (endpointsSpecification, pipelinesSpecification, " +
          "routing/catchAllPipeline, bucketsSpecification, …). " +
          "Fetch with get_openpipeline_configuration, modify, then send back.",
      ),
  })
  .passthrough();

/**
 * DQL processor verify request (POST /dqlProcessor/verify).
 * Spec fields: configurationId (string), protectedFields (string[]), script (string).
 */
export const dqlProcessorVerifySchema = z
  .object({
    script: z
      .string()
      .optional()
      .describe("The unverified DQL script, e.g. 'parse content, \"IPV4:ip LD HTTPDATE:time\\']\\'  LD:text\"'."),
    configurationId: z.string().optional().describe("Identifier of the configuration the script belongs to."),
    protectedFields: z
      .array(z.string())
      .optional()
      .describe("List of protected fields that the script must not modify."),
  })
  .passthrough();

/**
 * DQL processor autocomplete request (POST /dqlProcessor/autocomplete).
 * Spec fields: configurationId (string), cursorPosition (int32), protectedFields (string[]), script (string).
 */
export const dqlProcessorAutocompleteSchema = z
  .object({
    script: z.string().optional().describe("The current (in-)complete DQL script, e.g. 'parse'."),
    cursorPosition: z
      .number()
      .int()
      .optional()
      .describe("The position of the cursor inside the script (0-based character offset)."),
    configurationId: z.string().optional().describe("Identifier of the configuration."),
    protectedFields: z.array(z.string()).optional().describe("List of protected fields."),
  })
  .passthrough();

/**
 * Matcher verify request (POST /matcher/verify).
 * Spec fields: configurationId (string), context (string), query (string), restrictedFields (string[]).
 */
export const matcherVerifySchema = z
  .object({
    query: z.string().optional().describe("The matcher query to verify, e.g. 'matchesValue(type, \"security\")'."),
    configurationId: z
      .string()
      .optional()
      .describe("Identifier of the configuration in which the validity of the matcher query should be verified."),
    context: z.string().optional().describe("Context for verification, e.g. 'processing' or 'ROUTING_RULE'."),
    restrictedFields: z
      .array(z.string())
      .optional()
      .describe("Defined restricted fields against which the matcher should be verified."),
  })
  .passthrough();

/**
 * Matcher autocomplete request (POST /matcher/autocomplete).
 * Spec fields: cursorPosition (int32), query (string).
 */
export const matcherAutocompleteSchema = z
  .object({
    query: z.string().optional().describe("The current (in-)complete matcher query."),
    cursorPosition: z
      .number()
      .int()
      .optional()
      .describe("The position of the cursor inside the query (0-based character offset)."),
  })
  .passthrough();

/**
 * LQL to DQL conversion request (POST /matcher/lqlToDql).
 * Uses MatcherRequest schema: query (string).
 */
export const lqlToDqlSchema = z
  .object({
    query: z
      .string()
      .optional()
      .describe(
        'The LQL matcher string to convert, e.g. \'log.source="snmptraps" AND snmp.trap_oid="F5-BIGIP-COMMON-MIB"\'.',
      ),
  })
  .passthrough();
