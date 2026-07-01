import { z } from "zod";

/**
 * A single request attribute data source.
 *
 * Grounded in verified-live payload:
 * { enabled:true, source:"POST_PARAMETER", parameterName:"x" }
 */
const requestAttributeDataSourceSchema = z
  .object({
    enabled: z.boolean().optional(),
    source: z
      .string()
      .describe(
        "Capture source, e.g. POST_PARAMETER, GET_PARAMETER, REQUEST_HEADER, RESPONSE_HEADER, " +
          "METHOD_PARAM, CLIENT_IP, …",
      ),
    parameterName: z.string().optional().describe("Parameter/header name to capture (for parameter/header sources)."),
    captureAndStore: z
      .string()
      .optional()
      .describe(
        "Capture+storage location: CAPTURE_AND_STORE_ON_SERVER | CAPTURE_AND_STORE_ON_CLIENT | " +
          "CAPTURE_AND_STORE_ON_BOTH | CAPTURE_ON_CLIENT_STORE_ON_SERVER.",
      ),
  })
  .passthrough();

/**
 * Request attribute definition.
 *
 * Grounded in verified-live payload:
 * { name, enabled:false, dataType:"STRING", normalization:"ORIGINAL", aggregation:"FIRST",
 *   confidential:false, skipPersonalDataMasking:false,
 *   dataSources:[{enabled:true, source:"POST_PARAMETER", parameterName:"x"}] }
 */
export const requestAttributeSchema = z
  .object({
    name: z.string().describe("Request attribute name."),
    enabled: z.boolean().optional(),
    dataType: z.string().optional().describe("STRING | INTEGER | DOUBLE."),
    normalization: z.string().optional().describe("ORIGINAL | TO_LOWER_CASE | TO_UPPER_CASE."),
    aggregation: z.string().optional().describe("FIRST | LAST | ALL_DISTINCT_VALUES | COUNT_DISTINCT_VALUES | …"),
    confidential: z.boolean().optional(),
    skipPersonalDataMasking: z.boolean().optional(),
    dataSources: z
      .array(requestAttributeDataSourceSchema)
      .optional()
      .describe(
        "One or more capture rules. POST_PARAMETER/GET_PARAMETER need parameterName; " +
          "some sources require captureAndStore.",
      ),
  })
  .passthrough();

/**
 * A condition within a request naming rule.
 *
 * Grounded in verified-live payload:
 * { attribute:"SERVICE_TYPE", comparisonInfo:{ type:"SERVICE_TYPE", comparison:"EQUALS", value:"WEB_SERVICE", negate:false } }
 */
const requestNamingConditionSchema = z
  .object({
    attribute: z.string().describe("Condition attribute, e.g. SERVICE_TYPE, SERVICE_DISPLAY_NAME, …"),
    comparisonInfo: z
      .object({
        type: z.string().describe("Comparison type, e.g. SERVICE_TYPE, STRING, …"),
        comparison: z.string().describe("Operator, e.g. EQUALS, CONTAINS, …"),
        value: z.unknown().optional(),
        negate: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Request naming rule definition.
 *
 * Grounded in verified-live payload:
 * { enabled:false, namingPattern:"...", managementZones:[], conditions:[...] }
 */
export const requestNamingSchema = z
  .object({
    namingPattern: z.string().describe("The naming pattern/placeholder string applied to matching requests."),
    enabled: z.boolean().optional(),
    managementZones: z.array(z.string()).optional(),
    conditions: z
      .array(requestNamingConditionSchema)
      .optional()
      .describe("At least one condition (or a management zone) is required by the API."),
  })
  .passthrough();
