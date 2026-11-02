/**
 * TypeSafe Jev client and engine selection.
 *
 * Jev answers narrow, typed judgments (Choice / Score / Noul). JobOps uses it
 * for selection and classification calls only; generative work stays on the
 * configured LLM. The API key is read from TYPESAFE_API_KEY on the server.
 */

import { logger } from "@infra/logger";
import { getEffectiveSettings } from "@server/services/settings";
import type { JudgmentEngine } from "@shared/types";
import { TypeSafeClient } from "@typesafe-ai/sdk";

const JEV_TIMEOUT_MS = 20_000;

let client: TypeSafeClient | null = null;
let warnedMissingKey = false;

export function isJevConfigured(): boolean {
  return Boolean(process.env.TYPESAFE_API_KEY?.trim());
}

export function getJevClient(): TypeSafeClient {
  if (!client) {
    client = new TypeSafeClient({
      timeout: JEV_TIMEOUT_MS,
      retry: { maxRetries: 1 },
    });
  }
  return client;
}

/** For tests: drop the cached client so a new environment is picked up. */
export function resetJevClientForTests(): void {
  client = null;
  warnedMissingKey = false;
}

type EngineSettingKey =
  | "projectSelectionEngine"
  | "emailRoutingEngine"
  | "scoringEngine";

/**
 * True when the user selected Jev for this judgment and Jev is usable.
 * Anything else, including a settings read failure or a missing API key,
 * resolves to the configured LLM so the feature keeps working.
 */
export async function shouldUseJev(key: EngineSettingKey): Promise<boolean> {
  let engine: JudgmentEngine = "llm";
  try {
    engine = (await getEffectiveSettings())[key].value;
  } catch (error) {
    logger.warn("Could not read judgment engine setting; using the LLM", {
      key,
      error,
    });
    return false;
  }
  if (engine !== "jev") return false;
  if (!isJevConfigured()) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      logger.warn(
        "TypeSafe Jev is selected but TYPESAFE_API_KEY is not set; using the configured LLM instead",
        { key },
      );
    }
    return false;
  }
  return true;
}
