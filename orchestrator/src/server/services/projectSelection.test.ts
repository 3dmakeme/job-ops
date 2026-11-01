import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResumeProjectSelectionItem } from "./resumeProjects";

const { shouldUseJev, rankProjectsWithJev, callJson } = vi.hoisted(() => ({
  shouldUseJev: vi.fn(),
  rankProjectsWithJev: vi.fn(),
  callJson: vi.fn(),
}));

vi.mock("./jev/client", () => ({ shouldUseJev }));
vi.mock("./jev/project-ranking", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./jev/project-ranking")>()),
  rankProjectsWithJev,
}));
vi.mock("./modelSelection", () => ({
  resolveLlmModel: async () => "model",
  createConfiguredLlmService: async () => ({ callJson }),
}));

import { pickProjectIdsForJob } from "./projectSelection";

const project = (id: string): ResumeProjectSelectionItem => ({
  id,
  name: id,
  description: "",
  date: "",
  isVisibleInBase: true,
  summaryText: "",
});
const eligibleProjects = [project("a"), project("b"), project("c")];
const args = { jobDescription: "TypeScript", eligibleProjects, desiredCount: 2 };

describe("pickProjectIdsForJob engine toggle", () => {
  beforeEach(() => {
    shouldUseJev.mockReset();
    rankProjectsWithJev.mockReset();
    callJson.mockReset();
  });

  it("uses the LLM when Jev is not selected", async () => {
    shouldUseJev.mockResolvedValue(false);
    callJson.mockResolvedValue({
      success: true,
      data: { selectedProjectIds: ["c", "a"] },
    });
    expect(await pickProjectIdsForJob(args)).toEqual(["c", "a"]);
    expect(rankProjectsWithJev).not.toHaveBeenCalled();
  });

  it("uses Jev and skips the LLM when selected", async () => {
    shouldUseJev.mockResolvedValue(true);
    rankProjectsWithJev.mockResolvedValue([
      { id: "a", relevance: 0, impact: 0, score: 0.1 },
      { id: "b", relevance: 1, impact: 1, score: 0.9 },
      { id: "c", relevance: 0, impact: 0, score: 0.5 },
    ]);
    expect(await pickProjectIdsForJob(args)).toEqual(["b", "c"]);
    expect(callJson).not.toHaveBeenCalled();
  });

  it("falls back to the LLM when Jev fails", async () => {
    shouldUseJev.mockResolvedValue(true);
    rankProjectsWithJev.mockRejectedValue(new Error("timeout"));
    callJson.mockResolvedValue({
      success: true,
      data: { selectedProjectIds: ["b", "a"] },
    });
    expect(await pickProjectIdsForJob(args)).toEqual(["b", "a"]);
    expect(callJson).toHaveBeenCalledTimes(1);
  });
});
