import { normalizeWhitespace } from "@shared/utils/string";
import { JSDOM } from "jsdom";
import type { ParsedMail } from "mailparser";
import { isLinkedInJobLink, normalizeLinkedInJobUrl } from "./job-url";

/** Senders whose mail is read as a LinkedIn job alert. */
export const LINKEDIN_ALERT_SENDERS: readonly string[] = [
  "jobalerts-noreply@linkedin.com",
  "jobs-listings@linkedin.com",
];

export type LinkedInAlertJob = {
  title: string;
  company: string;
  location?: string;
  jobUrl: string;
  sourceJobId?: string;
};

type RawListing = {
  title?: string;
  company?: string;
  location?: string;
  href: string;
};

const URL_PATTERN = /https?:\/\/[^\s<>"]+/i;
const VIEW_JOB_LABEL = /^view job\b/i;
const SEPARATOR_LINE = /^[-=_*·•\s]+$/;
const CARD_TEXT_SEPARATOR = /[·•|]/;
const NON_CONTENT_TAGS = new Set(["HEAD", "SCRIPT", "STYLE", "TITLE"]);

export function isLinkedInAlertSender(parsed: ParsedMail): boolean {
  const address = parsed.from?.value[0]?.address?.trim().toLowerCase();
  return Boolean(address && LINKEDIN_ALERT_SENDERS.includes(address));
}

/**
 * A listing is a block of non-empty lines (title, company, optional location)
 * followed by a line holding its job link. Blank, separator and other link
 * lines end a block.
 */
function parseTextListings(text: string): RawListing[] {
  const listings: RawListing[] = [];
  let block: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeWhitespace(rawLine);
    if (!line || SEPARATOR_LINE.test(line)) {
      block = [];
      continue;
    }
    const href = URL_PATTERN.exec(line)?.[0];
    if (href) {
      if (VIEW_JOB_LABEL.test(line) || isLinkedInJobLink(href)) {
        const [title, company, location] = block.slice(-3);
        listings.push({ title, company, location, href });
      }
      block = [];
      continue;
    }
    block.push(line);
  }
  return listings;
}

/** Text outside links, split on the separators cards use between fields. */
function cardTextSegments(element: Element): string[] {
  const document = element.ownerDocument;
  const walker = document.createTreeWalker(element, 4 /* SHOW_TEXT */);
  const segments: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest("a") || NON_CONTENT_TAGS.has(parent.tagName))
      continue;
    for (const part of (node.textContent ?? "").split(CARD_TEXT_SEPARATOR)) {
      const segment = normalizeWhitespace(part);
      if (segment) segments.push(segment);
    }
  }
  return segments;
}

function parseHtmlListings(html: string): RawListing[] {
  const { document } = new JSDOM(html).window;
  const jobAnchors = [...document.querySelectorAll("a[href]")].flatMap(
    (anchor) => {
      const href = anchor.getAttribute("href")?.trim() ?? "";
      if (!isLinkedInJobLink(href)) return [];
      const key = normalizeLinkedInJobUrl(href)?.sourceJobId ?? href;
      return [{ anchor, href, key }];
    },
  );

  const keys = [...new Set(jobAnchors.map((entry) => entry.key))];
  return keys.flatMap((key) => {
    const titled = jobAnchors.find(
      (entry) =>
        entry.key === key &&
        normalizeWhitespace(entry.anchor.textContent ?? ""),
    );
    if (!titled) return [];

    // The card is the closest ancestor with text of its own that holds no
    // other job's link.
    let segments: string[] = [];
    for (
      let element = titled.anchor.parentElement;
      element && element !== document.documentElement;
      element = element.parentElement
    ) {
      const holdsOtherJob = jobAnchors.some(
        (entry) => entry.key !== key && element?.contains(entry.anchor),
      );
      if (holdsOtherJob) break;
      segments = cardTextSegments(element);
      if (segments.length > 0) break;
    }

    const [company, location] = segments;
    return [
      {
        title: titled.anchor.textContent ?? "",
        company,
        location,
        href: titled.href,
      },
    ];
  });
}

/**
 * Job listings in a LinkedIn alert email: the text/plain part when there is
 * one, otherwise the HTML. Listings without a title, company or usable link
 * are dropped, and repeats of a job URL are collapsed.
 */
export function parseLinkedInAlertEmail(
  parsed: ParsedMail,
): LinkedInAlertJob[] {
  const text = parsed.text?.trim();
  const rawListings = text
    ? parseTextListings(text)
    : typeof parsed.html === "string"
      ? parseHtmlListings(parsed.html)
      : [];

  const jobs = new Map<string, LinkedInAlertJob>();
  for (const raw of rawListings) {
    const title = normalizeWhitespace(raw.title ?? "");
    const company = normalizeWhitespace(raw.company ?? "");
    const location = normalizeWhitespace(raw.location ?? "");
    const url = normalizeLinkedInJobUrl(raw.href);
    if (!title || !company || !url || jobs.has(url.jobUrl)) continue;
    jobs.set(url.jobUrl, {
      title,
      company,
      ...(location ? { location } : {}),
      jobUrl: url.jobUrl,
      ...(url.sourceJobId ? { sourceJobId: url.sourceJobId } : {}),
    });
  }
  return [...jobs.values()];
}
