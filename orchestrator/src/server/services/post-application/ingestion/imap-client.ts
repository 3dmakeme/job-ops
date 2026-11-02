import { logger } from "@infra/logger";
import { ImapFlow } from "imapflow";

export const IMAP_CONNECTION_TIMEOUT_MS = 15_000;

export type ImapConnectionConfig = {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
};

export type ImapFetchedMessage = {
  uid: number;
  source: Buffer;
};

export interface ImapClient {
  connect(): Promise<void>;
  openInboxReadOnly(): Promise<{ uidValidity: string }>;
  searchUidsSince(since: Date): Promise<number[]>;
  fetchMessageSources(uids: number[]): Promise<ImapFetchedMessage[]>;
  close(): Promise<void>;
}

/** Login was rejected by the server. Never carries the server response. */
export class ImapAuthenticationError extends Error {
  constructor() {
    super("IMAP login failed. Check the username and password.");
    this.name = "ImapAuthenticationError";
  }
}

/** DNS, TCP, TLS, timeout or protocol failure. Never carries the server response. */
export class ImapConnectionError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ImapConnectionError";
  }
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function toImapError(error: unknown, message: string): Error {
  if (
    error &&
    typeof error === "object" &&
    (error as { authenticationFailed?: unknown }).authenticationFailed === true
  ) {
    return new ImapAuthenticationError();
  }
  return new ImapConnectionError(message, errorCode(error));
}

export function createImapClient(config: ImapConnectionConfig): ImapClient {
  const target = `${config.host}:${config.port}`;
  // tls=false means STARTTLS is required, so the password never crosses the
  // wire unencrypted. Certificate validation stays at the Node default (on).
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.tls,
    ...(config.tls ? {} : { doSTARTTLS: true }),
    auth: { user: config.username, pass: config.password },
    connectionTimeout: IMAP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: IMAP_CONNECTION_TIMEOUT_MS,
    disableAutoIdle: true,
    logger: false,
  });
  client.on("error", (error) => {
    logger.warn("IMAP connection error", {
      host: config.host,
      port: config.port,
      code: errorCode(error),
    });
  });

  return {
    async connect() {
      try {
        await client.connect();
      } catch (error) {
        throw toImapError(
          error,
          `Could not reach the IMAP server at ${target}.`,
        );
      }
    },

    async openInboxReadOnly() {
      try {
        const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });
        return { uidValidity: String(mailbox.uidValidity) };
      } catch (error) {
        throw toImapError(error, "IMAP server could not open INBOX.");
      }
    },

    async searchUidsSince(since: Date) {
      try {
        const uids = await client.search({ since }, { uid: true });
        return uids || [];
      } catch (error) {
        throw toImapError(error, "IMAP server search failed.");
      }
    },

    async fetchMessageSources(uids: number[]) {
      if (uids.length === 0) return [];
      try {
        // `source` is fetched with BODY.PEEK[], so \Seen is never set.
        const messages = await client.fetchAll(
          uids,
          { uid: true, source: true },
          { uid: true },
        );
        return messages.flatMap((message) =>
          message.source ? [{ uid: message.uid, source: message.source }] : [],
        );
      } catch (error) {
        throw toImapError(error, "IMAP server fetch failed.");
      }
    },

    async close() {
      if (!client.usable) {
        client.close();
        return;
      }
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  };
}
