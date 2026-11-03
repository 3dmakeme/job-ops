import { describe, expect, it } from "vitest";
import { isLinkedInJobLink, normalizeLinkedInJobUrl } from "./job-url";

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

  it("keeps a non-LinkedIn URL exactly as given, trimmed", () => {
    expect(
      normalizeLinkedInJobUrl("  https://careers.example.com/jobs/42?ref=li  "),
    ).toEqual({ jobUrl: "https://careers.example.com/jobs/42?ref=li" });
  });

  it("keeps a LinkedIn job link without a derivable id as given", () => {
    const raw =
      "https://www.linkedin.com/comm/jobs/view/backend-developer/?trackingId=x";
    expect(normalizeLinkedInJobUrl(raw)).toEqual({ jobUrl: raw });
  });

  it("does not trust job paths on look-alike hosts", () => {
    const raw = "https://linkedin.com.example.net/jobs/view/123";
    expect(normalizeLinkedInJobUrl(raw)).toEqual({ jobUrl: raw });
    expect(isLinkedInJobLink(raw)).toBe(false);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hi",
    "mailto:jobs@linkedin.com",
    "not a url",
  ])("rejects %s", (raw) => {
    expect(normalizeLinkedInJobUrl(raw)).toBeNull();
    expect(isLinkedInJobLink(raw)).toBe(false);
  });

  it("ignores a redirect value that is not an http(s) URL", () => {
    const raw = `https://click.example.com/r?u=${encodeURIComponent("javascript:void('/jobs/view/123')")}`;
    expect(normalizeLinkedInJobUrl(raw)).toEqual({ jobUrl: raw });
  });
});

describe("isLinkedInJobLink", () => {
  it("recognises direct and wrapped LinkedIn job links", () => {
    expect(
      isLinkedInJobLink("https://www.linkedin.com/comm/jobs/view/no-id/"),
    ).toBe(true);
    expect(
      isLinkedInJobLink(
        `https://click.example.com/r?u=${encodeURIComponent("https://www.linkedin.com/jobs/view/9")}`,
      ),
    ).toBe(true);
  });

  it("does not treat other LinkedIn links as job links", () => {
    expect(
      isLinkedInJobLink("https://www.linkedin.com/comm/jobs/search?keywords=x"),
    ).toBe(false);
  });
});
