import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    connect: vi.fn(),
    openInboxReadOnly: vi.fn(),
    searchUidsSince: vi.fn(),
    searchUidsAfter: vi.fn(),
    fetchMessageSizes: vi.fn(),
    fetchMessageSources: vi.fn(),
    close: vi.fn(),
    // Flag/move/delete methods must never be reached by a read-only sync.
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
  getPostApplicationMessageByExternalId: vi.fn(),
  upsertPostApplicationMessage: vi.fn(),
  startPostApplicationSyncRun: vi.fn(),
  completePostApplicationSyncRun: vi.fn(),
  classifyWithSmartRouter: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("./imap-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./imap-client")>()),
  createImapClient: mocks.createImapClient,
}));

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

vi.mock("@infra/product-analytics", () => ({
  trackServerProductEvent: vi.fn().mockResolvedValue(false),
}));

vi.mock("@server/repositories/post-application-integrations", () => ({
  getPostApplicationIntegration: mocks.getPostApplicationIntegration,
  updatePostApplicationIntegrationSyncState:
    mocks.updatePostApplicationIntegrationSyncState,
  replacePostApplicationIntegrationCredentialsIfUnchanged:
    mocks.replaceCredentialsIfUnchanged,
  upsertConnectedPostApplicationIntegration: vi.fn(),
}));

vi.mock("@server/repositories/post-application-messages", () => ({
  getPostApplicationMessageByExternalId:
    mocks.getPostApplicationMessageByExternalId,
  upsertPostApplicationMessage: mocks.upsertPostApplicationMessage,
}));

vi.mock("@server/repositories/post-application-sync-runs", () => ({
  startPostApplicationSyncRun: mocks.startPostApplicationSyncRun,
  completePostApplicationSyncRun: mocks.completePostApplicationSyncRun,
}));

vi.mock("@server/repositories/jobs", () => ({
  getAllJobs: vi.fn().mockResolvedValue([
    {
      id: "job-1",
      employer: "Example Co",
      title: "Software Engineer",
      status: "applied",
    },
  ]),
}));

vi.mock("@server/services/applicationTracking", () => ({
  transitionStage: vi.fn(),
}));

vi.mock("./email-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./email-router")>()),
  classifyWithSmartRouter: mocks.classifyWithSmartRouter,
}));

import { IMAP_MAX_MESSAGE_BYTES, IMAP_MAX_SYNC_BYTES } from "./imap-client";
import { runImapIngestionSync } from "./imap-sync";

const MiB = 1024 * 1024;
const TRUNCATION_WARNING = "IMAP message exceeds size limit; truncating";
const BUDGET_WARNING = "IMAP sync byte budget exceeded; skipping messages";
const RESET_WARNING = "IMAP UIDVALIDITY changed; discarding sync watermark";
const WATERMARK_LOG = "IMAP sync watermark";

function rawMessage(headers: Record<string, string>, body: string): Buffer {
  const headerText = Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\r\n");
  return Buffer.from(`${headerText}\r\n\r\n${body}`, "utf8");
}

const DATE_HEADER = "Mon, 02 Nov 2026 10:00:00 +0000";
const LONG_HTML_SENTENCE =
  "Thank you for applying to the Platform Engineer role at Example Co. ";

const textMessage = rawMessage(
  {
    From: '"Jane Recruiter" <Jane@Example.com>',
    To: "candidate@example.com",
    Subject: "Interview invitation",
    Date: DATE_HEADER,
    "Message-ID": "<abc123@mail.example.com>",
    References: "<root@mail.example.com> <parent@mail.example.com>",
    "In-Reply-To": "<parent@mail.example.com>",
    "Content-Type": "text/plain; charset=utf-8",
  },
  "We would like to schedule an interview next week.",
);

const htmlMessage = rawMessage(
  {
    From: "noreply@jobs.example.org",
    Subject: "Application received",
    Date: DATE_HEADER,
    "In-Reply-To": "<original@jobs.example.org>",
    "Content-Type": "text/html; charset=utf-8",
  },
  `<html><body><p>${LONG_HTML_SENTENCE.repeat(5)}</p><a href="https://example.com/track?token=abc">Track</a></body></html>`,
);

const unthreadedMessage = rawMessage(
  {
    From: "talent@example.net",
    Subject: "Newsletter",
    Date: DATE_HEADER,
    "Message-ID": "<news@example.net>",
  },
  "Plain newsletter body.",
);

