import { branches } from "../data/branches.js";
import { getPrice } from "../data/pricing.js";
import type { Branch } from "../types.js";
import { complianceRules, getOpeningDisclosure } from "./complianceService.js";
import { findSlots, formatSlotForSpeech } from "./slotService.js";

export interface VoiceRespondInput {
  transcript: string;
  known?: {
    name?: string;
    phone?: string;
    age?: number;
    direction?: string;
    branch?: Branch;
  };
}

export function respondToInboundLead(input: VoiceRespondInput) {
  const transcript = input.transcript.toLowerCase();
  const known = input.known ?? {};

  if (!transcript.trim()) {
    return {
      reply: getOpeningDisclosure(true),
      nextAction: "ask_permission",
      complianceRules
    };
  }

  const branch = known.branch ?? detectBranch(transcript);
  const direction = known.direction ?? detectDirection(transcript);
  const age = known.age ?? detectAge(transcript);

  if (!direction) {
    return {
      reply: "Подскажите, пожалуйста, какое направление интересно: хип-хоп, брейкданс, контемпорари, йога, зумба, сальса или что-то другое?",
      nextAction: "ask_direction"
    };
  }

  if (!age && isLikelyChildDirection(direction)) {
    return {
      reply: "Для детских групп важно подобрать по возрасту. Сколько лет ребенку?",
      nextAction: "ask_age",
      known: { ...known, direction, branch }
    };
  }

  if (!branch) {
    return {
      reply: "Какой филиал вам удобнее: Развилка, район озера или район первой школы?",
      nextAction: "ask_branch",
      known: { ...known, direction, age }
    };
  }

  const found = findSlots({ direction, branch, age, limit: 3 });
  if (found.length === 0) {
    return {
      reply: "По этим параметрам я не вижу точного группового варианта. Передам заявку администратору, чтобы вам подобрали место без ошибки.",
      nextAction: "handoff",
      known: { ...known, direction, branch, age }
    };
  }

  const price = getPrice(direction, branch);
  const slotText = found.map(formatSlotForSpeech).join("; ");
  const address = branches[branch];

  return {
    reply: `Нашла варианты: ${slotText}. Пробное занятие стоит ${price.trial} рублей. Вам какой вариант зафиксировать? Адрес филиала: ${address.address}${address.floor ? `, ${address.floor}` : ""}.`,
    nextAction: "offer_slots",
    known: { ...known, direction, branch, age },
    slots: found,
    price
  };
}

function detectBranch(text: string): Branch | undefined {
  if (text.includes("развил")) return "Развилка";
  if (text.includes("озер") || text.includes("псекуп")) return "Озеро";
  if (text.includes("школь") || text.includes("первой школ") || text.includes("1 школ")) return "Школьная";
  if (text.includes("чернях")) return "Черняховского";
  return undefined;
}

function detectDirection(text: string): string | undefined {
  const candidates = [
    ["хип", "Hip-hop"],
    ["hip", "Hip-hop"],
    ["брейк", "Breakdance"],
    ["break", "Breakdance"],
    ["контемп", "Contemporary"],
    ["contemporary", "Contemporary"],
    ["йог", "Йога"],
    ["зумб", "Zumba"],
    ["сальс", "Salsa/Bachata"],
    ["бачат", "Salsa/Bachata"],
    ["стрип", "Стрип-пластика"],
    ["к-поп", "K-pop"],
    ["кей-поп", "K-pop"],
    ["k-pop", "K-pop"],
    ["восточ", "Восточные танцы"],
    ["джаз", "Jazz funk"],
    ["lady", "Lady style"],
    ["леди", "Lady style"],
    ["dancehall", "Dancehall"],
    ["дэнс", "Dancehall"],
    ["хореограф", "Детская хореография"]
  ] as const;

  return candidates.find(([needle]) => text.includes(needle))?.[1];
}

function detectAge(text: string): number | undefined {
  const match = text.match(/(\d{1,2})\s*(год|года|лет)?/);
  if (!match) return undefined;
  const age = Number(match[1]);
  return age > 0 && age < 100 ? age : undefined;
}

function isLikelyChildDirection(direction: string): boolean {
  return ["Hip-hop", "Breakdance", "Contemporary", "Детская хореография"].includes(direction);
}
