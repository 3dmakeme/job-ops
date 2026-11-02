import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    connect: vi.fn(),
    openInboxReadOnly: vi.fn(),
    searchUidsSince: vi.fn(),
    fetchMessageSources: vi.fn(),
    close: vi.fn(),
    // Flag/move/delete methods must never be reached by a read-only sync.
    messageFlagsAdd: vi.fn(),
    messageFlagsSet: vi.fn(),
    messageFlagsRemove: vi.fn(),
    messageDelete: vi.fn(),
    messageMove: vi.fn(),
  },
  createImapClient: vi.fn(),
  decryptSecret: vi.fn(),
  getPostApplicationIntegration: vi.fn(),
  updatePostApplicationIntegrationSyncState: vi.fn(),
  getPostApplicationMessageByExternalId: vi.fn(),
  upsertPostApplicationMessage: vi.fn(),
  startPostApplicationSyncRun: vi.fn(),
  completePostApplicationSyncRun: vi.fn(),
  classifyWithSmartRouter: vi.fn(),
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
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@infra/product-analytics", () => ({
  trackServerProductEvent: vi.fn().mockResolvedValue(false),
}));

vi.mock("@server/repositories/post-application-integrations", () => ({
  getPostApplicationIntegration: mocks.getPostApplicationIntegration,
  updatePostApplicationIntegrationSyncState:
    mocks.updatePostApplicationIntegrationSyncState,
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

import { runImapIngestionSync } from "./imap-sync";

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
    expect(mocks.client.fetchMessageSources).toHaveBeenCalledWith([12, 11]);
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

  it("never calls a flag-setting, move or delete method", async () => {
    await runImapIngestionSync({ accountKey: "default" });

    expect(mocks.client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(mocks.client.messageFlagsSet).not.toHaveBeenCalled();
    expect(mocks.client.messageFlagsRemove).not.toHaveBeenCalled();
    expect(mocks.client.messageDelete).not.toHaveBeenCalled();
    expect(mocks.client.messageMove).not.toHaveBeenCalled();
  });

  it("treats an undecryptable password as not connected", async () => {
    mocks.decryptSecret.mockRejectedValueOnce(new Error("bad tag"));

    await expect(
      runImapIngestionSync({ accountKey: "default" }),
    ).rejects.toThrow("IMAP account 'default' is not connected.");
    expect(mocks.createImapClient).not.toHaveBeenCalled();
    expect(mocks.startPostApplicationSyncRun).not.toHaveBeenCalled();
  });

  it("treats a missing integration as not connected", async () => {
    mocks.getPostApplicationIntegration.mockResolvedValueOnce(null);

    await expect(runImapIngestionSync({ accountKey: "other" })).rejects.toThrow(
      "IMAP account 'other' is not connected.",
    );
  });
});
