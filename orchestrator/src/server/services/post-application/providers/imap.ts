import { encryptSecret } from "@infra/credential-crypto";
import { logger } from "@infra/logger";
import {
  disconnectPostApplicationIntegration,
  getPostApplicationIntegration,
  upsertConnectedPostApplicationIntegration,
} from "@server/repositories/post-application-integrations";
import {
  createImapClient,
  ImapAuthenticationError,
  type ImapConnectionConfig,
  ImapConnectionError,
} from "@server/services/post-application/ingestion/imap-client";
import {
  ImapAccountNotConnectedError,
  parseStoredImapCredentials,
  runImapIngestionSync,
} from "@server/services/post-application/ingestion/imap-sync";
import type { PostApplicationIntegration } from "@shared/types";
import { providerInvalidRequest, providerUpstreamError } from "./errors";
import type {
  PostApplicationProviderActionResult,
  PostApplicationProviderAdapter,
  PostApplicationProviderConnectArgs,
  PostApplicationProviderDisconnectArgs,
  PostApplicationProviderStatusArgs,
  PostApplicationProviderSyncArgs,
} from "./types";

const DEFAULT_IMAP_PORT = 993;
const MAX_HOSTNAME_LENGTH = 253;
const HOSTNAME_PATTERN = /^[A-Za-z0-9.-]+$/;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseImapConnectPayload(
  args: PostApplicationProviderConnectArgs,
): ImapConnectionConfig {
  const raw = args.payload?.payload;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw providerInvalidRequest(
      "IMAP connect requires connection settings in body.payload.",
    );
  }
  const payload = raw as Record<string, unknown>;

  const host = asString(payload.host);
  if (
    !host ||
    host.length > MAX_HOSTNAME_LENGTH ||
    !HOSTNAME_PATTERN.test(host)
  ) {
    throw providerInvalidRequest(
      "IMAP connect requires a hostname in body.payload.host, without scheme, path or spaces.",
    );
  }

  const port = payload.port ?? DEFAULT_IMAP_PORT;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw providerInvalidRequest(
      "IMAP connect requires body.payload.port to be an integer from 1 to 65535.",
    );
  }

  const tls = payload.tls ?? true;
  if (typeof tls !== "boolean") {
    throw providerInvalidRequest(
      "IMAP connect requires body.payload.tls to be a boolean.",
    );
  }

  const username = asString(payload.username);
  if (!username) {
    throw providerInvalidRequest(
      "IMAP connect requires a non-empty username in body.payload.username.",
    );
  }

  // The password is used verbatim: surrounding spaces may be significant.
  const password = payload.password;
  if (typeof password !== "string" || password.length === 0) {
    throw providerInvalidRequest(
      "IMAP connect requires a non-empty password in body.payload.password.",
    );
  }

  return { host, port, tls, username, password };
}

function toImapProviderError(error: unknown): unknown {
  if (error instanceof ImapAuthenticationError) {
    return providerInvalidRequest(error.message);
  }
  if (error instanceof ImapConnectionError) {
    return providerUpstreamError(error.message);
  }
  if (error instanceof ImapAccountNotConnectedError) {
    return providerInvalidRequest(error.message);
  }
  return error;
}

function toPublicIntegration(
  integration: PostApplicationIntegration | null,
): PostApplicationIntegration | null {
  if (!integration) return null;

  const credentials = integration.credentials ?? {};
  return {
    ...integration,
    credentials: {
      host: asString(credentials.host) ?? null,
      port: typeof credentials.port === "number" ? credentials.port : null,
      tls: typeof credentials.tls === "boolean" ? credentials.tls : null,
      username: asString(credentials.username) ?? null,
      hasPassword:
        typeof credentials.passwordEncrypted === "string" &&
        credentials.passwordEncrypted.length > 0,
    },
  };
}

function buildStatus(
  accountKey: string,
  integration: PostApplicationIntegration | null,
  message?: string,
): PostApplicationProviderActionResult {
  const publicIntegration = toPublicIntegration(integration);
  const hasPassword = Boolean(publicIntegration?.credentials?.hasPassword);

  return {
    status: {
      provider: "imap",
      accountKey,
      connected: publicIntegration?.status === "connected" && hasPassword,
      integration: publicIntegration,
    },
    message,
  };
}

