// `/jobs/view/<id>`, `/comm/jobs/view/<id>` or `/jobs/view/<slug>-<id>`.
const JOB_VIEW_PATH = /^\/(?:comm\/)?jobs\/view\/(?:[^/]+-)?(\d+)\/?$/;

export type NormalizedLinkedInJobUrl = {
  jobUrl: string;
  sourceJobId: string;
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
 * Clean `https://www.linkedin.com/jobs/view/<id>` form of a LinkedIn job
 * link, given directly or inside a redirect wrapper's query value. `null` for
 * anything else: no derivable job id, a host that is not linkedin.com or one
 * of its subdomains, or a scheme other than http(s). Links are never kept as
 * given, so a forged alert cannot point a job at another site.
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
  return null;
}
