export type ElevenLabsTtsModel = "flash_v2_5" | "multilingual_v2_v3";

export interface CallCostPricing {
  topUpMultiplier: number;
  elevenLabsFlashTtsPer1kCharsUsd: number;
  elevenLabsMultilingualTtsPer1kCharsUsd: number;
  elevenLabsScribeRealtimePerHourUsd: number;
  elevenLabsScribeBatchPerHourUsd: number;
  elevenLabsEntityDetectionPerHourUsd: number;
  elevenLabsKeytermPromptingPerHourUsd: number;
  openAiGpt54InputPer1MUsd: number;
  openAiGpt54CachedInputPer1MUsd: number;
  openAiGpt54OutputPer1MUsd: number;
  openAiGpt54MiniInputPer1MUsd: number;
  openAiGpt54MiniCachedInputPer1MUsd: number;
  openAiGpt54MiniOutputPer1MUsd: number;
  backchannelOneTimeCharsTotal: number;     // суммарно символов на пре-генерацию backchannel-семплов
  backchannelAmortizedCallsHorizon: number;  // на сколько звонков amortize one-time generation
  clarifyAvgCharsPerCall: number;            // средние доп. chars на CLARIFY/handoff/loop guard
  // Anthropic pricing (актуально на 2026-05). Cache rates ~10x дешевле обычного input.
  anthropicSonnetInputPer1MUsd: number;
  anthropicSonnetCacheReadPer1MUsd: number;
  anthropicSonnetCacheWrite5mPer1MUsd: number;
  anthropicSonnetCacheWrite1hPer1MUsd: number;
  anthropicSonnetOutputPer1MUsd: number;
  anthropicHaikuInputPer1MUsd: number;
  anthropicHaikuCacheReadPer1MUsd: number;
  anthropicHaikuCacheWrite5mPer1MUsd: number;
  anthropicHaikuCacheWrite1hPer1MUsd: number;
  anthropicHaikuOutputPer1MUsd: number;
}

export interface CallCostUsage {
  callMinutes: number;
  ttsCharacters: number;
  ttsModel: ElevenLabsTtsModel;
  sttMode: "realtime" | "batch";
  sttMinutes?: number;
  useEntityDetection?: boolean;
  useKeytermPrompting?: boolean;
  // OpenAI-схема (legacy / fallback). Используется если brainProvider=openai.
  dialogInputTokens: number;
  dialogCachedInputTokens?: number;
  dialogOutputTokens: number;
  extractionInputTokens: number;
  extractionCachedInputTokens?: number;
  extractionOutputTokens: number;
  postCallSummaryInputTokens?: number;
  postCallSummaryCachedInputTokens?: number;
  postCallSummaryOutputTokens?: number;
  // Anthropic-схема. Используется если brainProvider=anthropic.
  brainProvider?: "openai" | "anthropic";
  anthropicSonnetInputTokens?: number;
  anthropicSonnetCacheReadTokens?: number;
  anthropicSonnetCacheWriteTokens?: number;
  anthropicSonnetCacheTtl?: "5m" | "1h";
  anthropicSonnetOutputTokens?: number;
  anthropicHaikuInputTokens?: number;
  anthropicHaikuCacheReadTokens?: number;
  anthropicHaikuCacheWriteTokens?: number;
  anthropicHaikuCacheTtl?: "5m" | "1h";
  anthropicHaikuOutputTokens?: number;
  // Telephony / storage
  telephonyInboundPerMinuteUsd?: number;
  telephonyBridgePerMinuteUsd?: number;
  recordingStorageUsdPerCall?: number;
  mediaStorageUsdPerCall?: number;
}

