/**
 * Rank resume projects against a job description with TypeSafe Jev.
 *
 * One request carries two graded Score questions per project: how relevant the
 * project is to what the job asks for, and how much real-world impact it
 * shows. Code combines them with fixed weights, so ranking is selection, not
 * generation: Jev cannot invent a project.
 */

import { stripHtmlTags } from "@shared/utils/string";
import { score } from "@typesafe-ai/sdk";
import type { ResumeProjectSelectionItem } from "../resumeProjects";
import { getJevClient } from "./client";

const JOB_DESCRIPTION_CHAR_LIMIT = 6000;
const PROJECT_SUMMARY_CHAR_LIMIT = 500;

export const RELEVANCE_WEIGHT = 0.75;
export const IMPACT_WEIGHT = 0.25;

const RELEVANCE_LEVELS = [
  "Unrelated: shares no technologies, domain or skills with the job",
  "Tangential: touches the job's field but not its core requirements",
  "Relevant: uses several technologies or skills the job asks for",
  "Highly relevant: directly matches the job's core stack or domain",
] as const;

const IMPACT_LEVELS = [
  "Little evidence of real-world use or impact",
  "Some evidence of real use, such as users, deployment or scale",
  "Clear real-world engineering impact with concrete outcomes",
] as const;

export type RankedProject = {
  id: string;
  relevance: number;
  impact: number;
  score: number;
};

type ScoreAnswer = {
  score: number;
  probabilities: Readonly<Record<number, number>>;
};

/** Probability-weighted level, scaled to 0..1 so ties between projects break smoothly. */
export function expectedLevel(answer: ScoreAnswer, levelCount: number): number {
  const top = levelCount - 1;
  if (top <= 0) return 0;
  let total = 0;
  let weight = 0;
  for (const [level, probability] of Object.entries(answer.probabilities)) {
    const p = Number(probability);
    if (!Number.isFinite(p) || p <= 0) continue;
    total += Number(level) * p;
    weight += p;
  }
  const expected = weight > 0 ? total / weight : answer.score;
  return Math.min(1, Math.max(0, expected / top));
}

export function combineProjectScores(relevance: number, impact: number) {
  return RELEVANCE_WEIGHT * relevance + IMPACT_WEIGHT * impact;
}

export function buildProjectState(
  jobDescription: string,
  projects: ResumeProjectSelectionItem[],
) {
  return {
    jobDescription: stripHtmlTags(jobDescription).slice(
      0,
      JOB_DESCRIPTION_CHAR_LIMIT,
    ),
    projects: projects.map((project) => ({
      name: project.name,
      description: project.description,
      summary: project.summaryText.slice(0, PROJECT_SUMMARY_CHAR_LIMIT),
    })),
  };
}

export async function rankProjectsWithJev(args: {
  jobDescription: string;
  projects: ResumeProjectSelectionItem[];
}): Promise<RankedProject[]> {
  if (args.projects.length === 0) return [];

  const questions: Record<
    string,
    ReturnType<typeof score<typeof RELEVANCE_LEVELS | typeof IMPACT_LEVELS>>
  > = {};
  args.projects.forEach((_, index) => {
    questions[`relevance_${index}`] = score(
      `How relevant is \`projects[${index}]\` to what \`jobDescription\` asks for in skills, technologies and domain?`,
      RELEVANCE_LEVELS,
    );
    questions[`impact_${index}`] = score(
      `How much real-world engineering impact does \`projects[${index}]\` show?`,
      IMPACT_LEVELS,
    );
  });

  const { answers } = await getJevClient().systemOne({
    state: buildProjectState(args.jobDescription, args.projects),
    questions,
  });

  return args.projects.map((project, index) => {
    const relevance = expectedLevel(
      answers[`relevance_${index}`] as ScoreAnswer,
      RELEVANCE_LEVELS.length,
    );
    const impact = expectedLevel(
      answers[`impact_${index}`] as ScoreAnswer,
      IMPACT_LEVELS.length,
    );
    return {
      id: project.id,
      relevance,
      impact,
      score: combineProjectScores(relevance, impact),
    };
  });
}

/** Highest combined score first; equal scores keep the resume's own order. */
export function pickTopProjectIds(
  ranked: RankedProject[],
  count: number,
): string[] {
  return ranked
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.score - a.item.score || a.index - b.index)
    .slice(0, Math.max(0, count))
    .map(({ item }) => item.id);
}
