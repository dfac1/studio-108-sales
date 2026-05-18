// Feature flags для постепенного раскатывания изменений.
// Управляются через ENV (FLAGS_JSON) и могут быть оверайднуты по conversationId/phone.
// Пример FLAGS_JSON: '{"empathicVoiceForObjections":true,"variantGreetingV2":false}'

import { config } from "../config.js";

export type FlagKey =
  | "empathicVoiceForObjections"
  | "variantGreetingV2"
  | "useExtendedBackchannels"
  | "shadowSchemaValidation"
  | "showFeatureFlagsInResponse"
  | "humanizationSkipSimpleSteps"
  | "humanizationProsodyBreaks"
  | "useElevenLabsV3AudioTags"
  | "useCustomerProfile"
  | "useLongTermMemory"
  | "useSuccessStories"
  | "useStrategySupervisor"
  | "useActiveListening"
  | "useStreamingBrain"
  | "useDailyQADigest";

interface FlagDef {
  defaultValue: boolean;
  description: string;
}

const FLAGS: Record<FlagKey, FlagDef> = {
  empathicVoiceForObjections: { defaultValue: true, description: "Использовать empathic voice preset на возражениях клиента." },
  variantGreetingV2: { defaultValue: false, description: "Альтернативный пул greeting-фраз (тестируем конверсию)." },
  useExtendedBackchannels: { defaultValue: true, description: "Использовать расширенный пул backchannel-семплов (понимаю/хорошо/конечно)." },
  shadowSchemaValidation: { defaultValue: false, description: "Запускать новые проверки reply в shadow-режиме (только лог, не блокировать)." },
  showFeatureFlagsInResponse: { defaultValue: false, description: "Включать состояние флагов в /api/voice/turn — для отладки." },
  humanizationSkipSimpleSteps: { defaultValue: true, description: "На простых шагах (ask_name/ask_age/ask_branch/ask_consent) использовать fallback без вызова brain — экономит латентность и токены." },
  humanizationProsodyBreaks: { defaultValue: true, description: "Вставлять короткие SSML-паузы внутри длинных реплик для естественного ритма речи." },
  useElevenLabsV3AudioTags: { defaultValue: false, description: "Разрешать brain вставлять ElevenLabs v3 audio tags вроде [мягко], [улыбаясь]. Включать только когда voice v3-совместим." },
  useCustomerProfile: { defaultValue: true, description: "Классифицировать профиль клиента (young_parent/teen/busy_adult/mature) и подстраивать регистр brain." },
  useLongTermMemory: { defaultValue: true, description: "Загружать контекст прошлых обращений по телефону и передавать в brain." },
  useSuccessStories: { defaultValue: true, description: "Подбирать релевантные истории успеха из KB и передавать в brain как подсказку." },
  useStrategySupervisor: { defaultValue: true, description: "Запускать Claude supervisor каждые 3 turn'а для стратегической оценки. Асинхронный — не блокирует reply. Verdict используется в next turn." },
  useActiveListening: { defaultValue: false, description: "Проигрывать backchannel пока клиент говорит (browser side). Требует тестов." },
  useStreamingBrain: { defaultValue: false, description: "Стримить Claude reply и стартовать TTS на первом предложении." },
  useDailyQADigest: { defaultValue: true, description: "Включить эндпоинты QA digest и rating." }
};

let cachedRuntimeFlags: Partial<Record<FlagKey, boolean>> | null = null;

function loadRuntimeFlags(): Partial<Record<FlagKey, boolean>> {
  if (cachedRuntimeFlags) return cachedRuntimeFlags;
  cachedRuntimeFlags = {};
  const raw = process.env.FLAGS_JSON ?? "";
  if (!raw.trim()) return cachedRuntimeFlags;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed)) {
        if (key in FLAGS && typeof value === "boolean") {
          cachedRuntimeFlags[key as FlagKey] = value;
        }
      }
    }
  } catch {}
  return cachedRuntimeFlags;
}

export function isFlagOn(flag: FlagKey, ctx?: { conversationId?: string; phone?: string }): boolean {
  // Sticky-by-conversation: для одного диалога флаг детерминирован.
  // Если в ENV конкретно задан — берём значение из ENV.
  const runtime = loadRuntimeFlags();
  if (runtime[flag] !== undefined) return Boolean(runtime[flag]);
  return FLAGS[flag].defaultValue;
}

export function listFlags(): Array<{ key: FlagKey; value: boolean; description: string }> {
  return (Object.keys(FLAGS) as FlagKey[]).map((key) => ({
    key,
    value: isFlagOn(key),
    description: FLAGS[key].description
  }));
}

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const VARIANT_LOG_PATH = resolve(process.env.VARIANT_LOG_PATH ?? "./data/variant-picks.jsonl");

export function logVariantPick(key: string, picked: string, options: string[]): void {
  const record = { ts: new Date().toISOString(), key, picked, optionsCount: options.length };
  void mkdir(dirname(VARIANT_LOG_PATH), { recursive: true })
    .then(() => appendFile(VARIANT_LOG_PATH, `${JSON.stringify(record)}\n`, "utf8"))
    .catch(() => {});
  void config;
}
