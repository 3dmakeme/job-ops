import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

describe.sequential("database migrations", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("boots when an older pipeline_runs table lacks config_snapshot", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "better-sqlite3";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      const sqlite = new Database(dbPath);
      sqlite.exec(\`
        CREATE TABLE pipeline_runs (
          id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          status TEXT NOT NULL DEFAULT 'running',
          jobs_discovered INTEGER NOT NULL DEFAULT 0,
          jobs_processed INTEGER NOT NULL DEFAULT 0,
          error_message TEXT
        );
      \`);
      sqlite.close();

      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);

      const migratedDb = new Database(dbPath, { readonly: true });
      const columns = migratedDb.prepare("PRAGMA table_info(pipeline_runs)").all();
      if (!columns.some((column) => column.name === "config_snapshot")) {
        throw new Error("config_snapshot column missing after migration");
      }
      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
        },
        stdio: "pipe",
      },
    );
  });

  it("creates tenant foreign keys for tenant-scoped core tables", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "better-sqlite3";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);

      const migratedDb = new Database(dbPath, { readonly: true });

      function hasTenantCascade(tableName) {
        const fks = migratedDb.prepare(\`PRAGMA foreign_key_list(\${tableName})\`).all();
        return fks.some((fk) => fk.from === "tenant_id" && fk.table === "tenants" && String(fk.on_delete).toUpperCase() === "CASCADE");
      }

      const requiredTables = ["jobs", "pipeline_runs", "settings"];
      for (const tableName of requiredTables) {
        if (!hasTenantCascade(tableName)) {
          throw new Error(\`\${tableName} is missing tenant_id -> tenants(id) ON DELETE CASCADE\`);
        }
      }

      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
        },
        stdio: "pipe",
      },
    );
  });

  it("marks only existing workspaces for legacy onboarding migration", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "better-sqlite3";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      const sqlite = new Database(dbPath);
      sqlite.exec(\`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO settings(key, value) VALUES ('llmProvider', 'openrouter');
      \`);
      sqlite.close();

      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);

      const migratedDb = new Database(dbPath, { readonly: true });
      const pending = migratedDb.prepare(
        "SELECT value FROM settings WHERE key = 'onboardingLegacyMigrationPending'",
      ).get();
      if (pending?.value !== "1") {
        throw new Error("Existing workspace was not marked for onboarding migration");
      }
      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        env: { ...process.env, DATA_DIR: tempDir },
        stdio: "pipe",
      },
    );
  });

  it("creates hosted usage tables with user-scoped foreign keys and indexes", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "better-sqlite3";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);

      const migratedDb = new Database(dbPath, { readonly: true });

      function tableExists(tableName) {
        return Boolean(
          migratedDb
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(tableName),
        );
      }

      for (const tableName of ["account_subscriptions", "hosted_usage_counters", "hosted_usage_reservations"]) {
        if (!tableExists(tableName)) {
          throw new Error(\`\${tableName} was not created\`);
        }
        const fks = migratedDb.prepare(\`PRAGMA foreign_key_list(\${tableName})\`).all();
        const hasTenantCascade = fks.some((fk) => fk.from === "tenant_id" && fk.table === "tenants" && String(fk.on_delete).toUpperCase() === "CASCADE");
        const hasUserCascade = fks.some((fk) => fk.from === "user_id" && fk.table === "users" && String(fk.on_delete).toUpperCase() === "CASCADE");
        if (!hasTenantCascade || !hasUserCascade) {
          throw new Error(\`\${tableName} is missing hosted usage foreign keys\`);
        }
      }

      const counterIndexes = migratedDb.prepare("PRAGMA index_list(hosted_usage_counters)").all();
      const counterUnique = counterIndexes.find((index) => index.name === "idx_hosted_usage_counters_tenant_user_period_action_unique");
      if (!counterUnique || !counterUnique.unique) {
        throw new Error("hosted usage counter unique index missing");
      }

      const reservationIndexes = migratedDb.prepare("PRAGMA index_list(hosted_usage_reservations)").all();
      const reservationUnique = reservationIndexes.find((index) => index.name === "idx_hosted_usage_reservations_idempotency_unique");
      if (!reservationUnique || !reservationUnique.unique) {
        throw new Error("hosted usage reservation idempotency unique index missing");
      }

      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
        },
        stdio: "pipe",
      },
    );
  });

  it("backfills legacy PDF rows as generated", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "better-sqlite3";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      const migrationUrl = pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href;
      await import(\`\${migrationUrl}?run=initial\`);

      const sqlite = new Database(dbPath);
      sqlite.prepare("INSERT INTO jobs(id, title, employer, job_url, pdf_path, pdf_source) VALUES (?, ?, ?, ?, ?, NULL)").run(
        "legacy-pdf-job",
        "Legacy PDF Job",
        "Acme",
        "https://example.com/legacy-pdf-job",
        "data/pdfs/resume_legacy-pdf-job.pdf",
      );
      sqlite.close();

      await import(\`\${migrationUrl}?run=backfill\`);

      const migratedDb = new Database(dbPath, { readonly: true });
      const row = migratedDb.prepare("SELECT pdf_source FROM jobs WHERE id = ?").get("legacy-pdf-job");
      if (row?.pdf_source !== "generated") {
        throw new Error(\`Expected legacy PDF source to be generated, got \${row?.pdf_source}\`);
      }
      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
        },
        stdio: "pipe",
      },
    );
  });

  it("adds the tracer-link composite unique index to legacy tables", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "better-sqlite3";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      const sqlite = new Database(dbPath);
      sqlite.exec(\`
        CREATE TABLE tracer_links (
          id TEXT PRIMARY KEY,
          token TEXT NOT NULL UNIQUE,
          job_id TEXT NOT NULL,
          source_path TEXT NOT NULL,
          source_label TEXT NOT NULL,
          destination_url TEXT NOT NULL,
          destination_url_hash TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE tracer_click_events (
          id TEXT PRIMARY KEY,
          tracer_link_id TEXT NOT NULL,
          clicked_at INTEGER NOT NULL,
          is_likely_bot INTEGER NOT NULL DEFAULT 0,
          unique_fingerprint_hash TEXT
        );

        INSERT INTO tracer_links(
          id, token, job_id, source_path, source_label, destination_url,
          destination_url_hash, created_at, updated_at
        )
        VALUES
          ('link-1', 'acme-aa', 'job-1', 'basics.url.href', 'Portfolio', 'https://example.com', 'hash-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('link-2', 'acme-bb', 'job-1', 'basics.url.href', 'Portfolio', 'https://example.com', 'hash-1', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

        INSERT INTO tracer_click_events(id, tracer_link_id, clicked_at)
        VALUES ('click-1', 'link-2', 1);
      \`);
      sqlite.close();

      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);

      const migratedDb = new Database(dbPath, { readonly: true });
      const indexes = migratedDb.prepare("PRAGMA index_list(tracer_links)").all();
      const uniqueIndex = indexes.find((index) => index.name === "idx_tracer_links_tenant_user_job_source_destination_unique");
      if (!uniqueIndex || !uniqueIndex.unique) {
        throw new Error("tracer_links composite unique index missing after migration");
      }

      const linkCount = migratedDb.prepare("SELECT count(*) AS count FROM tracer_links").get();
      if (linkCount.count !== 1) {
        throw new Error(\`Expected duplicate tracer links to be merged, got \${linkCount.count}\`);
      }

      const click = migratedDb.prepare("SELECT tracer_link_id FROM tracer_click_events WHERE id = ?").get("click-1");
      if (click?.tracer_link_id !== "link-1") {
        throw new Error(\`Expected duplicate click to be reassigned to link-1, got \${click?.tracer_link_id}\`);
      }

      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
        },
        stdio: "pipe",
      },
    );
  });

  it("relaxes legacy NOT NULL password columns while preserving accounts", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "better-sqlite3";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      const sqlite = new Database(dbPath);
      sqlite.exec(\`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          display_name TEXT,
          password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          is_system_admin INTEGER NOT NULL DEFAULT 0,
          is_disabled INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE tenants (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE tenant_memberships (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner', 'member')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
          UNIQUE(user_id, tenant_id)
        );

        INSERT INTO tenants(id, name, slug) VALUES ('tenant_default', 'JobOps', 'default');
        INSERT INTO users(id, username, display_name, password_hash, password_salt, is_system_admin)
        VALUES ('user-legacy', 'legacy', 'Legacy Owner', 'legacy-hash', 'legacy-salt', 1);
        INSERT INTO tenant_memberships(id, user_id, tenant_id, role)
        VALUES ('membership-legacy', 'user-legacy', 'tenant_default', 'owner');
      \`);
      sqlite.close();

      const migrationUrl = pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href;
      await import(\`\${migrationUrl}?run=initial\`);
      await import(\`\${migrationUrl}?run=rerun\`);

      const migratedDb = new Database(dbPath);
      const columns = migratedDb.prepare("PRAGMA table_info(users)").all();
      for (const columnName of ["password_hash", "password_salt"]) {
        const column = columns.find((entry) => entry.name === columnName);
        if (!column || column.notnull !== 0) {
          throw new Error(\`\${columnName} is still NOT NULL after migration\`);
        }
      }

      const user = migratedDb.prepare("SELECT username, password_hash, is_system_admin FROM users WHERE id = ?").get("user-legacy");
      if (user?.password_hash !== "legacy-hash" || user.is_system_admin !== 1) {
        throw new Error("Legacy user did not survive the rebuild");
      }

      const membership = migratedDb.prepare("SELECT tenant_id FROM tenant_memberships WHERE user_id = ?").get("user-legacy");
      if (membership?.tenant_id !== "tenant_default") {
        throw new Error("Legacy tenant membership did not survive the rebuild");
      }

      const userCount = migratedDb.prepare("SELECT count(*) AS count FROM users").get();
      if (userCount.count !== 1) {
        throw new Error(\`Expected a single user after the rebuild, got \${userCount.count}\`);
      }

      migratedDb.prepare("INSERT INTO users(id, username) VALUES (?, ?)").run("user-sso", "sso");

      let duplicateMessage = null;
      try {
        migratedDb.prepare("INSERT INTO users(id, username) VALUES (?, ?)").run("user-duplicate", "legacy");
      } catch (error) {
        duplicateMessage = error.message;
      }
      if (!duplicateMessage?.includes("UNIQUE constraint failed: users.username")) {
        throw new Error(\`Expected a username uniqueness failure, got \${duplicateMessage}\`);
      }

      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
          BASIC_AUTH_USER: "",
          BASIC_AUTH_PASSWORD: "",
        },
        stdio: "pipe",
      },
    );
  });

  it("creates sso_identities with a unique provider subject", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "better-sqlite3";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);

      const migratedDb = new Database(dbPath);

      const fks = migratedDb.prepare("PRAGMA foreign_key_list(sso_identities)").all();
      const hasTenantCascade = fks.some((fk) => fk.from === "tenant_id" && fk.table === "tenants" && String(fk.on_delete).toUpperCase() === "CASCADE");
      const hasUserCascade = fks.some((fk) => fk.from === "user_id" && fk.table === "users" && String(fk.on_delete).toUpperCase() === "CASCADE");
      if (!hasTenantCascade || !hasUserCascade) {
        throw new Error("sso_identities is missing its foreign keys");
      }

      const indexes = migratedDb.prepare("PRAGMA index_list(sso_identities)").all();
      if (!indexes.some((index) => index.name === "idx_sso_identities_user_id")) {
        throw new Error("sso_identities user index missing");
      }

      migratedDb.prepare("INSERT INTO users(id, username) VALUES (?, ?)").run("user-1", "alice");
      migratedDb.prepare("INSERT INTO sso_identities(id, user_id, provider, issuer, subject) VALUES (?, ?, ?, ?, ?)").run(
        "identity-1",
        "user-1",
        "oidc",
        "https://id.example.com",
        "subject-1",
      );

      let duplicateFailed = false;
      try {
        migratedDb.prepare("INSERT INTO sso_identities(id, user_id, provider, issuer, subject) VALUES (?, ?, ?, ?, ?)").run(
          "identity-2",
          "user-1",
          "oidc",
          "https://id.example.com",
          "subject-1",
        );
      } catch {
        duplicateFailed = true;
      }
      if (!duplicateFailed) {
        throw new Error("sso_identities allowed a duplicate provider subject");
      }

      let unknownProviderFailed = false;
      try {
        migratedDb.prepare("INSERT INTO sso_identities(id, user_id, provider, issuer, subject) VALUES (?, ?, ?, ?, ?)").run(
          "identity-3",
          "user-1",
          "linkedin",
          "https://id.example.com",
          "subject-2",
        );
      } catch {
        unknownProviderFailed = true;
      }
      if (!unknownProviderFailed) {
        throw new Error("sso_identities accepted an unknown provider");
      }

      const stored = migratedDb.prepare("SELECT tenant_id FROM sso_identities WHERE id = ?").get("identity-1");
      if (stored?.tenant_id !== "tenant_default") {
        throw new Error(\`Expected the default tenant, got \${stored?.tenant_id}\`);
      }

      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
        },
        stdio: "pipe",
      },
    );
  });

  it("enforces private unique indexes when user_id is null", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "better-sqlite3";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);

      const migratedDb = new Database(dbPath);
      migratedDb.prepare("INSERT INTO jobs(id, tenant_id, user_id, title, employer, job_url) VALUES (?, ?, NULL, ?, ?, ?)").run(
        "job-null-owner-1",
        "tenant_default",
        "Role",
        "Acme",
        "https://example.com/null-owner",
      );

      let duplicateFailed = false;
      try {
        migratedDb.prepare("INSERT INTO jobs(id, tenant_id, user_id, title, employer, job_url) VALUES (?, ?, NULL, ?, ?, ?)").run(
          "job-null-owner-2",
          "tenant_default",
          "Role",
          "Acme",
          "https://example.com/null-owner",
        );
      } catch {
        duplicateFailed = true;
      }

      if (!duplicateFailed) {
        throw new Error("jobs unique index allowed duplicate NULL user_id rows");
      }

      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
        },
        stdio: "pipe",
      },
    );
  });
});

describe.sequential("gmail token encryption migration", () => {
  const REFRESH_A = "1//refresh-token-tenant-a-plain";
  const ACCESS_A = "ya29.access-token-tenant-a-plain";
  const REFRESH_B = "1//refresh-token-tenant-b-plain";
  const ACCESS_B = "ya29.access-token-tenant-b-plain";
  const SEEDED_TOKENS = [REFRESH_A, ACCESS_A, REFRESH_B, ACCESS_B];
  const IMAP_CREDENTIALS = {
    host: "mail.example.com",
    passwordEncrypted: "v1:imap:already:encrypted",
  };

  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  function childEnv(dataDir: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir };
    delete env.CREDENTIALS_ENCRYPTION_KEY;
    return env;
  }

  function runNode(
    dataDir: string,
    args: string[],
  ): { status: number | null; output: string } {
    const result = spawnSync(process.execPath, ["--import", "tsx", ...args], {
      env: childEnv(dataDir),
      encoding: "utf8",
    });
    return {
      status: result.status,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  }

  function runMigrate(dataDir: string) {
    return runNode(dataDir, ["src/server/db/migrate.ts"]);
  }

  function runRollback(dataDir: string) {
    return runNode(dataDir, [
      "src/server/db/rollback-gmail-token-encryption.ts",
    ]);
  }

  function expectNoTokens(output: string): void {
    for (const token of SEEDED_TOKENS) {
      expect(output).not.toContain(token);
    }
  }

  function filesWithPrefix(dataDir: string, prefix: string): string[] {
    return readdirSync(dataDir).filter(
      (name) => name.startsWith(prefix) && name.endsWith(".db"),
    );
  }

  async function seedLegacyDb(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), "job-ops-gmail-tokens-"));
    expect(runMigrate(dataDir).status).toBe(0);

    const sqlite = new Database(join(dataDir, "jobs.db"));
    // Production runs in WAL mode (db/index.ts), and the mode persists in the file.
    sqlite.pragma("journal_mode = WAL");
    sqlite.exec(`
      INSERT INTO tenants(id, name, slug) VALUES ('tenant_b', 'B', 'b');
      INSERT INTO users(id, username) VALUES ('user_a', 'a'), ('user_b', 'b');
    `);
    const insertIntegration = sqlite.prepare(
      "INSERT INTO post_application_integrations(id, tenant_id, user_id, provider, account_key, status, credentials) VALUES (?, ?, ?, ?, 'default', 'connected', ?)",
    );
    insertIntegration.run(
      "gmail-a",
      "tenant_default",
      "user_a",
      "gmail",
      JSON.stringify({
        refreshToken: REFRESH_A,
        accessToken: ACCESS_A,
        expiryDate: 1_900_000_000_000,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        email: "a@example.com",
      }),
    );
    insertIntegration.run(
      "gmail-b",
      "tenant_b",
      "user_b",
      "gmail",
      JSON.stringify({ refreshToken: REFRESH_B, accessToken: ACCESS_B }),
    );
    insertIntegration.run(
      "imap-a",
      "tenant_default",
      "user_a",
      "imap",
      JSON.stringify(IMAP_CREDENTIALS),
    );
    const insertJob = sqlite.prepare(
      "INSERT INTO jobs(id, tenant_id, user_id, title, employer, job_url) VALUES (?, ?, ?, 'Role', 'Acme', ?)",
    );
    insertJob.run("job-a", "tenant_default", "user_a", "https://example.com/a");
    insertJob.run("job-b", "tenant_b", "user_b", "https://example.com/b");
    sqlite.close();
    return dataDir;
  }

  function readCredentials(
    dbPath: string,
    id: string,
  ): Record<string, unknown> {
    const sqlite = new Database(dbPath, { readonly: true });
    const row = sqlite
      .prepare(
        "SELECT credentials FROM post_application_integrations WHERE id = ?",
      )
      .get(id) as { credentials: string };
    sqlite.close();
    return JSON.parse(row.credentials) as Record<string, unknown>;
  }

  function countJobs(dbPath: string): number {
    const sqlite = new Database(dbPath, { readonly: true });
    const row = sqlite.prepare("SELECT count(*) AS count FROM jobs").get() as {
      count: number;
    };
    sqlite.close();
    return row.count;
  }

  async function decryptWithDataDir(
    dataDir: string,
    values: unknown[],
  ): Promise<string[]> {
    const originalEnv = { ...process.env };
    process.env = { ...originalEnv, DATA_DIR: dataDir };
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    vi.resetModules();
    try {
      const { decryptSecret } = await import("@infra/credential-crypto");
      return await Promise.all(
        values.map((value) => decryptSecret(String(value))),
      );
    } finally {
      process.env = originalEnv;
      vi.resetModules();
    }
  }

  it("encrypts plaintext rows across tenants after a verified backup", async () => {
    tempDir = await seedLegacyDb();
    const dbPath = join(tempDir, "jobs.db");
    const jobsBefore = countJobs(dbPath);

    const result = runMigrate(tempDir);

    expect(result.status).toBe(0);
    expectNoTokens(result.output);

    const rowA = readCredentials(dbPath, "gmail-a");
    expect(String(rowA.refreshTokenEncrypted)).toMatch(/^v1:/);
    expect(String(rowA.accessTokenEncrypted)).toMatch(/^v1:/);
    expect(rowA).not.toHaveProperty("refreshToken");
    expect(rowA).not.toHaveProperty("accessToken");
    expect(rowA).toMatchObject({
      expiryDate: 1_900_000_000_000,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      email: "a@example.com",
    });

    const rowB = readCredentials(dbPath, "gmail-b");
    expect(String(rowB.refreshTokenEncrypted)).toMatch(/^v1:/);
    expect(String(rowB.accessTokenEncrypted)).toMatch(/^v1:/);
    expect(rowB).not.toHaveProperty("refreshToken");
    expect(rowB).not.toHaveProperty("accessToken");

    expect(readCredentials(dbPath, "imap-a")).toEqual(IMAP_CREDENTIALS);
    expect(countJobs(dbPath)).toBe(jobsBefore);

    await expect(
      decryptWithDataDir(tempDir, [
        rowA.refreshTokenEncrypted,
        rowA.accessTokenEncrypted,
        rowB.refreshTokenEncrypted,
        rowB.accessTokenEncrypted,
      ]),
    ).resolves.toEqual([REFRESH_A, ACCESS_A, REFRESH_B, ACCESS_B]);

    const backups = filesWithPrefix(
      tempDir,
      "jobs_pre_gmail_token_encryption_",
    );
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(
      /^jobs_pre_gmail_token_encryption_\d{8}T\d{6}Z\.db$/,
    );
    const backupPath = join(tempDir, backups[0]);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);

    const backup = new Database(backupPath, { readonly: true });
    expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
    const backupRow = backup
      .prepare(
        "SELECT credentials FROM post_application_integrations WHERE id = 'gmail-a'",
      )
      .get() as { credentials: string };
    backup.close();
    expect(JSON.parse(backupRow.credentials)).toMatchObject({
      refreshToken: REFRESH_A,
      accessToken: ACCESS_A,
    });
  });

  it("purges leftover plaintext tokens from jobs.db and its WAL", async () => {
    tempDir = await seedLegacyDb();
    const dbPath = join(tempDir, "jobs.db");

    const result = runMigrate(tempDir);

    expect(result.status).toBe(0);
    expect(result.output).toContain(
      "Purged plaintext Gmail tokens from database file",
    );
    expectNoTokens(result.output);

    const walPath = `${dbPath}-wal`;
    const liveFiles = [dbPath, ...(existsSync(walPath) ? [walPath] : [])];
    for (const file of liveFiles) {
      const bytes = readFileSync(file);
      for (const token of SEEDED_TOKENS) {
        expect(bytes.includes(token)).toBe(false);
      }
    }

    const backups = filesWithPrefix(
      tempDir,
      "jobs_pre_gmail_token_encryption_",
    );
    expect(backups).toHaveLength(1);
    const backupBytes = readFileSync(join(tempDir, backups[0]));
    for (const token of SEEDED_TOKENS) {
      expect(backupBytes.includes(token)).toBe(true);
    }
  });

  it("is a no-op on repeated runs and on databases without gmail rows", async () => {
    tempDir = await seedLegacyDb();
    const dbPath = join(tempDir, "jobs.db");
    expect(runMigrate(tempDir).status).toBe(0);
    const firstRunA = readCredentials(dbPath, "gmail-a");
    const firstRunB = readCredentials(dbPath, "gmail-b");
    const jobsBefore = countJobs(dbPath);
    const filesBefore = readdirSync(tempDir).sort();

    const second = runMigrate(tempDir);

    expect(second.status).toBe(0);
    expect(second.output).not.toContain("Purged plaintext Gmail tokens");
    expect(readCredentials(dbPath, "gmail-a")).toEqual(firstRunA);
    expect(readCredentials(dbPath, "gmail-b")).toEqual(firstRunB);
    expect(countJobs(dbPath)).toBe(jobsBefore);
    expect(readdirSync(tempDir).sort()).toEqual(filesBefore);
    expect(
      filesWithPrefix(tempDir, "jobs_pre_gmail_token_encryption_"),
    ).toHaveLength(1);

    const freshDir = await mkdtemp(join(tmpdir(), "job-ops-gmail-tokens-"));
    try {
      const fresh = runMigrate(freshDir);
      expect(fresh.status).toBe(0);
      expect(fresh.output).not.toContain("Purged plaintext Gmail tokens");
      expect(filesWithPrefix(freshDir, "jobs_pre_gmail_token_")).toEqual([]);
    } finally {
      await rm(freshDir, { recursive: true, force: true });
    }
  });

  it("leaves rows untouched and still boots when the backup fails", async () => {
    tempDir = await seedLegacyDb();
    const dbPath = join(tempDir, "jobs.db");
    const before = readCredentials(dbPath, "gmail-a");
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "better-sqlite3";

      Database.prototype.backup = async () => {
        throw new Error("simulated backup failure");
      };
      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);
    `;

    const result = runNode(tempDir, ["--input-type=module", "-e", script]);

    expect(result.status).toBe(0);
    expect(result.output).toContain("pre-migration backup failed");
    expectNoTokens(result.output);
    expect(readCredentials(dbPath, "gmail-a")).toEqual(before);
    expect(readCredentials(dbPath, "gmail-b")).toEqual({
      refreshToken: REFRESH_B,
      accessToken: ACCESS_B,
    });
    expect(filesWithPrefix(tempDir, "jobs_pre_gmail_token_")).toEqual([]);
  });

  it("rolls encrypted rows back to plaintext after a verified backup", async () => {
    tempDir = await seedLegacyDb();
    const dbPath = join(tempDir, "jobs.db");
    expect(runMigrate(tempDir).status).toBe(0);

    const rollback = runRollback(tempDir);

    expect(rollback.status).toBe(0);
    expectNoTokens(rollback.output);
    const rowA = readCredentials(dbPath, "gmail-a");
    expect(rowA).toEqual({
      refreshToken: REFRESH_A,
      accessToken: ACCESS_A,
      expiryDate: 1_900_000_000_000,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      email: "a@example.com",
    });
    expect(readCredentials(dbPath, "gmail-b")).toEqual({
      refreshToken: REFRESH_B,
      accessToken: ACCESS_B,
    });
    expect(readCredentials(dbPath, "imap-a")).toEqual(IMAP_CREDENTIALS);
    const rollbackBackups = filesWithPrefix(
      tempDir,
      "jobs_pre_gmail_token_rollback_",
    );
    expect(rollbackBackups).toHaveLength(1);
    expect(statSync(join(tempDir, rollbackBackups[0])).mode & 0o777).toBe(
      0o600,
    );

    const again = runRollback(tempDir);

    expect(again.status).toBe(0);
    expect(readCredentials(dbPath, "gmail-a")).toEqual(rowA);
    expect(
      filesWithPrefix(tempDir, "jobs_pre_gmail_token_rollback_"),
    ).toHaveLength(1);
  });

  it("exits non-zero and writes nothing when rollback cannot decrypt", async () => {
    tempDir = await seedLegacyDb();
    const dbPath = join(tempDir, "jobs.db");
    expect(runMigrate(tempDir).status).toBe(0);
    const encrypted = readCredentials(dbPath, "gmail-a");
    writeFileSync(
      join(tempDir, "credentials-key"),
      "a-different-credentials-key-that-cannot-decrypt\n",
    );

    const rollback = runRollback(tempDir);

    expect(rollback.status).not.toBe(0);
    expect(rollback.output).toContain("Gmail token rollback failed");
    expect(readCredentials(dbPath, "gmail-a")).toEqual(encrypted);
  });
});
