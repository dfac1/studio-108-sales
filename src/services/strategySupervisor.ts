/**
 * Strategy Supervisor — раз в N turn'ов запускает «надстройку» над FSM:
 * оценивает «теплоту» клиента, выявляет главное возражение и даёт совет brain'у.
 *
 * Использует Claude Sonnet 4.6 с extended thinking (если поддерживается). Дорого, поэтому:
 *  - вызывается раз в SUPERVISOR_EVERY_TURNS=3 turn'ов
 *  - и только на содержательных stage (offer_solution / отказ / возражение)
 *  - результат cache'ится в state.supervisorVerdict до следующего N-го turn'а.
 *
 * Возвращает структурированный verdict. Если Claude недоступен — null,
 * полагаемся на rules-based fallback.
 */

import type { SalesDialogState } from "./salesDialog.js";
import { callAnthropicTool, isAnthropicConfigured } from "./anthropicClient.js";
import { config } from "../config.js";

export interface StrategyVerdict {
  warmth: number;            // 0..1: насколько клиент «греется» к покупке
  mainObjection?: string;    // главное возражение, если есть
  advice: string;            // 1-2 предложения совета для brain'а
  source: "anthropic" | "rules";
  latencyMs: number;
}

const SUPERVISOR_EVERY_TURNS = 3;
const HOT_STAGES = new Set([
  "offer_solution",
  "offered_solution",
  "ask_phone",
  "ask_consent"
]);

export function shouldRunSupervisor(state: SalesDialogState): boolean {
  const turn = state.turnIndex ?? 0;
  if (turn < 2) return false;
  // На горячих стадиях supervisor всегда полезен
  if (state.stage && HOT_STAGES.has(state.stage)) return true;
  // Иначе раз в N turn'ов
  if (turn % SUPERVISOR_EVERY_TURNS !== 0) return false;
  // Не пересчитываем чаще, чем раз в N turn'ов
  const lastAt = state.supervisorVerdict?.turnIndexAt ?? -SUPERVISOR_EVERY_TURNS;
  return turn - lastAt >= SUPERVISOR_EVERY_TURNS;
}

// In-memory cache supervisor verdict'ов по conversationId.
// Supervisor работает fire-and-forget: запускается на turn N,
// результат используется на turn N+1 (без блокировки текущего ответа).
interface CachedVerdict {
  warmth: number;
  mainObjection?: string;
  advice: string;
  source: "anthropic" | "rules";
  computedAtTurn: number;
}
const verdictCache = new Map<string, CachedVerdict>();

export function getCachedVerdict(conversationId: string | undefined): CachedVerdict | undefined {
  if (!conversationId) return undefined;
  return verdictCache.get(conversationId);
}

/**
 * Fire-and-forget запуск supervisor'а. Не блокирует turn —
 * verdict пишется в cache, читается на следующем turn'е.
 */
export function fireSupervisor(
  conversationId: string | undefined,
  input: EvaluateInput,
  currentTurn: number
): void {
  if (!conversationId) return;
  void (async () => {
    try {
      const verdict = await evaluateStrategy(input);
      if (verdict) {
        verdictCache.set(conversationId, {
          warmth: verdict.warmth,
          mainObjection: verdict.mainObjection,
          advice: verdict.advice,
          source: verdict.source,
          computedAtTurn: currentTurn
        });
        // Не разрастаем кеш бесконечно — храним последние 50 разговоров
        if (verdictCache.size > 50) {
          const firstKey = verdictCache.keys().next().value;
          if (firstKey) verdictCache.delete(firstKey);
        }
      }
    } catch {
      // supervisor — best-effort
    }
  })();
}

interface EvaluateInput {
  state: SalesDialogState;
  recentMessages: string[];
  currentStage?: string;
}

const SYSTEM_PROMPT = `
Ты — supervisor для голосового sales-агента танцевальной студии. Тебе не нужно отвечать клиенту.
Твоя задача — оценить состояние диалога и подсказать рядом стоящему агенту тактику следующих 1-2 ходов.

На вход даём:
- последние 3-5 реплик клиента
- текущая стадия FSM
- что уже известно о клиенте

Верни три факта:
1) warmth — число от 0 до 1, насколько клиент тёплый и близок к записи.
2) mainObjection — самая важная блокировка (например: "цена", "не уверен в направлении", "нет времени", "ищет конкретное время которого нет"). Если нет — null.
3) advice — 1-2 предложения совета для агента. Простой русский, без канцелярита.

Не выдумывай факты — основывайся только на тексте.
`.trim();

const TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    warmth: { type: "number", minimum: 0, maximum: 1 },
    mainObjection: { type: ["string", "null"] },
    advice: { type: "string", maxLength: 300 }
  },
  required: ["warmth", "advice"],
  additionalProperties: false
};

