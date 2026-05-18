import { describe, expect, it } from "vitest";
import {
  cleanHumanReply,
  containsBannedSpeechWords,
  injectProsodyBreaks,
  normalizeForElevenLabsRussianSpeech,
  stripAudioTags,
  stripSsmlBreaks
} from "./russianSpeech.js";

describe("russian speech normalization", () => {
  it("keeps chat text readable and does not rewrite prices or time for display", () => {
    const reply = cleanHumanReply("Пробное стоит 300 рублей. Studio 108. Вт в 17:30.");

    expect(reply).toContain("300 рублей");
    expect(reply).toContain("Studio 108");
    expect(reply).toContain("Вт в 17:30");
  });

  it("normalizes brand, money and time for ElevenLabs Russian TTS", () => {
    const normalized = normalizeForElevenLabsRussianSpeech("Studio 108. Пробное стоит 300 рублей. Вт в 17:30.");

    expect(normalized).toContain("Студия сто восемь");
    expect(normalized).toContain("триста рублей");
    expect(normalized).toContain("во вторник");
    expect(normalized).toContain("в пять тридцать вечера");
  });

  it("normalizes age, floor and branch address for ElevenLabs Russian TTS", () => {
    const normalized = normalizeForElevenLabsRussianSpeech("Ждем вас по адресу: ул. Герцена 52Д, 3-й этаж. Ребенку 5 лет.");

    expect(normalized).toContain("улица Герцена, пятьдесят два дэ");
    expect(normalized).toContain("третий этаж");
    expect(normalized).toContain("пять лет");
  });

  it("flags risky words for speech output", () => {
    expect(containsBannedSpeechWords("Это большая группа и хороший вариант.")).toBe(true);
    expect(containsBannedSpeechWords("Подберу удобный вариант и время.")).toBe(false);
  });
});

describe("prosody breaks", () => {
  it("inserts a natural ellipsis between weekday and time on Flash (default)", () => {
    const out = injectProsodyBreaks("Анна, у нас есть вариант во вторник, в 17:30 на Развилке. Подойдёт?", { action: "offer_solution" });
    expect(out).toContain("во вторник… в 17:30");
  });

  it("inserts an ellipsis before the trailing question after a long reply", () => {
    const out = injectProsodyBreaks("Анна, для дочки в этом возрасте хорошо заходит хип-хоп. Ближайший вариант — вторник, 17:30 на Развилке. Пробное по триста рублей. Подойдёт это время?");
    expect(out).toMatch(/\.\s+…\s*Подойдёт/);
  });

  it("uses SSML breaks only on v3-compatible models", () => {
    const ssml = injectProsodyBreaks("Анна, у нас есть вариант во вторник, в 17:30 на Развилке. Подойдёт?", { action: "offer_solution", preferSsmlBreaks: true });
    expect(ssml).toContain('<break time="220ms"/>');
  });

  it("does not break already-short replies", () => {
    const short = "Угу, поняла.";
    expect(injectProsodyBreaks(short)).toBe(short);
  });

  it("strip removes SSML break tags", () => {
    const withBreaks = 'Анна, <break time="140ms"/> во вторник, <break time="220ms"/> в 17:30.';
    expect(stripSsmlBreaks(withBreaks)).toBe("Анна, во вторник, в 17:30.");
  });

  it("stripAudioTags removes only known v3 markers", () => {
    expect(stripAudioTags("[мягко] Анна, [улыбаясь] вариант подойдёт?")).toBe("Анна, вариант подойдёт?");
    expect(stripAudioTags("Адрес: ул. Герцена 52Д [запасной вход]")).toBe("Адрес: ул. Герцена 52Д [запасной вход]");
  });

  it("normalize does not produce double prepositions like «в в»", () => {
    const text = "Из ближайшего могу предложить во вторник, в 17:30 на Развилке.";
    const out = normalizeForElevenLabsRussianSpeech(text);
    expect(out).not.toContain("в в ");
    expect(out).not.toContain("во в ");
  });
});
