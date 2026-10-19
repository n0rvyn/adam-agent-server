import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import { v4 as uuidv4 } from "uuid";
import { createChannel, getChannel, updateChannel, listChannels, deleteChannel, updateChannelStatus } from "../../store/channels.js";
import { toPublicChannel, mergeRedactedConfig } from "../../channels/channel-redaction.js";
import { getMessagesByChannel } from "../../store/messages.js";
import type { Channel } from "../../shared/types.js";
import type { ChannelManager } from "../../channels/manager.js";
import { startWeixinLoginWithQr, waitForWeixinLogin } from "../../channels/adapters/wechat/login-qr.js";
import { WeChatAdapter, type WeChatConfig } from "../../channels/adapters/wechat/wechat.js";
import { getRuntimeConfig } from "../../config/runtime.js";
import { getOwnerViewerKey } from "../../chat/viewer-identity.js";
import {
  cleanupBuiltInAdapterRuntime,
  refreshBuiltInAdapter,
  registerBuiltInAdapter,
  unregisterBuiltInAdapter,
} from "../../channels/built-in-adapters.js";
import { parseMailChannelConfig } from "../../channels/adapters/email/address.js";
import { getEmailGateway, startEmailGatewayFromConfig } from "../../channels/adapters/email/email-gateway.js";
import { mapGatewayStatusToChannelStatus } from "../../channels/adapters/email/email-virtual-adapter.js";

const channelParamsSchema = z.object({
  id: z.string().uuid(),
});

const createChannelBodySchema = z.object({
  name: z.string().min(1, "name is required"),
  platform: z.string().min(1, "platform is required"),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional().default(true),
  linkedRoleId: z.string().optional(),
  allowedChatIds: z.array(z.string()).optional(),
});

const updateChannelBodySchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  linkedRoleId: z.string().optional(),
  allowedChatIds: z.array(z.string()).optional(),
  viewerKey: z.string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_.@:-]+$/, "viewerKey must be alphanumeric or one of _ . @ : -")
    .optional(),
  defaultRecipientCapBytes: z.number().int().min(1_048_576).max(209_715_200).optional(),
  recipientCapMap: z.record(
    z.string().regex(/^[a-z0-9.-]+$/),
    z.number().int().min(1_048_576).max(209_715_200),
  ).optional(),
});

// channelManager is passed explicitly when registering via (instance) => channelRoutes(instance, mgr)
// When registered directly via app.register(channelRoutes), Fastify passes opts object as 2nd arg
let _channelManager: ChannelManager | undefined;

export function setChannelManager(mgr: ChannelManager): void {
  _channelManager = mgr;
}

export function getChannelManager(): ChannelManager | undefined {
  return _channelManager;
}

