import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("credential crypto", () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-credential-crypto-"));
    process.env = { ...originalEnv, DATA_DIR: tempDir };
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it("round trips a secret", async () => {
    const { encryptSecret, decryptSecret } = await import(
      "./credential-crypto"
    );

    const encrypted = await encryptSecret("imap-password-123");

    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(encrypted).not.toContain("imap-password-123");
    await expect(decryptSecret(encrypted)).resolves.toBe("imap-password-123");
  });

  it("produces different ciphertexts for the same input", async () => {
    const { encryptSecret } = await import("./credential-crypto");

    const first = await encryptSecret("same-input");
    const second = await encryptSecret("same-input");

    expect(first).not.toBe(second);
  });

  it("rejects tampered ciphertext without leaking it", async () => {
    const { encryptSecret, decryptSecret } = await import(
      "./credential-crypto"
    );

    const encrypted = await encryptSecret("top-secret-value");
    const parts = encrypted.split(":");
    const ciphertext = Buffer.from(parts[3], "base64url");
    ciphertext[0] = ciphertext[0] ^ 0xff;
    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      ciphertext.toString("base64url"),
    ].join(":");

    const error = await decryptSecret(tampered).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(parts[3]);
    expect((error as Error).message).not.toContain("top-secret-value");
    await expect(decryptSecret("not-a-valid-secret")).rejects.toThrow(
      "Encrypted secret has an unsupported format.",
    );
  });

  it("creates the key file with mode 0600 under DATA_DIR", async () => {
    const { encryptSecret } = await import("./credential-crypto");

    await encryptSecret("value");

    const keyPath = join(tempDir, "credentials-key");
    const keyStat = await stat(keyPath);
    expect(keyStat.mode & 0o777).toBe(0o600);
    expect((await readFile(keyPath, "utf8")).trim().length).toBeGreaterThan(32);
  });

  it("uses CREDENTIALS_ENCRYPTION_KEY when set", async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = "a".repeat(40);
    const { encryptSecret } = await import("./credential-crypto");
    const encrypted = await encryptSecret("value");

    await expect(stat(join(tempDir, "credentials-key"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    vi.resetModules();
    const fresh = await import("./credential-crypto");
    await expect(fresh.decryptSecret(encrypted)).resolves.toBe("value");

    vi.resetModules();
    process.env.CREDENTIALS_ENCRYPTION_KEY = "b".repeat(40);
    const otherKey = await import("./credential-crypto");
    await expect(otherKey.decryptSecret(encrypted)).rejects.toThrow(
      "Encrypted secret could not be decrypted.",
    );
  });
});
