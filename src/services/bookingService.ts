import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { branches } from "../data/branches.js";
import type { Booking } from "../types.js";
import { reserveSlot } from "./availabilityService.js";
import { getSlotById } from "./slotService.js";
import { registerSlotMetadata, scheduleRemindersForBooking } from "./reminderService.js";

export const bookingInputSchema = z.object({
  customerName: z.string().min(2),
  phone: z.string().min(7),
  age: z.number().int().positive().optional(),
  direction: z.string().min(2),
  branch: z.enum(["Озеро", "Развилка", "Школьная", "Черняховского"]),
  slotId: z.string().min(3),
  source: z.enum(["inbound_call", "inbound_form", "manual_test"]).default("manual_test"),
  notes: z.string().max(1000).optional(),
  consent: z.object({
    personalData: z.literal(true),
    aiVoiceDisclosure: z.boolean().optional(),
    callRecording: z.boolean().optional(),
    crossBorderTransfer: z.boolean().optional()
  })
});

export type BookingInput = z.infer<typeof bookingInputSchema>;

export async function createBooking(input: BookingInput): Promise<Booking> {
  const slot = getSlotById(input.slotId);
  if (!slot) {
    throw new Error("Выбранный слот не найден в актуальном расписании.");
  }

  if (slot.branch !== input.branch) {
    throw new Error("Филиал записи не совпадает с филиалом выбранного слота.");
  }

  if (slot.freePlaces <= 0) {
    throw new Error("В выбранной группе больше нет свободных мест.");
  }

  const booking: Booking = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    customerName: input.customerName,
    phone: input.phone,
    age: input.age,
    direction: input.direction,
    branch: input.branch,
    slotId: input.slotId,
    status: "trial_booked",
    source: input.source,
    notes: input.notes
  };

  const storagePath = resolve(config.bookingsStoragePath);
  await mkdir(dirname(storagePath), { recursive: true });
  const availabilityAfterBooking = reserveSlot(input.slotId);
  await appendFile(storagePath, `${JSON.stringify({ ...booking, consent: input.consent })}\n`, "utf8");

  const branchInfo = branches[input.branch];
  registerSlotMetadata(booking.id, {
    weekday: slot.weekday,
    time: slot.time,
    address: branchInfo.address,
    direction: input.direction,
    branch: input.branch
  });
  const trialDate = nextWeekdayDate(slot.weekday, slot.time);
  scheduleRemindersForBooking({ booking, trialDate }).catch((err) => console.error("schedule reminders failed", err));

  return {
    ...booking,
    notes: `${booking.notes ?? ""}${booking.notes ? " " : ""}Осталось мест: ${availabilityAfterBooking.freePlaces}.`
  };
}

const WEEKDAY_TO_INDEX: Record<string, number> = { Пн: 1, Вт: 2, Ср: 3, Чт: 4, Пт: 5, Сб: 6, Вс: 0 };

function nextWeekdayDate(weekday: string, time: string): Date {
  const target = WEEKDAY_TO_INDEX[weekday] ?? 0;
  const now = new Date();
  const result = new Date(now);
  let diff = (target - now.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  result.setDate(now.getDate() + diff);
  const [h, m] = time.split(":").map(Number);
  result.setHours(h ?? 19, m ?? 0, 0, 0);
  return result;
}