export interface ConversationCostProfile {
  callMinutes: number;
  assistantMessages: number;
  assistantCharacters: number;
  semanticExtractions: number;
  ttsModel?: ElevenLabsTtsModel;
  sttMode?: "realtime" | "batch";
  useEntityDetection?: boolean;
  useKeytermPrompting?: boolean;
  telephonyInboundPerMinuteUsd?: number;
  telephonyBridgePerMinuteUsd?: number;
  recordingStorageUsdPerCall?: number;
  mediaStorageUsdPerCall?: number;
  includePostCallSummary?: boolean;
  // Anthropic profile: какой brain используется и насколько кеш «тёплый».
  brainProvider?: "openai" | "anthropic";
  warmCache?: boolean;  // true если этот разговор пришёл, пока кеш ещё жив (не первый за TTL)
  cacheTtl?: "5m" | "1h";
}

export interface CostLineItem {
  key: string;
  label: string;
  baseUsd: number;
  withTopUpUsd: number;
}

export interface CallCostBreakdown {
  assumptions: {
    topUpMultiplier: number;
    sttMinutesBilled: number;
    telephonyIncluded: boolean;
    measuredUsageProfile: MeasuredUsageProfile;
  };
  usage: CallCostUsage;
  items: CostLineItem[];
  totals: {
    baseUsd: number;
    withTopUpUsd: number;
  };
}

export interface MeasuredUsageProfile {
  dialogInputTokensPerAssistantMessage: number;
  dialogOutputTokensPerAssistantMessage: number;
  extractionInputTokensPerHit: number;
  extractionOutputTokensPerHit: number;
  postCallSummaryInputTokens: number;
  postCallSummaryOutputTokens: number;
}

// Tarifs current as of 2026-05. Brain provider — Anthropic Claude.
// dialog: Sonnet 4.6 ($3 input / $15 output / 1M tok)
// extraction: Haiku 4.5 ($0.25 input / $1.25 output / 1M tok)
// Если переключитесь обратно на OpenAI — старые поля openAi* остались для совместимости.
export const currentCallCostPricing: CallCostPricing = {
  topUpMultiplier: 1.2,
  elevenLabsFlashTtsPer1kCharsUsd: 0.05,
  elevenLabsMultilingualTtsPer1kCharsUsd: 0.10,
  elevenLabsScribeRealtimePerHourUsd: 0.39,
  elevenLabsScribeBatchPerHourUsd: 0.22,
  elevenLabsEntityDetectionPerHourUsd: 0.07,
  elevenLabsKeytermPromptingPerHourUsd: 0.05,
  openAiGpt54InputPer1MUsd: 3,
  openAiGpt54CachedInputPer1MUsd: 0.3,
  openAiGpt54OutputPer1MUsd: 15,
  openAiGpt54MiniInputPer1MUsd: 0.25,
  openAiGpt54MiniCachedInputPer1MUsd: 0.03,
  openAiGpt54MiniOutputPer1MUsd: 1.25,
  // 7 backchannel-семплов: «Угу-угу,», «Ага, поняла.», «Так,», «Так, секунду, гляну.»,
  // «Секундочку.», «Так, поняла.», «Хорошо, удобно.» — суммарно ~110 символов.
  backchannelOneTimeCharsTotal: 110,
  // Регенерим backchannel-семплы примерно раз в 1000 звонков (при изменении персоны).
  backchannelAmortizedCallsHorizon: 1000,
  // CLARIFY (~60 chars) + loop-guard handoff (~150 chars). В среднем ≈30 chars на звонок.
  clarifyAvgCharsPerCall: 30,
  // Anthropic Sonnet 4.6
  anthropicSonnetInputPer1MUsd: 3,
  anthropicSonnetCacheReadPer1MUsd: 0.3,
  anthropicSonnetCacheWrite5mPer1MUsd: 3.75,
  anthropicSonnetCacheWrite1hPer1MUsd: 6,
  anthropicSonnetOutputPer1MUsd: 15,
  // Anthropic Haiku 4.5
  anthropicHaikuInputPer1MUsd: 0.25,
  anthropicHaikuCacheReadPer1MUsd: 0.025,
  anthropicHaikuCacheWrite5mPer1MUsd: 0.31,
  anthropicHaikuCacheWrite1hPer1MUsd: 0.5,
  anthropicHaikuOutputPer1MUsd: 1.25
};

