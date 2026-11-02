/**
 * Route a post-application email with TypeSafe Jev.
 *
 * One request carries three independent judgments over the same email:
 * whether it is part of a job application (Noul), which stage it signals
 * (Choice), and which active job it is about (Choice, with a "none" option).
 * Code turns the calibrated answers into the same result the LLM router
 * returns. Auto-linking needs every judgment to be confident, so low
 * confidence lands in the "pending" review queue instead of acting.
 */

import { messageTypeFromStageTarget } from "@server/services/post-application/stage-target";
import type { PostApplicationRouterStageTarget } from "@shared/types";
import { choice, noul } from "@typesafe-ai/sdk";
import type {
  IndexedActiveJob,
  SmartRouterResult,
} from "../post-application/ingestion/email-router";
import { getJevClient } from "./client";

/** Below this, a stage judgment is not trusted and the stage is left unchanged. */
export const STAGE_MIN_CONFIDENCE = 0.5;
/** Below this, "which job" is not trusted enough to link the email to one. */
export const JOB_MIN_CONFIDENCE = 0.5;
export const NO_JOB_OPTION = "none";

const STAGE_DESCRIPTIONS: Record<PostApplicationRouterStageTarget, string> = {
  no_change:
    "Related to the application but does not move it to a new stage, such as a generic update or a question",
  applied:
    "Confirms an application was received or submitted, for example an automatic acknowledgement",
  recruiter_screen:
    "Invites the candidate to an introductory call or screen with a recruiter or HR",
  assessment:
    "Sends or schedules a take-home task, coding test, online assessment or case study",
  hiring_manager_screen:
    "Invites the candidate to speak with the hiring manager or a team lead",
  technical_interview:
    "Invites the candidate to a technical interview or technical deep-dive",
  onsite:
    "Invites the candidate to a final round, panel or on-site (or virtual on-site) interview day",
  offer: "Offers the candidate the job or sends offer details",
  rejected:
    "Tells the candidate they were not selected or the application is unsuccessful",
  withdrawn: "Confirms the candidate withdrew from the process",
  closed:
    "Says the role was closed, filled or cancelled without a decision about the candidate",
};

type ChoiceAnswer = {
  choice: string;
  confidence: number;
  probabilities: Readonly<Record<string, number>>;
};

export type EmailRoutingAnswers = {
  relevant: { noul: number };
  stage: ChoiceAnswer;
  job: ChoiceAnswer;
};

const pct = (value: number) => Math.round(value * 100);

/** Probability that the chosen option is right (never above Jev's own confidence). */
function trustedProbability(answer: ChoiceAnswer): number {
  const probability = answer.probabilities[answer.choice];
  return Math.max(
    0,
    Math.min(
      1,
      answer.confidence,
      Number.isFinite(probability) ? probability : answer.confidence,
    ),
  );
}

function jobOption(index: number): string {
  return `job_${index}`;
}

export function mapEmailAnswers(
  answers: EmailRoutingAnswers,
  jobs: IndexedActiveJob[],
): SmartRouterResult {
  const relevance = Math.max(0, Math.min(1, answers.relevant.noul));
  const isRelevant = relevance >= 0.5;

  const stageTrust = trustedProbability(answers.stage);
  const rawStage = answers.stage.choice as PostApplicationRouterStageTarget;
  const stageTarget: PostApplicationRouterStageTarget =
    isRelevant && stageTrust >= STAGE_MIN_CONFIDENCE ? rawStage : "no_change";

  const jobTrust = trustedProbability(answers.job);
  const matchedJob =
    isRelevant &&
    answers.job.choice !== NO_JOB_OPTION &&
    jobTrust >= JOB_MIN_CONFIDENCE
      ? jobs.find((job) => jobOption(job.index) === answers.job.choice)
      : undefined;

  // The router's 0-100 confidence drives auto-linking at >= 95, so use the
  // weakest of the judgments that the link and its stage event depend on.
  const linkTrust = Math.min(
    relevance,
    jobTrust,
    stageTarget === "no_change" ? 1 : stageTrust,
  );
  const confidence = matchedJob
    ? pct(linkTrust)
    : isRelevant
      ? pct(relevance)
      : 0;

  const reason = [
    `Jev: relevant ${relevance.toFixed(2)}`,
    `stage ${rawStage} (${stageTrust.toFixed(2)})${stageTarget !== rawStage ? " not trusted" : ""}`,
    matchedJob
      ? `job ${matchedJob.company}: ${matchedJob.title} (${jobTrust.toFixed(2)})`
      : "no confident job match",
  ].join("; ");

  return {
    bestMatchId: matchedJob?.id ?? null,
    confidence,
    stageTarget,
    messageType: messageTypeFromStageTarget(stageTarget),
    isRelevant,
    stageEventPayload: null,
    reason,
  };
}

export async function classifyEmailWithJev(args: {
  emailText: string;
  jobs: IndexedActiveJob[];
}): Promise<SmartRouterResult> {
  const jobCriteria: Record<string, string> = {
    [NO_JOB_OPTION]:
      "The email is not clearly about any of the listed jobs, or the company and role do not match any of them",
  };
  for (const job of args.jobs) {
    jobCriteria[jobOption(job.index)] = `${job.company}: ${job.title}`;
  }

  const { answers } = await getJevClient().systemOne({
    state: { email: args.emailText },
    questions: {
      relevant: noul(
        "Is `email` part of a job application process, such as an acknowledgement, interview scheduling, assessment, offer or rejection, rather than marketing, a newsletter, a job alert or unrelated mail?",
      ),
      stage: choice(
        "Which application stage does `email` signal?",
        STAGE_DESCRIPTIONS,
      ),
      job: choice(
        "Which of these job applications is `email` about? Match on the company and role it names or that the sender represents.",
        jobCriteria,
      ),
    },
  });

  return mapEmailAnswers(answers as unknown as EmailRoutingAnswers, args.jobs);
}
