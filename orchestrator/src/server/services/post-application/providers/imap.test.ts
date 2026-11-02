import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_PASSWORD = "s3cret-Imap-Passw0rd!";

const mocks = vi.hoisted(() => ({
  client: {
    connect: vi.fn(),
    openInboxReadOnly: vi.fn(),
    searchUidsSince: vi.fn(),
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

describe.sequential("imap post-application provider", () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let executePostApplicationProviderAction: typeof import("./service").executePostApplicationProviderAction;
  let imapClientModule: typeof import("@server/services/post-application/ingestion/imap-client");
  let runWithRequestContext: typeof import("@infra/request-context").runWithRequestContext;
  let db: typeof import("@server/db").db;
  let schema: typeof import("@server/db").schema;

  const validPayload = {
    host: "mail.example.com",
    username: "candidate@example.com",
    password: TEST_PASSWORD,
  };

  const connect = (payload: Record<string, unknown>, accountKey = "default") =>
    executePostApplicationProviderAction({
      provider: "imap",
      action: "connect",
      accountKey,
      connectPayload: { payload },
    });

  async function readStoredCredentials(): Promise<unknown> {
    const rows = await db.select().from(schema.postApplicationIntegrations);
    const row = rows.find((candidate) => candidate.provider === "imap");
    return row?.credentials ?? null;
  }

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-imap-provider-"));
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

    await import("@server/db/migrate");
    ({ db, schema } = await import("@server/db"));
    ({ executePostApplicationProviderAction } = await import("./service"));
    imapClientModule = await import(
      "@server/services/post-application/ingestion/imap-client"
    );
    ({ runWithRequestContext } = await import("@infra/request-context"));
  });

  afterEach(async () => {
    const { closeDb } = await import("@server/db");
    closeDb();
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it.each([
    ["missing host", { ...validPayload, host: undefined }],
    ["host with scheme", { ...validPayload, host: "imaps://mail.example.com" }],
    ["host with path", { ...validPayload, host: "mail.example.com/inbox" }],
    ["host with whitespace", { ...validPayload, host: "mail example.com" }],
    ["host too long", { ...validPayload, host: `${"a".repeat(254)}` }],
    ["port zero", { ...validPayload, port: 0 }],
    ["port too large", { ...validPayload, port: 65536 }],
    ["port not integer", { ...validPayload, port: 993.5 }],
    ["port as string", { ...validPayload, port: "993" }],
    ["tls not boolean", { ...validPayload, tls: "yes" }],
    ["empty username", { ...validPayload, username: " " }],
    ["empty password", { ...validPayload, password: "" }],
  ])("rejects connect with %s as 400", async (_label, payload) => {
    await expect(connect(payload)).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
    });
    expect(mocks.createImapClient).not.toHaveBeenCalled();
    expect(await readStoredCredentials()).toBeNull();
  });

  it("verifies login and stores only the encrypted password", async () => {
    const response = await connect(validPayload);

    expect(mocks.createImapClient).toHaveBeenCalledWith({
      host: "mail.example.com",
      port: 993,
      tls: true,
      username: "candidate@example.com",
      password: TEST_PASSWORD,
    });
    expect(mocks.client.connect).toHaveBeenCalledTimes(1);
    expect(mocks.client.close).toHaveBeenCalledTimes(1);
    expect(response.status.connected).toBe(true);
    expect(response.message).toBe("IMAP integration connected.");
    expect(response.status.integration?.displayName).toBe(
      "candidate@example.com",
    );

    const credentials = await readStoredCredentials();
    const serialized = JSON.stringify(credentials);
    expect(serialized).not.toContain(TEST_PASSWORD);
    expect(serialized).toContain("passwordEncrypted");
    expect(credentials).toMatchObject({
      host: "mail.example.com",
      port: 993,
      tls: true,
      username: "candidate@example.com",
    });
    expect(JSON.stringify(response)).not.toContain(TEST_PASSWORD);
    expect(JSON.stringify(response)).not.toContain("passwordEncrypted");
  });

  it("passes explicit port and STARTTLS settings to the client", async () => {
    await connect({ ...validPayload, port: 143, tls: false });

    expect(mocks.createImapClient).toHaveBeenCalledWith(
      expect.objectContaining({ port: 143, tls: false }),
    );
  });

  it("maps an authentication failure to 400 without the password", async () => {
    mocks.client.connect.mockRejectedValueOnce(
      new imapClientModule.ImapAuthenticationError(),
    );

    const error = await connect(validPayload).catch((caught) => caught);

    expect(error).toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
      message: "IMAP login failed. Check the username and password.",
    });
    expect(JSON.stringify(error)).not.toContain(TEST_PASSWORD);
    expect(String(error.message)).not.toContain(TEST_PASSWORD);
    expect(mocks.client.close).toHaveBeenCalledTimes(1);
    expect(await readStoredCredentials()).toBeNull();
  });

  it("maps an unreachable host to 502 without the password", async () => {
    mocks.client.connect.mockRejectedValueOnce(
      new imapClientModule.ImapConnectionError(
        "Could not reach the IMAP server at mail.example.com:993.",
        "ENOTFOUND",
      ),
    );

    const error = await connect(validPayload).catch((caught) => caught);

    expect(error).toMatchObject({
      status: 502,
      code: "UPSTREAM_ERROR",
    });
    expect(String(error.message)).toContain("Could not reach the IMAP server");
    expect(String(error.message)).not.toContain(TEST_PASSWORD);
    expect(JSON.stringify(error)).not.toContain(TEST_PASSWORD);
    expect(mocks.client.close).toHaveBeenCalledTimes(1);
  });

  it("returns status with hasPassword and no secret fields", async () => {
    await connect(validPayload);

    const response = await executePostApplicationProviderAction({
      provider: "imap",
      action: "status",
      accountKey: "default",
    });

    expect(mocks.createImapClient).toHaveBeenCalledTimes(1);
    expect(response.status.connected).toBe(true);
    const credentials = response.status.integration?.credentials ?? {};
    expect(Object.keys(credentials).sort()).toEqual(
      ["host", "port", "tls", "username", "hasPassword"].sort(),
    );
    expect(credentials).toEqual({
      host: "mail.example.com",
      port: 993,
      tls: true,
      username: "candidate@example.com",
      hasPassword: true,
    });
    expect(JSON.stringify(response)).not.toContain(TEST_PASSWORD);
  });

  it("reports not connected when nothing is stored", async () => {
    const response = await executePostApplicationProviderAction({
      provider: "imap",
      action: "status",
      accountKey: "default",
    });

    expect(response.status.connected).toBe(false);
    expect(response.status.integration).toBeNull();
    expect(response.message).toBe("IMAP provider is not connected.");
  });

  it("disconnect nulls the stored credentials without a network call", async () => {
    await connect(validPayload);
    mocks.createImapClient.mockClear();

    const response = await executePostApplicationProviderAction({
      provider: "imap",
      action: "disconnect",
      accountKey: "default",
    });

    expect(mocks.createImapClient).not.toHaveBeenCalled();
    expect(response.message).toBe("IMAP integration disconnected.");
    expect(response.status.connected).toBe(false);
    expect(response.status.integration?.credentials).toMatchObject({
      hasPassword: false,
    });
    expect(await readStoredCredentials()).toBeNull();
  });

  it("does not expose an integration to another tenant", async () => {
    await connect(validPayload);
    mocks.createImapClient.mockClear();

    const otherTenant = { requestId: "tenant-b", tenantId: "tenant_b" };
    const status = await runWithRequestContext(otherTenant, () =>
      executePostApplicationProviderAction({
        provider: "imap",
        action: "status",
        accountKey: "default",
      }),
    );
    expect(status.status.connected).toBe(false);
    expect(status.status.integration).toBeNull();

    await expect(
      runWithRequestContext(otherTenant, () =>
        executePostApplicationProviderAction({
          provider: "imap",
          action: "sync",
          accountKey: "default",
        }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
      message: "IMAP account 'default' is not connected.",
    });
    expect(mocks.createImapClient).not.toHaveBeenCalled();

    const ownStatus = await executePostApplicationProviderAction({
      provider: "imap",
      action: "status",
      accountKey: "default",
    });
    expect(ownStatus.status.connected).toBe(true);
  });

  it("maps a sync login failure to 400 and marks the integration as error", async () => {
    await connect(validPayload);
    mocks.client.connect.mockRejectedValueOnce(
      new imapClientModule.ImapAuthenticationError(),
    );

    await expect(
      executePostApplicationProviderAction({
        provider: "imap",
        action: "sync",
        accountKey: "default",
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });

    const rows = await db.select().from(schema.postApplicationSyncRuns);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "failed",
      errorCode: "IMAP_SYNC_FAILED",
    });
    const [integration] = await db
      .select()
      .from(schema.postApplicationIntegrations);
    expect(integration?.status).toBe("error");
  });
});
