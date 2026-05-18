import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Booking } from "../types.js";

const QUEUE_PATH = resolve(process.env.REMINDERS_QUEUE_PATH ?? "./data/reminders.jsonl");

export type ReminderKind = "day_before" | "two_hours_before" | "post_trial" | "no_show_followup";
export type ReminderChannel = "sms" | "whatsapp" | "telegram" | "vk" | "call";
export type ReminderStatus = "scheduled" | "sent" | "cancelled" | "failed";

export interface ReminderRecord {
  id: string;
  bookingId: string;
  customerName: string;
  phone: string;
  kind: ReminderKind;
  channel: ReminderChannel;
  scheduledAt: string;
  status: ReminderStatus;
  payload: {
    text: string;
  };
  context?: {
    direction?: string;
    branch?: string;
    weekday?: string;
    time?: string;
    address?: string;
  };
  attemptedAt?: string;
  error?: string;
}

const SLOT_TIME_BY_BOOKING: Map<string, { weekday?: string; time?: string; address?: string; direction?: string; branch?: string }> = new Map();

export function registerSlotMetadata(bookingId: string, meta: { weekday?: string; time?: string; address?: string; direction?: string; branch?: string }): void {
  SLOT_TIME_BY_BOOKING.set(bookingId, meta);
}

export interface ScheduleRemindersInput {
  booking: Booking;
  trialDate: Date;
  channel?: ReminderChannel;
}

export async function scheduleRemindersForBooking(input: ScheduleRemindersInput): Promise<ReminderRecord[]> {
  const meta = SLOT_TIME_BY_BOOKING.get(input.booking.slotId) ?? {};
  const channel = input.channel ?? "whatsapp";
  const records: ReminderRecord[] = [];

  const trialMs = input.trialDate.getTime();
  const dayBefore = new Date(trialMs - 24 * 60 * 60 * 1000);
  const twoHoursBefore = new Date(trialMs - 2 * 60 * 60 * 1000);
  const postTrial = new Date(trialMs + 4 * 60 * 60 * 1000);

  records.push(buildRecord(input.booking, "day_before", channel, dayBefore, meta));
  records.push(buildRecord(input.booking, "two_hours_before", channel, twoHoursBefore, meta));
  records.push(buildRecord(input.booking, "post_trial", channel, postTrial, meta));

  await appendQueue(records);
  return records;
}

function buildRecord(
  booking: Booking,
  kind: ReminderKind,
  channel: ReminderChannel,
  scheduledAt: Date,
  meta: { weekday?: string; time?: string; address?: string; direction?: string; branch?: string }
): ReminderRecord {
  return {
    id: `r-${booking.id}-${kind}`,
    bookingId: booking.id,
    customerName: booking.customerName,
    phone: booking.phone,
    kind,
    channel,
    scheduledAt: scheduledAt.toISOString(),
    status: "scheduled",
    payload: { text: composeText(booking, kind, meta) },
    context: meta
  };
}

function composeText(booking: Booking, kind: ReminderKind, meta: { weekday?: string; time?: string; address?: string; direction?: string; branch?: string }): string {
  const direction = meta.direction ?? booking.direction;
  const where = meta.address ? `, ${meta.address}` : "";
  const when = [meta.weekday, meta.time].filter(Boolean).join(" в ");

  switch (kind) {
    case "day_before":
      return `${booking.customerName}, напоминаем: пробное занятие по ${direction.toLowerCase()} завтра${when ? ` ${when}` : ""}${where}. Ждём вас!`;
    case "two_hours_before":
      return `${booking.customerName}, через два часа ваше пробное по ${direction.toLowerCase()}${where}. Если планы поменялись — напишите, пожалуйста.`;
    case "post_trial":
      return `${booking.customerName}, как прошло пробное? Если понравилось — расскажу про абонемент.`;
    case "no_show_followup":
      return `${booking.customerName}, заметили, что вы не дошли до пробного. Может, поищем удобнее время?`;
    default:
      return "";
  }
}

async function appendQueue(records: ReminderRecord[]): Promise<void> {
  await mkdir(dirname(QUEUE_PATH), { recursive: true });
  const lines = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  await appendFile(QUEUE_PATH, lines, "utf8");
}

export async function readReminderQueue(): Promise<ReminderRecord[]> {
  try {
    const text = await readFile(QUEUE_PATH, "utf8");
    return text.split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line) as ReminderRecord; } catch { return null; }
    }).filter((value): value is ReminderRecord => value !== null);
  } catch {
    return [];
  }
}

export async function persistReminderQueue(records: ReminderRecord[]): Promise<void> {
  await mkdir(dirname(QUEUE_PATH), { recursive: true });
  const text = records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
  await writeFile(QUEUE_PATH, text, "utf8");
}

export async function dueReminders(now: Date = new Date()): Promise<ReminderRecord[]> {
  const all = await readReminderQueue();
  return all.filter((record) => record.status === "scheduled" && Date.parse(record.scheduledAt) <= now.getTime());
}

export async function markReminder(id: string, status: ReminderStatus, error?: string): Promise<void> {
  const all = await readReminderQueue();
  const updated = all.map((record) => record.id === id ? { ...record, status, attemptedAt: new Date().toISOString(), error } : record);
  await persistReminderQueue(updated);
}
