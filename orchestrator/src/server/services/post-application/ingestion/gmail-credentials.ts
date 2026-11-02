import { decryptSecret, encryptSecret } from "@infra/credential-crypto";
import type { GmailCredentials } from "./gmail-api";

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Prefers the encrypted key and falls back to the legacy plaintext key.
// Throws when the encrypted value cannot be decrypted.
async function readStoredToken(
  stored: Record<string, unknown>,
  encryptedKey: string,
  legacyKey: string,
): Promise<string | undefined> {
  const encrypted = asString(stored[encryptedKey]);
  if (encrypted) return asString(await decryptSecret(encrypted));
  return asString(stored[legacyKey]);
}

export async function encodeStoredGmailCredentials(
  creds: GmailCredentials,
): Promise<Record<string, unknown>> {
  return {
    refreshTokenEncrypted: await encryptSecret(creds.refreshToken),
    ...(creds.accessToken
      ? { accessTokenEncrypted: await encryptSecret(creds.accessToken) }
      : {}),
    ...(typeof creds.expiryDate === "number"
      ? { expiryDate: creds.expiryDate }
      : {}),
    ...(creds.scope ? { scope: creds.scope } : {}),
    ...(creds.tokenType ? { tokenType: creds.tokenType } : {}),
    ...(creds.email ? { email: creds.email } : {}),
  };
}

export async function decodeStoredGmailCredentials(
  stored: Record<string, unknown> | null,
): Promise<GmailCredentials | null> {
  if (!stored) return null;

  let refreshToken: string | undefined;
  try {
    refreshToken = await readStoredToken(
      stored,
      "refreshTokenEncrypted",
      "refreshToken",
    );
  } catch {
    return null;
  }
  if (!refreshToken) return null;

  let accessToken: string | undefined;
  try {
    accessToken = await readStoredToken(
      stored,
      "accessTokenEncrypted",
      "accessToken",
    );
  } catch {
    accessToken = undefined;
  }

  const expiryDate =
    typeof stored.expiryDate === "number" && Number.isFinite(stored.expiryDate)
      ? stored.expiryDate
      : undefined;

  return {
    refreshToken,
    accessToken,
    expiryDate,
    scope: asString(stored.scope),
    tokenType: asString(stored.tokenType),
    email: asString(stored.email),
  };
}
