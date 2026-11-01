import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getEffectiveSettings } = vi.hoisted(() => ({
  getEffectiveSettings: vi.fn(),
}));
vi.mock("@server/services/settings", () => ({ getEffectiveSettings }));

import { resetJevClientForTests, shouldUseJev } from "./client";

const settings = (engine: "llm" | "jev") => ({
  projectSelectionEngine: { value: engine },
  emailRoutingEngine: { value: engine },
});

describe("shouldUseJev", () => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  beforeEach(() => {
    getEffectiveSettings.mockReset();
    resetJevClientForTests();
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
  });

  it("is false when the LLM engine is selected", async () => {
    process.env.TYPESAFE_API_KEY = "key";
    getEffectiveSettings.mockResolvedValue(settings("llm"));
    expect(await shouldUseJev("emailRoutingEngine")).toBe(false);
  });

  it("is false when Jev is selected but no API key is set", async () => {
    delete process.env.TYPESAFE_API_KEY;
    getEffectiveSettings.mockResolvedValue(settings("jev"));
    expect(await shouldUseJev("projectSelectionEngine")).toBe(false);
  });

  it("is true when Jev is selected and a key is set", async () => {
    process.env.TYPESAFE_API_KEY = "key";
    getEffectiveSettings.mockResolvedValue(settings("jev"));
    expect(await shouldUseJev("projectSelectionEngine")).toBe(true);
  });

  it("falls back to the LLM when settings cannot be read", async () => {
    process.env.TYPESAFE_API_KEY = "key";
    getEffectiveSettings.mockRejectedValue(new Error("db down"));
    expect(await shouldUseJev("emailRoutingEngine")).toBe(false);
  });
});