// Замеры по реальным турнам после внедрения backchannel + variants + schema validation
// (фразы стали длиннее на 8-12% за счёт вариативности, но brain чаще даёт fallback из-за
// валидации, что слегка снижает dialog output tokens).
export const measuredUsageProfile: MeasuredUsageProfile = {
  dialogInputTokensPerAssistantMessage: 1480,
  dialogOutputTokensPerAssistantMessage: 58,
  extractionInputTokensPerHit: 960,
  extractionOutputTokensPerHit: 55,
  postCallSummaryInputTokens: 750,
  postCallSummaryOutputTokens: 130
};

// Замеры для Claude (см. scripts/cache-probe.ts). Меняйте при изменении промптов.
export interface AnthropicUsageProfile {
  sonnetCacheReadTokensPerTurn: number;     // тёплый cache hit (~3087)
  sonnetCacheWriteTokensFirstTurn: number;  // полный cache write на первом турне (~3087)
  sonnetCacheWriteOverheadPerTurn: number;  // overhead на каждый последующий turn (~120)
  sonnetNewInputTokensPerTurn: number;      // новый user message (~120 на средней реплике)
  sonnetOutputTokensPerTurn: number;        // средний reply (~50)
  haikuInputTokensPerExtraction: number;    // ~2047 без cache, либо ~500 с cache
  haikuCacheReadTokensPerExtraction: number;
  haikuCacheWriteTokensFirstExtraction: number;
  haikuOutputTokensPerExtraction: number;
}

export const anthropicUsageProfile: AnthropicUsageProfile = {
  sonnetCacheReadTokensPerTurn: 3087,
  sonnetCacheWriteTokensFirstTurn: 3087,
  sonnetCacheWriteOverheadPerTurn: 120,
  sonnetNewInputTokensPerTurn: 120,
  sonnetOutputTokensPerTurn: 60,
  haikuInputTokensPerExtraction: 2047,
  haikuCacheReadTokensPerExtraction: 0,
  haikuCacheWriteTokensFirstExtraction: 0,
  haikuOutputTokensPerExtraction: 200
};

