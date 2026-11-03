import { isDeepStrictEqual } from "node:util";
import { decryptSecret } from "@infra/credential-crypto";
import { logger } from "@infra/logger";
import {
  getPostApplicationIntegration,
  replacePostApplicationIntegrationCredentialsIfUnchanged,
} from "@server/repositories/post-application-integrations";
import { normalizeWhitespace } from "@shared/utils/string";
import { type ParsedMail, simpleParser } from "mailparser";
import { cleanEmailHtmlForLlm } from "./gmail-api";
import {
  createImapClient,
  IMAP_MAX_MESSAGE_BYTES,
  IMAP_MAX_SYNC_BYTES,
  type ImapConnectionConfig,
  type ImapFetchedMessage,
  type ImapMessageSize,
} from "./imap-client";
import {
  type IngestItem,
  type IngestionItemsOutcome,
  type IngestionSyncSummary,
  type IngestMessage,
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

/** Highest INBOX UID ingested without gaps, valid only for `uidValidity`. */
export type ImapSyncWatermark = {
  uidValidity: string;
  lastUid: number;
};

type ImapSyncMode = "first" | "incremental" | "reset";

/** `skipped`: the account was disconnected or reconnected during the sync. */
type ImapWatermarkWrite = "stored" | "unchanged" | "skipped";

type InboxFetchResult = {
  uidValidity: string;
  mode: ImapSyncMode;
  /** UIDs left after the `maxMessages` cap, before the byte budget. */
  candidates: number[];
  selected: number[];
  messages: ImapFetchedMessage[];
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

/** Reads `credentials.syncWatermark`; anything malformed counts as absent. */
export function parseImapSyncWatermark(
  credentials: Record<string, unknown> | null,
): ImapSyncWatermark | null {
  const value = credentials?.syncWatermark;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { uidValidity, lastUid } = value as Record<string, unknown>;
  if (
    typeof uidValidity !== "string" ||
    typeof lastUid !== "number" ||
    !Number.isInteger(lastUid) ||
    lastUid < 0
  ) {
    return null;
  }
  return { uidValidity, lastUid };
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
export const PARSER_OPTIONS = {
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

/**
 * Greedy in-order fit of UIDs into the per-sync byte budget. Each UID is
 * charged its reported size capped at the per-message limit (the cap when the
 * size is unknown); UIDs that do not fit are skipped so later, smaller ones can.
 * Truncated and skipped UIDs are logged as warnings.
 */
export function selectUidsWithinBudget(
  accountKey: string,
  orderedUids: number[],
  sizes: ImapMessageSize[],
): { selected: number[]; skipped: number[] } {
  const sizeByUid = new Map(sizes.map((entry) => [entry.uid, entry.size]));
  const selected: number[] = [];
  const skipped: number[] = [];
  const truncated: ImapMessageSize[] = [];
  let remaining = IMAP_MAX_SYNC_BYTES;
  for (const uid of orderedUids) {
    const size = sizeByUid.get(uid) ?? null;
    const charge =
      size === null
        ? IMAP_MAX_MESSAGE_BYTES
        : Math.min(size, IMAP_MAX_MESSAGE_BYTES);
    if (charge > remaining) {
      skipped.push(uid);
      continue;
    }
    remaining -= charge;
    selected.push(uid);
    if (size !== null && size > IMAP_MAX_MESSAGE_BYTES) {
      truncated.push({ uid, size });
    }
  }

  for (const { uid, size } of truncated) {
    logger.warn("IMAP message exceeds size limit; truncating", {
      provider: "imap",
      accountKey,
      uid,
      sizeBytes: size,
      limitBytes: IMAP_MAX_MESSAGE_BYTES,
    });
  }
  if (skipped.length > 0) {
    logger.warn("IMAP sync byte budget exceeded; skipping messages", {
      provider: "imap",
      accountKey,
      skippedCount: skipped.length,
      skippedUids: skipped,
      budgetBytes: IMAP_MAX_SYNC_BYTES,
    });
  }
  return { selected, skipped };
}

/**
 * Without a usable watermark, reads the newest `maxMessages` UIDs of the
 * `searchDays` window; with one, reads the oldest `maxMessages` UIDs above it,
 * so a backlog drains over several syncs.
 */
async function fetchInboxMessages(
  accountKey: string,
  config: ImapConnectionConfig,
  watermark: ImapSyncWatermark | null,
  searchDays: number,
  maxMessages: number,
): Promise<InboxFetchResult> {
  const client = createImapClient(config);
  try {
    await client.connect();
    const { uidValidity } = await client.openInboxReadOnly();
    let mode: ImapSyncMode;
    let candidates: number[];
    if (watermark && watermark.uidValidity === uidValidity) {
      mode = "incremental";
      const uids = await client.searchUidsAfter(watermark.lastUid);
      candidates = [...uids].sort((a, b) => a - b).slice(0, maxMessages);
    } else {
      mode = watermark ? "reset" : "first";
      if (watermark) {
        logger.warn("IMAP UIDVALIDITY changed; discarding sync watermark", {
          provider: "imap",
          accountKey,
          previousUidValidity: watermark.uidValidity,
          uidValidity,
        });
      }
      const since = new Date(Date.now() - searchDays * 24 * 60 * 60 * 1000);
      const uids = await client.searchUidsSince(since);
      candidates = [...uids].sort((a, b) => b - a).slice(0, maxMessages);
    }
    const sizes = await client.fetchMessageSizes(candidates);
    const { selected } = selectUidsWithinBudget(accountKey, candidates, sizes);

    const messages = await client.fetchMessageSources(
      selected,
      IMAP_MAX_MESSAGE_BYTES,
    );
    return { uidValidity, mode, candidates, selected, messages };
  } finally {
    await client.close();
  }
}

/**
 * The watermark this run may store: max(candidates) when every candidate was
 * processed, otherwise just below the lowest unprocessed one. `undefined`
 * leaves the stored value alone; `null` removes it.
 */
function resolveNextWatermark(
  fetched: InboxFetchResult,
  previous: ImapSyncWatermark | null,
  outcome: IngestionItemsOutcome,
): ImapSyncWatermark | null | undefined {
  const { uidValidity, mode, candidates, selected, messages } = fetched;
  if (candidates.length === 0) {
    if (mode === "reset") return null;
    return undefined;
  }

  const sourced = new Set(messages.map((message) => message.uid));
  const processed = new Set(
    selected.filter(
      (uid) =>
        sourced.has(uid) &&
        !outcome.erroredExternalMessageIds.has(`uid:${uidValidity}:${uid}`),
    ),
  );
  const unprocessed = candidates.filter((uid) => !processed.has(uid));
  let lastUid =
    unprocessed.length === 0
      ? candidates.reduce((a, b) => Math.max(a, b))
      : unprocessed.reduce((a, b) => Math.min(a, b)) - 1;
  if (mode === "incremental" && previous) {
    lastUid = Math.max(lastUid, previous.lastUid);
  }
  return { uidValidity, lastUid };
}

/**
 * Writes the watermark into the account's current credentials, unless the
 * account was reconnected or disconnected during the sync. The write only
 * lands if the credentials still equal the ones read here, so it can never
 * restore removed or replaced credentials.
 */
async function persistImapSyncWatermark(
  accountKey: string,
  connected: StoredImapCredentials,
  watermark: ImapSyncWatermark | null,
): Promise<ImapWatermarkWrite> {
  const integration = await getPostApplicationIntegration("imap", accountKey);
  const currentCredentials = integration?.credentials ?? null;
  const current = parseStoredImapCredentials(currentCredentials);
  if (
    !currentCredentials ||
    !current ||
    current.host !== connected.host ||
    current.port !== connected.port ||
    current.username !== connected.username ||
    current.passwordEncrypted !== connected.passwordEncrypted
  ) {
    return "skipped";
  }

  const { syncWatermark: storedWatermark, ...otherCredentials } =
    currentCredentials;
  if (
    watermark === null
      ? !("syncWatermark" in currentCredentials)
      : isDeepStrictEqual(storedWatermark, watermark)
  ) {
    return "unchanged";
  }

  const written = await replacePostApplicationIntegrationCredentialsIfUnchanged(
    {
      provider: "imap",
      accountKey,
      expectedCredentials: currentCredentials,
      credentials:
        watermark === null
          ? otherCredentials
          : { ...currentCredentials, syncWatermark: watermark },
    },
  );
  return written ? "stored" : "skipped";
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
  const previousWatermark = parseImapSyncWatermark(integration.credentials);
  let fetched: InboxFetchResult | null = null;

  return runPostApplicationIngestion({
    provider: "imap",
    accountKey: args.accountKey,
    integrationId: integration.id,
    failureErrorCode: "IMAP_SYNC_FAILED",
    listItems: async (): Promise<IngestItem[]> => {
      fetched = await fetchInboxMessages(
        args.accountKey,
        {
          host: stored.host,
          port: stored.port,
          tls: stored.tls,
          username: stored.username,
          password,
        },
        previousWatermark,
        searchDays,
        maxMessages,
      );
      const { uidValidity, messages } = fetched;

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
    onItemsProcessed: async (outcome) => {
      if (!fetched) return;
      const next = resolveNextWatermark(fetched, previousWatermark, outcome);
      const write =
        next === undefined
          ? "unchanged"
          : await persistImapSyncWatermark(args.accountKey, stored, next);
      logger.info("IMAP sync watermark", {
        provider: "imap",
        accountKey: args.accountKey,
        mode: fetched.mode,
        candidateCount: fetched.candidates.length,
        previousLastUid: previousWatermark?.lastUid ?? null,
        newLastUid:
          write === "skipped"
            ? null
            : ((next === undefined ? previousWatermark : next)?.lastUid ??
              null),
        watermarkWrite: write,
      });
    },
  });
}
