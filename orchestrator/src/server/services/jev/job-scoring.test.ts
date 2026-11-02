import { beforeEach, describe, expect, it, vi } from "vitest";

const systemOne = vi.fn();
vi.mock("./client", () => ({ getJevClient: () => ({ systemOne }) }));

import {
  buildCandidateState,
  buildReason,
  combineScores,
  scoreJobWithJev,
} from "./job-scoring";

const answer = (level: number) => ({
  score: level,
  probabilities: { 0: 0, 1: 0, 2: 0, 3: 0, [level]: 1 },
  confidence: 1,
});

const profile = {
  basics: { headline: "AI Leader" },
  summary: { content: "<p>Leads <b>AI</b> teams</p>" },
  sections: {
    experience: {
      items: [
        {
          company: "Acme",
          position: "Head of AI",
          period: "2023",
          description: "<p>Built things</p>",
        },
        { company: "Hidden", position: "X", hidden: true },
      ],
    },
    skills: { items: [{ name: "AI", keywords: ["LLM", "Snowflake"] }] },
  },
};

describe("buildCandidateState", () => {
  it("strips markup, drops hidden items and keeps a compact shape", () => {
    const state = buildCandidateState(profile);
    expect(state.summary).toBe("Leads AI teams");
    expect(state.experience).toHaveLength(1);
    expect(state.experience[0]).toMatchObject({
      company: "Acme",
      role: "Head of AI",
    });
    expect(state.skills[0]).toContain("LLM, Snowflake");
  });
});

describe("combineScores / buildReason", () => {
  it("weights the four dimensions to a 0..100 integer", () => {
    expect(combineScores({ domain: 1, level: 1, skills: 1, overall: 1 })).toBe(
      100,
    );
    expect(combineScores({ domain: 0, level: 0, skills: 0, overall: 0 })).toBe(
      0,
    );
    expect(combineScores({ domain: 1, level: 0, skills: 0, overall: 0 })).toBe(
      30,
    );
  });

  it("assembles the reason from the dimension levels", () => {
    expect(buildReason({ domain: 1, level: 1, skills: 1, overall: 1 })).toBe(
      "TypeSafe Jev: direct match, right level or above, nearly all skills match; overall excellent fit.",
    );
  });
});

describe("scoreJobWithJev", () => {
  beforeEach(() => systemOne.mockReset());

  it("asks four Score questions in one request and combines the answers", async () => {
    systemOne.mockResolvedValue({
      answers: {
        domain: answer(3),
        level: answer(3),
        skills: answer(3),
        overall: answer(3),
      },
    });
    const result = await scoreJobWithJev(
      { title: "Head of AI", employer: "X", jobDescription: "<p>Lead AI</p>" },
      profile,
    );
    expect(result.score).toBe(100);
    expect(systemOne).toHaveBeenCalledTimes(1);
    const request = systemOne.mock.calls[0][0];
    expect(Object.keys(request.questions).sort()).toEqual([
      "domain",
      "level",
      "overall",
      "skills",
    ]);
    expect(request.state.job.description).toBe("Lead AI");
  });

  it("refuses a job with no description instead of guessing", async () => {
    await expect(
      scoreJobWithJev({ title: "t", jobDescription: " " }, profile),
    ).rejects.toThrow(/no description/);
    expect(systemOne).not.toHaveBeenCalled();
  });
});
