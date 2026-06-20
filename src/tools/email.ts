import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const EMAIL_BASE = "/platform/email/v1";

/**
 * Typed schema for SendEmailRequest per platform_email_v1.yaml.
 * Uses .passthrough() so callers may supply extra/future fields without
 * them being stripped.
 */
const recipientListsSchema = z
  .object({
    emailAddresses: z.array(z.string()).optional(),
    ssoUserIds: z.array(z.string()).optional(),
    ssoGroupIds: z.array(z.string()).optional(),
  })
  .passthrough();

const emailBodySchema = z
  .object({
    contentType: z.enum(["text/plain", "text/html"]).optional(),
    body: z.string().optional(),
  })
  .passthrough();

const sendEmailRequestSchema = z
  .object({
    toRecipients: recipientListsSchema.optional(),
    ccRecipients: recipientListsSchema.optional(),
    bccRecipients: recipientListsSchema.optional(),
    subject: z.string().optional(),
    body: emailBodySchema.optional(),
    notificationSettingsUrl: z.string().optional(),
  })
  .passthrough()
  .describe(
    "Email payload per Email API v1: toRecipients, ccRecipients, bccRecipients " +
      "(each with emailAddresses/ssoUserIds/ssoGroupIds), subject, body " +
      "(contentType: text/plain|text/html, body), notificationSettingsUrl.",
  );

export function registerEmailTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "send_email",
    {
      description:
        "Send an email via the Dynatrace Email API (platform email v1). " +
        "Requires DT_ENABLE_WRITES=true and the platform scope email:emails:send. " +
        "The sender is fixed to no-reply@dev.apps.dynatracelabs.com.",
      inputSchema: {
        email: sendEmailRequestSchema,
      },
    },
    async ({ email }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.post(`${EMAIL_BASE}/emails`, email),
      );
    },
  );
}
