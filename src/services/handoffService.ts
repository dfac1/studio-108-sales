import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config, type AdminEntry } from "../config.js";
import type { SalesDialogState } from "./salesDialog.js";

const HANDOFF_PATH = resolve(process.env.HANDOFF_LOG_PATH ?? "./data/handoffs.jsonl");

let routingCursor = 0;

export type HandoffReason =
  | "explicit_request"
  | "loop_guard"
  | "underage"
  | "no_slots"
  | "consent_refused"
  | "consent_without_slot"
  | "consent_missing_required_fields"
  | "clarify_max"
  | "manual";

export interface HandoffRecord {
  ts: string;
  conversationId?: string;
  reason: HandoffReason;
  lastStage?: string;
  lastUserText?: string;
  customerName?: string;
  phone?: string;
  age?: number;
  learnerType?: string;
  direction?: string;
  branch?: string;
  preferredTime?: string;
  preferredWeekday?: string;
  preferredDayType?: string;
  selectedSlotId?: string;
  recentActions?: string[];
  summary: string;
  callbackPriority: "high" | "normal";
  routedTo?: AdminEntry;
}

export async function recordHandoff(input: {
  reason: HandoffReason;
  state: SalesDialogState;
  lastUserText?: string;
}): Promise<HandoffRecord> {
  const record: HandoffRecord = {
    ts: new Date().toISOString(),
    conversationId: input.state.conversationId,
    reason: input.reason,
    lastStage: input.state.stage,
    lastUserText: input.lastUserText?.slice(0, 240),
    customerName: input.state.customerName,
    phone: input.state.phone,
    age: input.state.age,
    learnerType: input.state.learnerType,
    direction: input.state.direction,
    branch: input.state.branch,
    preferredTime: input.state.preferredTime,
    preferredWeekday: input.state.preferredWeekday,
    preferredDayType: input.state.preferredDayType,
    selectedSlotId: input.state.selectedSlotId,
    recentActions: input.state.recentActions?.slice(-5),
    summary: buildHandoffSummary(input.reason, input.state),
    callbackPriority: input.reason === "explicit_request" || input.reason === "no_slots" ? "high" : "normal",
    routedTo: routeAdmin(input.state.branch)
  };

  try {
    await mkdir(dirname(HANDOFF_PATH), { recursive: true });
    await appendFile(HANDOFF_PATH, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.error("handoff log write failed", error);
  }

  return record;
}

function routeAdmin(branch?: string): AdminEntry | undefined {
  const admins = config.admins;
  if (!admins.length) return undefined;
  if (branch) {
    const branchAdmins = admins.filter((admin) => !admin.branches || admin.branches.includes(branch));
    if (branchAdmins.length) {
      const picked = branchAdmins[routingCursor % branchAdmins.length];
      routingCursor = (routingCursor + 1) % Math.max(1, branchAdmins.length);
      return picked;
    }
  }
  const picked = admins[routingCursor % admins.length];
  routingCursor = (routingCursor + 1) % admins.length;
  return picked;
}

function buildHandoffSummary(reason: HandoffReason, state: SalesDialogState): string {
  const parts: string[] = [];
  if (state.customerName) parts.push(`Клиент: ${state.customerName}`);
  if (state.phone) parts.push(`Тел: ${state.phone}`);
  if (state.learnerType) {
    parts.push(state.learnerType === "child" ? "Для ребёнка" : "Для себя");
  }
  if (state.age) parts.push(`Возраст: ${state.age}`);
  if (state.direction) parts.push(`Направление: ${state.direction}`);
  if (state.branch) parts.push(`Филиал: ${state.branch}`);
  if (state.preferredTime || state.preferredWeekday || state.preferredDayType) {
    const time = [state.preferredWeekday, state.preferredDayType, state.preferredTime].filter(Boolean).join("/");
    parts.push(`Время: ${time}`);
  }

  const reasonText: Record<HandoffReason, string> = {
    explicit_request: "клиент сам попросил соединить с человеком",
    loop_guard: "ассистент застрял на одном шаге диалога",
    underage: "слишком маленький ребёнок (младше 4 лет)",
    no_slots: "нет подходящих свободных слотов в расписании",
    consent_refused: "клиент отказался от обработки данных",
    consent_without_slot: "клиент согласился, но слот не был выбран — подобрать вручную",
    consent_missing_required_fields: "клиент согласился, но не хватает данных для брони — уточнить",
    clarify_max: "не удалось расслышать клиента",
    manual: "ручная передача"
  };
  parts.push(`Причина: ${reasonText[reason]}`);
  if (state.stage) parts.push(`Шаг диалога: ${state.stage}`);

  return parts.join(". ") + ".";
}
