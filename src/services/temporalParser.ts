import type { Slot } from "../types.js";

export interface TemporalHint {
  weekday?: Slot["weekday"];
  dayType?: "weekday" | "weekend";
  time?: "morning" | "day" | "evening";
  resolvedDate?: string; // YYYY-MM-DD
}

const WEEKDAY_BY_INDEX: Slot["weekday"][] = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

const WEEKDAY_TOKENS: Array<[Slot["weekday"], string[]]> = [
  ["Пн", ["понедельник", "понедельн"]],
  ["Вт", ["вторник", "во вторник"]],
  ["Ср", ["сред", "среду"]],
  ["Чт", ["четверг"]],
  ["Пт", ["пятниц"]],
  ["Сб", ["суббот"]],
  ["Вс", ["воскрес"]]
];

export function parseTemporalHint(text: string, now: Date = new Date()): TemporalHint {
  const lower = text.toLowerCase();
  const hint: TemporalHint = {};

  // Время суток
  if (/\b(утр|до обеда|пораньше)/i.test(lower)) hint.time = "morning";
  else if (/\b(днем|днём|в обед|после обеда)/i.test(lower)) hint.time = "day";
  else if (/\b(вечер|после\s*(?:работы|18|шести|семи)|попозже)/i.test(lower)) hint.time = "evening";

  // Тип дней
  if (/\b(выходн|вых\b|по\s+(?:суббот|воскрес)|субб|воскрес)/i.test(lower)) hint.dayType = "weekend";
  else if (/\b(будн|после школы|по\s+будн)/i.test(lower)) hint.dayType = "weekday";

  // Относительные дни
  const todayIdx = now.getDay();
  if (/\bсегодня\b/i.test(lower)) {
    hint.weekday = WEEKDAY_BY_INDEX[todayIdx];
    hint.resolvedDate = formatDate(now);
  } else if (/\bзавтра\b/i.test(lower) && !/\bпослезавтра\b/i.test(lower)) {
    const date = addDays(now, 1);
    hint.weekday = WEEKDAY_BY_INDEX[date.getDay()];
    hint.resolvedDate = formatDate(date);
  } else if (/\bпослезавтра\b/i.test(lower)) {
    const date = addDays(now, 2);
    hint.weekday = WEEKDAY_BY_INDEX[date.getDay()];
    hint.resolvedDate = formatDate(date);
  } else if (/\bчерез\s+неделю\b/i.test(lower)) {
    const date = addDays(now, 7);
    hint.weekday = WEEKDAY_BY_INDEX[date.getDay()];
    hint.resolvedDate = formatDate(date);
  } else if (/\bна\s+эт(?:их|и|у)\s+выходн/i.test(lower) || /\bв\s+эт(?:и|у)\s+выходн/i.test(lower)) {
    hint.dayType = "weekend";
    const next = nextWeekday(now, 6); // суббота
    hint.weekday = "Сб";
    hint.resolvedDate = formatDate(next);
  } else if (/\bв\s+эту\s+субб/i.test(lower)) {
    hint.weekday = "Сб";
    hint.resolvedDate = formatDate(nextWeekday(now, 6));
  } else if (/\bв\s+это\s+воскрес/i.test(lower)) {
    hint.weekday = "Вс";
    hint.resolvedDate = formatDate(nextWeekday(now, 0));
  } else {
    // Явный день недели
    const explicit = WEEKDAY_TOKENS.find(([, tokens]) => tokens.some((token) => lower.includes(token)));
    if (explicit) {
      hint.weekday = explicit[0];
      const targetIdx = WEEKDAY_BY_INDEX.indexOf(explicit[0]);
      if (targetIdx >= 0) {
        hint.resolvedDate = formatDate(nextWeekday(now, targetIdx));
      }
    }
  }

  return hint;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function nextWeekday(from: Date, targetDayOfWeek: number): Date {
  const fromIdx = from.getDay();
  let diff = (targetDayOfWeek - fromIdx + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(from, diff);
}

function formatDate(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
