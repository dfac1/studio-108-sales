import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "127.0.0.1",
  bookingsStoragePath: process.env.BOOKINGS_STORAGE_PATH ?? "./data/bookings.jsonl",
  voice: {
    defaultTtsProvider: (process.env.DEFAULT_TTS_PROVIDER ?? "elevenlabs") as "elevenlabs" | "yandex",
    defaultSttProvider: (process.env.DEFAULT_STT_PROVIDER ?? "elevenlabs") as "elevenlabs" | "yandex",
    semanticMode: (process.env.SEMANTIC_MODE ?? "hybrid") as "rules_only" | "hybrid",
    semanticTimeoutMs: Number(process.env.SEMANTIC_TIMEOUT_MS ?? 1200),
    assistantName: process.env.ASSISTANT_NAME ?? "Анна"
  },
  admins: parseAdminList(process.env.ADMINS_JSON ?? ""),
  elevenLabs: {
    apiKey: process.env.ELEVENLABS_API_KEY ?? "",
    voiceId: process.env.ELEVENLABS_VOICE_ID ?? "",
    modelId: process.env.ELEVENLABS_MODEL_ID ?? "eleven_flash_v2_5",
    sttModelId: process.env.ELEVENLABS_STT_MODEL_ID ?? "scribe_v2",
    outputFormat: process.env.ELEVENLABS_OUTPUT_FORMAT ?? "ulaw_8000",
    pronunciationDictionaryLocators: parsePronunciationDictionaryLocators(process.env.ELEVENLABS_PRONUNCIATION_DICTIONARIES ?? "")
  },
  yandex: {
    apiKey: process.env.YANDEX_API_KEY ?? "",
    iamToken: process.env.YANDEX_IAM_TOKEN ?? "",
    folderId: process.env.YANDEX_FOLDER_ID ?? "",
    ttsVoice: process.env.YANDEX_TTS_VOICE ?? "marina",
    ttsEmotion: process.env.YANDEX_TTS_EMOTION ?? "good",
    ttsSpeed: Number(process.env.YANDEX_TTS_SPEED ?? 1),
    ttsFormat: process.env.YANDEX_TTS_FORMAT ?? "oggopus",
    ttsSampleRateHertz: Number(process.env.YANDEX_TTS_SAMPLE_RATE_HERTZ ?? 48000),
    sttLanguageCode: process.env.YANDEX_STT_LANGUAGE_CODE ?? "ru-RU",
    sttModel: process.env.YANDEX_STT_MODEL ?? "general",
    sttFormat: process.env.YANDEX_STT_FORMAT ?? "oggopus",
    sttSampleRateHertz: Number(process.env.YANDEX_STT_SAMPLE_RATE_HERTZ ?? 8000)
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    modelId: process.env.OPENAI_MODEL_ID ?? "gpt-5.4-mini",
    dialogModelId: process.env.OPENAI_DIALOG_MODEL_ID ?? "gpt-5.4",
    extractionModelId: process.env.OPENAI_EXTRACTION_MODEL_ID ?? (process.env.OPENAI_MODEL_ID ?? "gpt-5.4-mini"),
    dialogTimeoutMs: Number(process.env.OPENAI_DIALOG_TIMEOUT_MS ?? 4000)
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    dialogModel: process.env.ANTHROPIC_DIALOG_MODEL ?? "claude-sonnet-4-6",
    extractionModel: process.env.ANTHROPIC_EXTRACTION_MODEL ?? "claude-haiku-4-5-20251001",
    dialogTimeoutMs: Number(process.env.ANTHROPIC_DIALOG_TIMEOUT_MS ?? 5000),
    cacheTtl: ((process.env.ANTHROPIC_CACHE_TTL ?? "5m") as "5m" | "1h")
  },
  brainProvider: (process.env.BRAIN_PROVIDER ?? "anthropic") as "anthropic" | "openai"
};

export interface AdminEntry {
  name: string;
  channel: "phone" | "telegram" | "whatsapp";
  contact: string;
  branches?: string[];
}

function parseAdminList(value: string): AdminEntry[] {
  if (!value.trim()) {
    return [
      { name: "Дежурный администратор", channel: "phone", contact: "8 918 942-51-62", branches: ["Развилка"] },
      { name: "Дежурный администратор", channel: "phone", contact: "8 993 320-81-08", branches: ["Озеро", "Школьная"] }
    ];
  }
  try {
    const parsed = JSON.parse(value) as AdminEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parsePronunciationDictionaryLocators(
  value: string
): Array<{ pronunciation_dictionary_id: string; version_id: string }> {
  if (!value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as Array<{ pronunciation_dictionary_id?: string; version_id?: string }>;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item) => Boolean(item?.pronunciation_dictionary_id && item?.version_id))
      .map((item) => ({
        pronunciation_dictionary_id: String(item.pronunciation_dictionary_id),
        version_id: String(item.version_id)
      }))
      .slice(0, 3);
  } catch {
    return [];
  }
}
