import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResumeProjectSelectionItem } from "../resumeProjects";

const systemOne = vi.fn();
vi.mock("./client", () => ({ getJevClient: () => ({ systemOne }) }));

import {
  combineProjectScores,
  expectedLevel,
  pickTopProjectIds,
  rankProjectsWithJev,
} from "./project-ranking";

const project = (id: string): ResumeProjectSelectionItem => ({
  id,
  name: `Project ${id}`,
  description: "Built a thing",
  date: "2024",
  isVisibleInBase: true,
  summaryText: "Built a thing with TypeScript",
});

describe("expectedLevel", () => {
  it("is the probability-weighted level scaled to 0..1", () => {
    expect(
      expectedLevel({ score: 3, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } }, 4),
    ).toBe(1);
    expect(
      expectedLevel({ score: 0, probabilities: { 0: 1, 1: 0, 2: 0, 3: 0 } }, 4),
    ).toBe(0);
    expect(
      expectedLevel(
        { score: 1, probabilities: { 0: 0.5, 1: 0, 2: 0, 3: 0.5 } },
        4,
      ),
    ).toBeCloseTo(0.5);
  });

  it("falls back to the answer's score when probabilities are unusable", () => {
    expect(expectedLevel({ score: 2, probabilities: {} }, 3)).toBe(1);
  });
});

describe("pickTopProjectIds", () => {
  it("orders by score and keeps resume order for ties", () => {
    const ranked = [
      { id: "a", relevance: 0, impact: 0, score: 0.5 },
      { id: "b", relevance: 0, impact: 0, score: 0.9 },
      { id: "c", relevance: 0, impact: 0, score: 0.5 },
    ];
    expect(pickTopProjectIds(ranked, 2)).toEqual(["b", "a"]);
    expect(pickTopProjectIds(ranked, 0)).toEqual([]);
  });

  it("weights relevance above impact", () => {
    expect(combineProjectScores(1, 0)).toBeGreaterThan(
      combineProjectScores(0, 1),
    );
  });
});

describe("rankProjectsWithJev", () => {
  beforeEach(() => systemOne.mockReset());

  it("asks two score questions per project and ranks the answers", async () => {
    const level = (top: number, picked: number) => ({
      score: picked,
      probabilities: Object.fromEntries(
        Array.from({ length: top }, (_, i) => [i, i === picked ? 1 : 0]),
      ),
    });
    systemOne.mockResolvedValue({
      answers: {
        relevance_0: level(4, 0),
        impact_0: level(3, 0),
        relevance_1: level(4, 3),
        impact_1: level(3, 2),
      },
    });

    const ranked = await rankProjectsWithJev({
      jobDescription: "<p>We need TypeScript</p>",
      projects: [project("a"), project("b")],
    });

    const request = systemOne.mock.calls[0][0];
    expect(Object.keys(request.questions)).toEqual([
      "relevance_0",
      "impact_0",
      "relevance_1",
      "impact_1",
    ]);
    expect(request.state.jobDescription).toBe("We need TypeScript");
    expect(request.state.projects).toHaveLength(2);
    expect(pickTopProjectIds(ranked, 1)).toEqual(["b"]);
  });

  it("makes no request when there are no projects", async () => {
    expect(
      await rankProjectsWithJev({ jobDescription: "x", projects: [] }),
    ).toEqual([]);
    expect(systemOne).not.toHaveBeenCalled();
  });
});
