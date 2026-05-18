/**
 * Profile classifier — определяет тип клиента и подсказывает brain'у регистр общения.
 *
 * Идея: топ-менеджер интуитивно меняет манеру под собеседника. Подросток получает короткие
 * фразы, без «вы»; молодая мама — обстоятельные объяснения про педагога и безопасность;
 * занятый профессионал — экономию времени и минимум вопросов.
 *
 * Реализация — rules-based с конфиденс-скорингом. LLM-классификатор не нужен: входные сигналы
 * (возраст, learnerType, ChildGender, длина фраз клиента) хорошо разделяют профили.
 */

import type { SalesDialogState } from "./salesDialog.js";

export type CustomerProfile =
  | "young_parent"   // мама/папа, занятие подбираем для ребёнка 4-12 лет
  | "teen"           // подросток 13-18, звонит сам за себя
  | "busy_adult"     // взрослый 19-44, явные сигналы про нехватку времени
  | "mature"         // взрослый 45+, обычно учится для себя
  | "unknown";       // мало данных

export interface ProfileClassificationResult {
  profile: CustomerProfile;
  confidence: number;
  reasons: string[];
}

interface ProfileInput {
  state: Pick<SalesDialogState, "learnerType" | "age" | "customerName" | "customerGender" | "childGender" | "need">;
  recentMessages: string[];
}

const BUSY_MARKERS = [
  /у\s+меня\s+мало\s+времен/i,
  /после\s+работ/i,
  /некогда/i,
  /времени\s+нет/i,
  /срочно/i,
  /только\s+(?:вечер|поздн)/i,
  /очень\s+занят/i,
  /между\s+встреч/i,
  /я\s+на\s+работе/i,
  /быстр(?:ее|енько)/i
];

const TEEN_MARKERS = [
  /\bлол\b/i,
  /\bбро\b/i,
  /\bкринж/i,
  /\bтипа\b.*\bкак\s+бы/i,
  /\bорёт\b/i,
  /\bвайб/i,
  /\bкаво\b/i,
  /\bхайп/i
];

export function classifyCustomerProfile(input: ProfileInput): ProfileClassificationResult {
  const { state, recentMessages } = input;
  const reasons: string[] = [];

  // young_parent: ребёнок 4-12 лет, learnerType=child
  if (state.learnerType === "child" && state.age && state.age >= 4 && state.age <= 12) {
    reasons.push(`learnerType=child, age=${state.age}`);
    return { profile: "young_parent", confidence: 0.85, reasons };
  }

  // teen: подросток сам за себя 13-18
  if (state.learnerType === "adult" && state.age && state.age >= 13 && state.age <= 18) {
    reasons.push(`learnerType=adult, age=${state.age}`);
    return { profile: "teen", confidence: 0.8, reasons };
  }
  // Дополнительный сигнал — короткие сленговые фразы у adult клиента без возраста
  if (state.learnerType === "adult" && !state.age) {
    const slangHits = recentMessages.filter((msg) => TEEN_MARKERS.some((pat) => pat.test(msg)));
    if (slangHits.length >= 1) {
      reasons.push(`сленг-маркеры в речи: ${slangHits.length}`);
      return { profile: "teen", confidence: 0.55, reasons };
    }
  }

  // busy_adult: явные маркеры нехватки времени или возраст 25-44
  const busyHits = recentMessages.filter((msg) => BUSY_MARKERS.some((pat) => pat.test(msg)));
  if (busyHits.length >= 1) {
    reasons.push(`busy-маркеры в речи: ${busyHits.length}`);
    return { profile: "busy_adult", confidence: 0.75, reasons };
  }
  if (state.learnerType === "adult" && state.age && state.age >= 25 && state.age <= 44) {
    reasons.push(`adult, age=${state.age}, без явных busy-маркеров`);
    return { profile: "busy_adult", confidence: 0.45, reasons };
  }

  // mature: 45+
  if (state.learnerType === "adult" && state.age && state.age >= 45) {
    reasons.push(`learnerType=adult, age=${state.age}`);
    return { profile: "mature", confidence: 0.75, reasons };
  }

  // Дитя <4 или >12 без learnerType
  if (state.learnerType === "child" && state.age && (state.age < 4 || state.age > 12)) {
    reasons.push(`child age outside young_parent band (${state.age})`);
    return { profile: "young_parent", confidence: 0.6, reasons };
  }

  reasons.push("недостаточно данных");
  return { profile: "unknown", confidence: 0.2, reasons };
}

/**
 * Готовая инструкция для Claude — каким регистром общаться с данным профилем.
 * Передаётся в brain как `<customer_profile>` блок.
 */
export function profileGuidanceForBrain(profile: CustomerProfile): string {
  switch (profile) {
    case "young_parent":
      return [
        "Профиль: молодой родитель, занятие для ребёнка.",
        "Регистр: тёплый, заботливый, обстоятельный. Без давления.",
        "Можно упомянуть педагога и комфорт ребёнка («педагог встретит, проводит в зал»).",
        "Не уходи в психологические термины («раскрепощение», «социализация»). Простые слова: «понравится», «попробует», «спокойно»."
      ].join(" ");
    case "teen":
      return [
        "Профиль: подросток, звонит сам за себя.",
        "Регистр: короче, проще, дружелюбнее. Без «дочка/сын», без «уважаемый».",
        "Можно говорить «попробуй», «приходи на пробное», но «вы» оставляй — это всё-таки сервис.",
        "Не объясняй слишком много — подростки сразу хотят знать когда и где."
      ].join(" ");
    case "busy_adult":
      return [
        "Профиль: занятой взрослый.",
        "Регистр: уважительный, по делу, без лишних слов.",
        "Минимизируй число уточняющих вопросов. Если есть один лучший слот — сразу предлагай его.",
        "Не задавай вопросов про «цель занятий» — клиент сам скажет если хочет."
      ].join(" ");
    case "mature":
      return [
        "Профиль: зрелый клиент 45+.",
        "Регистр: спокойный, уважительный, неспешный.",
        "Дай чуть больше времени, не торопись с предложением слота. Подчеркни «начальный уровень», «без опыта», «спокойный темп»."
      ].join(" ");
    case "unknown":
    default:
      return [
        "Профиль: пока не определён.",
        "Регистр: нейтральный, тёплый, по делу. Не задавай профильных вопросов."
      ].join(" ");
  }
}
