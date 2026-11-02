/**
 * Score a job's suitability for the candidate with TypeSafe Jev.
 *
 * One request carries four graded Score questions (domain, seniority, skills,
 * overall fit). Code turns each into a probability-weighted 0..1 value and
 * combines them with fixed weights, so the number is a composite of reusable
 * judgments rather than a single generated figure. The reason text is
 * assembled from those judgments; Jev never writes prose.
 */

import { stripHtmlTags } from "@shared/utils/string";
import { score } from "@typesafe-ai/sdk";
import { getJevClient } from "./client";
import { expectedLevel } from "./project-ranking";

const JOB_DESCRIPTION_CHAR_LIMIT = 6000;
const SUMMARY_CHAR_LIMIT = 900;
const EXPERIENCE_CHAR_LIMIT = 350;
const MAX_EXPERIENCE_ITEMS = 6;
const MAX_SKILL_ITEMS = 12;

export const SCORE_WEIGHTS = {
  domain: 0.3,
  level: 0.2,
  skills: 0.2,
  overall: 0.3,
} as const;

type Dimension = keyof typeof SCORE_WEIGHTS;

const LEVELS: Record<Dimension, readonly string[]> = {
  domain: [
    "No overlap: a different field from the candidate's background",
    "Adjacent: a related field but the core work differs",
    "Strong overlap: the core work is in the candidate's main field",
    "Direct match: the role is the candidate's own specialism",
  ],
  level: [
    "Far below: a junior or individual contributor role well below the candidate's seniority",
    "Somewhat below or lateral: a senior individual contributor or team lead role",
    "Matches: a head-of, director or senior manager role leading teams",
    "Matches or above: VP, chief or executive scope the candidate has operated at",
  ],
  skills: [
    "Almost none of the required skills or technologies appear in the candidate's background",
    "A few required skills appear in the candidate's background",
    "Most required skills appear in the candidate's background",
    "Nearly all required skills and technologies appear in the candidate's background",
  ],
  overall: [
    "Poor fit: the candidate should not apply",
    "Weak fit: significant mismatch in role, level or skills",
    "Good fit: worth applying with minor gaps",
    "Excellent fit: the role closely matches the candidate's goals, level and experience",
  ],
};

const SHORT_LABELS: Record<Dimension, readonly string[]> = {
  domain: ["different field", "adjacent field", "strong overlap", "direct match"],
  level: ["well below level", "below or lateral", "right level", "right level or above"],
  skills: ["few skills match", "some skills match", "most skills match", "nearly all skills match"],
  overall: ["poor fit", "weak fit", "good fit", "excellent fit"],
};

type ProfileRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is ProfileRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function text(value: unknown, limit: number): string {
  return typeof value === "string"
    ? stripHtmlTags(value).replace(/\s+/g, " ").trim().slice(0, limit)
    : "";
}

function sectionItems(profile: ProfileRecord, key: string): ProfileRecord[] {
  const sections = isRecord(profile.sections) ? profile.sections : {};
  const section = sections[key];
  const raw = isRecord(section) ? section.items : profile[key];
  return Array.isArray(raw)
    ? raw.filter(isRecord).filter((item) => item.hidden !== true)
    : [];
}

/** A compact, stable view of the resume for Jev's state. */
export function buildCandidateState(profile: ProfileRecord) {
  const basics = isRecord(profile.basics) ? profile.basics : {};
  const summary = isRecord(profile.summary)
    ? text(profile.summary.content, SUMMARY_CHAR_LIMIT)
    : text(basics.summary, SUMMARY_CHAR_LIMIT);

  return {
    headline: text(basics.headline ?? basics.label, 200),
    summary,
    experience: sectionItems(profile, "experience")
      .slice(0, MAX_EXPERIENCE_ITEMS)
      .map((item) => ({
        company: text(item.company, 80),
        role: text(item.position, 120),
        period: text(item.period ?? item.date, 60),
        highlights: text(
          item.description ?? item.summary,
          EXPERIENCE_CHAR_LIMIT,
        ),
      })),
    skills: sectionItems(profile, "skills")
      .slice(0, MAX_SKILL_ITEMS)
      .map((item) => {
        const keywords = Array.isArray(item.keywords)
          ? item.keywords.filter((k) => typeof k === "string").join(", ")
          : "";
        return text(`${item.name ?? ""}: ${keywords} ${item.description ?? ""}`, 300);
      })
      .filter(Boolean),
  };
}

export function combineScores(parts: Record<Dimension, number>): number {
  const total = (Object.keys(SCORE_WEIGHTS) as Dimension[]).reduce(
    (sum, key) => sum + SCORE_WEIGHTS[key] * parts[key],
    0,
  );
  return Math.min(100, Math.max(0, Math.round(total * 100)));
}

export function buildReason(parts: Record<Dimension, number>): string {
  const label = (key: Dimension) => {
    const levels = SHORT_LABELS[key];
    return levels[Math.min(levels.length - 1, Math.round(parts[key] * (levels.length - 1)))];
  };
  return `TypeSafe Jev: ${label("domain")}, ${label("level")}, ${label("skills")}; overall ${label("overall")}.`;
}

export type JevJobScore = {
  score: number;
  reason: string;
  parts: Record<Dimension, number>;
};

export async function scoreJobWithJev(
  job: {
    title?: string | null;
    employer?: string | null;
    location?: string | null;
    workFromHomeType?: string | null;
    salary?: string | null;
    jobDescription?: string | null;
  },
  profile: ProfileRecord,
): Promise<JevJobScore> {
  const description = stripHtmlTags(job.jobDescription ?? "").slice(
    0,
    JOB_DESCRIPTION_CHAR_LIMIT,
  );
  if (!description.trim()) {
    throw new Error("Job has no description for Jev to score");
  }

  const questions = {
    domain: score(
      "How closely does the job's domain and day-to-day work match the candidate's background (`candidate`)?",
      LEVELS.domain,
    ),
    level: score(
      "How well does the seniority and scope of the job match the candidate's level (`candidate.experience`)?",
      LEVELS.level,
    ),
    skills: score(
      "How much of the job's required skills and technologies does the candidate (`candidate.skills`, `candidate.experience`) demonstrably have?",
      LEVELS.skills,
    ),
    overall: score(
      "Overall, how suitable is this job for the candidate (`candidate`) as a next role?",
      LEVELS.overall,
    ),
  };

  const response = await getJevClient().systemOne({
    state: {
      candidate: buildCandidateState(profile),
      job: {
        title: job.title ?? "",
        employer: job.employer ?? "",
        location: job.location ?? "",
        remote: job.workFromHomeType ?? "",
        salary: job.salary ?? "",
        description,
      },
    },
    questions,
  });

  const answers = response.answers as Record<
    Dimension,
    Parameters<typeof expectedLevel>[0]
  >;
  const parts = {
    domain: expectedLevel(answers.domain, LEVELS.domain.length),
    level: expectedLevel(answers.level, LEVELS.level.length),
    skills: expectedLevel(answers.skills, LEVELS.skills.length),
    overall: expectedLevel(answers.overall, LEVELS.overall.length),
  };
  return { score: combineScores(parts), reason: buildReason(parts), parts };
}
