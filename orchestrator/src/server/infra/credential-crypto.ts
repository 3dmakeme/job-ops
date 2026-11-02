import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@infra/logger";
import { getDataDir } from "@server/config/dataDir";

const ALGORITHM = "aes-256-gcm";
const FORMAT_PREFIX = "v1";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MIN_KEY_SECRET_LENGTH = 32;
const LOCAL_KEY_FILENAME = "credentials-key";

// Install-global key material (never tenant data), resolved once per process.
let cachedKey: Buffer | null = null;

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

async function readPersistedKeySecret(keyPath: string): Promise<string | null> {
  try {
    const stored = (await readFile(keyPath, "utf8")).trim();
    return stored || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function assertKeySecretLength(secret: string | null, keyPath: string): string {
  if (!secret || secret.length < MIN_KEY_SECRET_LENGTH) {
    throw new Error(
      `Persisted credentials key at ${keyPath} must be at least ${MIN_KEY_SECRET_LENGTH} characters long`,
    );
  }
  return secret;
}

async function ensurePersistedKeySecret(): Promise<string> {
  const dataDir = getDataDir();
  const keyPath = join(dataDir, LOCAL_KEY_FILENAME);

  await mkdir(dataDir, { recursive: true });

  const existing = await readPersistedKeySecret(keyPath);
  if (existing) {
    return assertKeySecretLength(existing, keyPath);
  }

  const generated = randomBytes(48).toString("base64url");
  try {
    await writeFile(keyPath, `${generated}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    logger.info("Generated local credentials encryption key", {
      path: keyPath,
    });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const raced = await readPersistedKeySecret(keyPath);
    return assertKeySecretLength(raced, keyPath);
  }
}

async function getEncryptionKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;

  const explicit = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (explicit) {
    if (explicit.length < MIN_KEY_SECRET_LENGTH) {
      throw new Error(
        `CREDENTIALS_ENCRYPTION_KEY must be at least ${MIN_KEY_SECRET_LENGTH} characters long`,
      );
    }
    cachedKey = deriveKey(explicit);
    return cachedKey;
  }

  cachedKey = deriveKey(await ensurePersistedKeySecret());
  return cachedKey;
}

export async function encryptSecret(plain: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    FORMAT_PREFIX,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export async function decryptSecret(cipher: string): Promise<string> {
  const parts = cipher.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT_PREFIX) {
    throw new Error("Encrypted secret has an unsupported format.");
  }

  const iv = Buffer.from(parts[1], "base64url");
  const authTag = Buffer.from(parts[2], "base64url");
  const ciphertext = Buffer.from(parts[3], "base64url");
  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Encrypted secret has an unsupported format.");
  }

  const key = await getEncryptionKey();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Encrypted secret could not be decrypted.");
  }
}
