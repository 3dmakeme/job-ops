import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateJobInput } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const alertJob = (trackingTitle: string): CreateJobInput => ({
  source: "linkedin",
  title: trackingTitle,
  employer: "Example Robotics",
  location: "London, England, United Kingdom",
  jobUrl: "https://www.linkedin.com/jobs/view/4012345678",
  sourceJobId: "4012345678",
});

describe.sequential("LinkedIn alert listings in importJobsStep", () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-linkedin-import-"));
    process.env = {
      ...originalEnv,
      DATA_DIR: tempDir,
      NODE_ENV: "test",
      JOBOPS_APP_MODE: "local",
    };
    await import("@server/db/migrate");
  });

  afterEach(async () => {
    const { closeDb } = await import("@server/db");
    closeDb();
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates a repeated or already-known listing at most once", async () => {
    const { importJobsStep } = await import(
      "@server/pipeline/steps/import-jobs"
    );
    const { getAllJobUrls } = await import("@server/repositories/jobs");

    // The same job twice in one scan, under slightly different titles so the
    // title/employer fuzzy merge does not hide the URL dedupe.
    const first = await importJobsStep({
      discoveredJobs: [
        alertJob("Senior Platform Engineer"),
        alertJob("Senior Platform Engineer (Hybrid)"),
      ],
    });
    expect(first.created).toBe(1);

    // A later scan of the same 7 days sees the job again.
    const second = await importJobsStep({
      discoveredJobs: [alertJob("Senior Platform Engineer")],
    });
    expect(second).toMatchObject({ created: 0, skipped: 1 });

    expect(await getAllJobUrls()).toEqual([
      "https://www.linkedin.com/jobs/view/4012345678",
    ]);
  });
});
