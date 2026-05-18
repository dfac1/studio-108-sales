// Предзаписанные ответы для самых частых статичных фраз — играются мгновенно без вызова ElevenLabs.
// Совпадение — точное по тексту. Если backend выдал нечто с переменными частями (имя клиента,
// время, цена) — преген не сработает, играем обычным streaming TTS.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../config.js";
import { synthesizeWithElevenLabs } from "./elevenLabsService.js";

const PREGEN_DIR = resolve("public", "audio", "pregenerated");

export interface PreGenEntry {
  key: string;
  text: string;
  url: string;
  cached: boolean;
}

// Статичные фразы (без подстановок) — перечислены руками.
// При изменении текста backend'а — перегенерируйте: POST /api/pregenerated/refresh.
const PREGEN_PHRASES: Array<{ key: string; text: string }> = [
  // Greeting варианты — самый частый turn (первая реплика после клиента)
  { key: "greet_1", text: "Здравствуйте, это Анна из Studio 108. Как к вам можно обращаться?" },
  { key: "greet_2", text: "Здравствуйте! Анна, Studio 108. Подскажите, как к вам обращаться?" },
  { key: "greet_3", text: "Здравствуйте, меня зовут Анна, Studio 108. Как вас зовут?" },
  { key: "greet_4", text: "Добрый день, Анна, Studio 108. Как к вам можно обращаться?" },
  { key: "greet_with_price", text: "Здравствуйте! Это Studio 108. Пробное занятие у нас обычно стоит от 300 рублей, на некоторых направлениях цена отличается. А мы подбираем занятие для вас или для ребёнка?" },

  // Branch open — без имени клиента. v2 — смягчённые формулировки + voicePreset "clarification".
  // Тексты синхронизированы с replyVariants.askBranchOpen.
  { key: "ask_branch_1_v2", text: "Где удобнее заниматься — на Развилке, у озера или возле первой школы?" },
  { key: "ask_branch_2_v2", text: "Подскажите, какой район ближе — Развилка, у озера или возле первой школы?" },
  { key: "ask_branch_3_v2", text: "А какой филиал вам удобнее — Развилка, у озера или возле первой школы?" },

  // Bot question — фиксированный ответ
  { key: "bot_disclosure", text: "Да, я голосовой ассистент Studio 108, помогаю записать на пробное занятие. Если что-то нужно решить лично — переключу на администратора. А как к вам можно обращаться?" }
];

// Шаблоны с подстановкой {NAME}. На пилоте — только имя «Андрей», расширим позже.
// Каждый шаблон + имя = одна mp3-фраза (без склейки на лету): чище звучит, нет щелчков.
const PREGEN_NAMES: string[] = ["Андрей"];

const PREGEN_TEMPLATES: Array<{ key: string; text: string }> = [
  // ask_learner с обращением по имени — самый частый шаблон 2-го turn
  { key: "ask_learner_named_v1", text: "{NAME}, занятие для вас или для ребёнка?" },
  { key: "ask_learner_named_v2", text: "{NAME}, подбираем для вас или для ребёнка?" },
  { key: "ask_learner_named_v3", text: "{NAME}, для вас подбираем или для ребёнка?" },
  { key: "ask_learner_named_v4", text: "{NAME}, подбираем занятие для вас или для ребёнка?" }
];

function expandedPregenEntries(): Array<{ key: string; text: string }> {
  const expanded: Array<{ key: string; text: string }> = [...PREGEN_PHRASES];
  for (const name of PREGEN_NAMES) {
    for (const tpl of PREGEN_TEMPLATES) {
      expanded.push({
        key: `${tpl.key}__${name}`,
        text: tpl.text.replace(/\{NAME\}/g, name)
      });
    }
  }
  return expanded;
}

