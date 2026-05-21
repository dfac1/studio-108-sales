import { config } from "../config.js";
import type { SpeechSynthesisInput, SpeechSynthesisResult, SpeechTranscriptionInput, SpeechTranscriptionResult, TtsProviderId, SttProviderId, VoiceProviderStatus } from "../types.js";
import { getElevenLabsSttStatus, getElevenLabsTtsStatus, streamWithElevenLabs, synthesizeWithElevenLabs, transcribeWithElevenLabs } from "./elevenLabsService.js";

export { streamWithElevenLabs };

export function getVoiceProvidersStatus(): {
  defaultTtsProvider: TtsProviderId;
  defaultSttProvider: SttProviderId;
  semanticMode: "rules_only" | "hybrid";
  providers: VoiceProviderStatus[];
} {
  return {
    defaultTtsProvider: config.voice.defaultTtsProvider,
    defaultSttProvider: config.voice.defaultSttProvider,
    semanticMode: config.voice.semanticMode,
    providers: [
      getElevenLabsTtsStatus(),
      getElevenLabsSttStatus()
    ]
  };
}

export async function synthesizeSpeech(input: SpeechSynthesisInput): Promise<SpeechSynthesisResult> {
  const provider = input.provider ?? config.voice.defaultTtsProvider;
  return synthesizeWithElevenLabs({ ...input, provider });
}

export async function transcribeSpeech(input: SpeechTranscriptionInput): Promise<SpeechTranscriptionResult> {
  const provider = input.provider ?? config.voice.defaultSttProvider;
  return transcribeWithElevenLabs({ ...input, provider });
}
