import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    connect: vi.fn(),
    openInboxReadOnly: vi.fn(),
    searchUidsSince: vi.fn(),
    searchUidsSinceFrom: vi.fn(),
    searchUidsAfter: vi.fn(),
    fetchMessageSizes: vi.fn(),
    fetchMessageSources: vi.fn(),
    close: vi.fn(),
    // Flag/move/delete methods must never be reached by a read-only scan.
    messageFlagsAdd: vi.fn(),
    messageFlagsSet: vi.fn(),
    messageFlagsRemove: vi.fn(),
    messageDelete: vi.fn(),
    messageMove: vi.fn(),
    expunge: vi.fn(),
  },
  createImapClient: vi.fn(),
  decryptSecret: vi.fn(),
  getPostApplicationIntegration: vi.fn(),
  updatePostApplicationIntegrationSyncState: vi.fn(),
  replaceCredentialsIfUnchanged: vi.fn(),
  upsertConnectedPostApplicationIntegration: vi.fn(),
  disconnectPostApplicationIntegration: vi.fn(),
  failToParse: new Set<string>(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock(
  "@server/services/post-application/ingestion/imap-client",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@server/services/post-application/ingestion/imap-client")
    >()),
    createImapClient: mocks.createImapClient,
  }),
);

vi.mock("@infra/credential-crypto", () => ({
  decryptSecret: mocks.decryptSecret,
  encryptSecret: vi.fn(),
}));

vi.mock("@infra/logger", () => ({
  logger: {
    info: mocks.info,
    warn: mocks.warn,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@server/repositories/post-application-integrations", () => ({
  getPostApplicationIntegration: mocks.getPostApplicationIntegration,
  updatePostApplicationIntegrationSyncState:
    mocks.updatePostApplicationIntegrationSyncState,
  replacePostApplicationIntegrationCredentialsIfUnchanged:
    mocks.replaceCredentialsIfUnchanged,
  upsertConnectedPostApplicationIntegration:
    mocks.upsertConnectedPostApplicationIntegration,
  disconnectPostApplicationIntegration:
    mocks.disconnectPostApplicationIntegration,
}));

vi.mock("mailparser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mailparser")>();
  return {
    ...actual,
    simpleParser: async (...args: Parameters<typeof actual.simpleParser>) => {
      const [source] = args;
      if (Buffer.isBuffer(source) && mocks.failToParse.has(source.toString()))
        throw new Error("malformed message");
      return actual.simpleParser(...args);
    },
  };
});

import {
  IMAP_MAX_MESSAGE_BYTES,
  IMAP_MAX_SYNC_BYTES,
  ImapConnectionError,
} from "@server/services/post-application/ingestion/imap-client";
import {
  LINKEDIN_ALERT_LOOKBACK_DAYS,
  scanLinkedInAlertEmails,
} from "./scanner";

const MiB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
);

function fixture(name: string): Buffer {
  return readFileSync(join(fixturesDir, name));
}

const FIXTURES_BY_UID: Record<number, Buffer> = {
  101: fixture("multipart-alert.eml"),
  102: fixture("html-only-alert.eml"),
  103: fixture("non-alert-sender.eml"),
  104: fixture("no-job-id-alert.eml"),
};

const storedCredentials = {
  host: "imap.example.com",
  port: 993,
  tls: true,
  username: "candidate@example.com",
  passwordEncrypted: "enc:v1:secret",
  syncWatermark: { uidValidity: "777", lastUid: 50 },
};

