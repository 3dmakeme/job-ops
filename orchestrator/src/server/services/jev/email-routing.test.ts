import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexedActiveJob } from "../post-application/ingestion/email-router";

const systemOne = vi.fn();
vi.mock("./client", () => ({ getJevClient: () => ({ systemOne }) }));

import {
  classifyEmailWithJev,
  type EmailRoutingAnswers,
  mapEmailAnswers,
} from "./email-routing";

const jobs: IndexedActiveJob[] = [
  { index: 1, id: "job-acme", company: "Acme", title: "Data Lead" },
  { index: 2, id: "job-globex", company: "Globex", title: "Architect" },
];

const choiceAnswer = (choice: string, p: number) => ({
  choice,
  confidence: p,
  probabilities: { [choice]: p },
});

const answers = (over: Partial<EmailRoutingAnswers> = {}): EmailRoutingAnswers => ({
  relevant: { noul: 0.99 },
  stage: choiceAnswer("recruiter_screen", 0.97),
  job: choiceAnswer("job_2", 0.98),
  ...over,
});

describe("mapEmailAnswers", () => {
  it("auto-links only when every judgment is confident", () => {
    const result = mapEmailAnswers(answers(), jobs);
    expect(result.bestMatchId).toBe("job-globex");
    expect(result.stageTarget).toBe("recruiter_screen");
    expect(result.isRelevant).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(95);
    expect(result.stageEventPayload).toBeNull();
  });

  it("keeps the match below the auto-link threshold when the stage is shaky", () => {
    const result = mapEmailAnswers(
      answers({ stage: choiceAnswer("offer", 0.6) }),
      jobs,
    );
    expect(result.bestMatchId).toBe("job-globex");
    expect(result.stageTarget).toBe("offer");
    expect(result.confidence).toBeLessThan(95);
    expect(result.confidence).toBeGreaterThanOrEqual(50);
  });

  it("does not trust a low-confidence stage", () => {
    const result = mapEmailAnswers(
      answers({ stage: choiceAnswer("rejected", 0.3) }),
      jobs,
    );
    expect(result.stageTarget).toBe("no_change");
    expect(result.reason).toContain("not trusted");
  });

  it("does not link when the job judgment is weak or is 'none'", () => {
    expect(
      mapEmailAnswers(answers({ job: choiceAnswer("job_1", 0.3) }), jobs)
        .bestMatchId,
    ).toBeNull();
    expect(
      mapEmailAnswers(answers({ job: choiceAnswer("none", 0.99) }), jobs)
        .bestMatchId,
    ).toBeNull();
  });

  it("ignores an unknown job label", () => {
    expect(
      mapEmailAnswers(answers({ job: choiceAnswer("job_9", 0.99) }), jobs)
        .bestMatchId,
    ).toBeNull();
  });

  it("treats irrelevant mail as no_change with zero confidence", () => {
    const result = mapEmailAnswers(answers({ relevant: { noul: 0.02 } }), jobs);
    expect(result).toMatchObject({
      isRelevant: false,
      bestMatchId: null,
      stageTarget: "no_change",
      confidence: 0,
    });
  });
});

describe("classifyEmailWithJev", () => {
  beforeEach(() => systemOne.mockReset());

  it("sends one request with relevance, stage and job questions", async () => {
    systemOne.mockResolvedValue({ answers: answers() });
    const result = await classifyEmailWithJev({
      emailText: "Hi, we'd like to schedule a call",
      jobs,
    });

    expect(systemOne).toHaveBeenCalledTimes(1);
    const request = systemOne.mock.calls[0][0];
    expect(request.state).toEqual({ email: "Hi, we'd like to schedule a call" });
    expect(Object.keys(request.questions)).toEqual(["relevant", "stage", "job"]);
    expect(Object.keys(request.questions.job.criteria)).toEqual([
      "none",
      "job_1",
      "job_2",
    ]);
    expect(request.questions.job.criteria.job_1).toBe("Acme: Data Lead");
    expect(result.bestMatchId).toBe("job-globex");
  });
});
