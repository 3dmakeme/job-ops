import { decryptSecret } from "@infra/credential-crypto";
import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import { getPostApplicationIntegration } from "@server/repositories/post-application-integrations";
import {
  createImapClient,
  IMAP_MAX_MESSAGE_BYTES,
  ImapAuthenticationError,
  type ImapConnectionConfig,
  ImapConnectionError,
  type ImapFetchedMessage,
} from "@server/services/post-application/ingestion/imap-client";
import {
  PARSER_OPTIONS,
  parseStoredImapCredentials,
  selectUidsWithinBudget,
} from "@server/services/post-application/ingestion/imap-sync";
import { simpleParser } from "mailparser";
import {
  isLinkedInAlertSender,
  type LinkedInAlertJob,
  parseLinkedInAlertEmail,
} from "./alert-parser";

/** Fixed lookback, independent of the post-application sync window. */
export const LINKEDIN_ALERT_LOOKBACK_DAYS = 7;
const LINKEDIN_ALERT_SEARCH_FROM = "linkedin.com";
const LINKEDIN_ALERT_MAX_MESSAGES = 100;
const IMAP_ACCOUNT_KEY = "default";
const NOT_CONNECTED_ERROR = "LinkedIn alerts: no IMAP account connected";
const SCAN_FAILED_ERROR = "LinkedIn alerts: scan failed";

export type LinkedInAlertScanResult = {
  jobs: LinkedInAlertJob[];
  /** A `LinkedIn alerts: ...` source error, or null when the scan ran. */
  error: string | null;
};

type InboxScan = {
  candidateCount: number;
  selectedCount: number;
  skippedCount: number;
  messages: ImapFetchedMessage[];
};

async function fetchAlertMessages(
  config: ImapConnectionConfig,
): Promise<InboxScan> {
  const client = createImapClient(config);
  try {
    await client.connect();
    await client.openInboxReadOnly();
    const since = new Date(
      Date.now() - LINKEDIN_ALERT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );
    const uids = await client.searchUidsSinceFrom(
      since,
      LINKEDIN_ALERT_SEARCH_FROM,
    );
    const candidates = [...uids]
      .sort((a, b) => b - a)
      .slice(0, LINKEDIN_ALERT_MAX_MESSAGES);
    const sizes = await client.fetchMessageSizes(candidates);
    const { selected, skipped } = selectUidsWithinBudget(
      IMAP_ACCOUNT_KEY,
      candidates,
      sizes,
    );
    const messages = await client.fetchMessageSources(
      selected,
      IMAP_MAX_MESSAGE_BYTES,
    );
    return {
      candidateCount: candidates.length,
      selectedCount: selected.length,
      skippedCount: skipped.length,
      messages,
    };
  } finally {
    await client.close();
  }
}

/**
 * Reads LinkedIn job-alert emails from the last 7 days in the active tenant's
 * "default" IMAP account. Read-only, and deliberately independent of the
 * post-application sync: it never reads or writes `syncWatermark` or any
 * other integration state. Never throws; failures come back as `error`.
 */
export async function scanLinkedInAlertEmails(): Promise<LinkedInAlertScanResult> {
  let scan: InboxScan;
  try {
    const integration = await getPostApplicationIntegration(
      "imap",
      IMAP_ACCOUNT_KEY,
    );
    const stored = parseStoredImapCredentials(integration?.credentials ?? null);
    if (!stored) return { jobs: [], error: NOT_CONNECTED_ERROR };

    let password: string;
    try {
      password = await decryptSecret(stored.passwordEncrypted);
    } catch {
      return { jobs: [], error: NOT_CONNECTED_ERROR };
    }

    scan = await fetchAlertMessages({
      host: stored.host,
      port: stored.port,
      tls: stored.tls,
      username: stored.username,
      password,
    });
  } catch (error) {
    logger.warn("LinkedIn alerts inbox scan failed", {
      step: "discover-linkedin-alerts",
      error: sanitizeUnknown(error),
    });
    // IMAP errors carry fixed messages without server responses; anything
    // else stays in the server log only.
    const imapError =
      error instanceof ImapAuthenticationError ||
      error instanceof ImapConnectionError;
    return {
      jobs: [],
      error: imapError
        ? `LinkedIn alerts: ${error.message}`
        : SCAN_FAILED_ERROR,
    };
  }

  const jobs = new Map<string, LinkedInAlertJob>();
  let matchedSenderCount = 0;
  for (const message of scan.messages) {
    try {
      const parsed = await simpleParser(message.source, PARSER_OPTIONS);
      if (!isLinkedInAlertSender(parsed)) continue;
      matchedSenderCount += 1;
      for (const job of parseLinkedInAlertEmail(parsed)) {
        if (!jobs.has(job.jobUrl)) jobs.set(job.jobUrl, job);
      }
    } catch {
      logger.warn("LinkedIn alert email could not be parsed; skipping", {
        step: "discover-linkedin-alerts",
        uid: message.uid,
      });
    }
  }

  logger.info("LinkedIn alerts inbox scan", {
    step: "discover-linkedin-alerts",
    candidateCount: scan.candidateCount,
    selectedCount: scan.selectedCount,
    skippedCount: scan.skippedCount,
    matchedSenderCount,
    listingCount: jobs.size,
  });
  return { jobs: [...jobs.values()], error: null };
}
