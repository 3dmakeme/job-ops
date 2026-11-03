// `/jobs/view/<id>`, `/comm/jobs/view/<id>` or `/jobs/view/<slug>-<id>`.
const JOB_VIEW_PATH = /^\/(?:comm\/)?jobs\/view\/(?:[^/]+-)?(\d+)\/?$/;
const JOB_VIEW_SEGMENT = /\/jobs\/view\//;

export type NormalizedLinkedInJobUrl = {
  jobUrl: string;
  sourceJobId?: string;
};

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isLinkedInHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "linkedin.com" || host.endsWith(".linkedin.com");
}

/** The URL itself, then each query-parameter value that is an http(s) URL. */
function candidateUrls(url: URL): URL[] {
  const nested = [...url.searchParams.values()].flatMap((value) => {
    const parsed = parseHttpUrl(value);
    return parsed ? [parsed] : [];
  });
  return [url, ...nested];
}

/**
 * Whether the link points at a LinkedIn job page, directly or through a
 * redirect wrapper, even when no job id can be derived from it.
 */
export function isLinkedInJobLink(raw: string): boolean {
  const url = parseHttpUrl(raw);
  if (!url) return false;
  return candidateUrls(url).some(
    (candidate) =>
      isLinkedInHost(candidate) && JOB_VIEW_SEGMENT.test(candidate.pathname),
  );
}

/**
 * Clean `https://www.linkedin.com/jobs/view/<id>` form when a job id can be
 * derived, otherwise the trimmed link as given. `null` for anything that is
 * not an http(s) URL.
 */
export function normalizeLinkedInJobUrl(
  raw: string,
): NormalizedLinkedInJobUrl | null {
  const url = parseHttpUrl(raw);
  if (!url) return null;
  for (const candidate of candidateUrls(url)) {
    if (!isLinkedInHost(candidate)) continue;
    const match = JOB_VIEW_PATH.exec(candidate.pathname);
    if (match) {
      return {
        jobUrl: `https://www.linkedin.com/jobs/view/${match[1]}`,
        sourceJobId: match[1],
      };
    }
  }
  return { jobUrl: raw.trim() };
}
