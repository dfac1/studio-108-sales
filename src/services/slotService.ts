import type { Branch, Slot } from "../types.js";
import { slots } from "../data/slots.js";
import { withAvailability } from "./availabilityService.js";

export interface SlotSearch {
  direction?: string;
  branch?: Branch;
  age?: number;
  preferredTime?: "morning" | "day" | "evening";
  limit?: number;
}

function normalize(value: string): string {
  return value.toLowerCase().replace("хип-хоп", "hip-hop").replace("хип хоп", "hip-hop");
}

function isPreferredTime(slot: Slot, preferredTime?: SlotSearch["preferredTime"]): boolean {
  if (!preferredTime) return true;
  const hour = Number(slot.time.slice(0, 2));
  if (preferredTime === "morning") return hour < 12;
  if (preferredTime === "day") return hour >= 12 && hour < 18;
  return hour >= 17;
}

function isAgeMatch(slot: Slot, age?: number): boolean {
  if (!age) return true;
  const level = normalize(slot.level ?? "");
  const direction = normalize(slot.direction);

  if (slot.ageMin && age < slot.ageMin) return false;
  if (slot.ageMax && age > slot.ageMax) return false;

  if (age <= 6) {
    return Boolean(slot.ageMin && slot.ageMax) || level.includes("4-6") || direction.includes("детская");
  }

  if (age < 16) {
    const adultOnly = level.includes("взрос") || level.includes("pro") || direction.includes("pro") || direction.includes("стрип") || direction.includes("lady") || direction.includes("dancehall") || direction.includes("йога") || direction.includes("salsa");
    return !adultOnly;
  }

  return true;
}

export function findSlots(search: SlotSearch): Slot[] {
  const limit = search.limit ?? 3;
  const direction = search.direction ? normalize(search.direction) : undefined;

  return slots
    .map(withAvailability)
    .filter((slot) => slot.clientVisible)
    .filter((slot) => slot.freePlaces > 0)
    .filter((slot) => !search.branch || slot.branch === search.branch)
    .filter((slot) => !direction || normalize(`${slot.direction} ${slot.level ?? ""}`).includes(direction) || direction.includes(normalize(slot.direction)))
    .filter((slot) => isAgeMatch(slot, search.age))
    .filter((slot) => isPreferredTime(slot, search.preferredTime))
    .filter((slot) => !(slot.branch === "Школьная" && normalize(slot.direction).includes("стрип")))
    .slice(0, limit);
}

export function getSlotById(slotId: string): Slot | undefined {
  const slot = slots.find((candidate) => candidate.id === slotId);
  return slot ? withAvailability(slot) : undefined;
}

export function formatSlotForSpeech(slot: Slot): string {
  const level = slot.level ? `, ${slot.level}` : "";
  return `${slot.weekday} в ${slot.time}, ${slot.branch}, ${slot.direction}${level}, педагог ${slot.teacher}, свободных мест ${slot.freePlaces}`;
}