export function estimateCallCostFromConversationProfile(
  profile: ConversationCostProfile,
  pricing: CallCostPricing = currentCallCostPricing,
  measured: MeasuredUsageProfile = measuredUsageProfile,
  anthropic: AnthropicUsageProfile = anthropicUsageProfile
): CallCostBreakdown {
  const provider = profile.brainProvider ?? "anthropic";
  const usage: CallCostUsage = {
    callMinutes: profile.callMinutes,
    sttMinutes: profile.callMinutes,
    ttsCharacters: profile.assistantCharacters,
    ttsModel: profile.ttsModel ?? "flash_v2_5",
    sttMode: profile.sttMode ?? "realtime",
    useEntityDetection: profile.useEntityDetection ?? false,
    useKeytermPrompting: profile.useKeytermPrompting ?? false,
    brainProvider: provider,
    // OpenAI поля (нули, если используется anthropic)
    dialogInputTokens: provider === "openai" ? profile.assistantMessages * measured.dialogInputTokensPerAssistantMessage : 0,
    dialogOutputTokens: provider === "openai" ? profile.assistantMessages * measured.dialogOutputTokensPerAssistantMessage : 0,
    extractionInputTokens: provider === "openai" ? profile.semanticExtractions * measured.extractionInputTokensPerHit : 0,
    extractionOutputTokens: provider === "openai" ? profile.semanticExtractions * measured.extractionOutputTokensPerHit : 0,
    postCallSummaryInputTokens: profile.includePostCallSummary && provider === "openai" ? measured.postCallSummaryInputTokens : 0,
    postCallSummaryOutputTokens: profile.includePostCallSummary && provider === "openai" ? measured.postCallSummaryOutputTokens : 0,
    // Anthropic поля
    anthropicSonnetInputTokens: provider === "anthropic" ? profile.assistantMessages * anthropic.sonnetNewInputTokensPerTurn : 0,
    anthropicSonnetCacheReadTokens: provider === "anthropic" ? (profile.warmCache ? profile.assistantMessages : Math.max(0, profile.assistantMessages - 1)) * anthropic.sonnetCacheReadTokensPerTurn : 0,
    anthropicSonnetCacheWriteTokens: provider === "anthropic" ? (profile.warmCache ? 0 : anthropic.sonnetCacheWriteTokensFirstTurn) + Math.max(0, profile.assistantMessages - 1) * anthropic.sonnetCacheWriteOverheadPerTurn : 0,
    anthropicSonnetCacheTtl: profile.cacheTtl ?? "5m",
    anthropicSonnetOutputTokens: provider === "anthropic" ? profile.assistantMessages * anthropic.sonnetOutputTokensPerTurn : 0,
    anthropicHaikuInputTokens: provider === "anthropic" ? profile.semanticExtractions * anthropic.haikuInputTokensPerExtraction : 0,
    anthropicHaikuCacheReadTokens: provider === "anthropic" ? profile.semanticExtractions * anthropic.haikuCacheReadTokensPerExtraction : 0,
    anthropicHaikuCacheWriteTokens: provider === "anthropic" ? (profile.warmCache ? 0 : anthropic.haikuCacheWriteTokensFirstExtraction) : 0,
    anthropicHaikuCacheTtl: profile.cacheTtl ?? "5m",
    anthropicHaikuOutputTokens: provider === "anthropic" ? profile.semanticExtractions * anthropic.haikuOutputTokensPerExtraction : 0,
    telephonyInboundPerMinuteUsd: profile.telephonyInboundPerMinuteUsd ?? 0,
    telephonyBridgePerMinuteUsd: profile.telephonyBridgePerMinuteUsd ?? 0,
    recordingStorageUsdPerCall: profile.recordingStorageUsdPerCall ?? 0,
    mediaStorageUsdPerCall: profile.mediaStorageUsdPerCall ?? 0
  };

  return calculateCallCostBreakdown(usage, pricing, measured);
}

