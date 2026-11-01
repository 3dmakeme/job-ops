import { describe, expect, it } from "vitest";
import {
  applyTailoredCompetencies,
  extractCompetencyLines,
  extractProjectsFromResume,
  parseTailoredCompetencies,
} from "./tailoring";

describe("rxresume tailoring", () => {
  it("strips html from project catalog descriptions", () => {
    const { catalog, selectionItems } = extractProjectsFromResume({
      sections: {
        projects: {
          items: [
            {
              id: "p1",
              name: "Analytics",
              description:
                "<ul><li><p><strong>Built analytics</strong> using FastAPI.</p></li></ul>",
              hidden: false,
              period: "2024",
            },
          ],
        },
      },
    });

    expect(catalog[0].description).toBe("Built analytics using FastAPI.");
    expect(selectionItems[0].summaryText).toBe(
      "Built analytics using FastAPI.",
    );
  });

  describe("core competencies", () => {
    const resume = () => ({
      customSections: [
        {
          id: "s1",
          title: "Core Competencies",
          type: "awards",
          hidden: false,
          columns: 1,
          items: [
            {
              id: "a",
              hidden: false,
              title: "AI Platforms",
              awarder: "",
              date: "",
              description: "<p>Embedded <strong>AI</strong></p>",
            },
            {
              id: "b",
              hidden: true,
              title: "Hidden",
              awarder: "",
              date: "",
              description: "",
            },
          ],
        },
        { id: "s2", title: "Other", type: "summary", items: [] },
      ],
    });

    it("extracts visible competencies as Title — description lines", () => {
      expect(extractCompetencyLines(resume())).toEqual([
        "AI Platforms — Embedded AI",
      ]);
    });

    it("returns no lines when the section is absent", () => {
      expect(extractCompetencyLines({ customSections: [] })).toEqual([]);
      expect(extractCompetencyLines({})).toEqual([]);
    });

    it("replaces the items with tailored lines using the item shape", () => {
      const data = resume();
      applyTailoredCompetencies(data, [
        "Data Governance — GDPR by design",
        "Leadership",
      ]);
      const items = data.customSections[0].items as Array<
        Record<string, unknown>
      >;
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({
        title: "Data Governance",
        description: "<p>GDPR by design</p>",
        hidden: false,
      });
      expect(items[1]).toMatchObject({ title: "Leadership", description: "" });
      expect(items[0].id).not.toBe(items[1].id);
    });

    it("stores tailored text in content for summary-type items", () => {
      const data = {
        customSections: [
          {
            title: "Core Competencies",
            items: [{ id: "x", hidden: false, content: "<p>old</p>" }],
          },
        ],
      };
      applyTailoredCompetencies(data, JSON.stringify(["New — text"]));
      expect(data.customSections[0].items[0]).toMatchObject({
        content: "<p>New — text</p>",
      });
    });

    it("ignores invalid or empty tailored input", () => {
      const data = resume();
      applyTailoredCompetencies(data, "not json");
      applyTailoredCompetencies(data, []);
      expect(data.customSections[0].items).toHaveLength(2);
      expect(parseTailoredCompetencies('["a"," "]')).toEqual(["a"]);
    });
  });
});
