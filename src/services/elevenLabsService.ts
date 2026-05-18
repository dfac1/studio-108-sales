import { Readable } from "node:stream";
import { config } from "../config.js";
import type { SpeechSynthesisInput, SpeechSynthesisResult, SpeechTranscriptionInput, SpeechTranscriptionResult, VoiceProviderStatus } from "../types.js";
import { injectProsodyBreaks, normalizeForElevenLabsRussianSpeech, stripAudioTags, stripSsmlBreaks } from "./russianSpeech.js";
import { isFlagOn } from "./featureFlags.js";
import { ELEVENLABS_UA } from "./elevenLabsKeepAlive.js";

export type VoicePreset = "default" | "greeting" | "business" | "empathic" | "joyful" | "clarification";

const VOICE_PRESETS: Record<VoicePreset, { stability: number; similarity_boost: number; style: number; speed: number; use_speaker_boost: boolean }> = {
  default:       { stability: 0.45, similarity_boost: 0.85, style: 0.35, speed: 0.96, use_speaker_boost: true },
  greeting:      { stability: 0.5,  similarity_boost: 0.9,  style: 0.5,  speed: 0.95, use_speaker_boost: true },
  business:      { stability: 0.55, similarity_boost: 0.85, style: 0.25, speed: 0.97, use_speaker_boost: true },
  empathic:      { stability: 0.55, similarity_boost: 0.85, style: 0.45, speed: 0.93, use_speaker_boost: true },
  joyful:        { stability: 0.4,  similarity_boost: 0.9,  style: 0.55, speed: 0.97, use_speaker_boost: true },
  clarification: { stability: 0.55, similarity_boost: 0.85, style: 0.4,  speed: 0.94, use_speaker_boost: true }
};

function contentTypeForFormat(outputFormat: string): string {
  if (outputFormat.includes("ulaw") || outputFormat.includes("alaw")) return "audio/basic";
  if (outputFormat.startsWith("mp3")) return "audio/mpeg";
  if (outputFormat.startsWith("pcm")) return "audio/wave";
  return "audio/ogg";
}

function buildElevenLabsRequestBody(text: string, preset: VoicePreset = "default", action?: string): Record<string, unknown> {
  // Pipeline preprocessing:
  // 1) audio v3 tags (`[мягко]` и т.п.) — оставляем только когда voice v3-совместим.
  // 2) нормализуем русский (произношение, деньги, дни, время).
  // 3) prosody: на старых/Flash моделях вставляем многоточия (TTS их понимает как паузы),
  //    на v3+ — SSML <break time>.
  const v3TagsAllowed = isFlagOn("useElevenLabsV3AudioTags") && supportsSsmlBreaks(config.elevenLabs.modelId);
  const prosodyEnabled = isFlagOn("humanizationProsodyBreaks");
  const preferSsml = supportsSsmlBreaks(config.elevenLabs.modelId);

  let prepared = v3TagsAllowed ? text : stripAudioTags(text);
  prepared = normalizeForElevenLabsRussianSpeech(prepared);
  if (prosodyEnabled) {
    prepared = injectProsodyBreaks(prepared, { action, preferSsmlBreaks: preferSsml });
  } else {
    prepared = stripSsmlBreaks(prepared);
  }

  const body: Record<string, unknown> = {
    text: prepared,
    model_id: config.elevenLabs.modelId,
    language_code: "ru",
    apply_text_normalization: "on",
    voice_settings: VOICE_PRESETS[preset] ?? VOICE_PRESETS.default
  };
  if (config.elevenLabs.pronunciationDictionaryLocators.length) {
    body.pronunciation_dictionary_locators = config.elevenLabs.pronunciationDictionaryLocators;
  }
  return body;
}

function supportsSsmlBreaks(modelId: string): boolean {
  // Только Eleven v3+ полноценно понимает <break time>.
  // Flash v2.5 и Multilingual v2 их фактически игнорируют — лучше использовать многоточия.
  if (!modelId) return false;
  if (/eleven_v3|multilingual_v3/i.test(modelId)) return true;
  return false;
}

export function getElevenLabsTtsStatus(): VoiceProviderStatus {
  return {
    id: "elevenlabs",
    kind: "tts",
    configured: Boolean(config.elevenLabs.apiKey && config.elevenLabs.voiceId),
    realtimeReady: Boolean(config.elevenLabs.apiKey && config.elevenLabs.voiceId),
    notes: [
      "Хороший выбор для быстрого живого TTS.",
      "Для телефонии лучше использовать ulaw_8000 или alaw_8000."
    ]
  };
}

export function getElevenLabsSttStatus(): VoiceProviderStatus {
  return {
    id: "elevenlabs",
    kind: "stt",
    configured: Boolean(config.elevenLabs.apiKey),
    realtimeReady: Boolean(config.elevenLabs.apiKey),
    notes: [
      "Scribe подходит для A/B теста по скорости и качеству русской речи.",
      "Realtime STT лучше использовать уже на телефонии или веб-аудио."
    ]
  };
}

