// Новый dialog-handler по PSY-паттерну: LLM ведёт сценарий через промпт + маркеры.
// См. salesPromptSteps.ts и memory/psy_reference_architecture.
//
// Контракт совместим со старым handleSalesDialog — voicePipeline переключается
// флагом USE_DIALOG_V2, без других изменений.

import { config } from "../config.js";
import type { Slot, Booking, Branch } from "../types.js";
import { callAnthropicText, callAnthropicTextStream, isAnthropicConfigured } from "./anthropicClient.js";

/** Streaming-режим Anthropic. При USE_LLM_STREAMING=true внутри ходим тем же контрактом,
 *  но логируем `llm_first_token` / `llm_first_sentence`. Контракт ответа caller'у не меняется.
 *  Откат: убрать env var, рестарт ~30 сек. */
const USE_LLM_STREAMING = process.env.USE_LLM_STREAMING === "true";
import { findSlots, getSlotById } from "./slotService.js";
import { slots as allSlots } from "../data/slots.js";
import { createBooking } from "./bookingService.js";
import { cleanHumanReply } from "./russianSpeech.js";
import {
  buildStepPrompt,
  parseTransition,
  stripTransitionMarker,
  type StepId,
  type SalesSessionContext,
  type AvailableSlot,
} from "./salesPromptSteps.js";
import type { SalesDialogState, SalesDialogResult, SalesDialogInput } from "./salesDialog.js";
import { extractRussianNumeralWordsAsDigits, normalizeRussianPhone, directionForSpeech } from "./salesDialog.js";
import { recordHandoff } from "./handoffService.js";
import type { SalesBrainAction } from "./openAiSalesBrain.js";

/** v2 step ↔ старый SalesBrainAction для совместимости с voicePipeline.action. */
const STEP_TO_ACTION: Record<StepId, SalesBrainAction> = {
  ask_name: "ask_name",
  ask_learner: "ask_learner",
  ask_age: "ask_age",
  ask_direction: "ask_need",
  ask_branch: "ask_branch",
  offer_slot: "offer_solution",
  ask_phone: "ask_phone",
  ask_consent: "ask_consent",
  booked: "booked",
  handoff: "handoff",
};

const VALID_DIRECTIONS = new Set([
  "Hip-hop", "Breakdance", "Contemporary", "Lady style", "Yoga", "Zumba",
  "Salsa/Bachata", "K-pop", "Stretch", "Детская хореография", "Восточные танцы", "Jazz funk"
]);

const VALID_BRANCHES = new Set<Branch>(["Развилка", "Озеро", "Школьная", "Черняховского"]);

/** State coming in carries `stage` which we use as StepId. Default to ask_name. */
function currentStep(state: SalesDialogState | undefined): StepId {
  const s = state?.stage;
  if (s === "ask_name" || s === "ask_learner" || s === "ask_age" || s === "ask_direction" ||
      s === "ask_branch" || s === "offer_slot" || s === "ask_phone" || s === "ask_consent" ||
      s === "booked" || s === "handoff") {
    return s;
  }
  return "ask_name";
}

/** Преобразуем накопленный state в контекст для промпта. */
function buildContext(state: SalesDialogState): SalesSessionContext {
  const ctx: SalesSessionContext = {};
  if (state.customerName) ctx.customerName = state.customerName;
  if (state.customerGender && state.customerGender !== "unknown") ctx.customerGender = state.customerGender;
  if (state.learnerType === "child") ctx.learnerType = "child";
  else if (state.learnerType === "adult") ctx.learnerType = "self";
  if (state.childGender === "boy" || state.childGender === "girl") ctx.childGender = state.childGender;
  if (state.age !== undefined) ctx.age = state.age;
  if (state.direction) ctx.direction = state.direction;
  if (state.rejectedDirections?.length) ctx.rejectedDirections = [...state.rejectedDirections];
  if (state.branch && state.branch !== "Черняховского") ctx.branch = state.branch;
  if (state.preferredTime) ctx.preferredTime = state.preferredTime;
  if (state.preferredWeekday) ctx.preferredWeekday = state.preferredWeekday;
  if (state.preferredDayType) ctx.preferredDayType = state.preferredDayType;
  if (state.selectedSlotId) ctx.selectedSlotId = state.selectedSlotId;
  if (state.phone) ctx.phone = state.phone;
  if (state.personalDataConsent !== undefined) ctx.consent = state.personalDataConsent;
  return ctx;
}