function connectedIntegration() {
  return {
    id: "integration-imap-1",
    provider: "imap",
    accountKey: "default",
    displayName: "candidate@example.com",
    status: "connected",
    credentials: {
      host: "mail.example.com",
      port: 993,
      tls: true,
      username: "candidate@example.com",
      passwordEncrypted: "v1:iv:tag:ciphertext",
    },
    lastConnectedAt: null,
    lastSyncedAt: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function integrationWith(extraCredentials: Record<string, unknown>) {
  const integration = connectedIntegration();
  return {
    ...integration,
    credentials: { ...integration.credentials, ...extraCredentials },
  };
}

function messageFor(uid: number): Buffer {
  return rawMessage(
    {
      From: "talent@example.net",
      Subject: `Message ${uid}`,
      Date: DATE_HEADER,
      "Message-ID": `<msg-${uid}@example.net>`,
    },
    `Body of message ${uid}.`,
  );
}

function sourcesFor(uids: number[]) {
  return uids.map((uid) => ({ uid, source: messageFor(uid) }));
}

function credentialWrites() {
  return mocks.replaceCredentialsIfUnchanged.mock.calls.map(([input]) => input);
}

function storedWatermarks() {
  return credentialWrites().map((input) => input.credentials.syncWatermark);
}

function upsertCallFor(externalMessageId: string) {
  return mocks.upsertPostApplicationMessage.mock.calls
    .map(([input]) => input)
    .find((input) => input.externalMessageId === externalMessageId);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createImapClient.mockReturnValue(mocks.client);
  mocks.client.connect.mockResolvedValue(undefined);
  mocks.client.openInboxReadOnly.mockResolvedValue({ uidValidity: "777" });
  mocks.client.searchUidsSince.mockResolvedValue([10, 12, 11]);
  mocks.client.searchUidsAfter.mockResolvedValue([]);
  mocks.client.fetchMessageSizes.mockImplementation(async (uids: number[]) =>
    uids.map((uid) => ({ uid, size: 4096 })),
  );
  mocks.client.fetchMessageSources.mockResolvedValue([
    { uid: 12, source: textMessage },
    { uid: 11, source: htmlMessage },
    { uid: 10, source: unthreadedMessage },
  ]);
  mocks.client.close.mockResolvedValue(undefined);
  mocks.decryptSecret.mockResolvedValue("decrypted-password");
  mocks.getPostApplicationIntegration.mockResolvedValue(connectedIntegration());
  mocks.getPostApplicationMessageByExternalId.mockResolvedValue(null);
  mocks.startPostApplicationSyncRun.mockResolvedValue({
    id: "sync-run-1",
    startedAt: Date.now(),
  });
  mocks.completePostApplicationSyncRun.mockResolvedValue(null);
  mocks.updatePostApplicationIntegrationSyncState.mockResolvedValue(null);
  mocks.replaceCredentialsIfUnchanged.mockResolvedValue(true);
  mocks.classifyWithSmartRouter.mockResolvedValue({
    bestMatchId: null,
    confidence: 60,
    stageTarget: "no_change",
    messageType: "other",
    isRelevant: true,
    stageEventPayload: null,
    reason: "relevant",
  });
  mocks.upsertPostApplicationMessage.mockImplementation(async (input) => ({
    message: {
      id: `saved-${input.externalMessageId}`,
      matchedJobId: input.matchedJobId,
      processingStatus: input.processingStatus,
      stageTarget: input.stageTarget,
      receivedAt: input.receivedAt,
    },
    wasCreated: true,
    previousProcessingStatus: null,
    autoLinkTransitioned: false,
  }));
});

describe("imap ingestion sync", () => {
  it("connects with the decrypted password and reads INBOX read-only", async () => {
    const before = Date.now();
    await runImapIngestionSync({ accountKey: "default", maxMessages: 2 });

    expect(mocks.decryptSecret).toHaveBeenCalledWith("v1:iv:tag:ciphertext");
    expect(mocks.createImapClient).toHaveBeenCalledWith({
      host: "mail.example.com",
      port: 993,
      tls: true,
      username: "candidate@example.com",
      password: "decrypted-password",
    });
    expect(mocks.client.openInboxReadOnly).toHaveBeenCalledTimes(1);
    const since = mocks.client.searchUidsSince.mock.calls[0]?.[0] as Date;
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    expect(since.getTime()).toBeGreaterThanOrEqual(before - ninetyDaysMs);
    expect(since.getTime()).toBeLessThanOrEqual(Date.now() - ninetyDaysMs);
    expect(mocks.client.fetchMessageSizes).toHaveBeenCalledWith([12, 11]);
    expect(mocks.client.fetchMessageSources).toHaveBeenCalledWith(
      [12, 11],
      IMAP_MAX_MESSAGE_BYTES,
    );
  });

  it("maps messages and upserts them with provider imap", async () => {
    const summary = await runImapIngestionSync({ accountKey: "default" });

    expect(summary).toEqual({
      discovered: 3,
      relevant: 3,
      classified: 3,
      errored: 0,
    });

    const text = upsertCallFor("abc123@mail.example.com");
    expect(text).toMatchObject({
      provider: "imap",
      accountKey: "default",
      integrationId: "integration-imap-1",
      syncRunId: "sync-run-1",
      externalMessageId: "abc123@mail.example.com",
      externalThreadId: "root@mail.example.com",
      fromAddress: "jane@example.com",
      fromDomain: "example.com",
      senderName: "Jane Recruiter",
      subject: "Interview invitation",
      receivedAt: Date.parse(DATE_HEADER),
      snippet: "We would like to schedule an interview next week.",
    });

    const html = upsertCallFor("uid:777:11");
    expect(html).toMatchObject({
      provider: "imap",
      externalThreadId: "original@jobs.example.org",
      fromAddress: "noreply@jobs.example.org",
      fromDomain: "jobs.example.org",
      senderName: null,
      subject: "Application received",
      receivedAt: Date.parse(DATE_HEADER),
    });
    expect(html.snippet).toHaveLength(200);
    expect(html.snippet.startsWith("Thank you for applying")).toBe(true);
    expect(html.snippet).not.toMatch(/\s{2,}/);
    expect(html.snippet).not.toContain("<p>");

    const unthreaded = upsertCallFor("news@example.net");
    expect(unthreaded).toMatchObject({
      provider: "imap",
      externalThreadId: null,
      snippet: "Plain newsletter body.",
    });
  });

  it("routes each new message through the smart router", async () => {
    await runImapIngestionSync({ accountKey: "default" });

    expect(mocks.classifyWithSmartRouter).toHaveBeenCalledTimes(3);
    const emailTexts = mocks.classifyWithSmartRouter.mock.calls.map(
      ([input]) => input.emailText as string,
    );
    const textEmail = emailTexts.find((value) =>
      value.includes("Interview invitation"),
    );
    expect(textEmail).toContain("Subject: Interview invitation");
    expect(textEmail).toContain(
      "We would like to schedule an interview next week.",
    );
    expect(textEmail).toContain(`Date: ${DATE_HEADER}`);
    const htmlEmail = emailTexts.find((value) =>
      value.includes("Application received"),
    );
    expect(htmlEmail).toContain("Thank you for applying");
    expect(htmlEmail).not.toContain("token=abc");
  });

  it("does not re-classify a message that already exists", async () => {
    mocks.client.fetchMessageSources.mockResolvedValue([
      { uid: 12, source: textMessage },
    ]);
    mocks.getPostApplicationMessageByExternalId.mockResolvedValue({
      id: "post-msg-1",
      classificationLabel: "interview",
      classificationConfidence: 0.97,
      classificationPayload: { method: "smart_router" },
      relevanceLlmScore: 97,
      relevanceDecision: "relevant",
      matchedJobId: "job-1",
      matchConfidence: 97,
      stageTarget: "technical_interview",
      messageType: "interview",
      stageEventPayload: null,
      processingStatus: "auto_linked",
    });

    await runImapIngestionSync({ accountKey: "default" });

    expect(mocks.getPostApplicationMessageByExternalId).toHaveBeenCalledWith(
      "imap",
      "default",
      "abc123@mail.example.com",
    );
    expect(mocks.classifyWithSmartRouter).not.toHaveBeenCalled();
    expect(upsertCallFor("abc123@mail.example.com")).toMatchObject({
      provider: "imap",
      classificationLabel: "interview",
      matchedJobId: "job-1",
      processingStatus: "auto_linked",
    });
  });

  it("counts a message that fails to parse and still ingests the rest", async () => {
    mocks.client.fetchMessageSources.mockResolvedValue([
      { uid: 12, source: textMessage },
      { uid: 11, source: null as unknown as Buffer },
      { uid: 10, source: unthreadedMessage },
    ]);

    const summary = await runImapIngestionSync({ accountKey: "default" });

    expect(summary).toEqual({
      discovered: 3,
      relevant: 2,
      classified: 2,
      errored: 1,
    });
    expect(mocks.upsertPostApplicationMessage).toHaveBeenCalledTimes(2);
    expect(mocks.warn).toHaveBeenCalledWith(
      "Failed to ingest post-application message",
      expect.objectContaining({
        provider: "imap",
        accountKey: "default",
        syncRunId: "sync-run-1",
        externalMessageId: "uid:777:11",
        error: expect.any(String),
      }),
    );
    expect(mocks.completePostApplicationSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", messagesErrored: 1 }),
    );
  });

  it("closes the client after a successful sync", async () => {
    await runImapIngestionSync({ accountKey: "default" });

    expect(mocks.client.close).toHaveBeenCalledTimes(1);
  });

  it("closes the client and fails the run when the server errors", async () => {
    mocks.client.searchUidsSince.mockRejectedValueOnce(
      new Error("IMAP server search failed."),
    );

    await expect(
      runImapIngestionSync({ accountKey: "default" }),
    ).rejects.toThrow("IMAP server search failed.");

    expect(mocks.client.close).toHaveBeenCalledTimes(1);
    expect(mocks.completePostApplicationSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sync-run-1",
        status: "failed",
        errorCode: "IMAP_SYNC_FAILED",
      }),
    );
    expect(
      mocks.updatePostApplicationIntegrationSyncState,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "imap",
        accountKey: "default",
        status: "error",
      }),
    );
  });

  it.each([
    ["first", null],
    ["incremental", { uidValidity: "777", lastUid: 9 }],
    ["reset", { uidValidity: "555", lastUid: 9 }],
  ])("never calls a flag-setting, move, delete or expunge method (%s sync)", async (_mode, watermark) => {
    if (watermark) {
      mocks.getPostApplicationIntegration.mockResolvedValue(
        integrationWith({ syncWatermark: watermark }),
      );
    }
    mocks.client.searchUidsAfter.mockResolvedValue([10, 11, 12]);

    await runImapIngestionSync({ accountKey: "default" });

    expect(mocks.client.openInboxReadOnly).toHaveBeenCalledTimes(1);
    expect(mocks.client.fetchMessageSources).toHaveBeenCalledTimes(1);
    expect(mocks.client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(mocks.client.messageFlagsSet).not.toHaveBeenCalled();
    expect(mocks.client.messageFlagsRemove).not.toHaveBeenCalled();
    expect(mocks.client.messageDelete).not.toHaveBeenCalled();
    expect(mocks.client.messageMove).not.toHaveBeenCalled();
    expect(mocks.client.expunge).not.toHaveBeenCalled();
  });

  it("treats an undecryptable password as not connected", async () => {
    mocks.decryptSecret.mockRejectedValueOnce(new Error("bad tag"));

    await expect(
      runImapIngestionSync({ accountKey: "default" }),
    ).rejects.toThrow("IMAP account 'default' is not connected.");
    expect(mocks.createImapClient).not.toHaveBeenCalled();
    expect(mocks.startPostApplicationSyncRun).not.toHaveBeenCalled();
  });

  it("logs no size warnings when every message is small", async () => {
    await runImapIngestionSync({ accountKey: "default" });

    expect(mocks.client.fetchMessageSources).toHaveBeenCalledWith(
      [12, 11, 10],
      IMAP_MAX_MESSAGE_BYTES,
    );
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("truncates and still ingests a message over the per-message cap", async () => {
    mocks.client.fetchMessageSizes.mockResolvedValue([
      { uid: 12, size: 5 * MiB },
      { uid: 11, size: 4096 },
      { uid: 10, size: 4096 },
    ]);

    const summary = await runImapIngestionSync({ accountKey: "default" });

    expect(mocks.client.fetchMessageSources).toHaveBeenCalledWith(
      [12, 11, 10],
      IMAP_MAX_MESSAGE_BYTES,
    );
    expect(summary.discovered).toBe(3);
    expect(upsertCallFor("abc123@mail.example.com")).toMatchObject({
      provider: "imap",
      subject: "Interview invitation",
    });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith(
      TRUNCATION_WARNING,
      expect.objectContaining({
        provider: "imap",
        accountKey: "default",
        uid: 12,
        sizeBytes: 5 * MiB,
        limitBytes: IMAP_MAX_MESSAGE_BYTES,
      }),
    );
    const [, fields] = mocks.warn.mock.calls[0] ?? [];
    expect(Object.keys(fields).sort()).toEqual(
      ["accountKey", "limitBytes", "provider", "sizeBytes", "uid"].sort(),
    );
  });

  it("skips messages beyond the sync budget and fits smaller older ones", async () => {
    // UIDs 100..69 (32 messages) leave 320 bytes of the 32 MiB budget.
    const fullUids = Array.from({ length: 32 }, (_, index) => 100 - index);
    mocks.client.searchUidsSince.mockResolvedValue([66, 67, 68, ...fullUids]);
    mocks.client.fetchMessageSizes.mockResolvedValue([
      ...fullUids.map((uid) => ({ uid, size: MiB - 10 })),
      { uid: 68, size: MiB },
      { uid: 67, size: 100 },
      { uid: 66, size: null },
    ]);
    mocks.client.fetchMessageSources.mockResolvedValue([
      { uid: 100, source: textMessage },
      { uid: 67, source: unthreadedMessage },
    ]);

    const summary = await runImapIngestionSync({ accountKey: "default" });

    const [fetchedUids, limit] =
      mocks.client.fetchMessageSources.mock.calls[0] ?? [];
    expect(fetchedUids).toEqual([...fullUids, 67]);
    expect(fetchedUids).not.toContain(68);
    expect(fetchedUids).not.toContain(66);
    expect(limit).toBe(IMAP_MAX_MESSAGE_BYTES);
    expect(summary.discovered).toBe(2);
    expect(upsertCallFor("news@example.net")).toMatchObject({
      provider: "imap",
    });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith(
      BUDGET_WARNING,
      expect.objectContaining({
        provider: "imap",
        accountKey: "default",
        skippedCount: 2,
        skippedUids: [68, 66],
        budgetBytes: IMAP_MAX_SYNC_BYTES,
      }),
    );
    const [, fields] = mocks.warn.mock.calls[0] ?? [];
    expect(Object.keys(fields).sort()).toEqual(
      [
        "accountKey",
        "budgetBytes",
        "provider",
        "skippedCount",
        "skippedUids",
      ].sort(),
    );
  });

  it("charges a message with no reported size at the per-message cap", async () => {
    // 32 unknown-size messages use the whole budget, so even 1 byte is skipped.
    const unknownUids = Array.from({ length: 32 }, (_, index) => 33 - index);
    mocks.client.searchUidsSince.mockResolvedValue([1, ...unknownUids]);
    mocks.client.fetchMessageSizes.mockResolvedValue([
      ...unknownUids.map((uid) => ({ uid, size: null })),
      { uid: 1, size: 1 },
    ]);

    await runImapIngestionSync({ accountKey: "default" });

    expect(mocks.client.fetchMessageSources).toHaveBeenCalledWith(
      unknownUids,
      IMAP_MAX_MESSAGE_BYTES,
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      BUDGET_WARNING,
      expect.objectContaining({
        provider: "imap",
        accountKey: "default",
        skippedCount: 1,
        skippedUids: [1],
        budgetBytes: IMAP_MAX_SYNC_BYTES,
      }),
    );
    expect(mocks.warn).not.toHaveBeenCalledWith(
      TRUNCATION_WARNING,
      expect.anything(),
    );
  });

  it("treats a missing integration as not connected", async () => {
    mocks.getPostApplicationIntegration.mockResolvedValueOnce(null);

    await expect(runImapIngestionSync({ accountKey: "other" })).rejects.toThrow(
      "IMAP account 'other' is not connected.",
    );
  });

  describe("sync watermark", () => {
    it("first sync searches the 90-day window, takes the newest 100 and stores the max UID", async () => {
      const uids = Array.from({ length: 150 }, (_, index) => index + 1);
      mocks.client.searchUidsSince.mockResolvedValue(uids);
      mocks.client.fetchMessageSources.mockImplementation(
        async (selected: number[]) => sourcesFor(selected),
      );
      const before = Date.now();

      await runImapIngestionSync({ accountKey: "default" });

      const since = mocks.client.searchUidsSince.mock.calls[0]?.[0] as Date;
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
      expect(since.getTime()).toBeGreaterThanOrEqual(before - ninetyDaysMs);
      expect(since.getTime()).toBeLessThanOrEqual(Date.now() - ninetyDaysMs);
      expect(mocks.client.searchUidsAfter).not.toHaveBeenCalled();
      const newest = Array.from({ length: 100 }, (_, index) => 150 - index);
      expect(mocks.client.fetchMessageSizes).toHaveBeenCalledWith(newest);
      expect(storedWatermarks()).toEqual([
        { uidValidity: "777", lastUid: 150 },
      ]);
      expect(credentialWrites()[0]).toMatchObject({
        provider: "imap",
        accountKey: "default",
        expectedCredentials: connectedIntegration().credentials,
      });
      expect(
        mocks.updatePostApplicationIntegrationSyncState,
      ).not.toHaveBeenCalledWith(
        expect.objectContaining({ credentials: expect.anything() }),
      );
      expect(mocks.info).toHaveBeenCalledWith(WATERMARK_LOG, {
        provider: "imap",
        accountKey: "default",
        mode: "first",
        candidateCount: 100,
        previousLastUid: null,
        newLastUid: 150,
        watermarkWrite: "stored",
      });
    });

    it("first sync with no messages stores nothing", async () => {
      mocks.client.searchUidsSince.mockResolvedValue([]);
      mocks.client.fetchMessageSources.mockResolvedValue([]);

      await runImapIngestionSync({ accountKey: "default" });

      expect(credentialWrites()).toEqual([]);
      expect(mocks.info).toHaveBeenCalledWith(
        WATERMARK_LOG,
        expect.objectContaining({ mode: "first", newLastUid: null }),
      );
    });

    it("incremental sync fetches the oldest UIDs above the watermark and advances it", async () => {
      mocks.getPostApplicationIntegration.mockResolvedValue(
        integrationWith({ syncWatermark: { uidValidity: "777", lastUid: 20 } }),
      );
      mocks.client.searchUidsAfter.mockResolvedValue([25, 21, 23, 22, 24]);
      mocks.client.fetchMessageSources.mockImplementation(
        async (selected: number[]) => sourcesFor(selected),
      );

      const summary = await runImapIngestionSync({
        accountKey: "default",
        maxMessages: 3,
        searchDays: 7,
      });

      expect(mocks.client.searchUidsAfter).toHaveBeenCalledWith(20);
      expect(mocks.client.searchUidsSince).not.toHaveBeenCalled();
      expect(mocks.client.fetchMessageSizes).toHaveBeenCalledWith([21, 22, 23]);
      expect(mocks.client.fetchMessageSources).toHaveBeenCalledWith(
        [21, 22, 23],
        IMAP_MAX_MESSAGE_BYTES,
      );
      expect(summary.discovered).toBe(3);
      expect(storedWatermarks()).toEqual([{ uidValidity: "777", lastUid: 23 }]);
      expect(mocks.info).toHaveBeenCalledWith(WATERMARK_LOG, {
        provider: "imap",
        accountKey: "default",
        mode: "incremental",
        candidateCount: 3,
        previousLastUid: 20,
        newLastUid: 23,
        watermarkWrite: "stored",
      });
      expect(mocks.warn).not.toHaveBeenCalled();
    });

    it("discards the watermark and uses the full window when uidValidity changes", async () => {
      mocks.getPostApplicationIntegration.mockResolvedValue(
        integrationWith({
          syncWatermark: { uidValidity: "555", lastUid: 500 },
        }),
      );

      await runImapIngestionSync({ accountKey: "default" });

      expect(mocks.client.searchUidsAfter).not.toHaveBeenCalled();
      expect(mocks.client.searchUidsSince).toHaveBeenCalledTimes(1);
      expect(mocks.client.fetchMessageSizes).toHaveBeenCalledWith([12, 11, 10]);
      expect(mocks.warn).toHaveBeenCalledWith(RESET_WARNING, {
        provider: "imap",
        accountKey: "default",
        previousUidValidity: "555",
        uidValidity: "777",
      });
      expect(storedWatermarks()).toEqual([{ uidValidity: "777", lastUid: 12 }]);
      expect(mocks.info).toHaveBeenCalledWith(WATERMARK_LOG, {
        provider: "imap",
        accountKey: "default",
        mode: "reset",
        candidateCount: 3,
        previousLastUid: 500,
        newLastUid: 12,
        watermarkWrite: "stored",
      });
    });

    it("removes the old watermark when a reset finds no messages", async () => {
      mocks.getPostApplicationIntegration.mockResolvedValue(
        integrationWith({
          syncWatermark: { uidValidity: "555", lastUid: 500 },
        }),
      );
      mocks.client.searchUidsSince.mockResolvedValue([]);
      mocks.client.fetchMessageSources.mockResolvedValue([]);

      await runImapIngestionSync({ accountKey: "default" });

      const writes = credentialWrites();
      expect(writes).toHaveLength(1);
      expect(writes[0]?.credentials).toEqual(
        connectedIntegration().credentials,
      );
      expect(writes[0]?.credentials).not.toHaveProperty("syncWatermark");
    });

    it("holds the watermark below a UID skipped by the byte budget", async () => {
      mocks.getPostApplicationIntegration.mockResolvedValue(
        integrationWith({ syncWatermark: { uidValidity: "777", lastUid: 50 } }),
      );
      // UIDs 51..82 leave 320 bytes, so 83 (1 MiB) is skipped and 84 fits.
      const fullUids = Array.from({ length: 32 }, (_, index) => 51 + index);
      mocks.client.searchUidsAfter.mockResolvedValue([...fullUids, 83, 84]);
      mocks.client.fetchMessageSizes.mockResolvedValue([
        ...fullUids.map((uid) => ({ uid, size: MiB - 10 })),
        { uid: 83, size: MiB },
        { uid: 84, size: 100 },
      ]);
      mocks.client.fetchMessageSources.mockImplementation(
        async (selected: number[]) => sourcesFor(selected),
      );

      const summary = await runImapIngestionSync({ accountKey: "default" });

      expect(mocks.client.fetchMessageSources).toHaveBeenCalledWith(
        [...fullUids, 84],
        IMAP_MAX_MESSAGE_BYTES,
      );
      expect(summary).toMatchObject({ discovered: 33, errored: 0 });
      expect(mocks.warn).toHaveBeenCalledWith(
        BUDGET_WARNING,
        expect.objectContaining({ skippedUids: [83] }),
      );
      expect(storedWatermarks()).toEqual([{ uidValidity: "777", lastUid: 82 }]);
    });

    it("holds the watermark below a UID whose item errors", async () => {
      mocks.getPostApplicationIntegration.mockResolvedValue(
        integrationWith({ syncWatermark: { uidValidity: "777", lastUid: 5 } }),
      );
      mocks.client.searchUidsAfter.mockResolvedValue([10, 11, 12]);
      mocks.client.fetchMessageSources.mockResolvedValue([
        { uid: 12, source: textMessage },
        { uid: 11, source: null as unknown as Buffer },
        { uid: 10, source: unthreadedMessage },
      ]);

      const summary = await runImapIngestionSync({ accountKey: "default" });

      expect(summary).toMatchObject({ discovered: 3, errored: 1 });
      expect(storedWatermarks()).toEqual([{ uidValidity: "777", lastUid: 10 }]);
    });

    it("holds the watermark below a UID the server returned no source for", async () => {
      mocks.getPostApplicationIntegration.mockResolvedValue(
        integrationWith({ syncWatermark: { uidValidity: "777", lastUid: 5 } }),
      );
      mocks.client.searchUidsAfter.mockResolvedValue([10, 11, 12]);
      mocks.client.fetchMessageSources.mockResolvedValue([
        { uid: 12, source: textMessage },
        { uid: 10, source: unthreadedMessage },
      ]);

      const summary = await runImapIngestionSync({ accountKey: "default" });

      expect(mocks.client.fetchMessageSources).toHaveBeenCalledWith(
        [10, 11, 12],
        IMAP_MAX_MESSAGE_BYTES,
      );
      expect(summary).toMatchObject({ discovered: 2, errored: 0 });
      expect(storedWatermarks()).toEqual([{ uidValidity: "777", lastUid: 10 }]);
    });

    it("never moves the watermark backwards and skips an unchanged write", async () => {
      mocks.getPostApplicationIntegration.mockResolvedValue(
        integrationWith({ syncWatermark: { uidValidity: "777", lastUid: 9 } }),
      );
      mocks.client.searchUidsAfter.mockResolvedValue([10, 11, 12]);
      mocks.client.fetchMessageSources.mockResolvedValue([
        { uid: 12, source: textMessage },
        { uid: 11, source: htmlMessage },
      ]);

      await runImapIngestionSync({ accountKey: "default" });

      expect(credentialWrites()).toEqual([]);
      expect(mocks.info).toHaveBeenCalledWith(
        WATERMARK_LOG,
        expect.objectContaining({
          previousLastUid: 9,
          newLastUid: 9,
          watermarkWrite: "unchanged",
        }),
      );
    });

    it("leaves the watermark unchanged when nothing is above it", async () => {
      mocks.getPostApplicationIntegration.mockResolvedValue(
        integrationWith({ syncWatermark: { uidValidity: "777", lastUid: 40 } }),
      );
      mocks.client.searchUidsAfter.mockResolvedValue([]);
      mocks.client.fetchMessageSources.mockResolvedValue([]);

      const summary = await runImapIngestionSync({ accountKey: "default" });

      expect(mocks.client.searchUidsAfter).toHaveBeenCalledWith(40);
      expect(mocks.client.searchUidsSince).not.toHaveBeenCalled();
      expect(summary.discovered).toBe(0);
      expect(credentialWrites()).toEqual([]);
      expect(mocks.info).toHaveBeenCalledWith(WATERMARK_LOG, {
        provider: "imap",
        accountKey: "default",
        mode: "incremental",
        candidateCount: 0,
        previousLastUid: 40,
        newLastUid: 40,
        watermarkWrite: "unchanged",
      });
    });

    it.each([
      ["a non-object", "garbage"],
      ["an array", [1, 2]],
      ["a numeric uidValidity", { uidValidity: 777, lastUid: 5 }],
      ["a string lastUid", { uidValidity: "777", lastUid: "5" }],
      ["a negative lastUid", { uidValidity: "777", lastUid: -1 }],
      ["a fractional lastUid", { uidValidity: "777", lastUid: 1.5 }],
      ["a missing lastUid", { uidValidity: "777" }],
    ])("treats %s watermark as a first sync", async (_label, syncWatermark) => {
      mocks.getPostApplicationIntegration.mockResolvedValue(
        integrationWith({ syncWatermark }),
      );

      await runImapIngestionSync({ accountKey: "default" });

      expect(mocks.client.searchUidsSince).toHaveBeenCalledTimes(1);
      expect(mocks.client.searchUidsAfter).not.toHaveBeenCalled();
      expect(mocks.warn).not.toHaveBeenCalledWith(
        RESET_WARNING,
        expect.anything(),
      );
      expect(storedWatermarks()).toEqual([{ uidValidity: "777", lastUid: 12 }]);
      expect(mocks.info).toHaveBeenCalledWith(
        WATERMARK_LOG,
        expect.objectContaining({ mode: "first", previousLastUid: null }),
      );
    });

    it("keeps every other credential key when writing the watermark", async () => {
      const extra = {
        displayHint: "keep me",
        nested: { a: 1, b: [true, null] },
      };
      const integration = integrationWith({
        ...extra,
        syncWatermark: { uidValidity: "777", lastUid: 9 },
      });
      mocks.getPostApplicationIntegration.mockResolvedValue(integration);
      mocks.client.searchUidsAfter.mockResolvedValue([10, 11, 12]);

      await runImapIngestionSync({ accountKey: "default" });

      const writes = credentialWrites();
      expect(writes).toHaveLength(1);
      expect(writes[0]?.credentials).toEqual({
        ...integration.credentials,
        syncWatermark: { uidValidity: "777", lastUid: 12 },
      });
      expect(writes[0]?.credentials.passwordEncrypted).toBe(
        "v1:iv:tag:ciphertext",
      );
      expect(Object.keys(writes[0]?.credentials ?? {})).toEqual(
        Object.keys(integration.credentials),
      );
    });

    it("skips the write when the account was reconnected during the sync", async () => {
      const reconnected = integrationWith({ host: "imap.other.example" });
      mocks.getPostApplicationIntegration
        .mockResolvedValueOnce(connectedIntegration())
        .mockResolvedValueOnce(reconnected);

      await runImapIngestionSync({ accountKey: "default" });

      expect(mocks.getPostApplicationIntegration).toHaveBeenCalledTimes(2);
      expect(credentialWrites()).toEqual([]);
      expect(mocks.info).toHaveBeenCalledWith(
        WATERMARK_LOG,
        expect.objectContaining({
          newLastUid: null,
          watermarkWrite: "skipped",
        }),
      );
    });

    it("skips the write when the account was disconnected during the sync", async () => {
      mocks.getPostApplicationIntegration
        .mockResolvedValueOnce(connectedIntegration())
        .mockResolvedValueOnce({
          ...connectedIntegration(),
          status: "disconnected",
          credentials: null,
        });

      await runImapIngestionSync({ accountKey: "default" });

      expect(credentialWrites()).toEqual([]);
      expect(mocks.info).toHaveBeenCalledWith(
        WATERMARK_LOG,
        expect.objectContaining({
          newLastUid: null,
          watermarkWrite: "skipped",
        }),
      );
    });

    it("skips the write when the account was reconnected with a new password", async () => {
      mocks.getPostApplicationIntegration
        .mockResolvedValueOnce(connectedIntegration())
        .mockResolvedValueOnce(
          integrationWith({ passwordEncrypted: "v1:new:tag:ciphertext" }),
        );

      await runImapIngestionSync({ accountKey: "default" });

      expect(credentialWrites()).toEqual([]);
    });

    it("logs a skipped write without a new lastUid when the credentials changed before the write", async () => {
      mocks.replaceCredentialsIfUnchanged.mockResolvedValue(false);

      const summary = await runImapIngestionSync({ accountKey: "default" });

      expect(summary.discovered).toBe(3);
      expect(credentialWrites()).toHaveLength(1);
      expect(mocks.info).toHaveBeenCalledWith(WATERMARK_LOG, {
        provider: "imap",
        accountKey: "default",
        mode: "first",
        candidateCount: 3,
        previousLastUid: null,
        newLastUid: null,
        watermarkWrite: "skipped",
      });
      const [, fields] =
        mocks.info.mock.calls.find(([message]) => message === WATERMARK_LOG) ??
        [];
      expect(JSON.stringify(fields)).not.toContain("ciphertext");
    });

    it("fails the run when the watermark cannot be stored", async () => {
      mocks.replaceCredentialsIfUnchanged.mockRejectedValue(
        new Error("disk full"),
      );

      await expect(
        runImapIngestionSync({ accountKey: "default" }),
      ).rejects.toThrow("disk full");
      expect(mocks.completePostApplicationSyncRun).toHaveBeenCalledTimes(1);
      expect(mocks.completePostApplicationSyncRun).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          errorCode: "IMAP_SYNC_FAILED",
        }),
      );
    });
  });
});