export async function evaluateStrategy(
  input: EvaluateInput
): Promise<Omit<StrategyVerdict, "turnIndexAt"> | null> {
  // Если Claude не сконфигурирован — отдаём rules-based вердикт
  if (!isAnthropicConfigured()) {
    return rulesFallback(input);
  }

  const userPrompt = buildUserPrompt(input);
  const startedAt = Date.now();

  try {
    const result = await callAnthropicTool<{ warmth: number; mainObjection: string | null; advice: string }>({
      model: config.anthropic.dialogModel,
      system: SYSTEM_PROMPT,
      user: userPrompt,
      toolName: "record_strategy_verdict",
      toolDescription: "Сохрани оценку диалога и совет агенту.",
      inputSchema: TOOL_SCHEMA,
      maxTokens: 300,
      temperature: 0.2,
      timeoutMs: 3500,
      cacheTtl: config.anthropic.cacheTtl
    });

    if (!result.input) return rulesFallback(input);

    return {
      warmth: clamp01(Number(result.input.warmth ?? 0.5)),
      mainObjection: result.input.mainObjection || undefined,
      advice: String(result.input.advice ?? "").slice(0, 300),
      source: "anthropic",
      latencyMs: Date.now() - startedAt
    };
  } catch {
    return rulesFallback(input);
  }
}

function buildUserPrompt(input: EvaluateInput): string {
  const lines: string[] = ["<dialog>"];
  if (input.currentStage) lines.push(`<current_stage>${input.currentStage}</current_stage>`);
  const s = input.state;
  lines.push("<known_state>");
  if (s.customerName) lines.push(`  <name>${escapeXml(s.customerName)}</name>`);
  if (s.age) lines.push(`  <age>${s.age}</age>`);
  if (s.learnerType) lines.push(`  <learner_type>${s.learnerType}</learner_type>`);
  if (s.direction) lines.push(`  <direction>${escapeXml(s.direction)}</direction>`);
  if (s.branch) lines.push(`  <branch>${escapeXml(s.branch)}</branch>`);
  if (s.customerProfile) lines.push(`  <profile>${s.customerProfile}</profile>`);
  if (s.previousContactSummary) lines.push(`  <previous_contact>${escapeXml(s.previousContactSummary)}</previous_contact>`);
  lines.push("</known_state>");
  lines.push("<recent_messages>");
  for (const msg of input.recentMessages.slice(-5)) {
    lines.push(`  <m>${escapeXml(msg)}</m>`);
  }
  lines.push("</recent_messages>");
  lines.push("</dialog>");
  lines.push("Вызови record_strategy_verdict.");
  return lines.join("\n");
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"]/g, (ch) => ({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;"}[ch] ?? ch));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

/**
 * Rules-based fallback. Использует простые сигналы для оценки.
 */
function rulesFallback(input: EvaluateInput): Omit<StrategyVerdict, "turnIndexAt"> | null {
  const startedAt = Date.now();
  const all = input.recentMessages.join(" ").toLowerCase();
  let warmth = 0.5;

  // Сигналы охлаждения
  if (/(дорого|подумаю|подумать|не уверен|может потом|перезвоните|сами\s+перезвон)/i.test(all)) warmth -= 0.2;
  if (/(не\s+знаю|не\s+решил|надо\s+посоветоваться|с\s+мужем|с\s+женой)/i.test(all)) warmth -= 0.15;
  if (/(нет\s+времени|занят|некогда|не\s+подойд[её]т)/i.test(all)) warmth -= 0.1;

  // Сигналы разогрева
  if (/(подойд[её]т|хорошо|удобно|записывайте|давайте|записать|подходит)/i.test(all)) warmth += 0.2;
  if (input.state.phone) warmth += 0.1;
  if (input.state.selectedSlotId) warmth += 0.15;

  warmth = clamp01(warmth);

  let mainObjection: string | undefined;
  if (/(дорого|цен[аы]\s+высок)/i.test(all)) mainObjection = "цена";
  else if (/(нет\s+времени|занят|некогда)/i.test(all)) mainObjection = "нет времени";
  else if (/(стесн|боюсь|не\s+уме|нулев)/i.test(all)) mainObjection = "неуверенность";
  else if (/(подумаю|посоветоваться|перезвоните)/i.test(all)) mainObjection = "клиент тянет время";

  let advice = "Продолжай по FSM, не дави.";
  if (warmth < 0.35) {
    advice = "Клиент тёплый слабо. Не предлагай новый слот, сначала закрой возражение.";
  } else if (warmth > 0.75) {
    advice = "Клиент готов. Можно сразу к телефону и согласию, без лишних вопросов.";
  } else if (mainObjection === "цена") {
    advice = "Подчеркни, что пробное — это разовая цена, без подписки. Без давления.";
  } else if (mainObjection === "нет времени") {
    advice = "Спроси удобный день/время, не предлагай слот заранее.";
  }

  return {
    warmth,
    mainObjection,
    advice,
    source: "rules",
    latencyMs: Date.now() - startedAt
  };
}
