import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { calculateCallCostBreakdown, currentCallCostPricing, formatUsd, measuredUsageProfile } from "../src/services/callCostModel.js";

const LOG_PATH = resolve(process.env.CONVERSATION_LOG_PATH ?? "./data/conversations.jsonl");

interface CacheUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

interface TurnLogRecord {
  ts: string;
  conversationId: string;
  turnIndex: number;
  userText: string;
  sttDurationMs?: number;
  action: string;
  reply: string;
  thinkingDelayMs?: number;
  backchannel?: string | null;
  brainSource?: string;
  brainCache?: CacheUsage;
  extractionCache?: CacheUsage;
}

async function main() {
  let raw: string;
  try {
    raw = await readFile(LOG_PATH, "utf8");
  } catch {
    console.error(`Не найден ${LOG_PATH}. Проведите хотя бы один диалог через /api/voice/turn.`);
    process.exit(1);
  }

  const records: TurnLogRecord[] = raw.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line) as TurnLogRecord; } catch { return null as unknown as TurnLogRecord; }
  }).filter((r): r is TurnLogRecord => Boolean(r));

  if (!records.length) {
    console.log("Лог пуст.");
    return;
  }

  const byConvo = new Map<string, TurnLogRecord[]>();
  for (const record of records) {
    const list = byConvo.get(record.conversationId) ?? [];
    list.push(record);
    byConvo.set(record.conversationId, list);
  }

  let totalBaseUsd = 0;
  let totalWithTopUpUsd = 0;
  let totalCalls = 0;
  let totalTurns = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalNewInputTokens = 0;

  console.log(`Считаю стоимость ${byConvo.size} диалогов из ${LOG_PATH}\n`);

  for (const [convoId, turns] of byConvo) {
    const sortedTurns = [...turns].sort((a, b) => a.turnIndex - b.turnIndex);
    const assistantCharacters = sortedTurns.reduce((sum, turn) => sum + (turn.reply?.length ?? 0), 0);
    const assistantMessages = sortedTurns.length;
    const totalSttMs = sortedTurns.reduce((sum, turn) => sum + (turn.sttDurationMs ?? 0), 0);
    const callMinutes = Math.max(0.5, totalSttMs / 1000 / 60 || sortedTurns.length * 0.4);

    // Аккумулируем фактические токены из turn-log (если есть).
    let sonnetInput = 0, sonnetCacheRead = 0, sonnetCacheWrite = 0, sonnetOutput = 0;
    let haikuInput = 0, haikuCacheRead = 0, haikuCacheWrite = 0, haikuOutput = 0;
    let semanticExtractions = 0;

    for (const t of sortedTurns) {
      if (t.brainCache) {
        sonnetInput += t.brainCache.inputTokens;
        sonnetCacheRead += t.brainCache.cacheReadInputTokens;
        sonnetCacheWrite += t.brainCache.cacheCreationInputTokens;
        sonnetOutput += t.brainCache.outputTokens;
      }
      if (t.extractionCache) {
        semanticExtractions += 1;
        haikuInput += t.extractionCache.inputTokens;
        haikuCacheRead += t.extractionCache.cacheReadInputTokens;
        haikuCacheWrite += t.extractionCache.cacheCreationInputTokens;
        haikuOutput += t.extractionCache.outputTokens;
      }
    }

    const usage = {
      callMinutes,
      sttMinutes: callMinutes,
      ttsCharacters: assistantCharacters,
      ttsModel: "flash_v2_5" as const,
      sttMode: "realtime" as const,
      brainProvider: "anthropic" as const,
      // OpenAI-поля (нули, потому что мы на anthropic)
      dialogInputTokens: 0,
      dialogOutputTokens: 0,
      extractionInputTokens: 0,
      extractionOutputTokens: 0,
      // Anthropic-поля по фактическим замерам
      anthropicSonnetInputTokens: sonnetInput,
      anthropicSonnetCacheReadTokens: sonnetCacheRead,
      anthropicSonnetCacheWriteTokens: sonnetCacheWrite,
      anthropicSonnetOutputTokens: sonnetOutput,
      anthropicSonnetCacheTtl: "5m" as const,
      anthropicHaikuInputTokens: haikuInput,
      anthropicHaikuCacheReadTokens: haikuCacheRead,
      anthropicHaikuCacheWriteTokens: haikuCacheWrite,
      anthropicHaikuOutputTokens: haikuOutput,
      anthropicHaikuCacheTtl: "5m" as const
    };

    const breakdown = calculateCallCostBreakdown(usage, currentCallCostPricing, measuredUsageProfile);
    totalBaseUsd += breakdown.totals.baseUsd;
    totalWithTopUpUsd += breakdown.totals.withTopUpUsd;
    totalCalls += 1;
    totalTurns += assistantMessages;
    totalCacheReadTokens += sonnetCacheRead + haikuCacheRead;
    totalCacheWriteTokens += sonnetCacheWrite + haikuCacheWrite;
    totalNewInputTokens += sonnetInput + haikuInput;

    const lastAction = sortedTurns[sortedTurns.length - 1]?.action ?? "?";
    const cacheHitPct = (sonnetInput + sonnetCacheRead) > 0 ? Math.round(sonnetCacheRead / (sonnetInput + sonnetCacheRead) * 100) : 0;
    console.log(`${convoId.padEnd(40)} ${assistantMessages} turns, ${assistantCharacters} chars, ${callMinutes.toFixed(2)} min, cache_hit=${cacheHitPct}%, last=${lastAction.padEnd(16)} → ${formatUsd(breakdown.totals.withTopUpUsd)}`);
  }

  if (totalCalls > 0) {
    const totalInputTokens = totalNewInputTokens + totalCacheReadTokens + totalCacheWriteTokens;
    const overallCacheHitPct = totalInputTokens > 0 ? Math.round(totalCacheReadTokens / totalInputTokens * 100) : 0;
    console.log(`\n=== Итог за период ===`);
    console.log(`Звонков: ${totalCalls}, турнов всего: ${totalTurns}, среднее ${(totalTurns / totalCalls).toFixed(1)} turn/call`);
    console.log(`Cache hit rate (input tokens): ${overallCacheHitPct}%`);
    console.log(`Средняя стоимость звонка: ${formatUsd(totalWithTopUpUsd / totalCalls)} (base ${formatUsd(totalBaseUsd / totalCalls)})`);
    console.log(`Сумма за период: ${formatUsd(totalWithTopUpUsd)} (base ${formatUsd(totalBaseUsd)})`);
  }
}

await main();
