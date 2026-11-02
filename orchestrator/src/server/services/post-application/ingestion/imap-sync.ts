import { decryptSecret } from "@infra/credential-crypto";
import { getPostApplicationIntegration } from "@server/repositories/post-application-integrations";
import { normalizeWhitespace } from "@shared/utils/string";
import { type ParsedMail, simpleParser } from "mailparser";
import { cleanEmailHtmlForLlm } from "./gmail-api";
import {
  createImapClient,
  type ImapConnectionConfig,
  type ImapFetchedMessage,
} from "./imap-client";
import {
  type IngestItem,
  type IngestMessage,
  type IngestionSyncSummary,
  runPostApplicationIngestion,
} from "./message-ingest";

const DEFAULT_SEARCH_DAYS = 90;
const DEFAULT_MAX_MESSAGES = 100;
const SNIPPET_MAX_LENGTH = 200;

export type ImapSyncSummary = IngestionSyncSummary;

export type StoredImapCredentials = {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  passwordEncrypted: string;
};

/** The integration is missing or its stored password is unusable. */
export class ImapAccountNotConnectedError extends Error {
  constructor(accountKey: string) {
    super(`IMAP account '${accountKey}' is not connected.`);
    this.name = "ImapAccountNotConnectedError";
  }
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseStoredImapCredentials(
  credentials: Record<string, unknown> | null,
): StoredImapCredentials | null {
  if (!credentials) return null;
  const host = asString(credentials.host);
  const username = asString(credentials.username);
  const passwordEncrypted = asString(credentials.passwordEncrypted);
  const port = credentials.port;
  if (
    !host ||
    !username ||
    !passwordEncrypted ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    typeof credentials.tls !== "boolean"
  ) {
    return null;
  }
  return { host, port, tls: credentials.tls, username, passwordEncrypted };
}

function stripAngleBrackets(value: string): string {
  return value.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

function firstMessageId(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value?.trim().split(/\s+/)[0];
  if (!first) return null;
  return stripAngleBrackets(first) || null;
}

function rawHeaderValue(parsed: ParsedMail, key: string): string {
  const line = parsed.headerLines.find((header) => header.key === key)?.line;
  if (!line) return "";
  return line
    .replace(/^[^:]*:/, "")
    .replace(/\r?\n[ \t]+/g, " ")
    .trim();
}

function formatFrom(parsed: ParsedMail): string {
  const first = parsed.from?.value[0];
  if (!first?.address) return parsed.from?.text ?? "";
  return first.name ? `${first.name} <${first.address}>` : first.address;
}

function extractBody(parsed: ParsedMail): string {
  const text = parsed.text?.trim();
  if (text) return text;
  if (typeof parsed.html === "string" && parsed.html.trim()) {
    return cleanEmailHtmlForLlm(parsed.html).trim();
  }
  return "";
}

// mailparser would otherwise synthesize `text` from HTML (keeping link URLs);
// the body rules below convert HTML with the same settings as Gmail instead.
const PARSER_OPTIONS = {
  skipHtmlToText: true,
  skipTextToHtml: true,
  skipImageLinks: true,
  skipTextLinks: true,
};

export function mapParsedImapMessage(
  parsed: ParsedMail,
  ids: { uid: number; uidValidity: string },
): IngestMessage {
  const body = extractBody(parsed);
  const messageId = parsed.messageId
    ? stripAngleBrackets(parsed.messageId)
    : "";

  return {
    externalMessageId: messageId || `uid:${ids.uidValidity}:${ids.uid}`,
    externalThreadId:
      firstMessageId(parsed.references) ?? firstMessageId(parsed.inReplyTo),
    from: formatFrom(parsed),
    subject: parsed.subject ?? "",
    date: rawHeaderValue(parsed, "date"),
    snippet: normalizeWhitespace(body).slice(0, SNIPPET_MAX_LENGTH),
    loadBody: async () => body,
  };
}

async function fetchRecentInboxMessages(
  config: ImapConnectionConfig,
  searchDays: number,
  maxMessages: number,
): Promise<{ uidValidity: string; messages: ImapFetchedMessage[] }> {
  const client = createImapClient(config);
  try {
    await client.connect();
    const { uidValidity } = await client.openInboxReadOnly();
    const since = new Date(Date.now() - searchDays * 24 * 60 * 60 * 1000);
    const uids = await client.searchUidsSince(since);
    const newestUids = [...uids].sort((a, b) => b - a).slice(0, maxMessages);
    const messages = await client.fetchMessageSources(newestUids);
    return { uidValidity, messages };
  } finally {
    await client.close();
  }
}

export async function runImapIngestionSync(args: {
  accountKey: string;
  maxMessages?: number;
  searchDays?: number;
}): Promise<ImapSyncSummary> {
  const integration = await getPostApplicationIntegration(
    "imap",
    args.accountKey,
  );
  const stored = parseStoredImapCredentials(integration?.credentials ?? null);
  if (!integration || !stored) {
    throw new ImapAccountNotConnectedError(args.accountKey);
  }

  let password: string;
  try {
    password = await decryptSecret(stored.passwordEncrypted);
  } catch {
    throw new ImapAccountNotConnectedError(args.accountKey);
  }

  const searchDays = Math.max(1, args.searchDays ?? DEFAULT_SEARCH_DAYS);
  const maxMessages = Math.max(1, args.maxMessages ?? DEFAULT_MAX_MESSAGES);

  return runPostApplicationIngestion({
    provider: "imap",
    accountKey: args.accountKey,
    integrationId: integration.id,
    failureErrorCode: "IMAP_SYNC_FAILED",
    listItems: async (): Promise<IngestItem[]> => {
      const { uidValidity, messages } = await fetchRecentInboxMessages(
        {
          host: stored.host,
          port: stored.port,
          tls: stored.tls,
          username: stored.username,
          password,
        },
        searchDays,
        maxMessages,
      );

      return messages.map((message) => ({
        externalMessageId: `uid:${uidValidity}:${message.uid}`,
        load: async () =>
          mapParsedImapMessage(
            await simpleParser(message.source, PARSER_OPTIONS),
            {
              uid: message.uid,
              uidValidity,
            },
          ),
      }));
    },
  });
}
