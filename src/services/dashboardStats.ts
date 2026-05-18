import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CONVERSATIONS_PATH = resolve(process.env.CONVERSATION_LOG_PATH ?? "./data/conversations.jsonl");
const HANDOFFS_PATH = resolve(process.env.HANDOFF_LOG_PATH ?? "./data/handoffs.jsonl");

interface TurnRecord {
  ts: string;
  conversationId: string;
  turnIndex: number;
  userText: string;
  action: string;
  reply: string;
  thinkingDelayMs?: number;
  bookingId?: string;
}

interface HandoffRecord {
  ts: string;
  conversationId?: string;
  reason: string;
  lastStage?: string;
  customerName?: string;
  phone?: string;
  summary: string;
  callbackPriority: "high" | "normal";
}

export interface DashboardStats {
  generatedAt: string;
  windowDays: number;
  totals: {
    conversations: number;
    turns: number;
    bookings: number;
    handoffs: number;
    avgTurnsPerConversation: number;
    bookingConversionPct: number;
    handoffRatePct: number;
  };
  perStep: Array<{
    action: string;
    entered: number;
    exited: number;
    dropOffPct: number;
  }>;
  handoffsByReason: Array<{ reason: string; count: number }>;
  recentHandoffs: Array<{
    ts: string;
    customerName?: string;
    phone?: string;
    reason: string;
    lastStage?: string;
    summary: string;
    priority: string;
  }>;
}

export async function buildDashboardStats(windowDays = 7): Promise<DashboardStats> {
  const turns = await readJsonl<TurnRecord>(CONVERSATIONS_PATH);
  const handoffs = await readJsonl<HandoffRecord>(HANDOFFS_PATH);

  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const recentTurns = turns.filter((turn) => Date.parse(turn.ts) >= cutoff);
  const recentHandoffs = handoffs.filter((h) => Date.parse(h.ts) >= cutoff);

  const turnsByConversation = new Map<string, TurnRecord[]>();
  for (const turn of recentTurns) {
    const list = turnsByConversation.get(turn.conversationId) ?? [];
    list.push(turn);
    turnsByConversation.set(turn.conversationId, list);
  }

  const conversations = turnsByConversation.size;
  const totalTurns = recentTurns.length;
  let bookings = 0;
  for (const list of turnsByConversation.values()) {
    if (list.some((turn) => turn.bookingId)) bookings += 1;
  }

  // Drop-off per step: сколько раз клиент попал на каждый шаг и сколько ушёл дальше.
  const enteredByAction = new Map<string, number>();
  const exitedByAction = new Map<string, number>();
  for (const list of turnsByConversation.values()) {
    const sorted = [...list].sort((a, b) => a.turnIndex - b.turnIndex);
    for (let i = 0; i < sorted.length; i++) {
      const action = sorted[i].action;
      enteredByAction.set(action, (enteredByAction.get(action) ?? 0) + 1);
      const next = sorted[i + 1];
      if (next && next.action !== action) {
        exitedByAction.set(action, (exitedByAction.get(action) ?? 0) + 1);
      }
    }
  }

  const perStep = [...enteredByAction.entries()]
    .map(([action, entered]) => {
      const exited = exitedByAction.get(action) ?? 0;
      const dropOffPct = entered > 0 ? Math.round(((entered - exited) / entered) * 100) : 0;
      return { action, entered, exited, dropOffPct };
    })
    .sort((a, b) => b.entered - a.entered);

  const handoffCounts = new Map<string, number>();
  for (const h of recentHandoffs) {
    handoffCounts.set(h.reason, (handoffCounts.get(h.reason) ?? 0) + 1);
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    totals: {
      conversations,
      turns: totalTurns,
      bookings,
      handoffs: recentHandoffs.length,
      avgTurnsPerConversation: conversations > 0 ? Math.round((totalTurns / conversations) * 10) / 10 : 0,
      bookingConversionPct: conversations > 0 ? Math.round((bookings / conversations) * 100) : 0,
      handoffRatePct: conversations > 0 ? Math.round((recentHandoffs.length / conversations) * 100) : 0
    },
    perStep,
    handoffsByReason: [...handoffCounts.entries()].map(([reason, count]) => ({ reason, count })),
    recentHandoffs: recentHandoffs.slice(-10).reverse().map((h) => ({
      ts: h.ts,
      customerName: h.customerName,
      phone: h.phone,
      reason: h.reason,
      lastStage: h.lastStage,
      summary: h.summary,
      priority: h.callbackPriority
    }))
  };
}

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const text = await readFile(path, "utf8");
    return text.split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line) as T; } catch { return null; }
    }).filter((value): value is T => value !== null);
  } catch {
    return [];
  }
}
