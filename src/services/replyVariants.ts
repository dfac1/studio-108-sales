import { config } from "../config.js";
import { logVariantPick } from "./featureFlags.js";

const lastPickByKey = new Map<string, string>();

function pick<T extends string>(key: string, items: T[]): T {
  const last = lastPickByKey.get(key);
  let candidate = items[Math.floor(Math.random() * items.length)];
  if (items.length > 1 && candidate === last) {
    const alternatives = items.filter((item) => item !== last);
    candidate = alternatives[Math.floor(Math.random() * alternatives.length)];
  }
  lastPickByKey.set(key, candidate);
  logVariantPick(key, candidate, items);
  // Если в фразе не было обращения по имени (maybeName вернул ""), а первое слово начинается со строчной — поднимаем регистр.
  const capitalized = candidate.replace(/^([а-яёa-z])/u, (m) => m.toUpperCase()) as T;
  return capitalized;
}

// Память по последнему обращению по имени (in-process). Для пилотного теста ОК.
const lastNameUsageByContext = new Map<string, number>();

/** Имя через раз: возвращает "Имя, " с шансом ~45%, но не два раза подряд. */
function maybeName(customerName?: string, slotKey: string = "any"): string {
  if (!customerName) return "";
  const turnsSinceLast = lastNameUsageByContext.get("global") ?? 99;
  if (turnsSinceLast < 1) {
    lastNameUsageByContext.set("global", turnsSinceLast + 1);
    return "";
  }
  const probability = slotKey === "greeting" ? 0.95 : slotKey === "branch" || slotKey === "phone" ? 0.6 : 0.4;
  if (Math.random() < probability) {
    lastNameUsageByContext.set("global", 0);
    return `${customerName}, `;
  }
  lastNameUsageByContext.set("global", turnsSinceLast + 1);
  return "";
}

interface ChildForms {
  dative: string;        // "дочке", "сыну", "ребёнку" (кому)
  genitive: string;      // "дочки", "сына", "ребёнка" (для кого)
  pron: string;          // "ей", "ему", "ребёнку"
  isKnown: boolean;
}

function getChildForms(gender?: "boy" | "girl" | "unknown"): ChildForms {
  if (gender === "girl") return { dative: "дочке", genitive: "дочки", pron: "ей", isKnown: true };
  if (gender === "boy")  return { dative: "сыну",  genitive: "сына",  pron: "ему", isKnown: true };
  return { dative: "ребёнку", genitive: "ребёнка", pron: "ребёнку", isKnown: false };
}

export function greeting(): string {
  const name = config.voice.assistantName;
  return pick("greeting", [
    `Здравствуйте, это ${name} из Studio 108. Как к вам можно обращаться?`,
    `Здравствуйте! ${name}, Studio 108. Подскажите, как к вам обращаться?`,
    `Здравствуйте, меня зовут ${name}, Studio 108. Как вас зовут?`,
    `Добрый день, ${name}, Studio 108. Как к вам можно обращаться?`
  ]);
}

export function continuityGreeting(customerName: string, daysSinceLast: number, lastDirection?: string): string {
  const name = config.voice.assistantName;
  const when = daysSinceLast <= 0 ? "сегодня" : daysSinceLast === 1 ? "вчера" : `${daysSinceLast} дней назад`;
  const direction = lastDirection ? ` про ${lastDirection.toLowerCase()}` : " про пробное занятие";
  return `${customerName}, здравствуйте! Это ${name}, Studio 108. Мы общались ${when}${direction}. Подскажите, удобно сейчас договорить?`;
}

export function returningCustomerGreeting(customerName: string): string {
  const name = config.voice.assistantName;
  return `${customerName}, добрый день! Это ${name}, Studio 108. Рада вас снова слышать. Как могу помочь?`;
}

export function askLearner(customerName?: string): string {
  const prefix = maybeName(customerName, "learner");
  return pick("ask_learner", [
    `${prefix}подбираем занятие для вас или для ребёнка?`,
    `${prefix}скажите, занятие для вас или для ребёнка?`,
    `${prefix}для вас подбираем или для ребёнка?`
  ]);
}

