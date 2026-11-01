import { createId } from "@paralleldrive/cuid2";
import type { ResumeProjectCatalogItem } from "@shared/types";
import { stripHtmlTags } from "@shared/utils/string";

type RecordLike = Record<string, unknown>;

export type TailoredSkillsInput =
  | Array<{ name: string; keywords: string[] }>
  | string
  | null
  | undefined;

export type TailoredCompetenciesInput = string[] | string | null | undefined;

export type TailorChunkInput = {
  headline?: string | null;
  summary?: string | null;
  skills?: TailoredSkillsInput;
  competencies?: TailoredCompetenciesInput;
};

export type ResumeProjectSelectionItem = ResumeProjectCatalogItem & {
  summaryText: string;
};

export function cloneResumeData<T>(data: T): T {
  return JSON.parse(JSON.stringify(data)) as T;
}

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function parseTailoredSkills(
  skills: TailoredSkillsInput,
): Array<RecordLike> | null {
  if (!skills) return null;
  const parsed = Array.isArray(skills)
    ? skills
    : typeof skills === "string"
      ? (JSON.parse(skills) as unknown)
      : null;
  if (!Array.isArray(parsed)) return null;
  return parsed.filter(
    (item) => item && typeof item === "object",
  ) as RecordLike[];
}

export function applyTailoredHeadline(
  resumeData: RecordLike,
  headline?: string | null,
): void {
  if (!headline) return;
  const basics = asRecord(resumeData.basics);
  if (!basics) return;
  basics.headline = headline;
  // Preserve current behavior for legacy consumers/templates that use label.
  basics.label = headline;
}

export function applyTailoredSummary(
  resumeData: RecordLike,
  summary?: string | null,
): void {
  if (!summary) return;
  const topSummary = asRecord(resumeData.summary);
  if (topSummary) {
    if (
      typeof topSummary.content === "string" ||
      topSummary.content === undefined
    ) {
      topSummary.content = summary;
      return;
    }
    if (
      typeof topSummary.value === "string" ||
      topSummary.value === undefined
    ) {
      topSummary.value = summary;
      return;
    }
  }

  const sections = asRecord(resumeData.sections);
  const summarySection = asRecord(sections?.summary);
  if (summarySection) {
    summarySection.content = summary;
    return;
  }
}

export function applyTailoredSkills(
  resumeData: RecordLike,
  tailoredSkills?: TailoredSkillsInput,
): void {
  const skills = parseTailoredSkills(tailoredSkills);
  if (!skills) return;

  const sections = asRecord(resumeData.sections);
  const skillsSection = asRecord(sections?.skills);
  const existingItems = asArray(skillsSection?.items);
  if (!skillsSection || !existingItems) return;
  const existing = existingItems
    .map((item) => asRecord(item))
    .filter((item): item is RecordLike => Boolean(item));

  const template = existing[0] ?? null;
  if (!template) return;

  skillsSection.items = skills.map((newSkill) => {
    const match =
      existing.find((item) => item.name === newSkill.name) ?? template;
    const next: RecordLike = { ...match };

    if ("id" in next) {
      next.id =
        (typeof newSkill.id === "string" && newSkill.id) ||
        (typeof match.id === "string" ? match.id : "") ||
        createId();
    }
    if ("name" in next) {
      next.name =
        (typeof newSkill.name === "string" ? newSkill.name : "") ||
        (typeof match.name === "string" ? match.name : "");
    }
    if ("keywords" in next) {
      next.keywords = Array.isArray(newSkill.keywords)
        ? newSkill.keywords.filter((k) => typeof k === "string")
        : Array.isArray(match.keywords)
          ? match.keywords.filter((k) => typeof k === "string")
          : [];
    }

    if ("description" in next) {
      next.description =
        typeof newSkill.description === "string"
          ? newSkill.description
          : typeof match.description === "string"
            ? match.description
            : "";
    }
    if ("proficiency" in next) {
      next.proficiency =
        typeof newSkill.proficiency === "string"
          ? newSkill.proficiency
          : typeof newSkill.description === "string"
            ? newSkill.description
            : typeof match.proficiency === "string"
              ? match.proficiency
              : "";
    }
    if ("level" in next) {
      next.level =
        typeof newSkill.level === "number"
          ? newSkill.level
          : typeof match.level === "number"
            ? match.level
            : next.level;
    }
    if ("hidden" in next) {
      next.hidden =
        typeof newSkill.hidden === "boolean"
          ? newSkill.hidden
          : typeof match.hidden === "boolean"
            ? match.hidden
            : next.hidden;
    }

    return next;
  });
}