export async function ensurePreGeneratedReplies(): Promise<PreGenEntry[]> {
  await mkdir(PREGEN_DIR, { recursive: true });
  const results: PreGenEntry[] = [];
  const allPhrases = expandedPregenEntries();

  for (const phrase of allPhrases) {
    const filePath = resolve(PREGEN_DIR, `${phrase.key}.mp3`);
    const url = `/audio/pregenerated/${phrase.key}.mp3`;
    try {
      await stat(filePath);
      results.push({ key: phrase.key, text: phrase.text, url, cached: true });
      continue;
    } catch {}

    if (!config.elevenLabs.apiKey || !config.elevenLabs.voiceId) {
      results.push({ key: phrase.key, text: phrase.text, url, cached: false });
      continue;
    }

    try {
      const result = await synthesizeWithElevenLabs({
        provider: "elevenlabs",
        text: phrase.text,
        outputFormat: "mp3_44100_128",
        voicePreset: phrase.key.startsWith("greet")
          ? "greeting"
          // ask_branch — короткие вопросы, легко звучат резко. Используем мягкий "clarification".
          : phrase.key.startsWith("ask_branch")
            ? "clarification"
            : "default"
      });
      await writeFile(filePath, result.audio);
      results.push({ key: phrase.key, text: phrase.text, url, cached: true });
    } catch (err) {
      console.error("pregen failed for", phrase.key, err);
      results.push({ key: phrase.key, text: phrase.text, url, cached: false });
    }
  }

  return results;
}

/**
 * Поиск совпадения по двум стратегиям:
 *
 *  1) Точный match по нормализованному тексту — для статичных фраз (greet_*, ask_branch_*).
 *  2) Fuzzy match по паттерну — для шаблонов с {NAME}. Brain может переформулировать
 *     «Андрей, занятие для вас или для ребёнка?» десятком способов, но интент тот же —
 *     ask_learner с обращением. Мы матчим по паттерну (имя в начале + ключевой оборот)
 *     и проигрываем canonical mp3 этого шаблона.
 *
 * Возвращает URL и key. Если совпадения нет — null, играем обычный TTS.
 */
export function findPreGeneratedReply(replyText: string): { url: string; key: string } | null {
  const normalized = normalize(replyText);
  // 1) точный match
  for (const phrase of expandedPregenEntries()) {
    if (normalize(phrase.text) === normalized) {
      return { url: `/audio/pregenerated/${phrase.key}.mp3`, key: phrase.key };
    }
  }
  // 2) fuzzy match по шаблонам с {NAME}
  for (const tpl of TEMPLATE_FUZZY_MATCHERS) {
    for (const name of PREGEN_NAMES) {
      // имя должно явно стоять в начале реплики (с запятой)
      const namePattern = new RegExp(`^${escapeRegex(name)}\\b\\s*,`, "i");
      if (!namePattern.test(replyText.trim())) continue;
      if (tpl.matches(normalized)) {
        const key = `${tpl.canonicalKey}__${name}`;
        return { url: `/audio/pregenerated/${key}.mp3`, key };
      }
    }
  }
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
}

// Fuzzy матчеры: каждый шаблон описан паттерном «о чём фраза», без учёта точной формулировки.
// При совпадении проигрываем canonical mp3 (всегда первая версия шаблона: ask_learner_named_v1).
const TEMPLATE_FUZZY_MATCHERS: Array<{ canonicalKey: string; matches: (normalized: string) => boolean }> = [
  {
    // ask_learner: «{Имя}, ... для вас или для ребёнка ...»
    canonicalKey: "ask_learner_named_v1",
    matches: (t) => /(?:для\s+)?(?:вас|себя)\s+(?:подбираем\s+|)или\s+(?:для\s+)?реб[её]н/i.test(t) ||
                    /реб[её]н(?:ка|ке|ку)?\s+или\s+(?:для\s+)?(?:вас|себя)/i.test(t)
  }
];

export function listPreGeneratedReplies(): PreGenEntry[] {
  return expandedPregenEntries().map((p) => ({
    key: p.key,
    text: p.text,
    url: `/audio/pregenerated/${p.key}.mp3`,
    cached: true
  }));
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[!?.,;:—–-]+/g, "").trim();
}
