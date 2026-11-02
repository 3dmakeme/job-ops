import type { PostApplicationIntegration } from "@shared/types";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@server/repositories/post-application-integrations", () => ({
  getPostApplicationIntegration: vi.fn().mockResolvedValue(null),
  upsertConnectedPostApplicationIntegration: vi.fn().mockImplementation(
    async ({
      provider,
      accountKey,
      displayName,
      credentials,
    }: {
      provider: "gmail";
      accountKey: string;
      displayName: string;
      credentials: Record<string, unknown>;
    }) =>
      ({
        id: "integration-test",
        provider,
        accountKey,
        displayName,
        status: "connected",
        credentials,
        lastConnectedAt: Date.now(),
        lastSyncedAt: null,
        lastError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) satisfies PostApplicationIntegration,
  ),
  disconnectPostApplicationIntegration: vi.fn().mockImplementation(
    async (provider: "gmail", accountKey: string) =>
      ({
        id: "integration-test",
        provider,
        accountKey,
        displayName: "Gmail (default)",
        status: "disconnected",
        credentials: null,
        lastConnectedAt: Date.now(),
        lastSyncedAt: null,
        lastError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) satisfies PostApplicationIntegration,
  ),
}));

const integrationRepo = await import(
  "@server/repositories/post-application-integrations"
);

import {
  PostApplicationProviderError,
  providerUpstreamError,
  toProviderAppError,
} from "./errors";
import {
  listPostApplicationProviders,
  resolvePostApplicationProvider,
} from "./registry";
import { executePostApplicationProviderAction } from "./service";

const { encryptSecret } = await import("@infra/credential-crypto");