/** Дополнительный hint для LLM: сколько цифр уже накопилось в buffer'е. */
function phoneBufferHint(state: SalesDialogState): string {
  const buf = state.phoneDigitsBuffer;
  if (!buf || buf.length === 0) return "";
  const need = Math.max(0, 11 - buf.length);
  return `\n\nКЛИЕНТ ДИКТУЕТ ТЕЛЕФОН ПО ЧАСТЯМ. Сейчас собрано ${buf.length} цифр из 11. Осталось примерно ${need}.\n
КРИТИЧНО — НЕ КОММЕНТИРУЙ распознавание:
— НЕ говори «там попалась буква», «не получилось разобрать», «STT ошибка».
— НЕ проси повторить с начала.
— НЕ упоминай конкретные цифры.

ПРАВИЛЬНО — попроси продолжить ОДНОЙ короткой фразой:
— «Продолжайте.»
— «Ещё несколько цифр.»
— «Жду остальное.»
— «Ещё чуть-чуть.»
Не больше 4 слов. Без имени клиента (он только что говорил). Никакого маркера — клиент продолжит диктовать на этом же шаге.\n`;
}

/** Применяем contextUpdate из маркера LLM к state (с валидацией). */
function applyContextUpdate(state: SalesDialogState, update: Partial<SalesSessionContext>): SalesDialogState {
  const next = { ...state };
  if (typeof update.customerName === "string" && update.customerName.trim()) {
    next.customerName = update.customerName.trim();
  }
  if (update.customerGender === "male" || update.customerGender === "female") {
    next.customerGender = update.customerGender;
  }
  if (update.learnerType === "self") {
    next.learnerType = "adult";
    next.learnerTypeLocked = true;
  } else if (update.learnerType === "child") {
    next.learnerType = "child";
    next.learnerTypeLocked = true;
  }
  if (update.childGender === "boy" || update.childGender === "girl") {
    next.childGender = update.childGender;
  }
  if (typeof update.age === "number" && update.age > 0 && update.age < 100) {
    next.age = Math.floor(update.age);
  }
  if (typeof update.direction === "string" && VALID_DIRECTIONS.has(update.direction)) {
    next.direction = update.direction;
    next.directionConfirmed = true;
    next._pendingDirection = undefined;
  }
  if (Array.isArray(update.rejectedDirections)) {
    const merged = new Set<string>([...(next.rejectedDirections ?? []), ...update.rejectedDirections.filter((d) => typeof d === "string" && VALID_DIRECTIONS.has(d))]);
    next.rejectedDirections = [...merged];
  }
  if (typeof update.branch === "string" && VALID_BRANCHES.has(update.branch as Branch)) {
    next.branch = update.branch as Branch;
  }
  if (update.preferredTime === "morning" || update.preferredTime === "day" || update.preferredTime === "evening") {
    next.preferredTime = update.preferredTime;
  }
  const VALID_WEEKDAYS = new Set(["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]);
  if (typeof update.preferredWeekday === "string" && VALID_WEEKDAYS.has(update.preferredWeekday)) {
    next.preferredWeekday = update.preferredWeekday as Slot["weekday"];
  }
  if (update.preferredDayType === "weekday" || update.preferredDayType === "weekend") {
    next.preferredDayType = update.preferredDayType;
  }
  if (typeof update.selectedSlotId === "string") {
    next.selectedSlotId = update.selectedSlotId;
  }
  if (typeof update.phone === "string") {
    next.phone = normalizePhone(update.phone);
  }
  if (typeof update.consent === "boolean") {
    next.personalDataConsent = update.consent;
  }
  return next;
}

/** Полная нормализация: использует v1-парсер с поддержкой 8XXX / +7XXX / 9XXX форматов. */
function normalizePhone(raw: string): string | undefined {
  return normalizeRussianPhone(raw);
}

/** Сводка направлений с возрастными окнами — из реальных слотов (`src/data/slots.ts`).
 *  Используется на шаге ask_direction чтобы LLM не предлагала направление,
 *  которое не подходит по возрасту клиента. */
function directionAgeWindowSummary(targetAge?: number): string {
  // Группируем слоты по direction, собираем минимальный/максимальный возраст из тех что объявлены.
  const dirInfo = new Map<string, { minAges: number[]; maxAges: number[]; levels: Set<string>; openEnded: boolean }>();
  for (const s of allSlots) {
    if (!s.clientVisible) continue;
    const info = dirInfo.get(s.direction) ?? { minAges: [], maxAges: [], levels: new Set<string>(), openEnded: false };
    if (s.level) info.levels.add(s.level);
    if (s.ageMin !== undefined) info.minAges.push(s.ageMin);
    if (s.ageMax !== undefined) info.maxAges.push(s.ageMax);
    // Если у слота не задан ни ageMin ни ageMax — он открыт для всех возрастов.
    if (s.ageMin === undefined && s.ageMax === undefined) info.openEnded = true;
    dirInfo.set(s.direction, info);
  }
  const lines: string[] = [];
  for (const [direction, info] of dirInfo) {
    const minAge = info.minAges.length ? Math.min(...info.minAges) : undefined;
    const maxAge = info.maxAges.length ? Math.max(...info.maxAges) : undefined;
    // Если есть и open-ended и явные возраста — самые широкие границы.
    let ageDesc: string;
    if (info.openEnded && minAge === undefined && maxAge === undefined) ageDesc = "любой возраст";
    else if (info.openEnded) ageDesc = `${minAge ?? 4}+ лет, есть и взрослые группы без верхнего ограничения`;
    else if (minAge !== undefined && maxAge !== undefined) ageDesc = `${minAge}–${maxAge} лет`;
    else if (minAge !== undefined) ageDesc = `от ${minAge} лет`;
    else if (maxAge !== undefined) ageDesc = `до ${maxAge} лет`;
    else ageDesc = "не указан";
    // Помечаем подходит ли направление для targetAge.
    let fitMark = "";
    if (targetAge !== undefined) {
      const fitsByMin = minAge === undefined || targetAge >= minAge || info.openEnded;
      const fitsByMax = maxAge === undefined || targetAge <= maxAge || info.openEnded;
      const fits = fitsByMin && fitsByMax;
      fitMark = fits ? " ✓ ПОДХОДИТ" : " ✗ НЕ подходит по возрасту";
    }
    lines.push(`— ${direction}: ${ageDesc}${fitMark}`);
  }
  return lines.join("\n");
}

/** Извлечь цифры из текста: либо явные цифры, либо русские числительные ("восемь девять..."). */
function digitsFromAnyText(text: string): string {
  // Сначала из явных цифр.
  const directDigits = text.replace(/\D/g, "");
  if (directDigits.length >= 3) return directDigits;
  // Иначе — пробуем числительные словами.
  const spelled = extractRussianNumeralWordsAsDigits(text);
  return spelled || directDigits;
}

/** Подбираем слоты для текущего state — это вход в offer_slot шаг. */
function pickAvailableSlots(state: SalesDialogState): { slots: Slot[]; asAvailable: AvailableSlot[] } {
  if (!state.direction || !state.branch) return { slots: [], asAvailable: [] };
  const slots = findSlots({
    direction: state.direction,
    branch: state.branch,
    age: state.age,
    preferredTime: state.preferredTime,
    limit: 5,
  })
    .filter((s) => !state.preferredWeekday || s.weekday === state.preferredWeekday)
    .filter((s) => {
      if (state.preferredDayType === "weekend") return s.weekday === "Сб" || s.weekday === "Вс";
      if (state.preferredDayType === "weekday") return s.weekday !== "Сб" && s.weekday !== "Вс";
      return true;
    })
    .slice(0, 3);
  const asAvailable: AvailableSlot[] = slots.map((s) => ({
    id: s.id,
    weekday: s.weekday,
    time: s.time,
    branch: s.branch,
    direction: s.direction,
    level: s.level,
    teacher: s.teacher,
  }));
  return { slots, asAvailable };
}

/** Попытка найти слоты на ТЕКУЩЕМ филиале, иначе на других. Возвращает alternateBranch
 *  если найдены на другом филиале — серверная подсказка для prompt'а. */
function pickSlotsWithBranchFallback(state: SalesDialogState): { slots: Slot[]; asAvailable: AvailableSlot[]; alternateBranch?: Branch } {
  const original = pickAvailableSlots(state);
  if (original.slots.length > 0) return original;
  if (!state.direction || !state.branch) return original;
  // Пробуем другие филиалы — если на основном нет слотов по направлению (например
  // «Контемп на Школьной» пусто), сразу видим где есть, чтобы предложить переключение
  // вместо leak'а «слоты не загружены» и преждевременного handoff'а.
  const ALL_BRANCHES: Branch[] = ["Развилка", "Озеро", "Школьная"];
  for (const altBranch of ALL_BRANCHES) {
    if (altBranch === state.branch) continue;
    const altState = { ...state, branch: altBranch };
    const altPicked = pickAvailableSlots(altState);
    if (altPicked.slots.length > 0) {
      return { ...altPicked, alternateBranch: altBranch };
    }
  }
  return original;
}

/** Fallback-реплика когда Anthropic не настроен или сломан. */
function fallbackReply(step: StepId, state: SalesDialogState): string {
  const name = state.customerName ? `${state.customerName}, ` : "";
  switch (step) {
    case "ask_name": return "Здравствуйте! Это Studio 108, меня зовут Анна. Как к вам можно обращаться?";
    case "ask_learner": return `${name}занятие подбираем для вас или для ребёнка?`;
    case "ask_age": return `${name}сколько лет?`;
    case "ask_direction": return `${name}вам ближе что-то поактивнее или поспокойнее?`;
    case "ask_branch": return `${name}где удобнее заниматься — на Развилке, у озера или возле первой школы?`;
    case "offer_slot": return `${name}посмотрю ближайшие варианты, секунду.`;
    case "ask_phone": return `${name}продиктуйте номер телефона для записи.`;
    case "ask_consent": return `${name}могу сохранить ваши данные для подтверждения?`;
    case "booked": return `${name}запись оформлена, ждём вас на пробном.`;
    case "handoff": return `${name}передам заявку администратору, он перезвонит.`;
  }
}

export interface SalesDialogStreamCallbacks {
  /** Срабатывает на каждое законченное предложение из LLM-стрима.
   *  Если задан — handleSalesDialogV2 принудительно использует streaming Claude,
   *  даже если USE_LLM_STREAMING=false. Caller (route turn-stream) использует это
   *  чтобы пушить sentence-event'ы в NDJSON клиенту по мере генерации. */
  onSentence?: (sentence: string, index: number) => void;
}

export async function handleSalesDialogV2(input: SalesDialogInput, callbacks?: SalesDialogStreamCallbacks): Promise<SalesDialogResult> {
  const incoming: SalesDialogState = {
    aiVoiceDisclosure: true,
    crossBorderTransfer: true,
    recentActions: [],
    retriesOnAction: {},
    ...input.state,
  };
  const step = currentStep(incoming);
  const context = buildContext(incoming);

  // Для offer_slot: подаём в контекст список доступных слотов из БД.
  let availableSlots: AvailableSlot[] | undefined;
  let foundSlots: Slot[] = [];
  let slotAlternateBranch: Branch | undefined;
  if (step === "offer_slot") {
    const picked = pickSlotsWithBranchFallback(incoming);
    foundSlots = picked.slots;
    availableSlots = picked.asAvailable;
    slotAlternateBranch = picked.alternateBranch;

    // Bug B fix: если слотов нет НИГДЕ (ни на выбранном филиале, ни на других),
    // НЕ зовём LLM — она склонна leak'нуть «не загружены»/«в системе нет» наружу.
    // Сразу отправляем в handoff с осмысленной фразой.
    if (foundSlots.length === 0 && incoming.direction && incoming.branch) {
      const name = incoming.customerName ? `${incoming.customerName}, ` : "";
      const dirSpoken = directionForSpeech(incoming.direction);
      const handoffReply = `${name}по направлению ${dirSpoken} сейчас групп нет в наличии. Передам заявку администратору — он подберёт расписание и свяжется с вами в ближайшее время.`;
      try {
        await recordHandoff({ reason: "no_slots", state: incoming, lastUserText: input.message });
      } catch (err) {
        console.error("[salesDialogV2] handoff log failed (no slots anywhere):", err instanceof Error ? err.message : err);
      }
      console.warn(JSON.stringify({
        tag: "guard",
        reason: "no_slots_anywhere",
        direction: incoming.direction,
        branch: incoming.branch,
        age: incoming.age,
      }));
      return {
        reply: handoffReply,
        state: { ...incoming, stage: "handoff" },
        action: "handoff",
        brainSource: "v2_no_slots_handoff",
      };
    }
  }

  // Детерминированный путь для ask_consent — если телефон уже собран и клиент сказал «да/нет»,
  // не зовём LLM (она ловится на повторный вопрос о телефоне). Сразу создаём бронь / handoff.
  if (step === "ask_consent" && incoming.phone) {
    const text = (input.message ?? "").toLowerCase().trim();
    const yesPattern = /(?<![а-яёa-z])(?:да|ок|окей|конечно|согласен|согласна|можно|давай(?:те)?|хорошо|подойд(?:ёт|ет)|подходит|устраивает|годится|без\s+проблем|разреш)(?![а-яёa-z])/iu;
    const noPattern = /(?<![а-яёa-z])(?:не\s*(?:т|нужно|надо|хочу|разреш|согласен|согласна)|откаж|нельзя|против)(?![а-яёa-z])/iu;
    if (yesPattern.test(text) && !noPattern.test(text)) {
      const slotId = incoming.selectedSlotId;
      const slot = slotId ? getSlotById(slotId) : undefined;
      const hasAllRequirements = Boolean(slot && incoming.customerName && incoming.direction && incoming.branch && incoming.branch !== "Черняховского");

      // Bug #1 fix: если на consent дошли БЕЗ выбранного слота (LLM проскочила
      // offer_slot — видели в stream/multi-fact-first), не создаём бронь с пустой
      // строкой в farewell («записала на пробное — , направление ...»).
      // Передаём админу, он подберёт слот руками. Consent сохраняем (клиент согласился).
      if (!hasAllRequirements) {
        const name = incoming.customerName ? `${incoming.customerName}, ` : "";
        const handoffReply = `${name}спасибо! Сейчас передам ваши контакты администратору — он перезвонит, уточнит удобное время и подтвердит запись.`;
        try {
          await recordHandoff({
            reason: !slot ? "consent_without_slot" : "consent_missing_required_fields",
            state: { ...incoming, personalDataConsent: true },
            lastUserText: input.message
          });
        } catch (err) {
          console.error("[salesDialogV2] handoff log failed (no slot at consent):", err instanceof Error ? err.message : err);
        }
        console.warn(JSON.stringify({
          tag: "guard",
          reason: "consent_without_slot",
          hasSlot: Boolean(slot), hasName: Boolean(incoming.customerName),
          hasDirection: Boolean(incoming.direction), branch: incoming.branch
        }));
        return {
          reply: handoffReply,
          state: { ...incoming, personalDataConsent: true, stage: "handoff" },
          action: "handoff",
          brainSource: "v2_consent_no_slot_handoff",
        };
      }

      // Создаём бронь — все требования выполнены.
      let booking: Booking | undefined;
      try {
        booking = await createBooking({
          customerName: incoming.customerName!,
          phone: incoming.phone,
          age: incoming.age,
          direction: incoming.direction!,
          branch: incoming.branch!,
          slotId: slot!.id,
          source: "inbound_call",
          consent: { personalData: true, aiVoiceDisclosure: true, crossBorderTransfer: true },
        });
      } catch (err) {
        console.error("[salesDialogV2] booking create failed (consent path):", err instanceof Error ? err.message : err);
      }
      const name = incoming.customerName ? `${incoming.customerName}, ` : "";
      const dirSpoken = directionForSpeech(slot!.direction ?? incoming.direction!);
      const dirName = dirSpoken ? `, направление ${dirSpoken}` : "";
      const slotPart = `${slot!.weekday} в ${slot!.time}, филиал ${slot!.branch}`;
      const farewell = `${name}записала ${incoming.learnerType === "child" ? (incoming.childGender === "girl" ? "вашу дочку" : incoming.childGender === "boy" ? "вашего сына" : "ребёнка") : "вас"} на пробное — ${slotPart}${dirName}. Пробное 300 рублей, оплата на месте. Спасибо, будем ждать вас. Уверена, вам у нас понравится. До встречи!`;
      const finalState: SalesDialogState = {
        ...incoming,
        personalDataConsent: true,
        stage: "booked",
        recentActions: [...(incoming.recentActions ?? []), "ask_consent"].slice(-10),
      };
      return {
        reply: farewell,
        state: finalState,
        action: "booked",
        booking,
        brainSource: "v2_consent_finalize",
      };
    }
    if (noPattern.test(text)) {
      const name = incoming.customerName ? `${incoming.customerName}, ` : "";
      const handoffReply = `${name}поняла, без проблем. Тогда передам ваши контакты администратору — он перезвонит и подтвердит запись.`;
      try {
        await recordHandoff({ reason: "consent_refused", state: incoming, lastUserText: input.message });
      } catch (err) {
        console.error("[salesDialogV2] handoff log failed (consent path):", err instanceof Error ? err.message : err);
      }
      return {
        reply: handoffReply,
        state: { ...incoming, personalDataConsent: false, stage: "handoff" },
        action: "handoff",
        brainSource: "v2_consent_refuse",
      };
    }
  }

  // Серверное накопление цифр телефона между ходами. Понимает три формата:
  //   8XXXXXXXXXX (11 цифр с восьмёрки), +7XXXXXXXXXX, 9XXXXXXXXX (10 с девятки),
  //   а также русские числительные словами («восемь девять два...»).
  // VAD режет на полу-номере → копим в state.phoneDigitsBuffer.
  if (step === "ask_phone" && !incoming.phone) {
    const inDigits = digitsFromAnyText(input.message ?? "");
    if (inDigits.length > 0) {
      const prevBuf = incoming.phoneDigitsBuffer ?? "";
      // Сначала пробуем СВЕЖИЙ фрагмент как самостоятельный полный номер
      // (клиент мог надиктовать всё сразу после фрагмента, не приписывая к предыдущему).
      let phone = normalizePhone(inDigits);
      let combinedForBuffer = inDigits;
      if (!phone) {
        // Не получился — пробуем как продолжение к буферу.
        const combined = (prevBuf + inDigits).slice(-15);
        phone = normalizePhone(combined);
        combinedForBuffer = combined;
      }
      if (phone) {
        // Полный номер собран — пропускаем LLM, сразу идём на ask_consent.
        const stateNoBuf: SalesDialogState = {
          ...incoming,
          phone,
          phoneDigitsBuffer: undefined,
          stage: "ask_consent",
          recentActions: [...(incoming.recentActions ?? []), "ask_phone"].slice(-10),
        };
        const ack = `${incoming.customerName ? `${incoming.customerName}, ` : ""}записала номер. Могу сохранить ваши данные для подтверждения записи?`;
        return {
          reply: ack,
          state: stateNoBuf,
          action: "ask_consent",
          brainSource: "v2_phone_accumulator",
        };
      } else {
        // Цифры накопились но недостаточно — обновляем буфер для следующего turn'а.
        incoming.phoneDigitsBuffer = combinedForBuffer;
      }
    }
  }

  // На шаге выбора направления — добавляем реальные возрастные окна из расписания,
  // чтобы LLM не предлагала Lady style для 8-летки и Детскую хореографию для 16-летки.
  const directionsHint = step === "ask_direction"
    ? `\n\nДОСТУПНЫЕ НАПРАВЛЕНИЯ И ВОЗРАСТНЫЕ ОКНА (из расписания):\n${directionAgeWindowSummary(incoming.age)}\n\nКРИТИЧНО: предлагай ТОЛЬКО направления с пометкой «✓ ПОДХОДИТ». Никогда не предлагай направление с «✗ НЕ подходит» — у нас просто нет такой группы для этого возраста.\n`
    : "";
  // Bug B fix: если слоты подгружены с ДРУГОГО филиала (на запрошенном пусто),
  // явно говорим LLM что нужно мягко предложить переключение. Иначе LLM видит слоты
  // и не понимает что они не с запрошенного клиентом филиала — leak про «контекст».
  const branchSwapHint = (step === "offer_slot" && slotAlternateBranch && incoming.branch)
    ? `\n\nВНИМАНИЕ: на филиале «${incoming.branch}» по направлению «${incoming.direction}» сейчас нет групп. Слоты выше — с филиала «${slotAlternateBranch}». В реплике скажи клиенту мягко: «на филиале <выбранный> сейчас групп нет, но на филиале <${slotAlternateBranch}> есть <день в время>, попробуем?». Если клиент согласится — ставь маркер [→same:{"branch":"${slotAlternateBranch}"}] и предложи слот. НИКОГДА не упоминай «система», «контекст», «не загружены», «база» — это внутренние детали, не для клиента.\n`
    : "";
  const systemPrompt = buildStepPrompt(step, context, availableSlots) + phoneBufferHint(incoming) + directionsHint + branchSwapHint;
  const userMessage = input.message?.trim() || "(клиент молчит)";

  // История разговора — без неё LLM забывает что только что предложил.
  // Хранится в state в виде [{role, content}], cap 8 сообщений (~4 turn'а).
  type HistMsg = { role: "user" | "assistant"; content: string };
  const stateAny = incoming as SalesDialogState & { _v2History?: HistMsg[] };
  const history: HistMsg[] = Array.isArray(stateAny._v2History)
    ? stateAny._v2History
        .filter((m): m is HistMsg => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string")
        .map((m) => ({ role: m.role, content: m.content }))
    : [];

  let llmReply = "";
  let brainSource = "v2_anthropic";
  let brainCache: SalesDialogResult["brainCache"];
  // hoist'нуто наружу try чтобы catch видел — нужно для решения retry на non-stream endpoint.
  const streamingMode = USE_LLM_STREAMING || Boolean(callbacks?.onSentence);

  if (isAnthropicConfigured()) {
    try {
      let firstTokenMs = 0;
      let firstSentenceMs = 0;
      const callStart = Date.now();
      const result = streamingMode
        ? await callAnthropicTextStream({
            model: config.anthropic.dialogModel,
            system: systemPrompt,
            history,
            user: userMessage,
            maxTokens: 500,
            temperature: 0.7,
            timeoutMs: config.anthropic.dialogTimeoutMs,
            cacheTtl: config.anthropic.cacheTtl,
            onFirstToken: (delta) => {
              firstTokenMs = delta;
              console.log(JSON.stringify({
                tag: "perf",
                stage: "llm_first_token",
                step,
                ms: delta,
                model: config.anthropic.dialogModel,
              }));
            },
            onSentence: (sentence, idx) => {
              if (idx === 0) {
                firstSentenceMs = Date.now() - callStart;
                console.log(JSON.stringify({
                  tag: "perf",
                  stage: "llm_first_sentence",
                  step,
                  ms: firstSentenceMs,
                  firstTokenMs,
                  preview: sentence.slice(0, 60),
                }));
              }
              // Bug A fix: пропускаем sentence через cleanHumanReply ПЕРЕД отправкой
              // клиенту. Иначе TTS играет «понял» / «согласен» (мужской 1sg от Claude),
              // а для женского голоса Анны должно быть «поняла» / «согласна».
              // В non-streaming пути cleanHumanReply применялся к full reply, в streaming
              // нужен per-sentence чтобы каждый chunk TTS получил исправленную форму.
              // Прокидываем дальше; throw в callback'е проглатываем — стрим LLM не должен
              // падать из-за того, что клиент отвалился от NDJSON.
              const cleaned = cleanHumanReply(sentence);
              if (cleaned.trim()) {
                try { callbacks?.onSentence?.(cleaned, idx); } catch { /* ignore */ }
              }
            },
          })
        : await callAnthropicText({
            model: config.anthropic.dialogModel,
            system: systemPrompt,
            history,
            user: userMessage,
            maxTokens: 500,
            temperature: 0.7,
            timeoutMs: config.anthropic.dialogTimeoutMs,
            cacheTtl: config.anthropic.cacheTtl,
          });
      llmReply = result.text;
      brainCache = {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens,
      };
      console.log(JSON.stringify({
        tag: "perf",
        stage: "llm",
        step,
        ms: result.latencyMs,
        model: config.anthropic.dialogModel,
        streaming: streamingMode,
        firstTokenMs: firstTokenMs || undefined,
        firstSentenceMs: firstSentenceMs || undefined,
        inTok: result.inputTokens,
        outTok: result.outputTokens,
        cacheRead: result.cacheReadInputTokens,
        cacheCreate: result.cacheCreationInputTokens,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[salesDialogV2] anthropic call failed:", errMsg);
      // Если стрим упал на overloaded/rate-limit/5xx — пробуем non-streaming endpoint.
      // У Anthropic streaming и обычный messages endpoint иногда имеют отдельные
      // capacity-квоты: один может быть в перегрузке, второй — нет. Это второй
      // шанс прежде чем падать в детерминированный fallbackReply.
      const looksTransient = /overloaded|rate.?limit|too.?many|status\s+(429|5\d\d)|stream\s+error|empty body/i.test(errMsg);
      let retried = false;
      if (looksTransient && streamingMode) {
        try {
          const r2 = await callAnthropicText({
            model: config.anthropic.dialogModel,
            system: systemPrompt,
            history,
            user: userMessage,
            maxTokens: 500,
            temperature: 0.7,
            timeoutMs: config.anthropic.dialogTimeoutMs,
            cacheTtl: config.anthropic.cacheTtl,
          });
          llmReply = r2.text;
          brainCache = {
            inputTokens: r2.inputTokens,
            outputTokens: r2.outputTokens,
            cacheCreationInputTokens: r2.cacheCreationInputTokens,
            cacheReadInputTokens: r2.cacheReadInputTokens,
          };
          brainSource = "v2_anthropic_nonstream_retry";
          retried = true;
          console.log(JSON.stringify({
            tag: "perf",
            stage: "llm_nonstream_retry",
            step,
            ms: r2.latencyMs,
            inTok: r2.inputTokens,
            outTok: r2.outputTokens,
          }));
        } catch (err2) {
          console.error("[salesDialogV2] non-stream retry also failed:", err2 instanceof Error ? err2.message : err2);
        }
      }
      if (!retried) {
        llmReply = fallbackReply(step, incoming);
        brainSource = looksTransient ? "v2_fallback_anthropic_overload" : "v2_fallback_anthropic_error";
      }
    }
  } else {
    llmReply = fallbackReply(step, incoming);
    brainSource = "v2_fallback_no_anthropic";
  }

  // Парсим маркер перехода.
  const transition = parseTransition(llmReply);
  // Чистим: маркер + нормализуем мужские формы на женские («понял» → «поняла»).
  let cleanReply = cleanHumanReply(stripTransitionMarker(llmReply));

  // Защита: если LLM вернула только маркер (без текста реплики), cleanReply пустой
  // и клиент слышит тишину. Падаем в fallback для текущего шага. transition (если был)
  // оставляем — контекст-апдейт продолжит применяться, чтобы извлечённые факты не потерять.
  if (!cleanReply.trim()) {
    console.warn(JSON.stringify({ tag: "guard", reason: "empty_reply_after_strip", step, brainSource, hadMarker: Boolean(transition) }));
    cleanReply = cleanHumanReply(fallbackReply(step, incoming));
    if (brainSource === "v2_anthropic") brainSource = "v2_fallback_empty_reply";
  }

  // Применяем contextUpdate.
  let nextState: SalesDialogState = { ...incoming };
  if (transition?.contextUpdate) {
    nextState = applyContextUpdate(nextState, transition.contextUpdate);
  }
  // Определяем следующий step.
  let nextStep: StepId = step;
  if (transition) {
    if (transition.nextStep !== "same") {
      nextStep = transition.nextStep;
    }
  }
  nextState.stage = nextStep;
  nextState.recentActions = [...(incoming.recentActions ?? []), step].slice(-10);

  // Бизнес-логика на основе нового шага.
  let booking: Booking | undefined;
  let slots: Slot[] | undefined = foundSlots.length ? foundSlots : undefined;

  // AUTO-CONTINUE для переходов где LLM нужны свежие server-данные.
  // offer_slot: данные о слотах подгружаются по новому direction+branch+age.
  // Без auto-continue первая реплика заканчивается на «Поняла, у озера.» и разговор зависает —
  // следующий слот появится только когда клиент сам что-то скажет.
  if (
    nextStep === "offer_slot" &&
    step !== "offer_slot" &&
    nextState.direction &&
    nextState.branch &&
    nextState.branch !== "Черняховского"
  ) {
    try {
      const picked2 = pickAvailableSlots(nextState);
      slots = picked2.slots.length ? picked2.slots : slots;
      const ctx2 = buildContext(nextState);
      const prompt2 = buildStepPrompt("offer_slot", ctx2, picked2.asAvailable);
      const history2: HistMsg[] = [
        ...history,
        { role: "user" as const, content: userMessage },
        { role: "assistant" as const, content: cleanReply },
      ];
      // Если onSentence-callback есть — стримим и auto-continue, иначе клиент
      // в streaming-режиме услышит только первый вызов и тишину после («Хорошо.» → пусто).
      const r2 = callbacks?.onSentence
        ? await callAnthropicTextStream({
            model: config.anthropic.dialogModel,
            system: prompt2,
            history: history2,
            user: "(продолжи: предложи ближайший подходящий слот из контекста)",
            maxTokens: 350,
            temperature: 0.6,
            timeoutMs: config.anthropic.dialogTimeoutMs,
            cacheTtl: config.anthropic.cacheTtl,
            onSentence: (sentence, idx) => {
              // Bug A fix: тот же gender-flip per-sentence что в основном вызове.
              const cleaned = cleanHumanReply(sentence);
              if (cleaned.trim()) {
                try { callbacks!.onSentence!(cleaned, idx); } catch { /* ignore */ }
              }
            },
          })
        : await callAnthropicText({
            model: config.anthropic.dialogModel,
            system: prompt2,
            history: history2,
            user: "(продолжи: предложи ближайший подходящий слот из контекста)",
            maxTokens: 350,
            temperature: 0.6,
            timeoutMs: config.anthropic.dialogTimeoutMs,
            cacheTtl: config.anthropic.cacheTtl,
          });
      console.log(JSON.stringify({
        tag: "perf",
        stage: "llm_auto_continue",
        step: "offer_slot",
        ms: r2.latencyMs,
        model: config.anthropic.dialogModel,
        streaming: Boolean(callbacks?.onSentence),
        inTok: r2.inputTokens,
        outTok: r2.outputTokens,
        cacheRead: r2.cacheReadInputTokens,
      }));
      const transition2 = parseTransition(r2.text);
      const reply2 = cleanHumanReply(stripTransitionMarker(r2.text));
      if (reply2) {
        cleanReply = `${cleanReply} ${reply2}`.replace(/\s+/g, " ").trim();
      }
      if (transition2?.contextUpdate) {
        nextState = applyContextUpdate(nextState, transition2.contextUpdate);
      }
      if (brainCache) {
        brainCache.inputTokens += r2.inputTokens;
        brainCache.outputTokens += r2.outputTokens;
        brainCache.cacheCreationInputTokens += r2.cacheCreationInputTokens;
        brainCache.cacheReadInputTokens += r2.cacheReadInputTokens;
      }
      brainSource = `${brainSource}+auto_continue`;
    } catch (err) {
      console.error("[salesDialogV2] auto-continue failed:", err instanceof Error ? err.message : err);
    }
  }

  if (nextStep === "booked" && incoming.stage !== "booked") {
    const slotId = nextState.selectedSlotId;
    const slot = slotId ? getSlotById(slotId) : undefined;
    if (slot && nextState.customerName && nextState.phone && nextState.direction && nextState.branch && nextState.branch !== "Черняховского" && nextState.personalDataConsent) {
      try {
        booking = await createBooking({
          customerName: nextState.customerName,
          phone: nextState.phone,
          age: nextState.age,
          direction: nextState.direction,
          branch: nextState.branch,
          slotId: slot.id,
          source: "inbound_call",
          consent: { personalData: true, aiVoiceDisclosure: true, crossBorderTransfer: true },
        });
      } catch (err) {
        console.error("[salesDialogV2] booking create failed:", err instanceof Error ? err.message : err);
      }
    }
  }

  if (nextStep === "handoff" && incoming.stage !== "handoff") {
    try {
      const reason = nextState.age !== undefined && nextState.age < 4 ? "underage"
        : nextState.personalDataConsent === false ? "consent_refused"
        : "manual";
      await recordHandoff({ reason, state: nextState, lastUserText: userMessage });
    } catch (err) {
      console.error("[salesDialogV2] handoff log failed:", err instanceof Error ? err.message : err);
    }
  }

  // Обновляем историю разговора. Берём cleanReply без маркера — LLM в следующем turn
  // не должна видеть свои же маркеры (это инструкция системе, не часть диалога).
  // Cap 8 сообщений (~4 пары turn'ов) — достаточно для памяти о текущем шаге.
  const newHistory: HistMsg[] = [
    ...history,
    { role: "user" as const, content: userMessage },
    { role: "assistant" as const, content: cleanReply },
  ].slice(-8);
  (nextState as SalesDialogState & { _v2History?: HistMsg[] })._v2History = newHistory;

  return {
    reply: cleanReply,
    state: nextState,
    action: STEP_TO_ACTION[nextStep],
    booking,
    slots,
    brainSource,
    brainCache,
  };
}