function integration(credentials: Record<string, unknown> | null) {
  return {
    id: "integration-1",
    provider: "imap",
    accountKey: "default",
    displayName: "candidate@example.com",
    status: "connected",
    credentials,
    lastConnectedAt: null,
    lastSyncedAt: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function expectNoIntegrationWrites() {
  expect(
    mocks.updatePostApplicationIntegrationSyncState,
  ).not.toHaveBeenCalled();
  expect(mocks.replaceCredentialsIfUnchanged).not.toHaveBeenCalled();
  expect(
    mocks.upsertConnectedPostApplicationIntegration,
  ).not.toHaveBeenCalled();
  expect(mocks.disconnectPostApplicationIntegration).not.toHaveBeenCalled();
}

function expectNoMailboxWrites() {
  for (const method of [
    "messageFlagsAdd",
    "messageFlagsSet",
    "messageFlagsRemove",
    "messageDelete",
    "messageMove",
    "expunge",
  ] as const) {
    expect(mocks.client[method]).not.toHaveBeenCalled();
  }
}

describe("scanLinkedInAlertEmails", () => {
  let credentials: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.failToParse.clear();
    credentials = structuredClone(storedCredentials);
    mocks.getPostApplicationIntegration.mockResolvedValue(
      integration(credentials),
    );
    mocks.decryptSecret.mockResolvedValue("imap-password");
    mocks.createImapClient.mockReturnValue(mocks.client);
    mocks.client.connect.mockResolvedValue(undefined);
    mocks.client.close.mockResolvedValue(undefined);
    mocks.client.openInboxReadOnly.mockResolvedValue({ uidValidity: "777" });
    mocks.client.searchUidsSinceFrom.mockResolvedValue([101, 102, 103, 104]);
    mocks.client.fetchMessageSizes.mockImplementation(async (uids: number[]) =>
      uids.map((uid) => ({ uid, size: 4096 })),
    );
    mocks.client.fetchMessageSources.mockImplementation(
      async (uids: number[]) =>
        uids.flatMap((uid) =>
          FIXTURES_BY_UID[uid] ? [{ uid, source: FIXTURES_BY_UID[uid] }] : [],
        ),
    );
  });

  it("reads the last 7 days of LinkedIn mail read-only and returns alert listings", async () => {
    const before = Date.now();
    const result = await scanLinkedInAlertEmails();
    const after = Date.now();

    expect(mocks.client.connect).toHaveBeenCalledTimes(1);
    expect(mocks.client.openInboxReadOnly).toHaveBeenCalledTimes(1);
    expect(mocks.client.searchUidsSince).not.toHaveBeenCalled();
    expect(mocks.client.searchUidsAfter).not.toHaveBeenCalled();
    const [since, from] = mocks.client.searchUidsSinceFrom.mock.calls[0];
    expect(from).toBe("linkedin.com");
    expect(LINKEDIN_ALERT_LOOKBACK_DAYS).toBe(7);
    expect((since as Date).getTime()).toBeGreaterThanOrEqual(
      before - 7 * DAY_MS,
    );
    expect((since as Date).getTime()).toBeLessThanOrEqual(after - 7 * DAY_MS);
    expect(mocks.client.fetchMessageSources).toHaveBeenCalledWith(
      [104, 103, 102, 101],
      IMAP_MAX_MESSAGE_BYTES,
    );
    expect(mocks.client.close).toHaveBeenCalledTimes(1);

    expect(result.error).toBeNull();
    // Fixture (d) has no derivable job id, so it gives no listing.
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([
      "https://www.linkedin.com/jobs/view/4087654321",
      "https://www.linkedin.com/jobs/view/4087654322",
      "https://www.linkedin.com/jobs/view/4012345678",
      "https://www.linkedin.com/jobs/view/4012345679",
      "https://www.linkedin.com/jobs/view/4012345680",
    ]);
    // Fixture (c) is LinkedIn mail from a non-allowlisted sender.
    expect(result.jobs.some((job) => job.jobUrl.includes("4099999999"))).toBe(
      false,
    );

    expect(mocks.info).toHaveBeenCalledWith("LinkedIn alerts inbox scan", {
      step: "discover-linkedin-alerts",
      candidateCount: 4,
      selectedCount: 4,
      skippedCount: 0,
      matchedSenderCount: 3,
      listingCount: 5,
    });
    expectNoIntegrationWrites();
    expectNoMailboxWrites();
    expect(credentials).toEqual(storedCredentials);
  });

  it("gives zero listings for fixture (c) alone", async () => {
    mocks.client.searchUidsSinceFrom.mockResolvedValue([103]);

    const result = await scanLinkedInAlertEmails();

    expect(result).toEqual({ jobs: [], error: null });
    expect(mocks.info).toHaveBeenCalledWith(
      "LinkedIn alerts inbox scan",
      expect.objectContaining({ matchedSenderCount: 0, listingCount: 0 }),
    );
  });

  it("collapses a job repeated across alert emails", async () => {
    mocks.client.searchUidsSinceFrom.mockResolvedValue([101, 201]);
    FIXTURES_BY_UID[201] = FIXTURES_BY_UID[101];
    try {
      const result = await scanLinkedInAlertEmails();
      expect(result.jobs).toHaveLength(3);
    } finally {
      delete FIXTURES_BY_UID[201];
    }
  });

  it("takes only the newest 100 UIDs", async () => {
    const uids = Array.from({ length: 150 }, (_, index) => index + 1);
    mocks.client.searchUidsSinceFrom.mockResolvedValue(uids);

    await scanLinkedInAlertEmails();

    const [candidates] = mocks.client.fetchMessageSizes.mock.calls[0];
    expect(candidates).toHaveLength(100);
    expect(candidates[0]).toBe(150);
    expect(candidates.at(-1)).toBe(51);
  });

  it("skips messages beyond the 32 MiB budget with a warning", async () => {
    const uids = Array.from({ length: 34 }, (_, index) => 200 - index);
    mocks.client.searchUidsSinceFrom.mockResolvedValue(uids);
    mocks.client.fetchMessageSizes.mockImplementation(async (ids: number[]) =>
      ids.map((uid) => ({ uid, size: 2 * MiB })),
    );

    const result = await scanLinkedInAlertEmails();

    const [selected, maxBytes] = mocks.client.fetchMessageSources.mock.calls[0];
    expect(maxBytes).toBe(IMAP_MAX_MESSAGE_BYTES);
    expect(selected).toEqual(uids.slice(0, 32));
    expect(mocks.warn).toHaveBeenCalledWith(
      "IMAP sync byte budget exceeded; skipping messages",
      expect.objectContaining({
        skippedCount: 2,
        skippedUids: [168, 167],
        budgetBytes: IMAP_MAX_SYNC_BYTES,
      }),
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      "IMAP message exceeds size limit; truncating",
      expect.objectContaining({ uid: 200, limitBytes: IMAP_MAX_MESSAGE_BYTES }),
    );
    expect(result.error).toBeNull();
    expect(mocks.info).toHaveBeenCalledWith(
      "LinkedIn alerts inbox scan",
      expect.objectContaining({
        candidateCount: 34,
        selectedCount: 32,
        skippedCount: 2,
      }),
    );
  });

  it("returns a source error and closes the client when the connection fails", async () => {
    mocks.client.connect.mockRejectedValue(
      new ImapConnectionError(
        "Could not reach the IMAP server at imap.example.com:993.",
        "ECONNREFUSED",
      ),
    );

    const result = await scanLinkedInAlertEmails();

    expect(result).toEqual({
      jobs: [],
      error:
        "LinkedIn alerts: Could not reach the IMAP server at imap.example.com:993.",
    });
    expect(mocks.client.close).toHaveBeenCalledTimes(1);
    expect(mocks.client.searchUidsSinceFrom).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      "LinkedIn alerts inbox scan failed",
      expect.objectContaining({ step: "discover-linkedin-alerts" }),
    );
    expectNoIntegrationWrites();
    expect(credentials).toEqual(storedCredentials);
  });

  it("returns a source error and closes the client when fetching fails", async () => {
    mocks.client.fetchMessageSources.mockRejectedValue(
      new ImapConnectionError("IMAP server fetch failed.", null),
    );

    const result = await scanLinkedInAlertEmails();

    expect(result).toEqual({
      jobs: [],
      error: "LinkedIn alerts: IMAP server fetch failed.",
    });
    expect(mocks.client.close).toHaveBeenCalledTimes(1);
  });

  it("reports a generic source error for a non-IMAP failure and logs it", async () => {
    mocks.getPostApplicationIntegration.mockRejectedValue(
      new Error("SQLITE_BUSY: database is locked at /data/jobs.db"),
    );

    const result = await scanLinkedInAlertEmails();

    expect(result).toEqual({
      jobs: [],
      error: "LinkedIn alerts: scan failed",
    });
    expect(mocks.createImapClient).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      "LinkedIn alerts inbox scan failed",
      {
        step: "discover-linkedin-alerts",
        error: expect.objectContaining({
          message: expect.stringContaining("SQLITE_BUSY"),
        }),
      },
    );
  });

  it("does not copy a non-IMAP error from the inbox read into source errors", async () => {
    mocks.client.fetchMessageSizes.mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'size')"),
    );

    const result = await scanLinkedInAlertEmails();

    expect(result.error).toBe("LinkedIn alerts: scan failed");
    expect(mocks.client.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "no integration",
      () => mocks.getPostApplicationIntegration.mockResolvedValue(null),
    ],
    [
      "incomplete credentials",
      () =>
        mocks.getPostApplicationIntegration.mockResolvedValue(
          integration({ host: "imap.example.com" }),
        ),
    ],
    [
      "an undecryptable password",
      () => mocks.decryptSecret.mockRejectedValue(new Error("bad key")),
    ],
  ])("reports no IMAP account connected for %s", async (_label, arrange) => {
    arrange();

    const result = await scanLinkedInAlertEmails();

    expect(result).toEqual({
      jobs: [],
      error: "LinkedIn alerts: no IMAP account connected",
    });
    expect(mocks.createImapClient).not.toHaveBeenCalled();
  });

  it("uses the default IMAP account", async () => {
    await scanLinkedInAlertEmails();

    expect(mocks.getPostApplicationIntegration).toHaveBeenCalledWith(
      "imap",
      "default",
    );
    expect(mocks.createImapClient).toHaveBeenCalledWith({
      host: "imap.example.com",
      port: 993,
      tls: true,
      username: "candidate@example.com",
      password: "imap-password",
    });
  });

  it("skips a message that fails to parse and logs only its UID", async () => {
    mocks.failToParse.add(FIXTURES_BY_UID[102].toString());

    const result = await scanLinkedInAlertEmails();

    expect(result.error).toBeNull();
    expect(result.jobs).toHaveLength(3);
    expect(mocks.warn).toHaveBeenCalledWith(
      "LinkedIn alert email could not be parsed; skipping",
      { step: "discover-linkedin-alerts", uid: 102 },
    );
  });
});
