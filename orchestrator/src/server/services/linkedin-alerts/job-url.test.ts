import { describe, expect, it } from "vitest";
import { normalizeLinkedInJobUrl } from "./job-url";

const CLEAN = "https://www.linkedin.com/jobs/view/123";

describe("normalizeLinkedInJobUrl", () => {
  it.each([
    [
      "a /comm/ tracking link",
      "https://www.linkedin.com/comm/jobs/view/123/?trackingId=x",
    ],
    [
      "a slug link on a country subdomain",
      "https://uk.linkedin.com/jobs/view/senior-data-lead-at-acme-123",
    ],
    [
      "a plain link with a trailing slash",
      " https://linkedin.com/jobs/view/123/ ",
    ],
    [
      "a redirect wrapper with an encoded job link",
      `https://click.example.com/redirect?u=${encodeURIComponent("https://www.linkedin.com/jobs/view/123/?refId=abc")}`,
    ],
  ])("derives the clean form from %s", (_label, raw) => {
    expect(normalizeLinkedInJobUrl(raw)).toEqual({
      jobUrl: CLEAN,
      sourceJobId: "123",
    });
  });

  it.each([
    ["a non-LinkedIn job page", "https://careers.example.com/jobs/view/123"],
    ["a look-alike host", "https://linkedin.com.evil.example/jobs/view/123"],
    ["a look-alike domain", "https://evillinkedin.com/jobs/view/123"],
    [
      "linkedin.com in the path of another host",
      "https://evil.example/linkedin.com/jobs/view/1",
    ],
    [
      "linkedin.com in the user info",
      "https://www.linkedin.com@evil.example/jobs/view/123",
    ],
    [
      "a redirect wrapper around a non-LinkedIn page",
      `https://www.linkedin.com/redir?url=${encodeURIComponent("https://evil.example/jobs/view/123")}`,
    ],
    [
      "a LinkedIn job link without a job id",
      "https://www.linkedin.com/comm/jobs/view/backend-developer/?trackingId=x",
    ],
    ["another LinkedIn page", "https://www.linkedin.com/comm/jobs/search?k=x"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a data: URL", "data:text/html,hi"],
    ["a mailto: URL", "mailto:jobs@linkedin.com"],
    ["an ftp: URL", "ftp://www.linkedin.com/jobs/view/123"],
    [
      "a non-http(s) redirect value",
      `https://click.example.com/r?u=${encodeURIComponent("javascript:void('/jobs/view/123')")}`,
    ],
    ["text that is not a URL", "not a url"],
  ])("rejects %s", (_label, raw) => {
    expect(normalizeLinkedInJobUrl(raw)).toBeNull();
  });
});
