import { logger } from "@infra/logger";
import { ImapFlow } from "imapflow";

export const IMAP_CONNECTION_TIMEOUT_MS = 15_000;
/** Most bytes kept for any single message; larger ones are truncated. */
export const IMAP_MAX_MESSAGE_BYTES = 1 * 1024 * 1024;
/** Most message-source bytes held in memory for one sync run. */
export const IMAP_MAX_SYNC_BYTES = 32 * 1024 * 1024;

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

export type ImapMessageSize = {
  uid: number;
  size: number | null;
};

export interface ImapClient {
  connect(): Promise<void>;
  openInboxReadOnly(): Promise<{ uidValidity: string }>;
  searchUidsSince(since: Date): Promise<number[]>;
  fetchMessageSizes(uids: number[]): Promise<ImapMessageSize[]>;
  fetchMessageSources(
    uids: number[],
    maxBytes: number,
  ): Promise<ImapFetchedMessage[]>;
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

    async fetchMessageSizes(uids: number[]) {
      if (uids.length === 0) return [];
      try {
        const messages = await client.fetchAll(
          uids,
          { uid: true, size: true },
          { uid: true },
        );
        return messages.map((message) => ({
          uid: message.uid,
          size: typeof message.size === "number" ? message.size : null,
        }));
      } catch (error) {
        throw toImapError(error, "IMAP server fetch failed.");
      }
    },

    async fetchMessageSources(uids: number[], maxBytes: number) {
      if (uids.length === 0) return [];
      try {
        // `source` is fetched with BODY.PEEK[]<0.maxBytes>, so \Seen is never
        // set and the server sends at most maxBytes per message.
        const messages = await client.fetchAll(
          uids,
          { uid: true, source: { maxLength: maxBytes } },
          { uid: true },
        );
        return messages.flatMap((message) => {
          if (!message.source) return [];
          // Safeguard for servers that ignore the partial range: copy the
          // prefix so the over-long buffer can be released.
          const source =
            message.source.length > maxBytes
              ? Buffer.from(message.source.subarray(0, maxBytes))
              : message.source;
          return [{ uid: message.uid, source }];
        });
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