async function verifyImapLogin(config: ImapConnectionConfig): Promise<void> {
  const client = createImapClient(config);
  try {
    await client.connect();
  } finally {
    await client.close();
  }
}

export const imapProvider: PostApplicationProviderAdapter = {
  key: "imap",

  async connect(
    args: PostApplicationProviderConnectArgs,
  ): Promise<PostApplicationProviderActionResult> {
    const config = parseImapConnectPayload(args);

    try {
      await verifyImapLogin(config);
    } catch (error) {
      logger.warn("IMAP login verification failed", {
        provider: "imap",
        accountKey: args.accountKey,
        initiatedBy: args.initiatedBy ?? null,
        reason:
          error instanceof ImapAuthenticationError
            ? "authentication"
            : error instanceof ImapConnectionError
              ? (error.code ?? "connection")
              : "unknown",
      });
      throw toImapProviderError(error);
    }

    const integration = await upsertConnectedPostApplicationIntegration({
      provider: "imap",
      accountKey: args.accountKey,
      displayName: config.username,
      credentials: {
        host: config.host,
        port: config.port,
        tls: config.tls,
        username: config.username,
        passwordEncrypted: await encryptSecret(config.password),
      },
    });

    logger.info("IMAP integration connected", {
      provider: "imap",
      accountKey: args.accountKey,
      initiatedBy: args.initiatedBy ?? null,
      integrationId: integration.id,
    });

    return buildStatus(
      args.accountKey,
      integration,
      "IMAP integration connected.",
    );
  },

  async status(
    args: PostApplicationProviderStatusArgs,
  ): Promise<PostApplicationProviderActionResult> {
    const integration = await getPostApplicationIntegration(
      "imap",
      args.accountKey,
    );
    if (!integration) {
      return buildStatus(
        args.accountKey,
        null,
        "IMAP provider is not connected.",
      );
    }

    return buildStatus(args.accountKey, integration);
  },

  async sync(
    args: PostApplicationProviderSyncArgs,
  ): Promise<PostApplicationProviderActionResult> {
    const integration = await getPostApplicationIntegration(
      "imap",
      args.accountKey,
    );
    if (
      !integration ||
      !parseStoredImapCredentials(integration.credentials ?? null)
    ) {
      throw providerInvalidRequest(
        `IMAP account '${args.accountKey}' is not connected.`,
      );
    }

    let summary: Awaited<ReturnType<typeof runImapIngestionSync>>;
    try {
      summary = await runImapIngestionSync({
        accountKey: args.accountKey,
        maxMessages: args.payload?.maxMessages,
        searchDays: args.payload?.searchDays,
      });
    } catch (error) {
      throw toImapProviderError(error);
    }

    const refreshedIntegration = await getPostApplicationIntegration(
      "imap",
      args.accountKey,
    );
    logger.info("IMAP sync completed", {
      provider: "imap",
      accountKey: args.accountKey,
      initiatedBy: args.initiatedBy ?? null,
      integrationId: integration.id,
      discovered: summary.discovered,
      relevant: summary.relevant,
      classified: summary.classified,
      errored: summary.errored,
    });

    return buildStatus(
      args.accountKey,
      refreshedIntegration,
      `Sync complete: discovered=${summary.discovered}, relevant=${summary.relevant}, classified=${summary.classified}, errored=${summary.errored}.`,
    );
  },

  async disconnect(
    args: PostApplicationProviderDisconnectArgs,
  ): Promise<PostApplicationProviderActionResult> {
    const disconnected = await disconnectPostApplicationIntegration(
      "imap",
      args.accountKey,
    );
    logger.info("IMAP integration disconnected", {
      provider: "imap",
      accountKey: args.accountKey,
      initiatedBy: args.initiatedBy ?? null,
      integrationId: disconnected?.id ?? null,
    });

    return buildStatus(
      args.accountKey,
      disconnected,
      "IMAP integration disconnected.",
    );
  },
};