export function calculateCallCostBreakdown(
  usage: CallCostUsage,
  pricing: CallCostPricing = currentCallCostPricing,
  measured: MeasuredUsageProfile = measuredUsageProfile
): CallCostBreakdown {
  const sttMinutesBilled = usage.sttMinutes ?? usage.callMinutes;
  const sttHours = sttMinutesBilled / 60;
  const telephonyIncluded = Boolean(usage.telephonyInboundPerMinuteUsd || usage.telephonyBridgePerMinuteUsd);
  const ttsRate = usage.ttsModel === "multilingual_v2_v3"
    ? pricing.elevenLabsMultilingualTtsPer1kCharsUsd
    : pricing.elevenLabsFlashTtsPer1kCharsUsd;
  const sttRate = usage.sttMode === "batch"
    ? pricing.elevenLabsScribeBatchPerHourUsd
    : pricing.elevenLabsScribeRealtimePerHourUsd;

  const items: CostLineItem[] = [
    buildItem("stt", "ElevenLabs STT", sttHours * sttRate, pricing.topUpMultiplier),
    buildItem("tts", "ElevenLabs TTS", (usage.ttsCharacters / 1000) * ttsRate, pricing.topUpMultiplier),
    buildItem(
      "tts_clarify_overhead",
      "ElevenLabs TTS (clarify/handoff overhead)",
      (pricing.clarifyAvgCharsPerCall / 1000) * ttsRate,
      pricing.topUpMultiplier
    ),
    buildItem(
      "backchannel_amortized",
      "ElevenLabs TTS (backchannel one-time, amortized)",
      ((pricing.backchannelOneTimeCharsTotal / pricing.backchannelAmortizedCallsHorizon) / 1000) * ttsRate,
      pricing.topUpMultiplier
    ),
    // Anthropic Sonnet (humanize)
    buildItem(
      "anthropic_sonnet_input",
      "Claude Sonnet 4.6 input",
      ((usage.anthropicSonnetInputTokens ?? 0) / 1_000_000) * pricing.anthropicSonnetInputPer1MUsd,
      pricing.topUpMultiplier
    ),
    buildItem(
      "anthropic_sonnet_cache_read",
      "Claude Sonnet 4.6 cache read",
      ((usage.anthropicSonnetCacheReadTokens ?? 0) / 1_000_000) * pricing.anthropicSonnetCacheReadPer1MUsd,
      pricing.topUpMultiplier
    ),
    buildItem(
      "anthropic_sonnet_cache_write",
      "Claude Sonnet 4.6 cache write",
      ((usage.anthropicSonnetCacheWriteTokens ?? 0) / 1_000_000) * (usage.anthropicSonnetCacheTtl === "1h" ? pricing.anthropicSonnetCacheWrite1hPer1MUsd : pricing.anthropicSonnetCacheWrite5mPer1MUsd),
      pricing.topUpMultiplier
    ),
    buildItem(
      "anthropic_sonnet_output",
      "Claude Sonnet 4.6 output",
      ((usage.anthropicSonnetOutputTokens ?? 0) / 1_000_000) * pricing.anthropicSonnetOutputPer1MUsd,
      pricing.topUpMultiplier
    ),
    // Anthropic Haiku (extraction)
    buildItem(
      "anthropic_haiku_input",
      "Claude Haiku 4.5 input",
      ((usage.anthropicHaikuInputTokens ?? 0) / 1_000_000) * pricing.anthropicHaikuInputPer1MUsd,
      pricing.topUpMultiplier
    ),
    buildItem(
      "anthropic_haiku_cache_read",
      "Claude Haiku 4.5 cache read",
      ((usage.anthropicHaikuCacheReadTokens ?? 0) / 1_000_000) * pricing.anthropicHaikuCacheReadPer1MUsd,
      pricing.topUpMultiplier
    ),
    buildItem(
      "anthropic_haiku_cache_write",
      "Claude Haiku 4.5 cache write",
      ((usage.anthropicHaikuCacheWriteTokens ?? 0) / 1_000_000) * (usage.anthropicHaikuCacheTtl === "1h" ? pricing.anthropicHaikuCacheWrite1hPer1MUsd : pricing.anthropicHaikuCacheWrite5mPer1MUsd),
      pricing.topUpMultiplier
    ),
    buildItem(
      "anthropic_haiku_output",
      "Claude Haiku 4.5 output",
      ((usage.anthropicHaikuOutputTokens ?? 0) / 1_000_000) * pricing.anthropicHaikuOutputPer1MUsd,
      pricing.topUpMultiplier
    ),
    buildItem(
      "dialog_input",
      "OpenAI dialog input",
      (usage.dialogInputTokens / 1_000_000) * pricing.openAiGpt54InputPer1MUsd,
      pricing.topUpMultiplier
    ),
    buildItem(
      "dialog_cached_input",
      "OpenAI dialog cached input",
      ((usage.dialogCachedInputTokens ?? 0) / 1_000_000) * pricing.openAiGpt54CachedInputPer1MUsd,
      pricing.topUpMultiplier
    ),
    buildItem(
      "dialog_output",
      "OpenAI dialog output",
      (usage.dialogOutputTokens / 1_000_000) * pricing.openAiGpt54OutputPer1MUsd,
      pricing.topUpMultiplier
    ),
    buildItem(
      "extraction_input",
      "OpenAI extraction input",
      (usage.extractionInputTokens / 1_000_000) * pricing.openAiGpt54MiniInputPer1MUsd,
      pricing.topUpMultiplier
    ),
    buildItem(
      "extraction_cached_input",
      "OpenAI extraction cached input",
      ((usage.extractionCachedInputTokens ?? 0) / 1_000_000) * pricing.openAiGpt54MiniCachedInputPer1MUsd,
      pricing.topUpMultiplier
    ),
    buildItem(
      "extraction_output",
      "OpenAI extraction output",
      (usage.extractionOutputTokens / 1_000_000) * pricing.openAiGpt54MiniOutputPer1MUsd,
      pricing.topUpMultiplier
    ),
    buildItem(
      "post_call_summary_input",
      "OpenAI post-call summary input",
      (((usage.postCallSummaryInputTokens ?? 0) - (usage.postCallSummaryCachedInputTokens ?? 0)) / 1_000_000) * pricing.openAiGpt54MiniInputPer1MUsd,
      pricing.topUpMultiplier
    ),
    buildItem(
      "post_call_summary_cached_input",
      "OpenAI post-call summary cached input",
      ((usage.postCallSummaryCachedInputTokens ?? 0) / 1_000_000) * pricing.openAiGpt54MiniCachedInputPer1MUsd,
      pricing.topUpMultiplier
    ),
    buildItem(
      "post_call_summary_output",
      "OpenAI post-call summary output",
      ((usage.postCallSummaryOutputTokens ?? 0) / 1_000_000) * pricing.openAiGpt54MiniOutputPer1MUsd,
      pricing.topUpMultiplier
    ),
    buildItem(
      "stt_entity_detection",
      "ElevenLabs STT entity detection",
      usage.useEntityDetection ? sttHours * pricing.elevenLabsEntityDetectionPerHourUsd : 0,
      pricing.topUpMultiplier
    ),
    buildItem(
      "stt_keyterm_prompting",
      "ElevenLabs STT keyterm prompting",
      usage.useKeytermPrompting ? sttHours * pricing.elevenLabsKeytermPromptingPerHourUsd : 0,
      pricing.topUpMultiplier
    ),
    buildItem(
      "telephony_inbound",
      "Telephony inbound minute",
      usage.callMinutes * (usage.telephonyInboundPerMinuteUsd ?? 0),
      pricing.topUpMultiplier
    ),
    buildItem(
      "telephony_bridge",
      "Telephony media bridge / SIP trunk",
      usage.callMinutes * (usage.telephonyBridgePerMinuteUsd ?? 0),
      pricing.topUpMultiplier
    ),
    buildItem(
      "recording_storage",
      "Call recording / CRM writeback",
      usage.recordingStorageUsdPerCall ?? 0,
      pricing.topUpMultiplier
    ),
    buildItem(
      "media_storage",
      "Audio storage / retention",
      usage.mediaStorageUsdPerCall ?? 0,
      pricing.topUpMultiplier
    )
  ].filter((item) => item.baseUsd > 0);

  const totals = items.reduce(
    (acc, item) => ({
      baseUsd: acc.baseUsd + item.baseUsd,
      withTopUpUsd: acc.withTopUpUsd + item.withTopUpUsd
    }),
    { baseUsd: 0, withTopUpUsd: 0 }
  );

  return {
    assumptions: {
      topUpMultiplier: pricing.topUpMultiplier,
      sttMinutesBilled,
      telephonyIncluded,
      measuredUsageProfile: measured
    },
    usage,
    items,
    totals
  };
}

function buildItem(key: string, label: string, baseUsd: number, topUpMultiplier: number): CostLineItem {
  return {
    key,
    label,
    baseUsd: roundMoney(baseUsd),
    withTopUpUsd: roundMoney(baseUsd * topUpMultiplier)
  };
}

export function formatUsd(value: number): string {
  return `$${roundMoney(value).toFixed(4)}`;
}

function roundMoney(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}
