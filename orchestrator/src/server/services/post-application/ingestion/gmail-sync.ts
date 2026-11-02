import {
  getPostApplicationIntegration,
  upsertConnectedPostApplicationIntegration,
} from "@server/repositories/post-application-integrations";
import {
  buildEmailText,
  extractBodyText,
  getMessageFull,
  getMessageMetadata,
  listMessageIds,
  resolveGmailAccessToken,
} from "./gmail-api";
import {
  decodeStoredGmailCredentials,
  encodeStoredGmailCredentials,
} from "./gmail-credentials";
import {
  type IngestionSyncSummary,
  runPostApplicationIngestion,
} from "./message-ingest";

const DEFAULT_SEARCH_DAYS = 90;
const DEFAULT_MAX_MESSAGES = 100;

export type GmailSyncSummary = IngestionSyncSummary;

export const __test__ = {
  extractBodyText,
  buildEmailText,
};

function headerValue(
  headers: Array<{ name?: string; value?: string }>,
  name: string,
): string {
  const found = headers.find(
    (header) => (header.name ?? "").toLowerCase() === name.toLowerCase(),
  );
  return String(found?.value ?? "");
}

export async function runGmailIngestionSync(args: {
  accountKey: string;
  maxMessages?: number;
  searchDays?: number;
}): Promise<GmailSyncSummary> {
  const integration = await getPostApplicationIntegration(
    "gmail",
    args.accountKey,
  );
  const parsedCredentials = await decodeStoredGmailCredentials(
    integration?.credentials ?? null,
  );
  if (!integration || !parsedCredentials) {
    throw new Error(`Gmail account '${args.accountKey}' is not connected.`);
  }

  const searchDays = Math.max(1, args.searchDays ?? DEFAULT_SEARCH_DAYS);
  const maxMessages = Math.max(1, args.maxMessages ?? DEFAULT_MAX_MESSAGES);

  return runPostApplicationIngestion({
    provider: "gmail",
    accountKey: args.accountKey,
    integrationId: integration.id,
    failureErrorCode: "GMAIL_SYNC_FAILED",
    listItems: async () => {
      const resolvedCredentials =
        await resolveGmailAccessToken(parsedCredentials);
      if (!resolvedCredentials.accessToken) {
        throw new Error("Gmail sync failed to resolve access token.");
      }
      const accessToken = resolvedCredentials.accessToken;

      if (
        resolvedCredentials.accessToken !== parsedCredentials.accessToken ||
        resolvedCredentials.expiryDate !== parsedCredentials.expiryDate
      ) {
        await upsertConnectedPostApplicationIntegration({
          provider: "gmail",
          accountKey: args.accountKey,
          displayName: integration.displayName,
          credentials: await encodeStoredGmailCredentials(resolvedCredentials),
        });
      }

      const messageIds = await listMessageIds(
        accessToken,
        searchDays,
        maxMessages,
      );

      return messageIds.map((message) => ({
        externalMessageId: message.id,
        load: async () => {
          const metadata = await getMessageMetadata(accessToken, message.id);
          return {
            externalMessageId: metadata.id,
            externalThreadId: metadata.threadId,
            from: headerValue(metadata.headers, "From"),
            subject: headerValue(metadata.headers, "Subject"),
            date: headerValue(metadata.headers, "Date"),
            snippet: metadata.snippet,
            loadBody: async () => {
              const fullMessage = await getMessageFull(accessToken, message.id);
              return extractBodyText(fullMessage.payload);
            },
          };
        },
      }));
    },
  });
}
