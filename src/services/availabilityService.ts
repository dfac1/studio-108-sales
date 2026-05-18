import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Slot } from "../types.js";
import { slots } from "../data/slots.js";

export interface SlotAvailability {
  capacity: number;
  freePlaces: number;
}

const availabilityPath = resolve("./data/slot-availability.json");

function defaultAvailability(slot: Slot): SlotAvailability {
  const direction = slot.direction.toLowerCase();
  const level = (slot.level ?? "").toLowerCase();

  if (level.includes("4-6") || direction.includes("детская")) {
    return { capacity: 10, freePlaces: 4 };
  }

  if (direction.includes("salsa") || direction.includes("bachata")) {
    return { capacity: 16, freePlaces: 6 };
  }

  if (direction.includes("break")) {
    return { capacity: 12, freePlaces: 3 };
  }

  if (direction.includes("йога")) {
    return { capacity: 14, freePlaces: 5 };
  }

  if (level.includes("pro") || direction.includes("pro")) {
    return { capacity: 8, freePlaces: 2 };
  }

  return { capacity: 12, freePlaces: 4 };
}

function readAvailability(): Record<string, SlotAvailability> {
  if (!existsSync(availabilityPath)) {
    const seeded = Object.fromEntries(slots.map((slot) => [slot.id, defaultAvailability(slot)]));
    writeAvailability(seeded);
    return seeded;
  }

  let parsed: Record<string, SlotAvailability>;
  try {
    parsed = JSON.parse(readFileSync(availabilityPath, "utf8")) as Record<string, SlotAvailability>;
  } catch {
    const seeded = Object.fromEntries(slots.map((slot) => [slot.id, defaultAvailability(slot)]));
    writeAvailability(seeded);
    return seeded;
  }
  let changed = false;

  for (const slot of slots) {
    if (!parsed[slot.id]) {
      parsed[slot.id] = defaultAvailability(slot);
      changed = true;
    }
  }

  if (changed) {
    writeAvailability(parsed);
  }

  return parsed;
}

function writeAvailability(value: Record<string, SlotAvailability>) {
  mkdirSync(dirname(availabilityPath), { recursive: true });
  writeFileSync(availabilityPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function withAvailability(slot: Slot): Slot {
  const availability = readAvailability()[slot.id] ?? defaultAvailability(slot);
  return {
    ...slot,
    capacity: availability.capacity,
    freePlaces: availability.freePlaces
  };
}

export function getAllAvailability(): Record<string, SlotAvailability> {
  return readAvailability();
}

export function reserveSlot(slotId: string): SlotAvailability {
  const availability = readAvailability();
  const current = availability[slotId];

  if (!current) {
    throw new Error("Слот не найден в тестовом поле доступности.");
  }

  if (current.freePlaces <= 0) {
    throw new Error("В выбранной группе больше нет свободных мест.");
  }

  const next = {
    ...current,
    freePlaces: current.freePlaces - 1
  };

  availability[slotId] = next;
  writeAvailability(availability);
  return next;
}

export function resetAvailabilityForTests() {
  const seeded = Object.fromEntries(slots.map((slot) => [slot.id, defaultAvailability(slot)]));
  writeAvailability(seeded);
}
