import { config } from "../config.js";
import type { SpeechSynthesisInput, SpeechSynthesisResult, SpeechTranscriptionInput, SpeechTranscriptionResult, TtsProviderId, VoiceProviderStatus } from "../types.js";
import { getElevenLabsSttStatus, getElevenLabsTtsStatus, streamWithElevenLabs, synthesizeWithElevenLabs, transcribeWithElevenLabs } from "./elevenLabsService.js";
import { getYandexSttStatus, getYandexTtsStatus, synthesizeWithYandex, transcribeWithYandex } from "./yandexSpeechKitService.js";

export { streamWithElevenLabs };

export function getVoiceProvidersStatus(): {
  defaultTtsProvider: TtsProviderId;
  defaultSttProvider: "elevenlabs" | "yandex";
  semanticMode: "rules_only" | "hybrid";
  providers: VoiceProviderStatus[];
} {
  return {
    defaultTtsProvider: config.voice.defaultTtsProvider,
    defaultSttProvider: config.voice.defaultSttProvider,
    semanticMode: config.voice.semanticMode,
    providers: [
      getElevenLabsTtsStatus(),
      getYandexTtsStatus(),
      getElevenLabsSttStatus(),
      getYandexSttStatus()
    ]
  };
}

export async function synthesizeSpeech(input: SpeechSynthesisInput): Promise<SpeechSynthesisResult> {
  const provider = input.provider ?? config.voice.defaultTtsProvider;
  return provider === "yandex"
    ? synthesizeWithYandex({ ...input, provider })
    : synthesizeWithElevenLabs({ ...input, provider });
}

export async function transcribeSpeech(input: SpeechTranscriptionInput): Promise<SpeechTranscriptionResult> {
  const provider = input.provider ?? config.voice.defaultSttProvider;
  return provider === "yandex"
    ? transcribeWithYandex({ ...input, provider })
    : transcribeWithElevenLabs({ ...input, provider });
}