export function extractProjectsFromResume(resumeData: RecordLike): {
  catalog: ResumeProjectCatalogItem[];
  selectionItems: ResumeProjectSelectionItem[];
} {
  const sections = asRecord(resumeData.sections);
  const projectsSection = asRecord(sections?.projects);
  const items = asArray(projectsSection?.items);
  if (!items) return { catalog: [], selectionItems: [] };

  const catalog: ResumeProjectCatalogItem[] = [];
  const selectionItems: ResumeProjectSelectionItem[] = [];

  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) continue;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) continue;

    const name = typeof item.name === "string" ? item.name : id;
    const description =
      typeof item.description === "string"
        ? stripHtmlTags(item.description)
        : "";
    const date = typeof item.period === "string" ? item.period : "";

    const isVisibleInBase = !(typeof item.hidden === "boolean"
      ? item.hidden
      : false);

    const summaryRaw = description;

    const base: ResumeProjectCatalogItem = {
      id,
      name,
      description,
      date,
      isVisibleInBase,
    };
    catalog.push(base);
    selectionItems.push({
      ...base,
      summaryText: stripHtmlTags(summaryRaw),
    });
  }

  return { catalog, selectionItems };
}

export function applyProjectVisibility(args: {
  resumeData: RecordLike;
  selectedProjectIds: ReadonlySet<string>;
  forceVisibleProjectsSection?: boolean;
}): void {
  const sections = asRecord(args.resumeData.sections);
  const projectsSection = asRecord(sections?.projects);
  const items = asArray(projectsSection?.items);
  if (!projectsSection || !items) return;

  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) continue;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) continue;

    if ("hidden" in item) {
      item.hidden = !args.selectedProjectIds.has(id);
    }
  }

  if (args.forceVisibleProjectsSection !== false) {
    if ("hidden" in projectsSection) {
      projectsSection.hidden = false;
    }
  }
}

const COMPETENCIES_TITLE_PATTERN = /competenc/i;
const COMPETENCY_SEPARATOR = " — ";

function findCompetenciesSection(resumeData: RecordLike): RecordLike | null {
  const sections = asArray(resumeData.customSections) ?? [];
  for (const raw of sections) {
    const section = asRecord(raw);
    if (
      section &&
      typeof section.title === "string" &&
      COMPETENCIES_TITLE_PATTERN.test(section.title) &&
      Array.isArray(section.items)
    ) {
      return section;
    }
  }
  return null;
}

function competencyItemToLine(item: RecordLike): string {
  const head = [item.title, item.name].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  const body = [item.description, item.content].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  const text = body ? stripHtmlTags(body).trim() : "";
  if (head && text) return `${head.trim()}${COMPETENCY_SEPARATOR}${text}`;
  return head?.trim() || text;
}

/** Core competencies of the base resume as "Title — description" lines. */
export function extractCompetencyLines(resumeData: RecordLike): string[] {
  const section = findCompetenciesSection(resumeData);
  if (!section) return [];
  return (asArray(section.items) ?? [])
    .map((raw) => asRecord(raw))
    .filter((item): item is RecordLike => Boolean(item) && item?.hidden !== true)
    .map(competencyItemToLine)
    .filter(Boolean);
}

export function parseTailoredCompetencies(
  value: TailoredCompetenciesInput,
): string[] | null {
  if (!value) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  const lines = parsed
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : null;
}

export function applyTailoredCompetencies(
  resumeData: RecordLike,
  competencies?: TailoredCompetenciesInput,
): void {
  const lines = parseTailoredCompetencies(competencies);
  if (!lines) return;
  const section = findCompetenciesSection(resumeData);
  if (!section) return;
  const existing = (asArray(section.items) ?? [])
    .map((raw) => asRecord(raw))
    .filter((item): item is RecordLike => Boolean(item));
  const template = existing[0];
  if (!template) return;

  section.items = lines.map((line) => {
    const separatorIndex = line.indexOf(COMPETENCY_SEPARATOR);
    const head =
      separatorIndex >= 0 ? line.slice(0, separatorIndex).trim() : line;
    const tail =
      separatorIndex >= 0
        ? line.slice(separatorIndex + COMPETENCY_SEPARATOR.length).trim()
        : "";
    const next: RecordLike = { ...template, hidden: false };
    if ("id" in next) next.id = createId();
    if ("title" in template || "name" in template) {
      const key = "title" in template ? "title" : "name";
      next[key] = head;
      if ("description" in template) next.description = tail ? `<p>${tail}</p>` : "";
      else if ("content" in template) next.content = tail ? `<p>${tail}</p>` : "";
    } else if ("content" in template) {
      next.content = `<p>${line}</p>`;
    }
    return next;
  });
}

export function applyTailoredChunks(args: {
  resumeData: RecordLike;
  tailoredContent: TailorChunkInput;
}): void {
  applyTailoredSkills(args.resumeData, args.tailoredContent.skills);
  applyTailoredCompetencies(
    args.resumeData,
    args.tailoredContent.competencies,
  );
  applyTailoredSummary(args.resumeData, args.tailoredContent.summary);
  applyTailoredHeadline(args.resumeData, args.tailoredContent.headline);
}
