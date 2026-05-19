import type { SalesDialogInput, SalesDialogResult, SalesDialogState } from "./salesDialog.js";
import type { SemanticMode, SttProviderId, TtsProviderId } from "../types.js";
import { config } from "../config.js";
import { handleSalesDialog } from "./salesDialog.js";
import { getBackchannelKeyForAction, type BackchannelKey } from "./backchannelService.js";
import { findPreGeneratedReply } from "./preGeneratedReplies.js";
import { logConversationTurn, nextConversationId } from "./conversationLog.js";
import { stripAudioTagsForChat } from "./russianSpeech.js";
import { isFlagOn } from "./featureFlags.js";

export interface VoiceTurnInput {
  message: string;
  state?: SalesDialogState & { conversationId?: string; turnIndex?: number };
  providers?: {
    stt?: SttProviderId;
    tts?: TtsProviderId;
  };
  meta?: {
    sttProvider?: string;
    sttConfidence?: number;
    sttDurationMs?: number;
  };
}

export type VoicePreset = "default" | "greeting" | "business" | "empathic" | "joyful" | "clarification";

export interface VoiceTurnResult extends SalesDialogResult {
  backchannel: BackchannelKey | null;
  thinkingDelayMs: number;
  voicePreset: VoicePreset;
  pregeneratedAudioUrl?: string;  // если reply совпадает с предзаписанной фразой — URL готового mp3
  conversationId: string;
  turnIndex: number;
  runtime: {
    semanticMode: SemanticMode;
    sttProvider: SttProviderId;
    ttsProvider: TtsProviderId;
    lowLatencyPolicy: "policy_first";
  };
}

function pickVoicePreset(action: string, lastUserText: string): VoicePreset {
  const lower = lastUserText.toLowerCase();
  // Если клиент в эмоциональном моменте — empathic
  if (/(дорого|подумаю|боит|стесня|не уверен|сложно|не получится|не уме)/i.test(lower)) {
    return "empathic";
  }
  switch (action) {
    case "ask_name":      return "greeting";
    case "booked":        return "joyful";
    case "handoff":       return "empathic";
    case "offer_solution":return "business";
    case "ask_consent":
    case "ask_phone":     return "business";
    default:              return "default";
  }
}

function pickThinkingDelayMs(action: string, message: string): number {
  // Длительная "обдумка" нужна только на содержательных шагах, где клиент дал
  // существенный input. На технических переходах — почти моментально.
  if (action === "booked" || action === "handoff") return 200;
  if (action === "ask_name" || action === "ask_learner") return 150;
  if (action === "ask_consent" || action === "ask_slot_choice") return 200;
  if (action === "ask_phone") return 300 + Math.floor(Math.random() * 200);
  if (action === "ask_age" || action === "ask_branch") return 350 + Math.floor(Math.random() * 250);
  if (action === "ask_need") return 400 + Math.floor(Math.random() * 250);
  if (action === "offer_solution") {
    const len = message.length;
    if (len < 20) return 500 + Math.floor(Math.random() * 300);
    return 700 + Math.floor(Math.random() * 400);
  }
  return 350 + Math.floor(Math.random() * 250);
}

export async function handleVoiceTurn(input: VoiceTurnInput): Promise<VoiceTurnResult> {
  const startedAt = Date.now();
  const conversationId = nextConversationId(input.state);
  const turnIndex = (input.state?.turnIndex ?? 0) + 1;

  const dialogInput: SalesDialogInput = {
    message: input.message,
    state: input.state
  };
  const result = await handleSalesDialog(dialogInput);

  // Compact один-строковый лог для отладки через Render Logs API. Без него не видно
  // что реально происходит в диалоге — нужно сопоставлять userText / action / reply
  // и ключевые поля state, чтобы находить логические конфликты.
  console.log(JSON.stringify({
    tag: "dlg",
    conv: conversationId,
    t: turnIndex,
    user: input.message.slice(0, 160),
    action: result.action,
    stage: result.state.stage,
    name: result.state.customerName,
    learner: result.state.learnerType,
    age: result.state.age,
    need: result.state.need?.slice(0, 80),
    dir: result.state.direction,
    pending: result.state._pendingDirection,
    rej: result.state.rejectedDirections,
    branch: result.state.branch,
    src: result.brainSource,
    reply: result.reply.slice(0, 200)
  }));
  // Пре-reply backchannel («понимаю», «поняла», «ага» перед ответом бота) отключены —
  // клиент пишет что они режут слух и звучат лишними после его реплики.
  // Активное слушание (ugu во время речи клиента) остаётся — оно работает иначе и нравится.
  const backchannel: BackchannelKey | null = null;
  const thinkingDelayMs = pickThinkingDelayMs(result.action, input.message);
  const voicePreset = pickVoicePreset(result.action, input.message);

  void logConversationTurn({
    ts: new Date().toISOString(),
    conversationId,
    turnIndex,
    userText: input.message,
    sttProvider: input.meta?.sttProvider,
    sttConfidence: input.meta?.sttConfidence,
    sttDurationMs: input.meta?.sttDurationMs,
    action: result.action,
    reply: result.reply,
    replyDurationMs: Date.now() - startedAt,
    thinkingDelayMs,
    backchannel,
    state: stripStateForLog(result.state),
    factsExtracted: extractedDelta(input.state, result.state),
    slots: result.slots?.slice(0, 3).map((slot) => ({
      id: slot.id,
      weekday: slot.weekday,
      time: slot.time,
      branch: slot.branch,
      direction: slot.direction
    })),
    bookingId: result.booking?.id,
    brainSource: result.brainSource,
    brainCache: result.brainCache,
    extractionCache: result.extractionCache
  });

  const pregenerated = findPreGeneratedReply(result.reply);

  // Reply, который возвращаем в JSON клиенту — без audio-тегов:
  // в чате они выглядят как литералы «[мягко]», а в TTS пойдёт уже отдельный поток.
  // Если флаг useElevenLabsV3AudioTags ON — оставляем теги, чтобы TTS их использовал.
  // ВАЖНО: app.js берёт reply из этого ответа и отправляет его на /api/tts/stream.
  // Поэтому если флаг ON — теги должны быть в reply, чтобы TTS-pipeline их применил.
  const replyForClient = isFlagOn("useElevenLabsV3AudioTags")
    ? result.reply
    : stripAudioTagsForChat(result.reply);

  return {
    ...result,
    reply: replyForClient,
    state: { ...result.state, conversationId, turnIndex } as SalesDialogState & { conversationId: string; turnIndex: number },
    backchannel,
    thinkingDelayMs,
    voicePreset,
    pregeneratedAudioUrl: pregenerated?.url,
    conversationId,
    turnIndex,
    runtime: {
      semanticMode: config.voice.semanticMode,
      sttProvider: input.providers?.stt ?? config.voice.defaultSttProvider,
      ttsProvider: input.providers?.tts ?? config.voice.defaultTtsProvider,
      lowLatencyPolicy: "policy_first"
    }
  };
}

function stripStateForLog(state: SalesDialogState): Partial<SalesDialogState> {
  const { offeredSlots, ...rest } = state;
  return rest;
}

function extractedDelta(prev: SalesDialogState | undefined, next: SalesDialogState): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  const keys: (keyof SalesDialogState)[] = ["customerName", "phone", "age", "direction", "branch", "learnerType", "preferredTime", "preferredWeekday", "preferredDayType", "selectedSlotId", "personalDataConsent"];
  for (const key of keys) {
    if (next[key] !== undefined && prev?.[key] !== next[key]) {
      delta[key] = next[key];
    }
  }
  return delta;
}
