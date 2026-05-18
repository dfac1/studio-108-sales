import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const BOOKINGS_PATH = resolve(process.env.BOOKINGS_STORAGE_PATH ?? "./data/bookings.jsonl");
const CONVERSATIONS_PATH = resolve(process.env.CONVERSATION_LOG_PATH ?? "./data/conversations.jsonl");
const HANDOFFS_PATH = resolve(process.env.HANDOFF_LOG_PATH ?? "./data/handoffs.jsonl");

export interface PreviousContact {
  hasPreviousContact: boolean;
  daysSinceLast?: number;
  lastTs?: string;
  customerName?: string;
  hasBooking: boolean;
  lastDirection?: string;
  lastBranch?: string;
  lastAction?: string;
  notes?: string;
}

export async function lookupPreviousContact(phone: string): Promise<PreviousContact> {
  const normalized = normalizePhone(phone);
  if (!normalized) return { hasPreviousContact: false, hasBooking: false };

  const [bookings, turns, handoffs] = await Promise.all([
    readJsonl<{ phone: string; customerName: string; createdAt: string; direction?: string; branch?: string }>(BOOKINGS_PATH),
    readJsonl<{ ts: string; conversationId: string; turnIndex: number; userText: string; action: string; reply: string; state?: { phone?: string; customerName?: string; direction?: string; branch?: string } }>(CONVERSATIONS_PATH),
    readJsonl<{ ts: string; phone?: string; customerName?: string; lastStage?: string }>(HANDOFFS_PATH)
  ]);

  const matchedBookings = bookings.filter((b) => normalizePhone(b.phone) === normalized);
  const matchedTurns = turns.filter((turn) => normalizePhone(turn.state?.phone ?? "") === normalized);
  const matchedHandoffs = handoffs.filter((h) => normalizePhone(h.phone ?? "") === normalized);

  const allEvents: Array<{ ts: string; source: "booking" | "turn" | "handoff"; record: unknown }> = [
    ...matchedBookings.map((b) => ({ ts: b.createdAt, source: "booking" as const, record: b })),
    ...matchedTurns.map((t) => ({ ts: t.ts, source: "turn" as const, record: t })),
    ...matchedHandoffs.map((h) => ({ ts: h.ts, source: "handoff" as const, record: h }))
  ].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));

  if (!allEvents.length) return { hasPreviousContact: false, hasBooking: false };

  const last = allEvents[0];
  const lastTs = last.ts;
  const daysSinceLast = Math.floor((Date.now() - Date.parse(lastTs)) / (24 * 60 * 60 * 1000));

  const customerName =
    matchedBookings[0]?.customerName ??
    matchedTurns[0]?.state?.customerName ??
    matchedHandoffs[0]?.customerName;

  const lastDirection = matchedBookings[0]?.direction ?? matchedTurns[0]?.state?.direction;
  const lastBranch = matchedBookings[0]?.branch ?? matchedTurns[0]?.state?.branch;
  const lastAction = matchedTurns[0]?.action ?? matchedHandoffs[0]?.lastStage;

  return {
    hasPreviousContact: true,
    daysSinceLast,
    lastTs,
    customerName,
    hasBooking: matchedBookings.length > 0,
    lastDirection,
    lastBranch,
    lastAction,
    notes: matchedHandoffs[0]?.lastStage ? `Прошлый handoff на шаге ${matchedHandoffs[0].lastStage}.` : undefined
  };
}

function normalizePhone(phone: string): string {
  if (!phone) return "";
  const digits = phone.replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.startsWith("8") && digits.length === 11) return `+7${digits.slice(1)}`;
  if (digits.startsWith("7") && digits.length === 11) return `+${digits}`;
  return digits.length >= 10 ? `+${digits}` : "";
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
