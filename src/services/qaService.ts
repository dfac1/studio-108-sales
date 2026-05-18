/**
 * Daily QA loop — для ежедневного ревью звонков администратором.
 *
 * Идея: каждое утро администратор открывает вкладку QA в admin.html и видит:
 *  - агрегаты за последние 24ч (количество, средняя длительность, конверсия в booked, % handoff);
 *  - топ-«странных» диалогов (high retry rate, low brain quality, raised flags);
 *  - возможность поставить рейтинг 1-5 и оставить комментарий.
 *
 * Источник: data/conversations.jsonl. Результаты ревью → data/qa-ratings.jsonl.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TurnLogEntry } from "./conversationLog.js";

const CONVERSATIONS_PATH = resolve(process.env.CONVERSATION_LOG_PATH ?? "./data/conversations.jsonl");
const RATINGS_PATH = resolve(process.env.QA_RATINGS_PATH ?? "./data/qa-ratings.jsonl");

export interface QaDigestSummary {
  windowHours: number;
  totalConversations: number;
  totalBooked: number;
  totalHandoff: number;
  averageTurns: number;
  averageLatencyMs: number;
  brainHitRate: number;
  warnings: string[];
}

export interface QaConversationSummary {
  conversationId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  turns: number;
  finalAction: string;
  customerName?: string;
  phone?: string;
  direction?: string;
  branch?: string;
  bookingId?: string;
  warnings: string[];
  weirdnessScore: number;
}

export interface QaDigest {
  summary: QaDigestSummary;
  topWeird: QaConversationSummary[];
  recent: QaConversationSummary[];
}

async function readTurns(): Promise<TurnLogEntry[]> {
  try {
    const text = await readFile(CONVERSATIONS_PATH, "utf8");
    return text.split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line) as TurnLogEntry; } catch { return null; } })
      .filter((value): value is TurnLogEntry => value !== null);
  } catch {
    return [];
  }
}

export async function buildQaDigest(windowHours = 24): Promise<QaDigest> {
  const turns = await readTurns();
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
  const fresh = turns.filter((t) => Date.parse(t.ts) >= cutoff);

  const conversations = groupByConversation(fresh);

  const summary: QaDigestSummary = {
    windowHours,
    totalConversations: conversations.length,
    totalBooked: conversations.filter((c) => c.finalAction === "booked").length,
    totalHandoff: conversations.filter((c) => c.finalAction === "handoff").length,
    averageTurns: average(conversations.map((c) => c.turns)),
    averageLatencyMs: 0,
    brainHitRate: 0,
    warnings: []
  };

  // Латентность и brain hit rate считаем по turn'ам
  const latencies = fresh.map((t) => t.replyDurationMs ?? 0).filter((v) => v > 0);
  summary.averageLatencyMs = average(latencies);
  const brainHits = fresh.filter((t) => t.brainSource === "anthropic" || t.brainSource === "openai").length;
  summary.brainHitRate = fresh.length ? brainHits / fresh.length : 0;

  // Sort by weirdness
  const byWeird = [...conversations].sort((a, b) => b.weirdnessScore - a.weirdnessScore);
  const byRecency = [...conversations].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));

  if (summary.totalConversations > 0 && summary.totalBooked / summary.totalConversations < 0.05) {
    summary.warnings.push("Конверсия в booked ниже 5% — проверь логи");
  }
  if (summary.averageLatencyMs > 2500) {
    summary.warnings.push(`Высокая средняя латентность: ${Math.round(summary.averageLatencyMs)}мс`);
  }

  return {
    summary,
    topWeird: byWeird.slice(0, 5),
    recent: byRecency.slice(0, 20)
  };
}

function groupByConversation(turns: TurnLogEntry[]): QaConversationSummary[] {
  const byId = new Map<string, TurnLogEntry[]>();
  for (const turn of turns) {
    if (!byId.has(turn.conversationId)) byId.set(turn.conversationId, []);
    byId.get(turn.conversationId)!.push(turn);
  }

  const summaries: QaConversationSummary[] = [];
  for (const [id, list] of byId) {
    list.sort((a, b) => a.turnIndex - b.turnIndex);
    const first = list[0];
    const last = list[list.length - 1];
    const finalAction = last.action;
    const warnings: string[] = [];
    let weirdnessScore = 0;

    // Высокий retry rate
    const retriedTurns = list.filter((t) => {
      const retries = (t.state as any)?.retriesOnAction;
      if (!retries) return false;
      return Object.values(retries).some((v: any) => typeof v === "number" && v >= 2);
    });
    if (retriedTurns.length >= 2) {
      warnings.push(`Много retry: ${retriedTurns.length}`);
      weirdnessScore += retriedTurns.length;
    }

    // Handoff на ранней стадии
    if (finalAction === "handoff" && list.length <= 3) {
      warnings.push("Handoff на ранней стадии (≤3 turn)");
      weirdnessScore += 4;
    }

    // Низкий STT confidence
    const lowConfTurns = list.filter((t) => (t.sttConfidence ?? 1) < 0.6);
    if (lowConfTurns.length >= 2) {
      warnings.push(`STT confidence низкий: ${lowConfTurns.length} turn`);
      weirdnessScore += 2;
    }

    // Очень долгий диалог без booked
    if (list.length > 12 && finalAction !== "booked") {
      warnings.push(`Длинный диалог (${list.length} turn) без booking`);
      weirdnessScore += 3;
    }

    // Высокая латентность
    const highLatency = list.filter((t) => (t.replyDurationMs ?? 0) > 3000);
    if (highLatency.length >= 2) {
      warnings.push(`Латентность >3с: ${highLatency.length} turn`);
      weirdnessScore += 1;
    }

    summaries.push({
      conversationId: id,
      firstSeenAt: first.ts,
      lastSeenAt: last.ts,
      turns: list.length,
      finalAction,
      customerName: last.state?.customerName,
      phone: last.state?.phone,
      direction: last.state?.direction,
      branch: last.state?.branch,
      bookingId: list.find((t) => t.bookingId)?.bookingId,
      warnings,
      weirdnessScore
    });
  }
  return summaries;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export interface QaRating {
  ts: string;
  conversationId: string;
  rating: 1 | 2 | 3 | 4 | 5;
  comment?: string;
  reviewerEmail?: string;
}

export async function recordQaRating(rating: QaRating): Promise<void> {
  await mkdir(dirname(RATINGS_PATH), { recursive: true });
  await appendFile(RATINGS_PATH, `${JSON.stringify(rating)}\n`, "utf8");
}

export async function readQaRatings(): Promise<QaRating[]> {
  try {
    const text = await readFile(RATINGS_PATH, "utf8");
    return text.split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line) as QaRating; } catch { return null; } })
      .filter((value): value is QaRating => value !== null);
  } catch {
    return [];
  }
}

export async function getConversationTurns(conversationId: string): Promise<TurnLogEntry[]> {
  const turns = await readTurns();
  return turns
    .filter((t) => t.conversationId === conversationId)
    .sort((a, b) => a.turnIndex - b.turnIndex);
}
