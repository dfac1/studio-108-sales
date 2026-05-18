import { describe, expect, it } from "vitest";
import {
  calculateCallCostBreakdown,
  currentCallCostPricing,
  estimateCallCostFromConversationProfile
} from "./callCostModel.js";

describe("call cost model", () => {
  it("calculates a direct usage breakdown with top-up", () => {
    const result = calculateCallCostBreakdown({
      callMinutes: 4,
      sttMinutes: 4,
      sttMode: "realtime",
      ttsCharacters: 650,
      ttsModel: "flash_v2_5",
      dialogInputTokens: 1000,
      dialogOutputTokens: 100,
      extractionInputTokens: 500,
      extractionOutputTokens: 50
    });

    expect(result.totals.baseUsd).toBeGreaterThan(0);
    expect(result.totals.withTopUpUsd).toBeCloseTo(result.totals.baseUsd * currentCallCostPricing.topUpMultiplier, 4);
    expect(result.items.map((item) => item.key)).toContain("stt");
    expect(result.items.map((item) => item.key)).toContain("tts");
  });

  it("estimates a standard OpenAI conversation profile from measured prompt usage", () => {
    const result = estimateCallCostFromConversationProfile({
      callMinutes: 4,
      assistantMessages: 8,
      assistantCharacters: 650,
      semanticExtractions: 2,
      includePostCallSummary: true,
      brainProvider: "openai"
    });

    expect(result.usage.dialogInputTokens).toBeGreaterThan(8000);
    expect(result.usage.extractionInputTokens).toBeGreaterThan(1800);
    expect(result.totals.withTopUpUsd).toBeGreaterThan(result.totals.baseUsd);
  });

  it("estimates Anthropic conversation profile with cache split", () => {
    const result = estimateCallCostFromConversationProfile({
      callMinutes: 4,
      assistantMessages: 8,
      assistantCharacters: 650,
      semanticExtractions: 2,
      brainProvider: "anthropic",
      warmCache: true
    });

    expect(result.usage.brainProvider).toBe("anthropic");
    expect(result.usage.anthropicSonnetCacheReadTokens).toBeGreaterThan(0);
    expect(result.usage.anthropicSonnetOutputTokens).toBeGreaterThan(0);
    expect(result.totals.withTopUpUsd).toBeGreaterThan(0);
  });
});
