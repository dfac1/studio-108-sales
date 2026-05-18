import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Slot } from "../types.js";
import type { SalesDialogState } from "./salesDialog.js";

const LOG_PATH = resolve(process.env.CONVERSATION_LOG_PATH ?? "./data/conversations.jsonl");

export interface TurnLogEntry {
  ts: string;
  conversationId: string;
  turnIndex: number;
  userText: string;
  sttProvider?: string;
  sttConfidence?: number;
  sttDurationMs?: number;
  action: string;
  reply: string;
  replyDurationMs?: number;
  thinkingDelayMs?: number;
  backchannel?: string | null;
  state: Partial<SalesDialogState>;
  factsExtracted?: Record<string, unknown>;
  slots?: Array<Pick<Slot, "id" | "weekday" | "time" | "branch" | "direction">>;
  bookingId?: string;
  warnings?: string[];
  brainSource?: string;
  brainCache?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  extractionCache?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
}

export async function logConversationTurn(entry: TurnLogEntry): Promise<void> {
  try {
    await mkdir(dirname(LOG_PATH), { recursive: true });
    await appendFile(LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.error("conversation log write failed", error);
  }
}

export function nextConversationId(state?: Partial<SalesDialogState> & { conversationId?: string }): string {
  if (state?.conversationId) return state.conversationId;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 8);
  return `c-${stamp}-${rand}`;
}
