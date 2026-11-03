import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  },
  createImapClient: vi.fn(),
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

vi.mock("@server/extractors/registry", () => ({
  getExtractorRegistry: vi.fn().mockResolvedValue({
    manifests: new Map(),
    manifestBySource: new Map(),
    availableSources: [],
  }),
}));

const pipelineConfig = {
  topN: 10,
  minSuitabilityScore: 50,
  sources: [],
  outputDir: "./tmp",
  enableCrawling: true,
  enableScoring: true,
  enableImporting: true,
  enableAutoTailoring: true,
};

describe.sequential("LinkedIn alerts tenant isolation", () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-linkedin-alerts-"));
    process.env = {
      ...originalEnv,
      DATA_DIR: tempDir,
      NODE_ENV: "test",
      JOBOPS_APP_MODE: "local",
    };
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;

    mocks.createImapClient.mockReset().mockReturnValue(mocks.client);
    for (const fn of Object.values(mocks.client)) fn.mockReset();
    mocks.client.connect.mockResolvedValue(undefined);
    mocks.client.close.mockResolvedValue(undefined);
    mocks.client.openInboxReadOnly.mockResolvedValue({ uidValidity: "777" });
    mocks.client.searchUidsSinceFrom.mockResolvedValue([]);
    mocks.client.fetchMessageSizes.mockResolvedValue([]);
    mocks.client.fetchMessageSources.mockResolvedValue([]);

    await import("@server/db/migrate");
  });

  afterEach(async () => {
    const { closeDb } = await import("@server/db");
    closeDb();
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it("scans only the active tenant's IMAP account", async () => {
    const { db, schema } = await import("@server/db");
    const { runWithRequestContext } = await import("@infra/request-context");
    const settingsRepo = await import("@server/repositories/settings");
    const { executePostApplicationProviderAction } = await import(
      "@server/services/post-application/providers/service"
    );
    const { discoverJobsStep } = await import(
      "@server/pipeline/steps/discover-jobs"
    );

    // Tenant A connects an IMAP account and turns the source on.
    await executePostApplicationProviderAction({
      provider: "imap",
      action: "connect",
      accountKey: "default",
      connectPayload: {
        payload: {
          host: "imap.tenant-a.example.com",
          username: "a@example.com",
          password: "tenant-a-password",
        },
      },
    });
    await settingsRepo.setSetting("linkedinAlertsEnabled", "1");

    // Tenant B turns the source on but has no IMAP account.
    await db.insert(schema.tenants).values({
      id: "tenant_b",
      name: "Tenant B",
      slug: "tenant-b",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const tenantB = { requestId: "tenant-b", tenantId: "tenant_b" };
    await runWithRequestContext(tenantB, () =>
      settingsRepo.setSetting("linkedinAlertsEnabled", "1"),
    );
    mocks.createImapClient.mockClear();

    const tenantBResult = await runWithRequestContext(tenantB, () =>
      discoverJobsStep({ mergedConfig: pipelineConfig }),
    );

    expect(tenantBResult.sourceErrors).toEqual([
      "LinkedIn alerts: no IMAP account connected",
    ]);
    expect(tenantBResult.discoveredJobs).toEqual([]);
    expect(mocks.createImapClient).not.toHaveBeenCalled();

    const tenantAResult = await discoverJobsStep({
      mergedConfig: pipelineConfig,
    });

    expect(tenantAResult.sourceErrors).toEqual([]);
    expect(mocks.createImapClient).toHaveBeenCalledTimes(1);
    expect(mocks.createImapClient).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "imap.tenant-a.example.com",
        username: "a@example.com",
        password: "tenant-a-password",
      }),
    );
  });
});
