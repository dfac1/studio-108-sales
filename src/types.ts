export type Branch = "Озеро" | "Развилка" | "Школьная" | "Черняховского";

export type Weekday = "Пн" | "Вт" | "Ср" | "Чт" | "Пт" | "Сб" | "Вс";

export type PriceKind = "base" | "salsa_bachata" | "breakdance" | "strip" | "pro" | "yoga_razvilka";
export type TtsProviderId = "elevenlabs" | "yandex";
export type SttProviderId = "elevenlabs" | "yandex";
export type SemanticMode = "rules_only" | "hybrid";

export interface Slot {
  id: string;
  weekday: Weekday;
  time: string;
  branch: Branch;
  direction: string;
  level?: string;
  ageMin?: number;
  ageMax?: number;
  teacher: string;
  priceKind: PriceKind;
  clientVisible: boolean;
  capacity: number;
  freePlaces: number;
  notes?: string;
}

export interface PriceResult {
  trial: number;
  single: number | null;
  subscription: number | null;
  label: string;
  notes?: string[];
}

export interface Booking {
  id: string;
  createdAt: string;
  customerName: string;
  phone: string;
  age?: number;
  direction: string;
  branch: Branch;
  slotId: string;
  status: "trial_booked";
  source: "inbound_call" | "inbound_form" | "manual_test";
  notes?: string;
}

export interface SpeechSynthesisInput {
  provider?: TtsProviderId;
  text: string;
  voiceId?: string;
  outputFormat?: string;
  voicePreset?: "default" | "greeting" | "business" | "empathic" | "joyful" | "clarification";
  /** FSM-action (offer_solution / booked / …) — используется для просодических пауз и эмоций. */
  action?: string;
}

export interface SpeechSynthesisResult {
  provider: TtsProviderId;
  contentType: string;
  audio: Buffer;
  outputFormat: string;
  normalizedText: string;
}

export interface SpeechTranscriptionInput {
  provider?: SttProviderId;
  audio: Buffer;
  mimeType?: string;
  fileName?: string;
  languageCode?: string;
  formatHint?: "oggopus" | "lpcm";
  sampleRateHertz?: number;
}

export interface SpeechTranscriptionResult {
  provider: SttProviderId;
  text: string;
  languageCode?: string;
  confidence?: number;
}

export interface VoiceProviderStatus {
  id: TtsProviderId | SttProviderId;
  kind: "tts" | "stt";
  configured: boolean;
  realtimeReady: boolean;
  notes: string[];
}