export function askNeedAdult(customerName?: string): string {
  const prefix = maybeName(customerName, "need");
  return pick("ask_need_adult", [
    `${prefix}вам ближе что-то поактивнее, или поспокойнее? Или уже знаете, какое направление хотите попробовать?`,
    `${prefix}хочется чего-то активного или спокойного? Или уже выбрали конкретное направление в танцах?`,
    `${prefix}что вам ближе — динамичные танцы или спокойные? Или уже есть направление, которое нравится?`
  ]);
}

export function askNeedChild(customerName?: string, childGender?: "boy" | "girl" | "unknown"): string {
  const prefix = maybeName(customerName, "need");
  const child = getChildForms(childGender);
  return pick("ask_need_child", [
    `${prefix}для ${child.genitive} хотите просто попробовать танцы — или уже знаете, на какое направление записать?`,
    `${prefix}пробуем разные направления, чтобы ${child.pron} понравилось, или уже выбрали конкретное?`,
    `${prefix}хотите для ${child.genitive} попробовать танцы в целом, или уже есть направление, которое нравится?`,
    `${prefix}для ${child.genitive} лучше начать с пробного, чтобы посмотреть, или уже выбрали направление?`
  ]);
}

export function askAgeAdult(customerName?: string): string {
  const prefix = maybeName(customerName, "age");
  return pick("ask_age_adult", [
    `${prefix}сколько вам лет?`,
    `${prefix}возраст подскажите?`,
    `${prefix}сколько вам?`,
    `${prefix}а сколько лет?`
  ]);
}

export function askAgeChild(customerName?: string, childGender?: "boy" | "girl" | "unknown"): string {
  const prefix = maybeName(customerName, "age");
  const child = getChildForms(childGender);
  return pick("ask_age_child", [
    `${prefix}сколько лет ${child.dative}?`,
    `${prefix}возраст ${child.genitive} подскажите?`,
    `${prefix}а сколько ${child.dative}?`,
    child.isKnown ? `${prefix}сколько ${child.pron} лет?` : `${prefix}сколько лет ребёнку?`
  ]);
}

// Тексты ниже синхронизированы с PREGEN_PHRASES (ask_branch_*_v2) — pregen-кеш матчится по тексту.
export function askBranchOpen(): string {
  return pick("ask_branch_open", [
    `Где удобнее заниматься — на Развилке, у озера или возле первой школы?`,
    `Подскажите, какой район ближе — Развилка, у озера или возле первой школы?`,
    `А какой филиал вам удобнее — Развилка, у озера или возле первой школы?`
  ]);
}

export function askBranchAfterAddress(): string {
  return pick("ask_branch_after_address", [
    `У нас три филиала: на Развилке, у озера и возле первой школы. Какой вам удобнее?`,
    `Мы есть на Развилке, у озера и возле первой школы. Какой район ближе?`,
    `Три точки: Развилка, у озера и возле первой школы. Какая удобнее?`
  ]);
}

// ВАЖНО: тексты askBranchOpen синхронизированы с PREGEN_PHRASES (ask_branch_*_v2).
// Если меняешь формулировку — обнови ключ в preGeneratedReplies.ts, иначе кеш будет промахиваться.

export function askPhone(
  customerName?: string,
  slotMention?: string,
  trialPrice?: number,
  options?: { mentionPrice?: boolean }
): string {
  // slotMention уже может начинаться с предлога ("в среду в 20:00..."); не дублируем "на".
  const slot = slotMention
    ? (/^(?:в|во|на)\s/i.test(slotMention) ? slotMention : `на ${slotMention}`)
    : "на пробное занятие";
  const prefix = customerName && Math.random() < 0.5 ? `Отлично, ${customerName}. ` : "Отлично. ";
  const mentionPrice = options?.mentionPrice ?? true;
  const priceLine = mentionPrice && trialPrice ? `Пробное у нас по ${trialPrice} рублей. ` : "";
  return pick("ask_phone", [
    `${prefix}${priceLine}Запишу ${slot}. Подскажите номер телефона для записи.`,
    `${prefix}${priceLine}Запишу ${slot}. Какой номер указать для записи?`,
    `${prefix}${priceLine}Фиксирую ${slot}. Подскажите телефон, на него пришлём подтверждение.`
  ]);
}

export function askConsent(): string {
  return pick("ask_consent", [
    `Можно сохранить ваше имя, телефон и выбранное занятие, чтобы оформить запись?`,
    `Подтвердите, можно сохранить данные для записи?`,
    `Сохраняю имя, телефон и время для записи, согласны?`
  ]);
}