function gmailIntegration(
  credentials: Record<string, unknown>,
): PostApplicationIntegration {
  return {
    id: "integration-test",
    provider: "gmail",
    accountKey: "account:gmail:test",
    displayName: "Gmail (default)",
    status: "connected",
    credentials,
    lastConnectedAt: Date.now(),
    lastSyncedAt: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(
    "CREDENTIALS_ENCRYPTION_KEY",
    "test-credentials-encryption-key-0123456789",
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("post-application provider registry", () => {
  it("lists registered providers", () => {
    expect(listPostApplicationProviders()).toEqual(["gmail", "imap"]);
  });

  it("resolves a known provider", () => {
    const provider = resolvePostApplicationProvider("gmail");
    expect(provider.key).toBe("gmail");
  });

  it("throws explicit invalid-request error for unknown provider", () => {
    expect(() => resolvePostApplicationProvider("exchange")).toThrowError(
      PostApplicationProviderError,
    );

    try {
      resolvePostApplicationProvider("exchange");
      throw new Error("expected resolve to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PostApplicationProviderError);
      expect((error as PostApplicationProviderError).kind).toBe(
        "invalid_request",
      );
    }
  });
});

describe("post-application provider action dispatcher", () => {
  it("connects gmail and persists credentials in the integrations store", async () => {
    const response = await executePostApplicationProviderAction({
      provider: "gmail",
      action: "connect",
      accountKey: "account:gmail:test",
      connectPayload: {
        payload: {
          refreshToken: "refresh-token",
          accessToken: "access-token",
          email: "candidate@example.com",
          scope: "https://www.googleapis.com/auth/gmail.readonly",
        },
      },
    });

    expect(
      integrationRepo.upsertConnectedPostApplicationIntegration,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "gmail",
        accountKey: "account:gmail:test",
      }),
    );
    const [{ credentials: storedCredentials }] = vi.mocked(
      integrationRepo.upsertConnectedPostApplicationIntegration,
    ).mock.calls[0];
    expect(String(storedCredentials.refreshTokenEncrypted)).toMatch(/^v1:/);
    expect(String(storedCredentials.accessTokenEncrypted)).toMatch(/^v1:/);
    expect(storedCredentials).not.toHaveProperty("refreshToken");
    expect(storedCredentials).not.toHaveProperty("accessToken");
    expect(Object.values(storedCredentials)).not.toContain("refresh-token");
    expect(Object.values(storedCredentials)).not.toContain("access-token");
    expect(response.status.connected).toBe(true);
    expect(response.message).toBe("Gmail integration connected.");
    expect(JSON.stringify(response)).not.toContain(
      String(storedCredentials.refreshTokenEncrypted),
    );
    expect(response.status.integration?.credentials).toEqual(
      expect.objectContaining({
        hasRefreshToken: true,
        hasAccessToken: true,
        email: "candidate@example.com",
      }),
    );
  });

  it("dispatches status action to gmail provider", async () => {
    const response = await executePostApplicationProviderAction({
      provider: "gmail",
      action: "status",
      accountKey: "account:gmail:test",
    });

    expect(response).toEqual({
      provider: "gmail",
      action: "status",
      accountKey: "account:gmail:test",
      status: {
        provider: "gmail",
        accountKey: "account:gmail:test",
        connected: false,
        integration: null,
      },
      message: "Gmail provider is not connected.",
    });
  });

  it("reports a legacy plaintext gmail row as connected", async () => {
    const getIntegrationMock =
      integrationRepo.getPostApplicationIntegration as Mock;
    getIntegrationMock.mockResolvedValueOnce(
      gmailIntegration({ refreshToken: "refresh-token" }),
    );

    const response = await executePostApplicationProviderAction({
      provider: "gmail",
      action: "status",
      accountKey: "account:gmail:test",
    });

    expect(response.status.connected).toBe(true);
    expect(response.status.integration?.credentials).toEqual(
      expect.objectContaining({
        hasRefreshToken: true,
        hasAccessToken: false,
      }),
    );
    expect(JSON.stringify(response)).not.toContain("refresh-token");
  });

  it("reports an encrypted gmail row as connected without exposing tokens", async () => {
    const refreshTokenEncrypted = await encryptSecret("refresh-token");
    const accessTokenEncrypted = await encryptSecret("access-token");
    const getIntegrationMock =
      integrationRepo.getPostApplicationIntegration as Mock;
    getIntegrationMock.mockResolvedValueOnce(
      gmailIntegration({ refreshTokenEncrypted, accessTokenEncrypted }),
    );

    const response = await executePostApplicationProviderAction({
      provider: "gmail",
      action: "status",
      accountKey: "account:gmail:test",
    });

    expect(response.status.connected).toBe(true);
    expect(response.status.integration?.credentials).toEqual(
      expect.objectContaining({
        hasRefreshToken: true,
        hasAccessToken: true,
      }),
    );
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(refreshTokenEncrypted);
    expect(serialized).not.toContain(accessTokenEncrypted);
    expect(serialized).not.toContain("refresh-token");
  });

  it("disconnects gmail and clears credentials from integration store", async () => {
    const getIntegrationMock =
      integrationRepo.getPostApplicationIntegration as Mock;
    getIntegrationMock.mockResolvedValueOnce(
      gmailIntegration({
        refreshTokenEncrypted: await encryptSecret("refresh-token"),
      }),
    );

    const response = await executePostApplicationProviderAction({
      provider: "gmail",
      action: "disconnect",
      accountKey: "account:gmail:test",
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, revokeInit] = vi.mocked(global.fetch).mock.calls[0];
    expect(String(revokeInit?.body)).toBe("token=refresh-token");
    expect(
      integrationRepo.disconnectPostApplicationIntegration,
    ).toHaveBeenCalledWith("gmail", "account:gmail:test");
    expect(response.status.connected).toBe(false);
    expect(response.message).toBe("Gmail integration disconnected.");
    expect(response.status.integration?.credentials).toEqual(
      expect.objectContaining({
        hasRefreshToken: false,
        hasAccessToken: false,
      }),
    );
  });

  it("disconnects locally without revoking when the refresh token cannot be decrypted", async () => {
    const getIntegrationMock =
      integrationRepo.getPostApplicationIntegration as Mock;
    getIntegrationMock.mockResolvedValueOnce(
      gmailIntegration({ refreshTokenEncrypted: "v1:not:valid:ciphertext" }),
    );

    const response = await executePostApplicationProviderAction({
      provider: "gmail",
      action: "disconnect",
      accountKey: "account:gmail:test",
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(
      integrationRepo.disconnectPostApplicationIntegration,
    ).toHaveBeenCalledWith("gmail", "account:gmail:test");
    expect(response.status.connected).toBe(false);
  });

  it("returns invalid request when gmail connect payload is missing refresh token", async () => {
    await expect(
      executePostApplicationProviderAction({
        provider: "gmail",
        action: "connect",
        accountKey: "account:gmail:test",
        connectPayload: { payload: {} },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
    });
  });

  it("returns invalid request when imap connect payload is missing", async () => {
    await expect(
      executePostApplicationProviderAction({
        provider: "imap",
        action: "connect",
        accountKey: "account:imap:test",
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
      message: "IMAP connect requires connection settings in body.payload.",
    });
  });

  it("dispatches status action to imap provider", async () => {
    const response = await executePostApplicationProviderAction({
      provider: "imap",
      action: "status",
      accountKey: "account:imap:test",
    });

    expect(response.status).toEqual({
      provider: "imap",
      accountKey: "account:imap:test",
      connected: false,
      integration: null,
    });
    expect(response.message).toBe("IMAP provider is not connected.");
  });

  it("maps upstream provider errors to upstream app errors", () => {
    const appError = toProviderAppError(
      providerUpstreamError("Provider API timed out"),
    );

    expect(appError.status).toBe(502);
    expect(appError.code).toBe("UPSTREAM_ERROR");
    expect(appError.message).toBe("Provider API timed out");
  });
});
