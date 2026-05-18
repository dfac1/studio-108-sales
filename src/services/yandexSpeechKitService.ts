import { config } from "../config.js";
import type { SpeechSynthesisInput, SpeechSynthesisResult, SpeechTranscriptionInput, SpeechTranscriptionResult, VoiceProviderStatus } from "../types.js";
import { normalizeForRussianSpeech } from "./russianSpeech.js";

export function getYandexTtsStatus(): VoiceProviderStatus {
  return {
    id: "yandex",
    kind: "tts",
    configured: hasYandexAuth(),
    realtimeReady: hasYandexAuth(),
    notes: [
      "Сильный TTS для русского рынка и локального контура.",
      "Для браузера лучше OggOpus, для телефонии — LPCM 8kHz."
    ]
  };
}

export function getYandexSttStatus(): VoiceProviderStatus {
  return {
    id: "yandex",
    kind: "stt",
    configured: hasYandexAuth(),
    realtimeReady: hasYandexAuth(),
    notes: [
      "Подходит как основной STT для русского голоса.",
      "Для реального звонка лучше переходить на streaming STT."
    ]
  };
}

export async function synthesizeWithYandex(input: SpeechSynthesisInput): Promise<SpeechSynthesisResult> {
  ensureYandexConfigured("TTS");

  const normalizedText = normalizeForRussianSpeech(input.text);
  const outputFormat = mapYandexOutputFormat(input.outputFormat ?? config.yandex.ttsFormat);
  const body = new URLSearchParams();
  body.set("text", normalizedText);
  body.set("lang", "ru-RU");
  body.set("voice", config.yandex.ttsVoice);
  body.set("emotion", config.yandex.ttsEmotion);
  body.set("speed", String(config.yandex.ttsSpeed));
  body.set("format", outputFormat.format);
  if (outputFormat.sampleRateHertz) {
    body.set("sampleRateHertz", String(outputFormat.sampleRateHertz));
  }
  if (config.yandex.folderId && !config.yandex.apiKey) {
    body.set("folderId", config.yandex.folderId);
  }

  const response = await fetch("https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize", {
    method: "POST",
    headers: {
      Authorization: buildYandexAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Yandex SpeechKit TTS вернул ошибку ${response.status}: ${bodyText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    provider: "yandex",
    contentType: outputFormat.contentType,
    outputFormat: outputFormat.name,
    normalizedText,
    audio: Buffer.from(arrayBuffer)
  };
}

export async function transcribeWithYandex(input: SpeechTranscriptionInput): Promise<SpeechTranscriptionResult> {
  ensureYandexConfigured("STT");

  const params = new URLSearchParams();
  params.set("lang", input.languageCode ?? config.yandex.sttLanguageCode);
  params.set("topic", config.yandex.sttModel);
  params.set("format", input.formatHint ?? detectYandexAudioFormat(input.mimeType) ?? config.yandex.sttFormat);
  const shouldSendRate = params.get("format") === "lpcm";
  if (shouldSendRate) {
    params.set("sampleRateHertz", String(input.sampleRateHertz ?? config.yandex.sttSampleRateHertz));
  }
  if (config.yandex.folderId && !config.yandex.apiKey) {
    params.set("folderId", config.yandex.folderId);
  }

  const response = await fetch(`https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?${params.toString()}`, {
    method: "POST",
    headers: {
      Authorization: buildYandexAuthHeader(),
      "Content-Type": input.mimeType ?? "audio/ogg"
    },
    body: new Uint8Array(input.audio)
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Yandex SpeechKit STT вернул ошибку ${response.status}: ${bodyText}`);
  }

  const payload = await response.json() as { result?: string };
  return {
    provider: "yandex",
    text: payload.result ?? "",
    languageCode: input.languageCode ?? config.yandex.sttLanguageCode
  };
}

function hasYandexAuth(): boolean {
  return Boolean(config.yandex.apiKey || config.yandex.iamToken);
}

function ensureYandexConfigured(kind: "TTS" | "STT") {
  if (!hasYandexAuth()) {
    throw new Error(`Yandex SpeechKit ${kind} не настроен. Заполните YANDEX_API_KEY или YANDEX_IAM_TOKEN в .env.`);
  }
}

function buildYandexAuthHeader(): string {
  if (config.yandex.apiKey) return `Api-Key ${config.yandex.apiKey}`;
  if (config.yandex.iamToken) return `Bearer ${config.yandex.iamToken}`;
  throw new Error("Yandex SpeechKit не настроен.");
}

function detectYandexAudioFormat(mimeType?: string): "oggopus" | "lpcm" | undefined {
  if (!mimeType) return undefined;
  if (mimeType.includes("ogg")) return "oggopus";
  if (mimeType.includes("wav") || mimeType.includes("l16") || mimeType.includes("pcm")) return "lpcm";
  return undefined;
}

function mapYandexOutputFormat(outputFormat: string): {
  name: string;
  format: "oggopus" | "lpcm";
  sampleRateHertz?: number;
  contentType: string;
} {
  if (outputFormat.includes("ulaw") || outputFormat.includes("alaw") || outputFormat.includes("8000")) {
    return {
      name: "lpcm_8000",
      format: "lpcm",
      sampleRateHertz: 8000,
      contentType: "audio/L16;rate=8000"
    };
  }

  if (outputFormat.startsWith("mp3")) {
    return {
      name: "oggopus",
      format: "oggopus",
      contentType: "audio/ogg"
    };
  }

  if (outputFormat.includes("ogg")) {
    return {
      name: "oggopus",
      format: "oggopus",
      contentType: "audio/ogg"
    };
  }

  return {
    name: "lpcm_48000",
    format: "lpcm",
    sampleRateHertz: config.yandex.ttsSampleRateHertz,
    contentType: "audio/L16"
  };
}
