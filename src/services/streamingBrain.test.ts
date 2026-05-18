import { describe, expect, it } from "vitest";

// Используем приватную функцию через "хак" — переэкспортим тесты с реимпортом.
// Поскольку tryExtractFirstSentence приватная, тестируем поведение через публичный API
// с моком fetch. Здесь только smoke на саму экспортируемую функцию.

import { startStreamingBrain } from "./streamingBrain.js";

describe("startStreamingBrain", () => {
  it("rejects both promises when API key is missing", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "";
    // Чистим cached config — мы делаем это через прямой вызов
    const { startStreamingBrain: fn } = await import("./streamingBrain.js");
    const handle = fn({ user: "test" });
    await expect(handle.firstSentence).rejects.toThrow();
    await expect(handle.fullReply).rejects.toThrow();
    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
  });
});
