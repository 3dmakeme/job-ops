import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ParsedMail, simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { PARSER_OPTIONS } from "../post-application/ingestion/imap-sync";
import {
  isLinkedInAlertSender,
  LINKEDIN_ALERT_SENDERS,
  parseLinkedInAlertEmail,
} from "./alert-parser";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
);

function fixture(name: string): Buffer {
  return readFileSync(join(fixturesDir, name));
}

function parse(source: Buffer | string): Promise<ParsedMail> {
  return simpleParser(source, PARSER_OPTIONS);
}

function message(headers: string[], body: string): string {
  return [...headers, "", body].join("\r\n");
}

describe("parseLinkedInAlertEmail", () => {
  it("parses one listing per distinct job from the text part of fixture (a)", async () => {
    const parsed = await parse(fixture("multipart-alert.eml"));

    expect(isLinkedInAlertSender(parsed)).toBe(true);
    expect(parseLinkedInAlertEmail(parsed)).toEqual([
      {
        title: "Senior Platform Engineer",
        company: "Example Robotics",
        location: "London, England, United Kingdom",
        jobUrl: "https://www.linkedin.com/jobs/view/4012345678",
        sourceJobId: "4012345678",
      },
      {
        title: "Data Engineer",
        company: "Sample Analytics Ltd",
        location: "Manchester, England, United Kingdom",
        jobUrl: "https://www.linkedin.com/jobs/view/4012345679",
        sourceJobId: "4012345679",
      },
      {
        title: "Site Reliability Engineer",
        company: "Demo Cloud",
        location: "London Area, United Kingdom",
        jobUrl: "https://www.linkedin.com/jobs/view/4012345680",
        sourceJobId: "4012345680",
      },
    ]);
  });

  it("parses the HTML of an alert without a text part, fixture (b)", async () => {
    const parsed = await parse(fixture("html-only-alert.eml"));

    expect(parsed.text).toBeFalsy();
    expect(isLinkedInAlertSender(parsed)).toBe(true);
    expect(parseLinkedInAlertEmail(parsed)).toEqual([
      {
        title: "Junior Data Analyst",
        company: "Northwind Traders",
        location: "Bristol, England, United Kingdom",
        jobUrl: "https://www.linkedin.com/jobs/view/4087654321",
        sourceJobId: "4087654321",
      },
      {
        title: "Analytics Engineer",
        company: "Contoso",
        location: "Cardiff, Wales, United Kingdom",
        jobUrl: "https://www.linkedin.com/jobs/view/4087654322",
        sourceJobId: "4087654322",
      },
    ]);
  });

  it("does not treat a non-allowlisted LinkedIn sender as an alert, fixture (c)", async () => {
    const parsed = await parse(fixture("non-alert-sender.eml"));

    expect(parsed.from?.value[0]?.address).toBe(
      "messages-noreply@linkedin.com",
    );
    expect(isLinkedInAlertSender(parsed)).toBe(false);
  });

  it("keeps a job link without a derivable id as given, fixture (d)", async () => {
    const parsed = await parse(fixture("no-job-id-alert.eml"));

    expect(parseLinkedInAlertEmail(parsed)).toEqual([
      {
        title: "Backend Developer",
        company: "Example Labs",
        location: "Leeds, England, United Kingdom",
        jobUrl:
          "https://www.linkedin.com/comm/jobs/view/backend-developer-at-example-labs/?trackingId=xyz",
      },
    ]);
  });

  it("matches allowlisted senders case-insensitively", async () => {
    expect(LINKEDIN_ALERT_SENDERS).toEqual([
      "jobalerts-noreply@linkedin.com",
      "jobs-listings@linkedin.com",
    ]);
    const parsed = await parse(
      message(["From: JobAlerts-NoReply@LinkedIn.com"], "Hello"),
    );
    expect(isLinkedInAlertSender(parsed)).toBe(true);
  });

  it("drops listings without a company, title or usable link", async () => {
    const parsed = await parse(
      message(
        [
          "From: jobalerts-noreply@linkedin.com",
          "Content-Type: text/plain; charset=utf-8",
        ],
        [
          "Only A Title",
          "View job: https://www.linkedin.com/jobs/view/1/",
          "",
          "View job: https://www.linkedin.com/jobs/view/2/",
          "",
          "Engineer",
          "Acme",
          "View job: https://www.linkedin.com/jobs/view/3/",
        ].join("\r\n"),
      ),
    );

    expect(parseLinkedInAlertEmail(parsed)).toEqual([
      {
        title: "Engineer",
        company: "Acme",
        jobUrl: "https://www.linkedin.com/jobs/view/3",
        sourceJobId: "3",
      },
    ]);
  });

  it("rejects non-http(s) links in HTML", async () => {
    const parsed = await parse(
      message(
        [
          "From: jobalerts-noreply@linkedin.com",
          "Content-Type: text/html; charset=utf-8",
        ],
        "<div><a href=\"javascript:alert('/jobs/view/1')\">Engineer</a><p>Acme</p></div>",
      ),
    );

    expect(parseLinkedInAlertEmail(parsed)).toEqual([]);
  });

  it("does not take a card's text from a neighbouring job", async () => {
    const parsed = await parse(
      message(
        [
          "From: jobalerts-noreply@linkedin.com",
          "Content-Type: text/html; charset=utf-8",
        ],
        [
          "<div>",
          '<div><a href="https://www.linkedin.com/jobs/view/1">No Company Job</a></div>',
          '<div><a href="https://www.linkedin.com/jobs/view/2">Engineer</a><p>Acme</p></div>',
          "</div>",
        ].join(""),
      ),
    );

    expect(parseLinkedInAlertEmail(parsed)).toEqual([
      {
        title: "Engineer",
        company: "Acme",
        jobUrl: "https://www.linkedin.com/jobs/view/2",
        sourceJobId: "2",
      },
    ]);
  });
});
