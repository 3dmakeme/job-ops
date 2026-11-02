import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REFRESH_TOKEN = "1//refresh-token-plain-value";
const ACCESS_TOKEN = "ya29.access-token-plain-value";

describe.sequential("gmail stored credentials", () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let gmailCredentials: typeof import("./gmail-credentials");

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-gmail-credentials-"));
    process.env = { ...originalEnv, DATA_DIR: tempDir };
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    gmailCredentials = await import("./gmail-credentials");
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it("round trips encoded credentials", async () => {
    const creds = {
      refreshToken: REFRESH_TOKEN,
      accessToken: ACCESS_TOKEN,
      expiryDate: 1_900_000_000_000,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      tokenType: "Bearer",
      email: "candidate@example.com",
    };

    const stored = await gmailCredentials.encodeStoredGmailCredentials(creds);

    await expect(
      gmailCredentials.decodeStoredGmailCredentials(stored),
    ).resolves.toEqual(creds);
  });

  it("stores only encrypted token keys", async () => {
    const stored = await gmailCredentials.encodeStoredGmailCredentials({
      refreshToken: REFRESH_TOKEN,
      accessToken: ACCESS_TOKEN,
      email: "candidate@example.com",
    });

    expect(Object.keys(stored).sort()).toEqual([
      "accessTokenEncrypted",
      "email",
      "refreshTokenEncrypted",
    ]);
    expect(String(stored.refreshTokenEncrypted).startsWith("v1:")).toBe(true);
    expect(String(stored.accessTokenEncrypted).startsWith("v1:")).toBe(true);
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).not.toContain(ACCESS_TOKEN);
  });

  it("decodes legacy plaintext credentials", async () => {
    await expect(
      gmailCredentials.decodeStoredGmailCredentials({
        refreshToken: REFRESH_TOKEN,
        accessToken: ACCESS_TOKEN,
        expiryDate: 1_900_000_000_000,
      }),
    ).resolves.toMatchObject({
      refreshToken: REFRESH_TOKEN,
      accessToken: ACCESS_TOKEN,
      expiryDate: 1_900_000_000_000,
    });
  });

  it("prefers encrypted keys over leftover plaintext keys", async () => {
    const stored = await gmailCredentials.encodeStoredGmailCredentials({
      refreshToken: REFRESH_TOKEN,
      accessToken: ACCESS_TOKEN,
    });

    await expect(
      gmailCredentials.decodeStoredGmailCredentials({
        ...stored,
        refreshToken: "stale-plain-refresh",
        accessToken: "stale-plain-access",
      }),
    ).resolves.toMatchObject({
      refreshToken: REFRESH_TOKEN,
      accessToken: ACCESS_TOKEN,
    });
  });

  it("returns null when the refresh token cannot be decrypted", async () => {
    await expect(
      gmailCredentials.decodeStoredGmailCredentials({
        refreshTokenEncrypted: "v1:not:valid:ciphertext",
        refreshToken: REFRESH_TOKEN,
      }),
    ).resolves.toBeNull();
  });

  it("drops only the access token when it cannot be decrypted", async () => {
    const stored = await gmailCredentials.encodeStoredGmailCredentials({
      refreshToken: REFRESH_TOKEN,
    });

    const decoded = await gmailCredentials.decodeStoredGmailCredentials({
      ...stored,
      accessTokenEncrypted: "v1:not:valid:ciphertext",
    });

    expect(decoded?.refreshToken).toBe(REFRESH_TOKEN);
    expect(decoded?.accessToken).toBeUndefined();
  });

  it("returns null without a usable refresh token", async () => {
    await expect(
      gmailCredentials.decodeStoredGmailCredentials(null),
    ).resolves.toBeNull();
    await expect(
      gmailCredentials.decodeStoredGmailCredentials({
        accessToken: ACCESS_TOKEN,
      }),
    ).resolves.toBeNull();
  });
});