export async function synthesizeWithElevenLabs(input: SpeechSynthesisInput): Promise<SpeechSynthesisResult> {
  const apiKey = config.elevenLabs.apiKey;
  const voiceId = input.voiceId ?? config.elevenLabs.voiceId;

  if (!apiKey || !voiceId) {
    throw new Error("ElevenLabs не настроен. Заполните ELEVENLABS_API_KEY и ELEVENLABS_VOICE_ID в .env.");
  }

  const outputFormat = input.outputFormat ?? config.elevenLabs.outputFormat;
  const body = buildElevenLabsRequestBody(input.text, input.voicePreset, input.action);
  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`);
  url.searchParams.set("output_format", outputFormat);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      "User-Agent": ELEVENLABS_UA
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs вернул ошибку ${response.status}: ${errorText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    provider: "elevenlabs",
    contentType: contentTypeForFormat(outputFormat),
    outputFormat,
    normalizedText: body.text as string,
    audio: Buffer.from(arrayBuffer)
  };
}

export async function streamWithElevenLabs(input: SpeechSynthesisInput): Promise<{
  provider: "elevenlabs";
  contentType: string;
  outputFormat: string;
  normalizedText: string;
  stream: Readable;
}> {
  const apiKey = config.elevenLabs.apiKey;
  const voiceId = input.voiceId ?? config.elevenLabs.voiceId;

  if (!apiKey || !voiceId) {
    throw new Error("ElevenLabs не настроен. Заполните ELEVENLABS_API_KEY и ELEVENLABS_VOICE_ID в .env.");
  }

  const outputFormat = input.outputFormat ?? "mp3_44100_128";
  const body = buildElevenLabsRequestBody(input.text, input.voicePreset, input.action);
  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`);
  url.searchParams.set("output_format", outputFormat);
  if (!/eleven_v3/i.test(config.elevenLabs.modelId)) {
    url.searchParams.set("optimize_streaming_latency", "3");
  }

  // Retry-стратегия по статусам:
  //   - 200       → success
  //   - 400 validation_error → fail fast (наши данные кривые, retry не поможет)
  //   - 401 payment_required → fail fast (подписка приостановлена)
  //   - 403 (Cloudflare challenge) → retry с короткой паузой, CF часто пускает на 2-й попытке
  //   - 429 rate_limited → retry с длинной паузой
  //   - 5xx / network → retry с экспоненциальной паузой
  //   - другие 4xx → 1 retry, потом сдаёмся
  const maxRetries = 4;
  let lastError = "";
  let lastStatus = 0;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      // Бэк-офф зависит от типа предыдущей ошибки:
      // CF challenge — короткие паузы (200, 400, 800).
      // Rate limit — длинные (1000, 2000, 4000).
      // Остальное — средние (300, 600, 1200).
      let delay: number;
      if (lastStatus === 403) delay = 200 * 2 ** (attempt - 1);
      else if (lastStatus === 429) delay = 1000 * 2 ** (attempt - 1);
      else delay = 300 * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg",
          "User-Agent": ELEVENLABS_UA
        },
        body: JSON.stringify(body)
      });
    } catch (networkError) {
      // Сетевой сбой (ECONNRESET, timeout и т.п.) — тоже ретраим.
      lastError = networkError instanceof Error ? networkError.message : String(networkError);
      lastStatus = 0;
      continue;
    }

    if (response.ok && response.body) {
      return {
        provider: "elevenlabs",
        contentType: contentTypeForFormat(outputFormat),
        outputFormat,
        normalizedText: body.text as string,
        stream: Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>)
      };
    }

    lastError = response.body ? await response.text() : "no response body";
    lastStatus = response.status;

    // 400 validation_error — retry бесполезен.
    if (response.status === 400 && /validation_error|unsupported_model|invalid_voice/i.test(lastError)) {
      throw new Error(`ElevenLabs streaming вернул ошибку ${response.status}: ${lastError}`);
    }
    // 401 payment_required — retry не разморозит подписку.
    if (response.status === 401 && /payment_required|payment_issue/i.test(lastError)) {
      throw new Error(`ElevenLabs streaming вернул ошибку ${response.status}: ${lastError}`);
    }
  }
  throw new Error(`ElevenLabs streaming не ответил после ${maxRetries} попыток (последний статус ${lastStatus}): ${lastError.slice(0, 300)}`);
}

export async function transcribeWithElevenLabs(input: SpeechTranscriptionInput): Promise<SpeechTranscriptionResult> {
  const apiKey = config.elevenLabs.apiKey;
  if (!apiKey) {
    throw new Error("ElevenLabs STT не настроен. Заполните ELEVENLABS_API_KEY в .env.");
  }

  const form = new FormData();
  const fileName = input.fileName ?? guessFileName(input.mimeType);
  form.append("model_id", config.elevenLabs.sttModelId);
  form.append("file", new Blob([new Uint8Array(input.audio)], { type: input.mimeType ?? "audio/ogg" }), fileName);
  form.append("tag_audio_events", "false");
  form.append("diarize", "false");
  form.append("timestamps_granularity", "none");

  if (input.languageCode) {
    form.append("language_code", input.languageCode);
  }

  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "User-Agent": ELEVENLABS_UA
    },
    body: form
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ElevenLabs STT вернул ошибку ${response.status}: ${body}`);
  }

  const payload = await response.json() as { text?: string; language_code?: string; language_probability?: number };
  const cleanedText = stripAudioEventTags(payload.text ?? "");
  return {
    provider: "elevenlabs",
    text: cleanedText,
    languageCode: payload.language_code,
    confidence: payload.language_probability
  };
}

function stripAudioEventTags(text: string): string {
  return text
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function guessFileName(mimeType?: string): string {
  if (mimeType?.includes("wav")) return "audio.wav";
  if (mimeType?.includes("mpeg") || mimeType?.includes("mp3")) return "audio.mp3";
  if (mimeType?.includes("ogg")) return "audio.ogg";
  return "audio.bin";
}