export async function channelRoutes(fastify: FastifyInstance): Promise<void> {
  const channelManager = _channelManager;

  async function createChannelWithBuiltInRegistration(channel: Channel): Promise<Channel> {
    createChannel(channel);
    try {
      if (channelManager && channel.enabled) await registerBuiltInAdapter(channelManager, channel);
      return channel;
    } catch (error) {
      await cleanupBuiltInAdapterRuntime(channelManager, channel);
      deleteChannel(channel.id);
      throw error;
    }
  }
  // GET /channels — list all channels
  fastify.get(
    "/channels",
    {
      schema: {
        tags: ["Channels"],
        summary: "List channels",
        querystring: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Querystring: { enabled?: boolean } }>,
      _reply: FastifyReply,
    ) => {
      const channels = listChannels(request.query.enabled);
      return { channels: channels.map(toPublicChannel) };
    },
  );

  // POST /channels — add a new channel
  fastify.post(
    "/channels",
    {
      schema: {
        tags: ["Channels"],
        summary: "Create a channel",
        body: {
          type: "object",
          required: ["name", "platform", "config"],
          properties: {
            name: { type: "string", minLength: 1 },
            platform: { type: "string", minLength: 1 },
            config: { type: "object" },
            enabled: { type: "boolean" },
            linkedRoleId: { type: "string" },
            allowedChatIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: unknown }>,
      reply: FastifyReply,
    ) => {
      const parseResult = createChannelBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }

      const { name, platform, config, enabled, linkedRoleId, allowedChatIds } = parseResult.data;
      let normalizedConfig = config as Record<string, unknown>;
      if (platform === "email") {
        try {
          normalizedConfig = { ...parseMailChannelConfig(config as Record<string, unknown>) };
        } catch (error) {
          return reply.status(400).send({ code: "VALIDATION_ERROR", message: error instanceof Error ? error.message : String(error) });
        }
      }
      const channel: Channel = {
        id: uuidv4(),
        name,
        platform,
        enabled,
        status: "disconnected",
        config: normalizedConfig,
        linkedRoleId: linkedRoleId,
        allowedChatIds,
        viewerKey: getOwnerViewerKey(),
        createdAt: Date.now(),
        messageCount: 0,
      };

      try {
        await createChannelWithBuiltInRegistration(channel);
      } catch (error) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: sanitizeErrorMessage(error) });
      }
      return reply.status(201).send({ channel: toPublicChannel(channel) });
    },
  );

  // GET /channels/:id — get channel details
  fastify.get(
    "/channels/:id",
    {
      schema: {
        tags: ["Channels"],
        summary: "Get channel by ID",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = channelParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }

      const channel = getChannel(parseResult.data.id);
      if (!channel) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Channel not found" });
      }

      return { channel: toPublicChannel(channel) };
    },
  );

  // PATCH /channels/:id — update channel
  fastify.patch(
    "/channels/:id",
    {
      schema: {
        tags: ["Channels"],
        summary: "Update channel",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
            enabled: { type: "boolean" },
            config: { type: "object" },
            linkedRoleId: { type: "string" },
            allowedChatIds: { type: "array", items: { type: "string" } },
            viewerKey: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
      reply: FastifyReply,
    ) => {
      const paramsParse = channelParamsSchema.safeParse(request.params);
      if (!paramsParse.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(paramsParse.error) });
      }

      const channel = getChannel(paramsParse.data.id);
      if (!channel) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Channel not found" });
      }

      const bodyParse = updateChannelBodySchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(bodyParse.error) });
      }

      const updates = { ...bodyParse.data } as Partial<Channel>;
      // Restore real secret values for any redacted placeholders the client echoed back
      // (e.g. an edit form populated from a redacted GET), so saving an unchanged config
      // does not clobber stored credentials with the placeholder. Runs before email
      // normalization so it operates on the real values.
      if (updates.config) {
        updates.config = mergeRedactedConfig(updates.config as Record<string, unknown>, channel.config);
      }
      if ((channel.platform === "email" || updates.config) && (updates.config || channel.config)) {
        const nextConfig = updates.config ?? channel.config;
        if (channel.platform === "email") {
          try {
            updates.config = { ...parseMailChannelConfig(nextConfig as Record<string, unknown>) };
          } catch (error) {
            return reply.status(400).send({ code: "VALIDATION_ERROR", message: error instanceof Error ? error.message : String(error) });
          }
        }
      }

      const needsRuntimeRefresh = channel.platform === "email"
        && (updates.enabled !== undefined || updates.config !== undefined);
      updateChannel(channel.id, updates);
      const updated = getChannel(channel.id);
      if (channelManager && updated && needsRuntimeRefresh) {
        try {
          await refreshBuiltInAdapter(channelManager, updated);
        } catch (error) {
          updateChannel(channel.id, {
            name: channel.name,
            enabled: channel.enabled,
            status: channel.status,
            config: channel.config,
            linkedRoleId: channel.linkedRoleId,
            allowedChatIds: channel.allowedChatIds,
            lastMessageAt: channel.lastMessageAt,
            messageCount: channel.messageCount,
          });
          await cleanupBuiltInAdapterRuntime(channelManager, updated);
          if (channel.enabled) {
            try {
              await registerBuiltInAdapter(channelManager, channel);
            } catch (restoreError) {
              return reply.status(500).send({ code: "RESTORE_FAILED", message: sanitizeErrorMessage(restoreError) });
            }
          }
          return reply.status(400).send({ code: "VALIDATION_ERROR", message: sanitizeErrorMessage(error) });
        }
      }
      return { channel: updated ? toPublicChannel(updated) : updated };
    },
  );

  // DELETE /channels/:id — remove channel
  fastify.delete(
    "/channels/:id",
    {
      schema: {
        tags: ["Channels"],
        summary: "Delete channel",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = channelParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }

      const channel = getChannel(parseResult.data.id);
      if (!channel) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Channel not found" });
      }

      deleteChannel(channel.id);
      if (channelManager) {
        try {
          await unregisterBuiltInAdapter(channelManager, channel);
        } catch (error) {
          fastify.log.warn({ channelId: channel.id, error: sanitizeErrorMessage(error) }, "Failed to clean up built-in channel runtime");
        }
      }
      return reply.status(204).send();
    },
  );

  // POST /channels/:id/connect
  fastify.post(
    "/channels/:id/connect",
    {
      schema: {
        tags: ["Channels"],
        summary: "Connect channel",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = channelParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }
      if (!channelManager) {
        return reply.status(501).send({ code: "NOT_IMPLEMENTED", message: "Channel manager not initialized" });
      }
      const channel = getChannel(parseResult.data.id);
      if (!channel) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Channel not found" });
      }
      if (channel.platform === "email") {
        try {
          await ensureEmailGatewayReadyForConnect();
        } catch (error) {
          const gatewayStatus = getEmailGateway().getStatus();
          updateChannelStatus(channel.id, mapGatewayStatusToChannelStatus(gatewayStatus.status));
          return reply.status(409).send({
            code: "EMAIL_GATEWAY_NOT_READY",
            message: sanitizeErrorMessage(error),
            gatewayStatus,
          });
        }
      }
      if (!channelManager.hasAdapter(channel.id)) {
        try {
          await registerBuiltInAdapter(channelManager, channel);
        } catch (error) {
          return reply.status(400).send({ code: "VALIDATION_ERROR", message: sanitizeErrorMessage(error) });
        }
      }
      if (!channelManager.hasAdapter(channel.id)) {
        return reply.status(400).send({ code: "NO_ADAPTER", message: "No adapter registered for this channel. Install the appropriate adapter first." });
      }
      try {
        await channelManager.connectChannel(channel.id);
        const status = getChannel(channel.id)?.status ?? channelManager.getChannelStatus(channel.id);
        if (status !== "connected") {
          return reply.status(409).send({
            code: "CONNECT_INCOMPLETE",
            message: `Channel connect finished with status "${status}"`,
            status,
          });
        }
        return { channelId: channel.id, status };
      } catch (err) {
        return reply.status(500).send({ code: "CONNECT_FAILED", message: sanitizeErrorMessage(err) });
      }
    },
  );

  // POST /channels/:id/disconnect
  fastify.post(
    "/channels/:id/disconnect",
    {
      schema: {
        tags: ["Channels"],
        summary: "Disconnect channel",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = channelParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }
      if (!channelManager) {
        return reply.status(501).send({ code: "NOT_IMPLEMENTED", message: "Channel manager not initialized" });
      }
      const channel = getChannel(parseResult.data.id);
      if (!channel) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Channel not found" });
      }
      await channelManager.disconnectChannel(channel.id);
      return { channelId: channel.id, status: "disconnected" };
    },
  );

  // GET /channels/:id/capabilities — return channel adapter's capability declaration
  fastify.get(
    "/channels/:id/capabilities",
    {
      schema: {
        tags: ["Channels"],
        summary: "Get channel adapter capabilities",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = channelParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }

      const channel = getChannel(parseResult.data.id);
      if (!channel) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Channel not found" });
      }

      if (!channelManager) {
        return reply.status(503).send({ code: "MANAGER_UNAVAILABLE", message: "ChannelManager not initialized" });
      }

      const capabilities = channelManager.getCapabilities(parseResult.data.id);
      if (!capabilities) {
        return reply.status(404).send({ code: "ADAPTER_NOT_REGISTERED", message: "Channel adapter not active" });
      }

      return { capabilities };
    },
  );

  // GET /channels/:id/messages — channel message history
  fastify.get(
    "/channels/:id/messages",
    {
      schema: {
        tags: ["Channels"],
        summary: "Get channel message history",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Querystring: { limit?: number; offset?: number } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = channelParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }

      const channel = getChannel(parseResult.data.id);
      if (!channel) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Channel not found" });
      }

      const { limit = 50, offset = 0 } = request.query;
      const messages = getMessagesByChannel(channel.id, limit, offset);
      return { messages };
    },
  );

  // ===== WeChat QR Login Endpoints =====

  // POST /channels/:id/wechat/qr-start
  fastify.post(
    "/channels/:id/wechat/qr-start",
    {
      schema: {
        tags: ["WeChat"],
        summary: "Start WeChat QR login",
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = channelParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }
      const channel = getChannel(parseResult.data.id);
      if (!channel) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Channel not found" });
      }
      if (channel.platform !== "wechat") {
        return reply.status(400).send({ code: "INVALID_PLATFORM", message: "Channel is not a WeChat channel" });
      }

      const config = channel.config as unknown as WeChatConfig;
      const result = await startWeixinLoginWithQr({
        apiBaseUrl: config.baseUrl,
        routeTag: config.routeTag,
      });

      return result;
    },
  );

  // POST /channels/:id/wechat/qr-wait
  fastify.post(
    "/channels/:id/wechat/qr-wait",
    {
      schema: {
        tags: ["WeChat"],
        summary: "Wait for WeChat QR scan",
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          properties: {
            sessionKey: { type: "string" },
            timeoutMs: { type: "number" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: { sessionKey?: string; timeoutMs?: number } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = channelParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }
      const channel = getChannel(parseResult.data.id);
      if (!channel) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Channel not found" });
      }
      if (channel.platform !== "wechat") {
        return reply.status(400).send({ code: "INVALID_PLATFORM", message: "Channel is not a WeChat channel" });
      }

      const config = channel.config as unknown as WeChatConfig;
      const { sessionKey, timeoutMs } = request.body ?? {};

      const result = await waitForWeixinLogin({
        sessionKey: sessionKey ?? "",
        apiBaseUrl: config.baseUrl,
        timeoutMs: timeoutMs ?? 120_000,
        routeTag: config.routeTag,
      });

      if (result.connected && result.botToken) {
        // Save credentials to channel config
        const updatedConfig: WeChatConfig = {
          ...config,
          botToken: result.botToken,
          accountId: result.accountId,
          baseUrl: result.baseUrl ?? config.baseUrl,
          userId: result.userId,
        };
        updateChannel(channel.id, { config: updatedConfig });

        // Create and register adapter with channel manager
        if (channelManager) {
          const adapter = new WeChatAdapter(channel.id, updatedConfig);
          const updatedChannel = getChannel(channel.id);
          if (updatedChannel) {
            await channelManager.addChannel(updatedChannel, adapter);
          }
        }
      }

      return {
        connected: result.connected,
        accountId: result.accountId,
        message: result.message,
      };
    },
  );
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/pass(word)?=[^\s]+/gi, "password=****");
  return String(error);
}

async function ensureEmailGatewayReadyForConnect(): Promise<void> {
  const config = getRuntimeConfig().emailGateway;
  if (!config?.enabled) {
    throw new Error("Email Gateway is disabled. Enable Email Gateway in Settings before connecting Mail channels.");
  }

  const gateway = getEmailGateway();
  if (gateway.getStatus().status !== "connected") {
    await startEmailGatewayFromConfig(config);
  }

  const status = gateway.getStatus();
  if (status.status !== "connected") {
    const detail = status.lastError ? `: ${status.lastError}` : "";
    throw new Error(`Email Gateway status is ${status.status}${detail}`);
  }
}
