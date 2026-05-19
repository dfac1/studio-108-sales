import { branches } from "../data/branches.js";
import { getPrice } from "../data/pricing.js";
import type { Branch, Booking, Slot } from "../types.js";
import { createBooking } from "./bookingService.js";
import { extractWithOpenAi } from "./openAiInterpreter.js";
import { generateSalesReply, type SalesBrainAction, type SalesBrainState } from "./openAiSalesBrain.js";
import { cleanHumanReply, containsBannedSpeechWords } from "./russianSpeech.js";
import { findSlots } from "./slotService.js";
import * as variants from "./replyVariants.js";
import { recordHandoff, type HandoffReason } from "./handoffService.js";
import { parseTemporalHint } from "./temporalParser.js";
import { lookupPreviousContact } from "./customerHistory.js";
import { recordShadowEvent } from "./shadowMode.js";
import { isFlagOn } from "./featureFlags.js";
import { classifyCustomerProfile, profileGuidanceForBrain, type CustomerProfile } from "./customerProfile.js";
import { findRelevantSuccessStory } from "./successStories.js";
import { evaluateStrategy, shouldRunSupervisor, fireSupervisor, getCachedVerdict } from "./strategySupervisor.js";
void evaluateStrategy; // keep import for type

export interface SalesDialogState {
  customerName?: string;
  customerGender?: "male" | "female" | "unknown";
  phone?: string;
  need?: string;
  direction?: string;
  age?: number;
  learnerType?: "child" | "adult" | "unknown";
  preferredTime?: "morning" | "day" | "evening";
  preferredWeekday?: Slot["weekday"];
  preferredDayType?: "weekday" | "weekend";
  branch?: Branch;
  offeredSlots?: Slot[];
  offeredSlotIndex?: number;
  selectedSlotId?: string;
  personalDataConsent?: boolean;
  aiVoiceDisclosure?: boolean;
  crossBorderTransfer?: boolean;
  stage?: string;
  recentActions?: string[];
  retriesOnAction?: Record<string, number>;
  hasIntroduced?: boolean;
  clarifyStreak?: number;
  childGender?: "boy" | "girl" | "unknown";
  conversationId?: string;
  turnIndex?: number;
  lastInterruption?: {
    previousReply: string;
    spokenSoFar: string;
    unsaidPart: string;
    elapsedMs: number;
  };
  lastExtractionCache?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  customerProfile?: "young_parent" | "teen" | "busy_adult" | "mature" | "unknown";
  customerProfileConfidence?: number;
  /** true если direction подтверждён клиентом (а не подобран ботом эвристикой). */
  directionConfirmed?: boolean;
  /** Direction, который бот хочет предложить, но ждёт подтверждения клиента. */
  _pendingDirection?: string;
  /** Направления, которые клиент ЯВНО отверг ("не подходит хип-хоп"). Бот не должен предлагать повторно. */
  rejectedDirections?: string[];
  /** true когда learnerType установлен явно — больше не меняем по случайным "нам/я" в речи. */
  learnerTypeLocked?: boolean;
  /** Сжатая выжимка прошлых контактов клиента для передачи в brain. */
  previousContactSummary?: string;
  /** Подсказка-история успеха для текущего turn'а (опц.). */
  relevantStoryHint?: string;
  /** turnIndex, на котором впервые упомянули цену пробного. Не повторяем в скрипт-репликах. */
  trialPriceMentionedAtTurn?: number;
  /** turnIndex, на котором бот описал текущий direction (питч/что это). Используем для подавления повторов. */
  directionDescribedAtTurn?: number;
  /** Накопленные цифры телефона между ходами — пока клиент диктует частями. */
  phoneDigitsBuffer?: string;
  /** Последние реплики клиента для profile-classifier и supervisor'а. */
  recentCustomerMessages?: string[];
  /** Кешированный вердикт стратегического супервизора. */
  supervisorVerdict?: {
    warmth: number;        // 0..1
    mainObjection?: string;
    advice: string;
    turnIndexAt: number;
  };
}

// JS \b не работает с кириллицей корректно. Используем lookbehind/lookahead для русских границ слов.
const RU_BEFORE = "(?<![а-яёa-z])";
const RU_AFTER = "(?![а-яёa-z])";

const HANDOFF_TRIGGER_PATTERNS = [
  new RegExp(`${RU_BEFORE}операторов?${RU_AFTER}`, "iu"),
  new RegExp(`${RU_BEFORE}оператор${RU_AFTER}`, "iu"),
  new RegExp(`${RU_BEFORE}оператора${RU_AFTER}`, "iu"),
  new RegExp(`${RU_BEFORE}операторам?${RU_AFTER}`, "iu"),
  new RegExp(`${RU_BEFORE}менеджер`, "iu"),
  new RegExp(`${RU_BEFORE}администратор`, "iu"),
  new RegExp(`${RU_BEFORE}жив(?:ой|ого|ому)\\s+чел`, "iu"),
  new RegExp(`(?:^|[^а-яёa-z])(?:с|со)\\s+чел(?:овеком)?(?![а-яёa-z])`, "iu"),
  new RegExp(`(?:^|[^а-яёa-z])на\\s+чел(?:овека)?(?![а-яёa-z])`, "iu"),
  new RegExp(`${RU_BEFORE}переключ`, "iu"),
  new RegExp(`${RU_BEFORE}руководител`, "iu"),
  new RegExp(`${RU_BEFORE}не\\s+бот${RU_AFTER}`, "iu"),
  new RegExp(`${RU_BEFORE}живой\\s+голос`, "iu"),
  new RegExp(`${RU_BEFORE}настоящ(?:ий|им|его)\\s+чел`, "iu")
];

const BOT_QUESTION_PATTERNS = [
  new RegExp(`${RU_BEFORE}(?:ты|вы|это)\\s+бот${RU_AFTER}`, "iu"),
  new RegExp(`${RU_BEFORE}(?:ты|вы|это)\\s+робот${RU_AFTER}`, "iu"),
  new RegExp(`${RU_BEFORE}искусственн(?:ый|ого|ому|ого|ыми|ыми)\\s+интеллект`, "iu"),
  new RegExp(`${RU_BEFORE}и\\s*и\\s+голос`, "iu"),
  new RegExp(`${RU_BEFORE}ии${RU_AFTER}`, "iu"),
  new RegExp(`${RU_BEFORE}голосовой\\s+(?:бот|помощник|ассистент)`, "iu"),
  new RegExp(`${RU_BEFORE}ты\\s+живой${RU_AFTER}`, "iu"),
  new RegExp(`${RU_BEFORE}вы\\s+живой${RU_AFTER}`, "iu"),
  new RegExp(`${RU_BEFORE}(?:ты|вы)\\s+(?:чел|человек)${RU_AFTER}`, "iu"),
  new RegExp(`${RU_BEFORE}это\\s+ии${RU_AFTER}`, "iu")
];

function detectHandoffRequest(text: string): boolean {
  return HANDOFF_TRIGGER_PATTERNS.some((pattern) => pattern.test(text));
}

function detectBotQuestion(text: string): boolean {
  return BOT_QUESTION_PATTERNS.some((pattern) => pattern.test(text));
}

function reformulateForRepeat(action: SalesBrainAction, state: SalesDialogState): string {
  const name = state.customerName;
  switch (action) {
    case "ask_name":
      return "Скажите, пожалуйста, как вас зовут?";
    case "ask_learner":
      return name ? `${name}, занятие ищем для вас или для ребёнка?` : "Уточню: занятие для вас или для ребёнка?";
    case "ask_need":
      return name ? `${name}, что в итоге хотите попробовать — танцы поактивнее или поспокойнее?` : "Что хотите попробовать — танцы активные или спокойные?";
    case "ask_age":
      return name ? `${name}, напомните возраст, пожалуйста?` : "Возраст подскажите, пожалуйста?";
    case "ask_branch":
      return "Какой филиал вам удобнее — Развилка, на Псекупской или возле первой школы?";
    case "offer_solution":
      return "Этот вариант времени подходит, или посмотреть другой день?";
    case "ask_slot_choice":
      return "Какой из предложенных вариантов удобнее?";
    case "ask_phone":
      return "Подскажите номер телефона, я зафиксирую запись.";
    case "ask_consent":
      return "Можно сохранить ваши данные, чтобы оформить запись?";
    default:
      return "Уточните, пожалуйста?";
  }
}

// Память «когда последний раз обращались по имени». Хранится in-process — для пилотного веб-теста
// этого достаточно. При телефонии перенесём в state по conversationId.
const lastNameUsageByConversation = new Map<string, number>();

/**
 * Возвращает «{Имя}, » с шансом ~50%, но не два раза подряд в одном диалоге.
 * Без conversationId работает чисто probabilistic.
 */
function maybeName(customerName?: string, slotKey: string = "any", conversationId?: string): string {
  if (!customerName) return "";
  const key = conversationId ?? "global";
  const turnsSinceLast = lastNameUsageByConversation.get(key) ?? 99;
  // Никогда не даём имя в обращении два turn подряд.
  if (turnsSinceLast < 1) {
    lastNameUsageByConversation.set(key, turnsSinceLast + 1);
    return "";
  }
  // Для offer / booked — имя более естественно. Для тех. шагов реже.
  const probability = slotKey === "offer" || slotKey === "booked" ? 0.55 : 0.4;
  if (Math.random() < probability) {
    lastNameUsageByConversation.set(key, 0);
    return `${customerName}, `;
  }
  lastNameUsageByConversation.set(key, turnsSinceLast + 1);
  return "";
}

function pickHandoffReason(originalAction: string, retries: number, userText: string): HandoffReason {
  if (HANDOFF_TRIGGER_PATTERNS.some((pattern) => pattern.test(userText))) return "explicit_request";
  if (retries >= 2) return "loop_guard";
  if (originalAction === "handoff") return "manual";
  return "manual";
}

// Близкие по «темпу» направления — для подсказок, когда основное недоступно.
const directionAlternatives: Record<string, string[]> = {
  "Йога": ["Контemporary", "Стрип-пластика", "Восточные танцы"],
  "Hip-hop": ["Breakdance", "Jazz funk", "K-pop", "Dancehall"],
  "Breakdance": ["Hip-hop", "K-pop"],
  "Contemporary": ["Йога", "Lady style"],
  "Zumba": ["Hip-hop", "Jazz funk"],
  "Salsa/Bachata": ["Lady style", "Jazz funk"],
  "Lady style": ["Contemporary", "Jazz funk", "Стрип-пластика"],
  "Jazz funk": ["Hip-hop", "Lady style"],
  "K-pop": ["Hip-hop", "Jazz funk"],
  "Восточные танцы": ["Lady style", "Йога"],
  "Стрип-пластика": ["Lady style", "Contemporary"],
  "Детская хореография": ["Hip-hop", "Contemporary"]
};

/**
 * Извлекает из реплики список направлений, от которых клиент ЯВНО отказался.
 * Покрывает оба случая:
 *  - rejection of current bot suggestion: «не подходит хип-хоп»
 *  - proactive rejection: «не хочу йогу», «только не сальсу»
 * Возвращает массив канонических названий направлений.
 */
function detectRejectedDirections(text: string): string[] {
  const lower = text.toLowerCase();
  // Все известные направления и их алиасы
  const allDirections = [
    "Hip-hop", "Breakdance", "Contemporary", "Йога", "Zumba", "Lady style",
    "Восточные танцы", "Jazz funk", "K-pop", "Salsa/Bachata",
    "Стрип-пластика", "Dancehall", "Детская хореография"
  ];
  // Кириллический word-boundary: до/после алиаса не должно быть кириллической буквы.
  // (JS \b не работает с кириллицей.)
  const RU_BEFORE = "(?<![а-яёa-z])";
  const RU_AFTER = "(?![а-яёa-z])";
  // Маркеры отрицания. Расширенный набор — учитываются варианты:
  //  «не подходит», «не нравится», «не очень подходит», «не очень нравится»,
  //  «не интересно», «не хочу», «не нужно», «не катит», «так себе», «совсем не».
  const NEG_BEFORE = `(?:не\\s+(?:хочу|нрав|подход|интересн|нужн|надо|катит|очень)|не\\s+(?:будем|буду)|вместо|только\\s+не|кроме|без|так\\s+себе|совсем\\s+не)`;
  // Для «после алиаса» делаем регекс терпимее: позволяем словам между «не» и «подходит/нрав».
  // «хип-хоп не очень нам подходит» → matches.
  const NEG_AFTER = `(?:не\\s+(?:очень\\s+)?(?:(?:[а-яё]+\\s+){0,3})?(?:подход|нрав|катит|интересн)|не\\s+(?:хочу|нужн|надо|интересн)|так\\s+себе)`;
  const rejected: string[] = [];
  for (const dir of allDirections) {
    const aliases = directionAliases(dir);
    for (const alias of aliases) {
      // С флагом /u нельзя экранировать `-` — он не считается специальным.
      const aliasEsc = alias.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
      // Окно «отказ ... алиас» — отрицание в пределах 30 символов до алиаса
      const beforePattern = new RegExp(`${NEG_BEFORE}[^.!?]{0,40}${RU_BEFORE}${aliasEsc}${RU_AFTER}`, "iu");
      // Окно «алиас ... отказ» — терпимое к словам между алиасом и отрицанием
      const afterPattern = new RegExp(`${RU_BEFORE}${aliasEsc}${RU_AFTER}[^.!?]{0,50}${NEG_AFTER}`, "iu");
      if (beforePattern.test(lower) || afterPattern.test(lower)) {
        if (!rejected.includes(dir)) rejected.push(dir);
        break; // следующий direction
      }
    }
  }
  return rejected;
}

/**
 * Маркеры явного отказа от текущего направления:
 * «не подходит хип-хоп», «нет хочу другое», «не хочу хип-хоп», «давайте другое».
 * Проверяется в контексте: direction Hip-hop в state + клиент сказал отрицание + упомянул это направление.
 */
function isRejectionOfCurrentDirection(text: string, currentDirection: string): boolean {
  const lower = text.toLowerCase();
  const aliases = directionAliases(currentDirection);
  const mentionsCurrent = aliases.some((a) => lower.includes(a));
  if (!mentionsCurrent) {
    // Может быть generic отказ: «не подходит, нужно другое»
    const genericReject = /(?:не\s+подход|не\s+нрав|не\s+хочу|давай(?:те)?\s+друг|посмотрим\s+друг|нужно\s+друг|другое\s+направ)/i.test(lower);
    // Также: «нужно поспокойнее / поактивнее» после уже выбранного direction — это смена курса
    const switchVector = /(?:посп[оа]ко|поактивн|более\s+спок|более\s+актив|совсем\s+друг)/i.test(lower);
    return genericReject || switchVector;
  }
  // Если direction упомянут — проверяем что это в негативном контексте
  return /(?:не\s+подход|не\s+хочу|не\s+нрав|не\s+интересн|нет[,.\s]|вместо)/i.test(lower);
}

function directionAliases(direction: string): string[] {
  const map: Record<string, string[]> = {
    "Hip-hop": ["хип-хоп", "хип хоп", "хибхоп", "хепхоп", "hip-hop", "hip hop"],
    "Breakdance": ["брейк", "брейкданс", "break"],
    "Contemporary": ["контемп", "контемпорари", "contemporary", "современн"],
    "Йога": ["йог"],
    "Zumba": ["зумб", "zumba"],
    "Lady style": ["леди стайл", "леди-стайл", "lady style", "ladystyle", "леди"],
    "Восточные танцы": ["восточн", "ориентал"],
    "Jazz funk": ["джаз", "jazz"],
    "K-pop": ["k-pop", "кей-поп", "кпоп", "к-поп"],
    "Salsa/Bachata": ["сальс", "salsa", "бачат", "bachata"],
    "Стрип-пластика": ["стрип"],
    "Dancehall": ["dancehall", "дэнсхолл"],
    "Детская хореография": ["детская хореограф", "хореограф"]
  };
  return map[direction] ?? [direction.toLowerCase()];
}

/**
 * Проверяет, что для (direction, age, learnerType, branch?) реально существуют свободные слоты.
 * Используется чтобы НЕ предлагать клиенту направление, которое не существует в его профиле.
 * Например, «йога для 8-летки» — формально matchDirection вернёт Йога, но слотов нет.
 */
function isDirectionAvailable(direction: string, opts: { age?: number; branch?: Branch }): boolean {
  const slots = findSlots({ direction, age: opts.age, branch: opts.branch, limit: 1 });
  return slots.length > 0;
}

/**
 * true если в тексте клиент явно назвал танцевальное направление словом или алиасом.
 * Используется, чтобы отличить «я хочу хип-хоп» (явно) от «хотим танцевать» (общее).
 * В первом случае direction можно установить молча, во втором — нужно объявить и подтвердить.
 */
function isDirectionMentionedExplicitly(text: string): boolean {
  const lower = text.toLowerCase();
  const aliases = [
    "хип-хоп", "хип хоп", "хибхоп", "хепхоп", "hip-hop", "hip hop",
    "брейк", "брейкданс", "break",
    "контемп", "контемпорари", "contemporary",
    "йог",
    "зумб", "zumba",
    "сальс", "salsa", "бачат", "bachata",
    "леди стайл", "леди-стайл", "lady style", "ladystyle",
    "восточн", "ориентал",
    "джаз", "jazz",
    "k-pop", "кей-поп", "кпоп",
    "dancehall", "дэнсхолл",
    "стрип",
    "детская хореограф", "хореограф"
  ];
  return aliases.some((a) => lower.includes(a));
}

type DirectionCategory = "active" | "calm" | "neutral";

const DIRECTION_CATEGORY: Record<string, DirectionCategory> = {
  "Hip-hop": "active",
  "Breakdance": "active",
  "Zumba": "active",
  "Jazz funk": "active",
  "K-pop": "active",
  "Dancehall": "active",
  "Йога": "calm",
  "Contemporary": "calm",
  "Lady style": "calm",
  "Stretch": "calm",
  "Стрип-пластика": "calm",
  "Восточные танцы": "calm",
  "Детская хореография": "calm",
  "Salsa": "neutral",
  "Bachata": "neutral",
  "Salsa/Bachata": "neutral"
};

/**
 * Классифицирует выраженную клиентом потребность (state.need или явный текст)
 * в категорию «активное / спокойное / нейтральное». Используется, чтобы
 * после отказа от одного направления НЕ предложить противоположное по характеру.
 */
function classifyNeedCategory(need: string | undefined): DirectionCategory {
  if (!need) return "neutral";
  const lower = need.toLowerCase();
  if (/(?:поспок|спок|медлен|плавн|мягк|растяж|расслаб|здоров|пласт|йог|стрейч|stretch|восточ)/iu.test(lower)) return "calm";
  if (/(?:поактив|актив|подвиж|динам|темп|бодр|энерг|разогнат|похуд|встрях|кардио|быстр|хип|hip|брейк|зумб|breakdance|zumba|k-pop|кпоп|кей-поп)/iu.test(lower)) return "active";
  return "neutral";
}

/**
 * Если клиент сам не знает чего хочет — бот берёт инициативу и предлагает
 * самое популярное направление под профиль (возраст + child/adult).
 * Возвращает direction + готовую короткую "продающую" фразу.
 *
 * КРИТИЧНО: если клиент уже сказал «поспокойней» или «поактивнее» (state.need),
 * предложения противоположной категории отсекаются, даже если они «популярнее».
 * Иначе после отказа от Йоги бот рекомендует Hip-hop клиенту, попросившему спокойное.
 */
function suggestPopularDirection(state: SalesDialogState): { direction: string; pitch: string } | undefined {
  const rejected = new Set(state.rejectedDirections ?? []);
  const wantedCategory = classifyNeedCategory(state.need);

  // Список потенциальных предложений в приоритете. Для каждого учитываем:
  // (1) не в rejected, (2) availability check для (age, branch),
  // (3) категория совместима с предпочтением клиента.
  const pool: Array<{ direction: string; pitch: string }> = [];

  if (state.learnerType === "child") {
    const ageWord = state.age ? `Для ${state.age} лет ` : "Для детей ";
    pool.push({ direction: "Hip-hop",            pitch: `${ageWord}сейчас популярен хип-хоп — ритмичный, понятный, подходит большинству.` });
    pool.push({ direction: "Breakdance",         pitch: "Если ребёнок активный — отлично заходит брейкданс: силовой и динамичный." });
    pool.push({ direction: "Contemporary",       pitch: "Для плавных движений хорошо подходит контемп — там учатся выражать эмоции через движение." });
    pool.push({ direction: "Lady style",         pitch: "Для подростков, которым ближе женственный формат, отлично подходит леди стайл — плавная пластика и красивые связки." });
    pool.push({ direction: "Детская хореография", pitch: "Для спокойного начала отлично подходит детская хореография — мягкий формат и хорошая база." });
  } else {
    // Взрослые
    if (state.customerGender === "male") {
      pool.push({ direction: "Hip-hop",   pitch: "У взрослых сейчас популярнее всего хип-хоп — понятный формат и хорошая нагрузка." });
      pool.push({ direction: "Breakdance", pitch: "Если хочется активного — брейкданс: сила, координация, понятный вход для новичка." });
      pool.push({ direction: "Йога",       pitch: "Для спокойного формата — йога: растяжка и хорошая нагрузка без спешки." });
      pool.push({ direction: "Contemporary", pitch: "Контемп — пластика и плавные движения, понятный вход для новичка." });
    } else {
      pool.push({ direction: "Lady style",    pitch: "Самое популярное у взрослых сейчас — леди стайл: плавная пластика и простой вход для новичков." });
      pool.push({ direction: "Йога",          pitch: "Для спокойного формата отлично подходит йога: растяжка и хорошая нагрузка без спешки." });
      pool.push({ direction: "Contemporary",  pitch: "Контемп — современная пластика, понятная база и работа с эмоциями." });
      pool.push({ direction: "Zumba",         pitch: "Если хочется активного — зумба: бодрая музыка и хорошая нагрузка за час." });
      pool.push({ direction: "Hip-hop",       pitch: "Хип-хоп — самый понятный вход в современный танец, хорошо заходит и новичкам." });
    }
  }

  // Сортируем пул по совместимости с категорией клиента:
  // 0 = в той же категории, 1 = нейтральное направление, 2 = противоположная категория.
  const rank = (dir: string): number => {
    const cat = DIRECTION_CATEGORY[dir] ?? "neutral";
    if (wantedCategory === "neutral") return cat === "neutral" ? 1 : 0;
    if (cat === wantedCategory) return 0;
    if (cat === "neutral") return 1;
    return 2;
  };
  const ordered = [...pool].sort((a, b) => rank(a.direction) - rank(b.direction));

  for (const candidate of ordered) {
    if (rejected.has(candidate.direction)) continue;
    // Если клиент явно выразил предпочтение — НЕ предлагаем противоположное.
    // Лучше дойти до handoff, чем подсунуть Hip-hop тому, кто попросил спокойное.
    if (wantedCategory !== "neutral") {
      const cat = DIRECTION_CATEGORY[candidate.direction] ?? "neutral";
      if (cat !== "neutral" && cat !== wantedCategory) continue;
    }
    if (!isDirectionAvailable(candidate.direction, { age: state.age, branch: state.branch })) continue;
    return candidate;
  }
  return undefined;
}

function pickAlternativeDirection(direction: string | undefined, state: SalesDialogState): string | undefined {
  if (!direction) return undefined;
  const candidates = directionAlternatives[direction] ?? [];
  for (const candidate of candidates) {
    const slots = findSlots({ direction: candidate, branch: state.branch, age: state.age, limit: 1 });
    if (slots.length) return candidate;
  }
  return undefined;
}

function isClarifyingUserQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  if (!lower.endsWith("?") && !/(?:^|\s)(?:не\s+понял|не\s+поняла|что\s+это|что\s+такое|как\s+это|объясн|расскажи|расскажите|поясни|поясните|повторите|это\s+в\s+смысле)/i.test(lower)) {
    return false;
  }
  return /(?:что|как|кто|зачем|почему|какой|какая|какие|это\s+вопрос|не\s+понял|не\s+поняла|объясн|поясни|повторите|расскаж)/i.test(lower);
}

function isUnintelligible(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const meaningful = trimmed.replace(/[^\p{L}\p{N}]+/gu, "");
  if (meaningful.length < 1) return true;
  if (/^[\p{P}\p{S}\s]+$/u.test(trimmed)) return true;
  return false;
}

function pickClarifyPrompt(state: SalesDialogState): string {
  const variants = [
    "Извините, плохо вас расслышала. Повторите, пожалуйста?",
    "Простите, не разобрала. Можете повторить?",
    "Извините, связь пропала на секунду. Повторите, пожалуйста?"
  ];
  const prefix = state.customerName ? `${state.customerName}, ` : "";
  return prefix + variants[Math.floor(Math.random() * variants.length)];
}

export interface SalesDialogInput {
  message: string;
  state?: SalesDialogState;
}

export interface SalesDialogResult {
  reply: string;
  state: SalesDialogState;
  action: SalesBrainAction;
  booking?: Booking;
  slots?: Slot[];
  brainSource?: string;
  brainCache?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  extractionCache?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
}

interface ReplyContext {
  currentSlot?: Slot | (Pick<Slot, "weekday" | "time" | "branch" | "direction"> & { teacher?: string; address?: string; floor?: string });
  price?: {
    trial?: number;
    subscription?: number | null;
  };
  notes?: string[];
}

const directionByNeed: Array<[string[], string, string]> = [
  [["энерг", "похуд", "встрях", "кардио"], "Zumba", "если хочется хорошо подвигаться, попробуйте зумбу: там бодрая музыка, активный темп и хорошая нагрузка."],
  [["актив", "подвиж", "динам", "темп", "поактив", "бодр", "разогнат"], "Hip-hop", "если хочется чего-то поактивнее, для начала хорошо подходит хип-хоп: понятный формат и много движения."],
  [["спок", "медлен", "плавн", "поспок"], "Йога", "если хочется чего-то спокойнее, можно начать с йоги: спокойный формат и хорошая нагрузка без спешки."],
  [["растяж", "спина", "мягк", "расслаб", "здоров"], "Йога", "если хочется чего-то спокойнее, можно начать с йоги: мягкий формат и хорошая нагрузка без спешки."],
  [["женствен", "поженствен", "леди", "lady", "heels", "хилс"], "Lady style", "если хочется именно такой формат, можно попробовать леди стайл: красивые связки и плавная пластика."],
  [["пара", "партнер", "сальс", "бачат"], "Salsa/Bachata", "можно попробовать сальсу или бачату: это парные танцы, но прийти можно и без партнёра."],
  [["современ", "контемп", "чувств", "пластич"], "Contemporary", "если хочется чего-то современного и плавного, попробуйте контемпорари: красивые связки и работа с эмоциями."],
  [["трюк", "брейк", "сила", "мальчик"], "Breakdance", "если хочется чего-то более активного, попробуйте брейкданс: силовой формат и много движения."],
  [["кпоп", "k-pop", "кей"], "K-pop", "если нравятся современные танцы под знакомые треки, попробуйте K-pop: яркие связки и хороший темп."],
  [["восточ"], "Восточные танцы", "можно попробовать восточные танцы: спокойный формат, мягкая пластика и понятный вход для новичка."],
  [["джаз"], "Jazz funk", "если хочется чего-то поярче, попробуйте джаз-фанк: яркие связки и более сценический формат."]
];

export async function handleSalesDialog(input: SalesDialogInput): Promise<SalesDialogResult> {
  const text = input.message.trim();
  const lower = text.toLowerCase();
  const state: SalesDialogState = {
    aiVoiceDisclosure: true,
    crossBorderTransfer: true,
    recentActions: [],
    retriesOnAction: {},
    ...input.state
  };
  const replyResult = async (
    action: SalesDialogResult["action"],
    reply: string,
    nextState: SalesDialogState,
    options?: {
      slots?: Slot[];
      booking?: Booking;
      context?: ReplyContext;
    }
  ): Promise<SalesDialogResult> => {
    const previousAction = state.stage;
    const recentActions = [...(state.recentActions ?? []), action].slice(-5);
    const retriesOnAction = { ...(state.retriesOnAction ?? {}) };
    // Loop guard: считаем retry только если бот реально не сдвинулся, а не клиент задал уточняющий вопрос.
    const userAskedClarification = isClarifyingUserQuestion(text);
    if (previousAction && previousAction === action && !userAskedClarification) {
      retriesOnAction[action] = (retriesOnAction[action] ?? 0) + 1;
    } else if (previousAction !== action) {
      retriesOnAction[action] = 0;
    }

    let finalAction = action;
    let finalReply = reply;
    if ((retriesOnAction[action] ?? 0) >= 3 && action !== "handoff" && action !== "booked") {
      finalAction = "handoff";
      finalReply = `${state.customerName ? `${state.customerName}, ` : ""}давайте подключу администратора, чтобы он подобрал вариант лично — он наберёт в ближайшее время.`;
    }

    const normalizedState: SalesDialogState = {
      ...nextState,
      stage: finalAction,
      recentActions,
      retriesOnAction,
      hasIntroduced: nextState.hasIntroduced || finalAction !== "ask_name"
    };
    const normalizedReply = cleanHumanReply(finalReply);
    let brainSource: string | undefined;
    let brainCache: SalesDialogResult["brainCache"];
    let humanReply: string;
    if (finalAction === "handoff") {
      humanReply = normalizedReply;
    } else {
      const brainOut = await humanizeSalesReply({
        action: finalAction,
        customerMessage: text,
        fallbackReply: normalizedReply,
        state: normalizedState,
        slots: options?.slots,
        context: options?.context
      });
      humanReply = brainOut.reply;
      brainSource = brainOut.source;
      brainCache = brainOut.cacheUsage;
    }

    if (finalAction === "handoff") {
      void recordHandoff({
        reason: pickHandoffReason(action, retriesOnAction[action] ?? 0, lower),
        state: normalizedState,
        lastUserText: text
      });
    }

    // Если в финальной реплике упомянута цена пробного / руб — фиксируем,
    // чтобы скриптовые шаблоны не дублировали "Пробное у нас по X рублей" следующим ходом.
    if (
      normalizedState.trialPriceMentionedAtTurn === undefined &&
      /\b(?:руб|₽)\b/i.test(humanReply)
    ) {
      normalizedState.trialPriceMentionedAtTurn = normalizedState.turnIndex ?? 0;
    }
    // Если бот в этой реплике явно описал/охарактеризовал текущий direction — пометим.
    if (
      normalizedState.direction &&
      normalizedState.directionDescribedAtTurn === undefined
    ) {
      const dir = normalizedState.direction;
      const aliasesSimple: Record<string, RegExp> = {
        "Hip-hop":    /(?<![а-яёa-z])хип[-\s]?хоп(?![а-яёa-z])/iu,
        "Breakdance": /(?<![а-яёa-z])(?:брейк(?:[-\s]?данс)?|break)(?![а-яёa-z])/iu,
        "Contemporary": /(?<![а-яёa-z])(?:контемп(?:орари)?|contemporary)(?![а-яёa-z])/iu,
        "Йога":       /(?<![а-яёa-z])йог[ауеи](?![а-яёa-z])/iu,
        "Zumba":      /(?<![а-яёa-z])(?:зумб[ауы]|zumba)(?![а-яёa-z])/iu,
        "Lady style": /(?<![а-яёa-z])(?:леди\s*стайл|lady\s*style)(?![а-яёa-z])/iu,
        "Salsa/Bachata": /(?<![а-яёa-z])(?:сальс[ауы]|бачат[ауы])(?![а-яёa-z])/iu,
        "K-pop":      /(?<![а-яёa-z])(?:k-?pop|кей[-\s]?поп|кпоп)(?![а-яёa-z])/iu,
        "Детская хореография": /(?<![а-яёa-z])(?:детская\s+хореограф|хореограф)/iu
      };
      const pattern = aliasesSimple[dir];
      // Описанием считаем не просто упоминание имени, а имя + слова "формат / трюк / связки / пластика / нагрузка / акробатика / силовой / плавн".
      const describesPattern = /(?:формат|трюк|связк|пластик|нагрузк|акробат|силов|плавн|координац|растяж|ритм|сценич)/i;
      if (pattern && pattern.test(humanReply) && describesPattern.test(humanReply)) {
        normalizedState.directionDescribedAtTurn = normalizedState.turnIndex ?? 0;
      }
    }

    return {
      reply: humanReply,
      state: normalizedState,
      action: finalAction,
      booking: options?.booking,
      slots: options?.slots,
      brainSource,
      brainCache,
      extractionCache: state.lastExtractionCache
    };
  };
  const ask = (
    action: SalesDialogResult["action"],
    reply: string,
    nextState: SalesDialogState,
    slots?: Slot[],
    context?: ReplyContext
  ) => replyResult(action, reply, nextState, { slots, context });

  if (detectHandoffRequest(lower)) {
    return replyResult(
      "handoff",
      `${state.customerName ? `${state.customerName}, ` : ""}конечно, переключаю на администратора. Он перезвонит в ближайшее время.`,
      state
    );
  }

  // После handoff любая дальнейшая речь клиента — мягкое подтверждение, не новый цикл.
  if (state.stage === "handoff") {
    return replyResult(
      "handoff",
      `${state.customerName ? `${state.customerName}, ` : ""}заявка уже у администратора, он перезвонит в ближайшее время. Если хотите что-то уточнить сейчас — спрашивайте, я подскажу что смогу.`,
      state
    );
  }

  if (detectBotQuestion(lower)) {
    return replyResult(
      "ask_name",
      `Да, я голосовой ассистент Studio 108, помогаю записать на пробное занятие. Если что-то нужно решить лично — переключу на администратора. А как к вам можно обращаться?`,
      state
    );
  }

  if (isUnintelligible(text)) {
    const streak = (state.clarifyStreak ?? 0) + 1;
    if (streak >= 2) {
      return replyResult(
        "handoff",
        `${state.customerName ? `${state.customerName}, ` : ""}похоже, у нас плохая связь. Я передам заявку администратору, и он перезвонит вам сам.`,
        { ...state, clarifyStreak: 0 }
      );
    }
    const stageAction = (state.stage ?? "ask_name") as SalesBrainAction;
    const reformulated = `${pickClarifyPrompt(state)} ${reformulateForRepeat(stageAction, state)}`.trim();
    return replyResult(
      stageAction,
      reformulated,
      { ...state, clarifyStreak: streak }
    );
  }
  if ((state.clarifyStreak ?? 0) > 0) {
    state.clarifyStreak = 0;
  }

  const customerNameBefore = state.customerName;
  const directionBefore = state.direction;
  const branchBefore = state.branch;
  const ageBefore = state.age;
  await mergeExtractedFields(state, lower, text);
  // Имя клиента устанавливается ровно один раз. Дальше любые попытки
  // перезаписать (например, клиент произнёс название филиала похожее на имя) — игнорируются.
  if (customerNameBefore && state.customerName !== customerNameBefore) {
    state.customerName = customerNameBefore;
  }
  // Защита от мусора в имени: «Студия», «Здравствуйте», «Школа», «оператор» и т.п.
  // Если NLU успел извлечь такое слово как имя — сбрасываем и переспросим явно.
  dropFakeCustomerName(state);

  // КРИТИЧНО: на КАЖДОМ turn'е сканируем реплику на явный отказ от направления.
  // Это работает в двух случаях:
  //  (a) клиент отвергает текущий state.direction («не подходит хип-хоп» когда мы его выбрали)
  //  (b) клиент proactively говорит «не хочу йогу» в любом turn'е — даже если direction ещё не set
  //  (c) implicit: есть _pendingDirection и клиент сказал общее «не нравится / не подходит /
  //      не хочу» БЕЗ упоминания имени — относим к pending. Это типичный кейс «А-а-а, не,
  //      не очень нам подходит».
  const rejectedFromThisTurn = detectRejectedDirections(text);
  const GENERIC_REJECTION_PATTERN = /(?:не\s+подход|не\s+нрав|не\s+хочу|не\s+нужн|совсем\s+не|так\s+себе|не\s+(?:очень\s+)?подход)/i;
  if (
    rejectedFromThisTurn.length === 0 &&
    state._pendingDirection &&
    GENERIC_REJECTION_PATTERN.test(lower) &&
    !isPositive(lower)
  ) {
    rejectedFromThisTurn.push(state._pendingDirection);
  }
  // Та же логика для state.direction (без pending), если он не был подтверждён.
  if (
    rejectedFromThisTurn.length === 0 &&
    state.direction &&
    !state.directionConfirmed &&
    GENERIC_REJECTION_PATTERN.test(lower) &&
    !isPositive(lower)
  ) {
    rejectedFromThisTurn.push(state.direction);
  }
  if (rejectedFromThisTurn.length) {
    state.rejectedDirections = [...new Set([...(state.rejectedDirections ?? []), ...rejectedFromThisTurn])];
    // Если current direction среди отвергнутых — сбрасываем.
    if (state.direction && rejectedFromThisTurn.includes(state.direction)) {
      state.direction = undefined;
      state.directionConfirmed = false;
      state.need = text;
    }
    // Если pending direction (предложенный, но не подтверждённый) среди отвергнутых — тоже.
    if (state._pendingDirection && rejectedFromThisTurn.includes(state._pendingDirection)) {
      state._pendingDirection = undefined;
      state.directionConfirmed = false;
    }
    // Если directionBefore был отвергнут, тоже сбрасываем.
    if (directionBefore && rejectedFromThisTurn.includes(directionBefore) && state.direction === directionBefore) {
      state.direction = undefined;
      state.directionConfirmed = false;
    }
  }
  // Если NLU выдал direction который клиент уже отверг — отбрасываем.
  if (state.direction && (state.rejectedDirections ?? []).includes(state.direction)) {
    state.direction = undefined;
  }
  // Если matchDirection по новому need хочет выбрать отвергнутое — заранее зачищаем need
  // от упоминания этого direction, чтобы не зацикливаться.
  if (rejectedFromThisTurn.length && state.need) {
    for (const dir of rejectedFromThisTurn) {
      for (const alias of directionAliases(dir)) {
        const aliasEsc = alias.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
        // Кириллический «word boundary» — нет буквы до/после.
        const aliasRegex = new RegExp(`(?<![а-яёa-z])${aliasEsc}(?![а-яёa-z])`, "giu");
        state.need = state.need.replace(aliasRegex, "").replace(/\s{2,}/g, " ").trim();
      }
    }
  }

  // Обновляем буфер последних реплик клиента (для profile classifier и supervisor'а).
  const recentMessages = [...(state.recentCustomerMessages ?? []), text].slice(-6);
  state.recentCustomerMessages = recentMessages;

  // Profile classifier — лёгкий, выполняем каждый turn под флагом. Если данных мало —
  // получим "unknown" с низким confidence и brain просто не получит сильной директивы.
  if (isFlagOn("useCustomerProfile")) {
    const classification = classifyCustomerProfile({
      state: {
        learnerType: state.learnerType,
        age: state.age,
        customerName: state.customerName,
        customerGender: state.customerGender,
        childGender: state.childGender,
        need: state.need
      },
      recentMessages
    });
    state.customerProfile = classification.profile;
    state.customerProfileConfidence = classification.confidence;
  }

  // Long-term memory: после получения phone — загружаем prior contacts (см. customerHistory),
  // сохраняем сжатый summary в state.previousContactSummary, чтобы brain мог использовать.
  if (isFlagOn("useLongTermMemory") && state.phone && !state.previousContactSummary) {
    try {
      const history = await lookupPreviousContact(state.phone);
      if (history.hasPreviousContact) {
        const parts: string[] = [];
        parts.push(`Прошлый контакт: ${history.daysSinceLast ?? "?"} дн. назад`);
        if (history.hasBooking) parts.push("уже была бронь");
        if (history.lastDirection) parts.push(`интересовал(ся) ${history.lastDirection}`);
        if (history.lastBranch) parts.push(`филиал ${history.lastBranch}`);
        if (history.notes) parts.push(history.notes);
        state.previousContactSummary = parts.join("; ");
      }
    } catch {
      // memory — best-effort, не валим диалог при ошибке чтения
    }
  }

  // Success-story hint — релевантная история подбирается по direction/age/objection
  if (isFlagOn("useSuccessStories")) {
    try {
      const hint = await findRelevantSuccessStory({
        direction: state.direction,
        age: state.age,
        learnerType: state.learnerType,
        customerMessage: lower,
        stage: state.stage
      });
      state.relevantStoryHint = hint ?? undefined;
    } catch {
      state.relevantStoryHint = undefined;
    }
  }

  // Strategy supervisor — fire-and-forget, не блокирует текущий turn.
  // Verdict из ПРЕДЫДУЩЕГО turn'а уже в state.supervisorVerdict — он передаётся в brain.
  // На этом turn'е запускаем новый supervisor для следующего ответа.
  if (isFlagOn("useStrategySupervisor")) {
    // Сначала подхватываем последний рассчитанный verdict из cache (если есть и свежий)
    const cached = getCachedVerdict(state.conversationId);
    if (cached && (!state.supervisorVerdict || cached.computedAtTurn > state.supervisorVerdict.turnIndexAt)) {
      state.supervisorVerdict = {
        warmth: cached.warmth,
        mainObjection: cached.mainObjection,
        advice: cached.advice,
        turnIndexAt: cached.computedAtTurn
      };
    }
    // И запускаем background-расчёт для следующего turn'а
    if (shouldRunSupervisor(state)) {
      fireSupervisor(state.conversationId, {
        state,
        recentMessages,
        currentStage: state.stage
      }, state.turnIndex ?? 0);
    }
  }

  if (!state.customerName) {
    const singleName = text.trim().match(/^([А-ЯЁа-яёA-Za-z]{2,})$/)?.[1];
    if (singleName && !isGreetingWord(singleName) && !isNotAName(singleName)) {
      state.customerName = capitalize(singleName);
    }
  }

  if (!state.customerName) {
    if (state.phone) {
      const history = await lookupPreviousContact(state.phone);
      if (history.hasPreviousContact && history.customerName) {
        state.customerName = history.customerName;
        if (history.lastDirection && !state.direction) state.direction = history.lastDirection;
        if (history.lastBranch && !state.branch) state.branch = history.lastBranch as Branch;
        const greetingText = (history.daysSinceLast ?? 99) <= 30
          ? variants.continuityGreeting(history.customerName, history.daysSinceLast ?? 0, history.lastDirection)
          : variants.returningCustomerGreeting(history.customerName);
        return ask("ask_learner", greetingText, state);
      }
    }
    if (isPriceQuestion(lower)) {
      return ask("ask_name", "Здравствуйте! Это Studio 108. Пробное у нас обычно от 300 рублей, но цена зависит от направления. Подскажите, как к вам обращаться?", state);
    }
    return ask("ask_name", variants.greeting(), state);
  }

  if (isPriceQuestion(lower) && !state.direction) {
    return ask(
      "ask_learner",
      `${state.customerName}, пробное занятие у нас обычно стоит от 300 рублей, на некоторых направлениях цена отличается. А мы подбираем занятие для вас или для ребёнка?`,
      state
    );
  }

  if (isAddressQuestion(lower) && !state.branch) {
    return ask(
      "ask_branch",
      `${state.customerName}, у нас три основных филиала: на Развилке, у озера и возле первой школы. Какой из них удобнее?`,
      state
    );
  }

  if (!isLearnerStepClosed(state)) {
    return ask("ask_learner", variants.askLearner(state.customerName), state);
  }

  // Мета-вопросы клиента, на которые надо ОТВЕТИТЬ прежде чем продавливать direction.
  // Иначе бот выглядит глухим: «расскажите про студию» → бот «попробуем хип-хоп?».
  // Выполняются после ask_learner (чтобы знать ребёнок/взрослый) и ДО ask_direction_confirm-логики.
  if (isFrustrationSignal(lower)) {
    const prefix = state.customerName ? `${state.customerName}, ` : "";
    const list = state.learnerType === "child"
      ? "хип-хоп, брейкданс, контемп и детская хореография"
      : "хип-хоп, брейкданс, контемп, йога, зумба, сальса и бачата, леди стайл";
    return ask(
      "ask_need",
      `${prefix}извините, я вас услышала, отвечу. Studio 108 — танцевальная студия, три филиала: на Развилке, у озера и возле первой школы. Из направлений ${state.learnerType === "child" ? "для детей " : ""}есть ${list}. Что больше нравится — что-то поактивнее или поспокойнее?`,
      { ...state, _pendingDirection: undefined }
    );
  }
  if (isStudioInfoQuestion(lower)) {
    const prefix = state.customerName ? `${state.customerName}, ` : "";
    const list = state.learnerType === "child"
      ? "хип-хоп, брейкданс, контемп и детская хореография"
      : "хип-хоп, брейкданс, контемп, йога, зумба, сальса и бачата, леди стайл";
    return ask(
      "ask_need",
      `${prefix}Studio 108 — танцевальная студия с тремя филиалами: на Развилке, у озера и возле первой школы. У нас групповые занятия по разным направлениям, ${state.learnerType === "child" ? "для детей это " : ""}${list}. Что больше подходит — поактивнее или поспокойнее?`,
      { ...state, _pendingDirection: undefined }
    );
  }
  if (isScheduleQuestionGeneric(lower)) {
    const prefix = state.customerName ? `${state.customerName}, ` : "";
    return ask(
      "ask_need",
      `${prefix}расписание зависит от направления и филиала, обычно занятия идут с 10 до 22 часов. Когда подберём направление — подскажу ближайшие свободные группы. Что больше интересует — что-то поактивнее или поспокойнее?`,
      { ...state, _pendingDirection: undefined }
    );
  }

  // ПЕРВЫЙ ПРИОРИТЕТ (раньше всех остальных шагов): если на прошлом turn'е бот предложил
  // direction и ждёт подтверждения — сначала обрабатываем ответ клиента, иначе он попадёт
  // в isNeedStepClosed и зацикливается в ask_need.
  if (state.stage === "ask_direction_confirm" && state._pendingDirection) {
    const pending = state._pendingDirection;
    const branchExtractedThisTurn = !branchBefore && state.branch !== undefined;
    const ageExtractedThisTurn = !ageBefore && state.age !== undefined;
    // Сравниваем по русским алиасам, а не по английскому ключу: pending="Breakdance",
    // но клиент скажет "брейк-данс". Без алиасов бот ошибочно считает, что упомянуто ДРУГОЕ направление.
    const pendingAliases = directionAliases(pending).map((a) => a.toLowerCase());
    const textMentionsPending = pendingAliases.some((alias) =>
      new RegExp(`(?<![а-яёa-z])${alias.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}(?![а-яёa-z])`, "iu").test(lower)
    );
    const explicitOtherDirection = isDirectionMentionedExplicitly(text) && !textMentionsPending;
    // Ловим «не [очень/особо/совсем/сильно] нравится/хочу/подходит/интересно».
    // Также «не для нас», «не моё», «не пойдёт», «не айс», «не очень».
    const explicitRejection = /(?:не\s+(?:очень\s+|особо\s+|совсем\s+|сильно\s+|шибко\s+)?(?:хоч(?:у|ется|ется)|нрав|подход|интересн|пойд(?:ет|ёт)|айс)|не\s+(?:для\s+нас|моё|мое|наш(?:е|его)?)|не\s+очень(?![\sа-яё])|не\s+особо(?![\sа-яё])|давай(?:те)?\s+друг|посмотрим\s+друг|другое\s+направ|друг(?:ое|ой)\s+(?:танц|вид))/i.test(lower);
    // КРИТИЧНО: \b в JS не работает с кириллицей. "да\b" ловит "да" внутри "брейк-данс",
    // "ок\b" ловит "ок" внутри "около" / "сок". Используем lookbehind/lookahead с кириллицей.
    const explicitAcceptance =
      /(?<![а-яёa-z])(?:да|ок|окей)(?![а-яёa-z])/iu.test(lower) ||
      /(?:подойд|давай(?:те)?|хорошо|согласен|согласна|подходит|устраивает|годится|можно|идёт|идет)/i.test(lower);
    // Клиент спросил каталог («какие ещё / какие есть / что ещё / расскажите про другие»).
    // Это НЕ rejection — он не отверг pending, он хочет увидеть варианты до решения.
    const asksForCatalog = /(?:как(?:ие|ой|ая)\s+(?:ещ[её]|друг|есть|у\s+вас|вариант|направлен|танц)|что\s+ещ[её]|что\s+есть|что\s+(?:можете|может)\s+предлож|расскажите\s+(?:ещ[её]|про\s+друг|какие)|перечисл|покажите\s+варианты)/i.test(lower);

    if (asksForCatalog) {
      const prefix = state.customerName ? `${state.customerName}, ` : "";
      const list = state.learnerType === "child"
        ? "хип-хоп, брейкданс, контемп и детская хореография"
        : "хип-хоп, брейкданс, контемп, йога, зумба, сальса и бачата, леди стайл";
      // Сбрасываем pending — клиент явно хочет выбрать сам.
      return ask(
        "ask_need",
        `${prefix}конечно. У нас есть ${list}. Что больше нравится — что-то поактивнее или поспокойнее?`,
        { ...state, _pendingDirection: undefined }
      );
    }

    // Категория-конфликт = неявный отказ. Клиент в реплике выразил предпочтение
    // («нужно спокойное», «хочу поактивнее»), не совпадающее с категорией pending.
    // Это сильнее, чем "уточню — подойдёт?" — клиент уже сказал чего хочет, бот должен переключиться.
    const messageCategory = classifyNeedCategory(text);
    const pendingCategory = DIRECTION_CATEGORY[pending] ?? "neutral";
    const categoryConflict = messageCategory !== "neutral" && pendingCategory !== "neutral" && messageCategory !== pendingCategory;

    // КРИТИЧНО: rejection побеждает acceptance. Если клиент сказал «давайте другое посмотрим» —
    // это И «давайте» (acceptance pattern), И «давайте другое» (rejection pattern). Раньше
    // acceptance вы́играл и бот молча подтверждал отвергнутое направление.
    // Теперь rejection срабатывает безусловно, не оглядываясь на acceptance.
    if (explicitRejection || categoryConflict) {
      state.rejectedDirections = [...new Set([...(state.rejectedDirections ?? []), pending])];
      state._pendingDirection = undefined;
      // Сохраняем предпочтение клиента в state.need, чтобы suggestPopularDirection
      // выдал правильную категорию. Без этого после отказа от Hip-hop клиенту, попросившему
      // спокойное, бот выдаёт Breakdance (просто следующий в списке).
      if (categoryConflict) {
        state.need = text;
      }
      const suggested = suggestPopularDirection(state);
      if (suggested) {
        return ask(
          "ask_direction_confirm",
          `${state.customerName ? `${state.customerName}, ` : ""}поняла. Тогда ${suggested.pitch.charAt(0).toLowerCase()}${suggested.pitch.slice(1)} Попробуем это направление?`,
          { ...state, _pendingDirection: suggested.direction } as SalesDialogState
        );
      }
      return ask("ask_need", `${state.customerName ? `${state.customerName}, ` : ""}поняла, давайте подберём другое. Что больше нравится — что-то поактивнее или поспокойнее?`, state);
    }
    if (explicitOtherDirection) {
      state._pendingDirection = undefined;
    } else if (explicitAcceptance || branchExtractedThisTurn || ageExtractedThisTurn) {
      state.direction = pending;
      state.directionConfirmed = true;
      state._pendingDirection = undefined;
    } else {
      // Используем directionForSpeech, чтобы получить русское название («брейкданс»,
      // «хип-хоп»), а не latin ключ («breakdance», «Hip-hop») из state.
      return ask(
        "ask_direction_confirm",
        `${state.customerName ? `${state.customerName}, ` : ""}уточню: ${directionForSpeech(pending)} — подойдёт, или хотите посмотреть другое направление?`,
        state
      );
    }
  }

  if (!isNeedStepClosed(state)) {
    // Если только что был rejection — сразу предлагаем альтернативу с учётом rejectedDirections,
    // не возвращаемся к ask_need. Иначе клиент чувствует, что бот не запомнил.
    if (rejectedFromThisTurn.length > 0) {
      const suggested = suggestPopularDirection(state);
      if (suggested) {
        return ask(
          "ask_direction_confirm",
          `${state.customerName ? `${state.customerName}, ` : ""}тогда ${suggested.pitch.charAt(0).toLowerCase()}${suggested.pitch.slice(1)} Попробуем это направление?`,
          { ...state, _pendingDirection: suggested.direction } as SalesDialogState
        );
      }
    }
    // Если клиент уже намекнул "не знаю / посоветуйте / что-нибудь популярное" — не зацикливаемся
    // в ask_need, а сами предлагаем популярное направление и идём к филиалу.
    if (clientGivesInitiative(text) || clientGivesInitiative(state.need ?? "")) {
      const suggested = suggestPopularDirection(state);
      if (suggested) {
        state.direction = suggested.direction;
        return ask(
          "ask_branch",
          `${state.customerName ? `${state.customerName}, ` : ""}${suggested.pitch.charAt(0).toLowerCase()}${suggested.pitch.slice(1)} Какой филиал удобнее — Развилка, у озера или возле первой школы?`,
          state
        );
      }
    }
    // Если ask_need уже звучал 2 раза подряд — тоже берём инициативу,
    // чтобы не повторяться третий раз.
    const askNeedStreak = (state.recentActions ?? []).filter((a, idx, arr) => a === "ask_need" && arr.indexOf(a) >= arr.length - 3).length;
    if (askNeedStreak >= 2) {
      const suggested = suggestPopularDirection(state);
      if (suggested) {
        state.direction = suggested.direction;
        return ask(
          "ask_branch",
          `${state.customerName ? `${state.customerName}, ` : ""}${suggested.pitch.charAt(0).toLowerCase()}${suggested.pitch.slice(1)} Какой филиал удобнее — Развилка, у озера или возле первой школы?`,
          state
        );
      }
    }
    if (state.learnerType === "child") {
      return ask("ask_need", variants.askNeedChild(state.customerName, state.childGender), state);
    }
    return ask("ask_need", variants.askNeedAdult(state.customerName), state);
  }

  // Если клиент явно спросил «что у вас есть / что можете предложить» — не подбираем
  // direction автоматически, а возвращаемся к ask_need с уточняющим вопросом.
  const isCatalogQuestion = /\b(?:что\s+(?:у\s+вас\s+)?есть|что\s+(?:можете|может)\s+предлож|какие\s+(?:есть|у\s+вас|варианты|направлен)|расскажите|перечислите|какие\s+направлен)/i.test(lower);
  if (isCatalogQuestion && !state.direction) {
    const prefix = state.customerName ? `${state.customerName}, ` : "";
    if (state.learnerType === "child") {
      return ask("ask_need", `${prefix}для детей у нас есть хип-хоп, брейкданс, контемп и детская хореография. Какое направление ближе, или хотите начать с пробного, чтобы попробовать?`, state);
    }
    return ask("ask_need", `${prefix}у нас есть хип-хоп, брейкданс, контемп, йога, зумба, сальса и бачата, леди стайл. Что вам ближе — что-то поактивнее или поспокойнее?`, state);
  }

  // (ask_direction_confirm handler перенесён выше — после ask_learner check)

  // Для ребёнка с неизвестным возрастом — сначала возраст, потом направление.
  // Иначе бот предлагает «для этого возраста хорошо заходит хип-хоп...» когда возраста
  // вообще не знает, и может посоветовать направление, не подходящее по возрасту
  // (Lady style для 4-летнего, например). Исключение: клиент прямо назвал направление —
  // тогда возраст спросим позже на стадии needsAge.
  if (
    state.learnerType === "child" &&
    !state.age &&
    !state.direction &&
    !isDirectionMentionedExplicitly(text) &&
    !isDirectionMentionedExplicitly(state.need ?? "")
  ) {
    return ask("ask_age", variants.askAgeChild(state.customerName, state.childGender), state);
  }

  // Возраст ребёнка <4 — основные детские группы не подходят, передаём администратору.
  // Проверяем ЗДЕСЬ (а не позже после set'а direction), чтобы пути silent-set + ask_branch
  // не обходили handoff. Раньше handoff фиксировался только когда implicit-accept на возраст
  // в ask_direction_confirm handler устанавливал direction. С новой логикой ask_age-first
  // путь идёт через recentAskNeed → suggestPopularDirection → ask_branch напрямую.
  if (isChildLead(state) && state.age && state.age < 4) {
    return ask(
      "handoff",
      `${state.customerName ? `${state.customerName}, ` : ""}основные детские группы у нас стартуют примерно с 4 лет, поэтому для такого возраста ребёнка лучше, чтобы администратор подобрал вариант лично. Я передам заявку — он перезвонит вам с подходящим решением.`,
      state
    );
  }

  // Если direction ещё не известен, но из state.need можно вывести (например "хочу танцевать" → Hip-hop) —
  // мы НЕ устанавливаем direction молча, а явно объявляем клиенту: «Для дочки в этом возрасте
  // хорошо подходит хип-хоп. Подойдёт?». Без подтверждения нельзя auto-jump на ask_branch.
  // Иначе клиент не понимает, на что бот его записывает.
  if (!state.direction && state.need) {
    const matched = matchDirection(state);
    if (matched) {
      // Если клиент явно назвал направление словом или явным алиасом — устанавливаем молча
      // (он сам это сказал, бот не вкладывает выбор).
      // Если клиент уже дал branch (то есть деловой и пошёл по воронке) — тоже silent set:
      // direction будет упомянут в offer_solution естественно, без отдельного confirm-шага.
      // Confirm нужен только когда мы вот-вот переключимся на ask_branch, и клиент не понимает,
      // на что его записывают.
      const directionMentionedExplicitly = isDirectionMentionedExplicitly(state.need ?? "");
      if (directionMentionedExplicitly || state.branch) {
        state.direction = matched.direction;
      } else if (!state.directionConfirmed) {
        // Объявляем выбор и ждём подтверждения. Если клиент скажет «да» — закроем.
        return ask(
          "ask_direction_confirm",
          `${state.customerName ? `${state.customerName}, ` : ""}${matched.pitch.charAt(0).toLowerCase()}${matched.pitch.slice(1)} Попробуем это направление?`,
          { ...state, _pendingDirection: matched.direction } as SalesDialogState
        );
      } else {
        state.direction = matched.direction;
      }
    }
  }

  // Если клиент сам сказал «не знаю / посоветуйте / что популярно» — бот берёт инициативу
  // и предлагает топ-направление для возраста/learner, чтобы не зацикливаться на ask_need.
  if (!state.direction && clientGivesInitiative(text)) {
    const suggested = suggestPopularDirection(state);
    if (suggested) {
      state.direction = suggested.direction;
      return ask(
        "ask_branch",
        `${state.customerName ? `${state.customerName}, ` : ""}${suggested.pitch.charAt(0).toLowerCase()}${suggested.pitch.slice(1)} Какой филиал удобнее — Развилка, у озера или возле первой школы?`,
        state
      );
    }
  }

  if (!state.direction) {
    // Если клиент ТОЛЬКО ЧТО отверг направление — бот должен сразу предложить альтернативу,
    // а не переспрашивать «что вам ближе?». Иначе клиент чувствует, что бот не слышит контекст.
    if (rejectedFromThisTurn.length > 0) {
      const suggested = suggestPopularDirection(state);
      if (suggested) {
        // На ask_direction_confirm, чтобы получить подтверждение (или implicit accept).
        return ask(
          "ask_direction_confirm",
          `${state.customerName ? `${state.customerName}, ` : ""}тогда ${suggested.pitch.charAt(0).toLowerCase()}${suggested.pitch.slice(1)} Попробуем это направление?`,
          { ...state, _pendingDirection: suggested.direction }
        );
      }
    }
    // Если бот уже спрашивал ask_need в прошлом turn — не переспрашиваем формулировкой,
    // а сразу предлагаем популярное направление под возраст.
    const recentAskNeed = (state.recentActions ?? []).slice(-2).includes("ask_need");
    if (recentAskNeed) {
      const suggested = suggestPopularDirection(state);
      if (suggested) {
        state.direction = suggested.direction;
        return ask(
          "ask_branch",
          `${state.customerName ? `${state.customerName}, ` : ""}${suggested.pitch.charAt(0).toLowerCase()}${suggested.pitch.slice(1)} Какой филиал удобнее — Развилка, у озера или возле первой школы?`,
          state
        );
      }
    }
    return ask("ask_need", `${state.customerName ? `${state.customerName}, ` : ""}подскажите, вам ближе что-то поактивнее, что-то спокойнее, или уже есть конкретное направление?`, state);
  }

  if (needsAge(state.direction) && !state.age) {
    if (state.learnerType === "adult") {
      return ask("ask_age", variants.askAgeAdult(state.customerName), state);
    }
    return ask("ask_age", variants.askAgeChild(state.customerName, state.childGender), state);
  }

  if (isChildLead(state) && state.age && state.age < 4) {
    return ask(
      "handoff",
      `${state.customerName}, основные детские группы у нас стартуют примерно с 4 лет, поэтому для такого возраста ребёнка лучше, чтобы администратор подобрал вариант лично. Я передам заявку — он перезвонит вам с подходящим решением.`,
      state
    );
  }

  if (!state.branch) {
    if (isAmbiguousCenterBranch(lower)) {
      return ask("ask_branch", "В центре есть два наших филиала: один у озера, второй возле первой школы. Какой ближе вам?", state);
    }
    if (isVagueBranch(lower)) {
      return ask("ask_branch", variants.askBranchOpen(), state);
    }
    return ask("ask_branch", isAddressQuestion(lower) ? variants.askBranchAfterAddress() : variants.askBranchOpen(), state);
  }

  const slots = getCandidateSlots(state, 3);
  state.offeredSlots = slots;

  if (!slots.length) {
    // Если клиент явно сказал «не подходит вечером/утром/днём», и из-за этого нет слотов —
    // не handoff, а спросить про другое время.
    if (isNoTimeObjection(lower) && (state.preferredTime || state.preferredWeekday || state.preferredDayType)) {
      return ask(
        "ask_branch",
        `${state.customerName ? `${state.customerName}, ` : ""}поняла, такое время не подходит. Когда удобнее — утром, днём или в выходные?`,
        { ...state, preferredTime: undefined, preferredWeekday: undefined, preferredDayType: undefined, stage: "ask_branch" }
      );
    }

    // 1. Тот же direction в другом филиале
    const sameDirOtherBranches = getCandidateSlots({ ...state, branch: undefined }, 10).filter((slot) => slot.branch !== state.branch);
    if (sameDirOtherBranches.length) {
      const first = sameDirOtherBranches[0];
      return ask("offer_solution", `${state.customerName}, в филиале ${state.branch} на ${directionForSpeech(state.direction!)} свободных мест нет. На ${branchPrepositional(first.branch)} есть ${formatSlotTimeOnly(first)}. Подойдёт?`, { ...state, branch: first.branch, offeredSlotIndex: 0, stage: "offer_solution" }, sameDirOtherBranches);
    }

    // 2. Другое подходящее направление в том же филиале
    const altDirection = pickAlternativeDirection(state.direction, state);
    if (altDirection) {
      const altSlots = getCandidateSlots({ ...state, direction: altDirection }, 5);
      if (altSlots.length) {
        const first = altSlots[0];
        return ask("offer_solution", `${state.customerName}, на ${directionForSpeech(state.direction!)} ${branchPrepositional(state.branch!)} свободных мест нет. Могу предложить ${directionForSpeech(altDirection)} — близкое по формату направление, есть ${formatSlotTimeOnly(first)}. Подойдёт такой вариант?`, { ...state, direction: altDirection, offeredSlotIndex: 0, stage: "offer_solution" }, altSlots);
      }
    }

    // 3. Время не подходит — предлагаем посмотреть другое
    if (state.preferredWeekday || state.preferredDayType || state.preferredTime) {
      return ask("ask_branch", `${state.customerName}, на это время свободного места не вижу. Могу посмотреть другой день недели или другой филиал. Что удобнее?`, { ...state, preferredWeekday: undefined, preferredDayType: undefined, preferredTime: undefined, stage: "ask_branch" });
    }

    // 4. Реально ничего не нашли — handoff
    return ask("handoff", `${state.customerName}, в нашем расписании сейчас на эти параметры группу подобрать не получается. Передаю заявку администратору — он посмотрит лично и подскажет ближайший вариант.`, state);
  }

  if (state.stage === "offer_solution" || state.stage === "offered_solution") {
    const currentSlot = slots[state.offeredSlotIndex ?? 0] ?? slots[0];

    if (isTeacherQuestion(lower)) {
      return ask("offer_solution", teacherReply(state, currentSlot), { ...state, stage: "offer_solution" }, slots);
    }

    if (isPriceQuestion(lower)) {
      return ask("offer_solution", priceReply(currentSlot), { ...state, stage: "offer_solution" }, slots);
    }

    if (isAddressQuestion(lower)) {
      const branch = branches[currentSlot.branch];
      return ask("offer_solution", `Занятие пройдёт ${branchPrepositional(currentSlot.branch)}, по адресу ${branch.address}${branch.floor ? `, ${branch.floor}` : ""}. ${formatSlotTimeOnly(currentSlot)} вам удобно подъехать?`, { ...state, stage: "offer_solution" }, slots);
    }

    if (isThinkingObjection(lower)) {
      return ask("offer_solution", `Конечно, подумайте. Пробное как раз для этого и нужно: можно спокойно прийти, посмотреть атмосферу и решить, нравится ли. Если время в целом подходит — могу пока подержать место на ${formatSlotTimeOnly(currentSlot)}, потом при желании поменяем.`, { ...state, stage: "offer_solution" }, slots);
    }

    if (isNoTimeObjection(lower)) {
      return ask("offer_solution", "Понимаю. Тогда давайте посмотрим другой день. Вам удобнее будни или выходные?", { ...state, stage: "offer_solution" }, slots);
    }

    if (isFarObjection(lower)) {
      return ask("ask_branch", "Понимаю, далеко. Давайте подберём филиал поближе. У нас Развилка, у озера и возле первой школы — какой район ближе к вам?", { ...state, branch: undefined, stage: "ask_branch" }, slots);
    }

    if (isShyObjection(lower)) {
      return ask("offer_solution", `Это абсолютно нормально, многие приходят с нуля и тоже сначала стесняются. Пробное как раз и нужно, чтобы спокойно попробовать без обязательств. ${formatSlotTimeOnly(currentSlot)} вам подойдёт?`, { ...state, stage: "offer_solution" }, slots);
    }

    if (isExpensiveObjection(lower)) {
      const price = getPrice(currentSlot.direction, currentSlot.branch);
      return ask("offer_solution", `Понимаю. Пробное всего ${price.trial} рублей — это разовая цена одного занятия, чтобы посмотреть группу и педагога. Дальше — только если понравится. ${formatSlotTimeOnly(currentSlot)} удобно?`, { ...state, stage: "offer_solution" }, slots);
    }

    if (isCallbackLaterObjection(lower)) {
      return ask("offer_solution", `Конечно. Если хотите, я подержу место на ${formatSlotTimeOnly(currentSlot)}, а вы спокойно перезвоните и подтвердите. Так подойдёт?`, { ...state, stage: "offer_solution" }, slots);
    }

    if (isPartnerObjection(lower)) {
      return ask("offer_solution", `Конечно, можно прийти вдвоём — на пробное мест хватит. Записываю обоих на ${formatSlotTimeOnly(currentSlot)}?`, { ...state, stage: "offer_solution" }, slots);
    }

    if (isBeginnerObjection(lower)) {
      return ask("offer_solution", `Это как раз начальный уровень, опыт не нужен — большинство приходит совсем с нуля. ${formatSlotTimeOnly(currentSlot)} вам подойдёт?`, { ...state, stage: "offer_solution" }, slots);
    }

    if (isClothesObjection(lower)) {
      return ask("offer_solution", `Достаточно удобной спортивной формы и сменной обуви — на пробном этого вполне хватит. ${formatSlotTimeOnly(currentSlot)} удобно?`, { ...state, stage: "offer_solution" }, slots);
    }
  }

  if (rejectsAllOptions(lower) && (state.stage === "offer_solution" || state.stage === "offered_solution")) {
    const otherBranches = getCandidateSlots({ ...state, branch: undefined }, 10).filter((slot) => slot.branch !== state.branch);
    if (otherBranches.length) {
      const first = otherBranches[0];
      return ask("offer_solution", `${state.customerName}, тогда могу предложить другой филиал. Например, ${formatSlotTimeOnly(first)} ${branchPrepositional(first.branch)}. Такой вариант рассмотрим?`, { ...state, branch: first.branch, offeredSlotIndex: 0, stage: "offer_solution" }, otherBranches);
    }

    return ask("handoff", `${state.customerName}, поняла, эти варианты не подходят. Тогда подключу администратора — он вручную посмотрит расписание и подберёт ближайшее удобное время.`, state, slots);
  }

  if (isNegative(lower) && (state.stage === "offer_solution" || state.stage === "offered_solution")) {
    const nextIndex = (state.offeredSlotIndex ?? 0) + 1;
    if (slots[nextIndex]) {
      return replyResult(
        "offer_solution",
        `${state.customerName}, тогда есть вариант ${formatSlotTimeOnly(slots[nextIndex])}. Такое время удобнее?`,
        { ...state, offeredSlotIndex: nextIndex },
        {
          slots,
          context: {
            currentSlot: slots[nextIndex],
            price: getPrice(slots[nextIndex].direction, slots[nextIndex].branch),
            notes: ["Предложи следующий подходящий слот коротко и по-человечески."]
          }
        }
      );
    }

    const otherBranches = getCandidateSlots({ ...state, branch: undefined }, 10).filter((slot) => slot.branch !== state.branch);
    if (otherBranches.length) {
      const branchOptions = unique(otherBranches.map((slot) => branchPrepositional(slot.branch))).slice(0, 2).join(" или ");
      return ask("ask_branch", `${state.customerName}, на филиале ${state.branch} больше подходящих вариантов нет. Могу посмотреть ${branchOptions}. Какой филиал вам ближе?`, { ...state, branch: undefined, stage: "ask_branch" }, otherBranches);
    }

    return ask("handoff", `${state.customerName}, тогда подключу администратора — он вручную посмотрит расписание и подберёт ближайшее удобное время.`, state, slots);
  }

  if (!state.selectedSlotId) {
    const matchedSlot = pickSlotByText(slots, lower);
    if (matchedSlot) {
      state.selectedSlotId = matchedSlot.id;
    }
  }

  // Если слот ещё не показывали клиенту (state.stage не offer_solution и не offered_solution),
  // то "да" клиента относится НЕ к слоту, а к предыдущему вопросу (например, к филиалу).
  // В этом случае всегда показываем offer_solution, не пропуская его.
  const offerWasShown = state.stage === "offer_solution" || state.stage === "offered_solution";

  if (!state.selectedSlotId && (!isPositive(lower) || !offerWasShown)) {
    const solution = buildSolutionText(state, slots);
    state.directionDescribedAtTurn = state.turnIndex ?? 0;
    return replyResult("offer_solution", solution, { ...state, stage: "offered_solution" }, {
      slots,
      context: {
        currentSlot: slots[state.offeredSlotIndex ?? 0] ?? slots[0],
        price: getPrice((state.direction ?? slots[0].direction), state.branch ?? slots[0].branch),
        notes: ["Объясни вариант естественно и предложи только один лучший слот."]
      }
    });
  }

  if (!state.selectedSlotId && isPositive(lower) && !isNegative(lower) && offerWasShown) {
    state.selectedSlotId = slots[state.offeredSlotIndex ?? 0]?.id ?? slots[0].id;
  }

  if (!state.selectedSlotId) {
    return ask("ask_slot_choice", `${state.customerName}, какой из предложенных вариантов вам удобнее: первый, второй или третий?`, state, slots);
  }

  if (!state.phone) {
    const slot = slots.find((candidate) => candidate.id === state.selectedSlotId);
    const trialPrice = slot ? getPrice(slot.direction, slot.branch).trial : undefined;
    const turnNow = state.turnIndex ?? 0;
    const mentionPrice = state.trialPriceMentionedAtTurn === undefined;
    if (mentionPrice && trialPrice) {
      state.trialPriceMentionedAtTurn = turnNow;
    }
    // Если в буфере уже есть частично надиктованные цифры — переспрашиваем иначе:
    // не «какой номер?» (звучит будто бот ничего не слышал), а «услышала [N] цифр, но номера
    // не хватает — повторите целиком».
    const buffered = (state.phoneDigitsBuffer ?? "").length;
    if (buffered >= 4) {
      const prefix = state.customerName ? `${state.customerName}, ` : "";
      return ask(
        "ask_phone",
        `${prefix}услышала ${buffered} ${pluralizeDigits(buffered)}, но номер не сложился. Продиктуйте номер ещё раз — можно с восьмёрки, плюс-семёрки или сразу с девятки.`,
        { ...state, phoneDigitsBuffer: "" }, // сбрасываем буфер — клиент диктует заново
        slots
      );
    }
    return ask(
      "ask_phone",
      variants.askPhone(
        state.customerName,
        slot ? formatSlotForBooking(slot) : undefined,
        trialPrice,
        { mentionPrice }
      ),
      state,
      slots
    );
  }

  if (!state.personalDataConsent) {
    if (isPositive(lower)) {
      state.personalDataConsent = true;
    } else {
      return ask("ask_consent", `Тогда закрепляю место. ${variants.askConsent()}`, state, slots);
    }
  }

  const selectedSlot = slots.find((candidate) => candidate.id === state.selectedSlotId);
  if (!selectedSlot) {
    return ask("handoff", "Похоже, это место уже заняли. Передам заявку администратору, чтобы подобрать ближайший удобный вариант.", state, slots);
  }

  const booking = await createBooking({
    customerName: state.customerName,
    phone: state.phone,
    age: state.age,
    direction: state.direction,
    branch: selectedSlot.branch,
    slotId: selectedSlot.id,
    source: "inbound_form",
    notes: `Автозапись из веб-диалога. Потребность: ${state.need ?? "не указана"}`,
    consent: {
      personalData: true,
      aiVoiceDisclosure: true,
      callRecording: false,
      crossBorderTransfer: true
    }
  });

  const branch = branches[selectedSlot.branch];
  return replyResult(
    "booked",
    `${state.customerName}, готово, я записала вас на пробное занятие — ${formatSlotTimeOnly(selectedSlot)} ${branchPrepositional(selectedSlot.branch)}, направление ${directionForSpeech(selectedSlot.direction)}. Адрес: ${branch.address}${branch.floor ? `, ${branch.floor}` : ""}. Пробное у нас по ${getPrice(selectedSlot.direction, selectedSlot.branch).trial} рублей, оплата на месте. Ждём вас!`,
    state,
    {
      booking,
      slots,
      context: {
        currentSlot: {
          ...selectedSlot,
          address: branch.address,
          floor: branch.floor
        },
        price: getPrice(selectedSlot.direction, selectedSlot.branch),
        notes: ["Это финальное подтверждение записи. Без лишних вопросов."]
      }
    }
  );
}

// На простых шагах brain не нужен — fallback уже хорошо сформулирован, а вызов Claude добавляет
// 800-1500мс латентности и расходует токены. Brain используем только на содержательных шагах,
// где гуманизация реально меняет дело: offer_solution, обработка возражений, booked-подтверждение,
// и редкие ask_need (требует чувствительной формулировки).
//
// ask_learner НЕ включён сюда: на этом шаге часто клиент только что приветствовал, и нужен
// brain, чтобы поздороваться в ответ и подхватить контекст. Skip-brain тут давал «робота»
// который мгновенно начинал допрашивать без приветствия.
const SIMPLE_ACTIONS_NO_BRAIN: ReadonlySet<SalesBrainAction> = new Set<SalesBrainAction>([
  "ask_name",
  "ask_age",
  "ask_branch",
  "ask_consent",
  "ask_phone",
  "ask_slot_choice"
]);

// Слова, которые точно НЕ имя — клиент произнёс их как обращение к боту или приветствие.
// Если такое попало в state.customerName — нужно сбросить и переспросить имя.
const NOT_A_NAME_BLACKLIST = new Set([
  "студия", "студио", "студию", "студий", "студии",
  "studio", "сто", "восемь",
  "школа", "школу", "школе", "школы",
  "озеро", "озере", "озера",
  "развилка", "развилке", "развилки",
  "оператор", "менеджер", "администратор",
  "бот", "ассистент", "помощник",
  "девушка", "женщина", "мужчина",
  "алло", "слушаю", "говорите", "здрасте", "здравствуйте", "привет",
  "тренер", "педагог", "клуб", "салон",
  // Слова-связки / междометия / вопросительные — часто ловятся как имя после "Здравствуйте, Х" или "Это Х?".
  "ну", "так", "вот", "это", "то", "там", "тут", "здесь",
  "где", "что", "как", "почему", "зачем", "кто", "куда", "когда", "сколько", "какой", "какая", "какие",
  "получается", "значит", "слушайте", "давайте", "извините", "простите"
]);

function dropFakeCustomerName(state: SalesDialogState): boolean {
  if (!state.customerName) return false;
  const lower = state.customerName.trim().toLowerCase();
  if (NOT_A_NAME_BLACKLIST.has(lower)) {
    state.customerName = undefined;
    state.customerGender = undefined;
    return true;
  }
  return false;
}

// Сигналы, что клиент сам не знает чего хочет и ждёт, что бот предложит.
// На таких репликах в ask_need бот должен взять инициативу, а не переспрашивать.
const CLIENT_GIVES_INITIATIVE = /(не\s+знаю|не\s+определил|без\s+понятия|без\s+разниц|посоветуй|подскажи|что\s+посовет|подберит|расскажите|перечислит|какие|что\s+у\s+вас|что\s+есть|популярн|хит|что\s+сейчас\s+попул|что\s+нравится\s+детям|вы\s+посовет|подберите)/i;

export function clientGivesInitiative(message: string): boolean {
  return CLIENT_GIVES_INITIATIVE.test(message);
}

async function humanizeSalesReply(input: {
  action: SalesBrainAction;
  customerMessage: string;
  fallbackReply: string;
  state: SalesBrainState;
  slots?: Slot[];
  context?: ReplyContext;
}): Promise<{ reply: string; source: string; cacheUsage?: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number } }> {
  // ЖЁСТКИЙ режим: brain включается ТОЛЬКО когда клиент дал явный сигнал, требующий
  // нешаблонной реакции — задал вопрос, выразил возражение, попросил инициативу,
  // или спросил конкретный факт (цену/адрес/преподавателя). На стандартных ходах
  // FSM-fallback используется как есть. Это убирает класс багов «brain выдумал факт»
  // (фитнес, классика, две опции сразу и т.п.) — потому что brain просто не вызывается.
  const msg = input.customerMessage.toLowerCase();
  const customerAskedSomething = /\?/.test(input.customerMessage) || isClarifyingUserQuestion(input.customerMessage);
  const customerGivesInitiative = CLIENT_GIVES_INITIATIVE.test(msg);
  const customerObjected = /(?:не\s+(?:очень\s+|особо\s+|совсем\s+|сильно\s+|шибко\s+)?(?:хоч|нрав|подход|интересн|пойд(?:ет|ёт))|не\s+(?:для\s+нас|моё|мое)|подумаю|подумать|сомнева|дорог|дешев|пока\s+не|не\s+уверен)/i.test(msg);
  const customerAskedSpecific = isPriceQuestion(msg) || isAddressQuestion(msg) || isTeacherQuestion(msg);
  const brainNeeded = customerAskedSomething || customerGivesInitiative || customerObjected || customerAskedSpecific;
  if (!brainNeeded) {
    return { reply: input.fallbackReply, source: "skip_brain_no_signal" };
  }

  const brain = await generateSalesReply({
    action: input.action,
    customerMessage: input.customerMessage,
    fallbackReply: input.fallbackReply,
    state: input.state,
    slots: input.slots?.slice(0, 3).map((slot) => ({
      weekday: slot.weekday,
      time: slot.time,
      branch: slot.branch,
      direction: slot.direction,
      level: slot.level,
      teacher: slot.teacher
    })),
    context: {
      currentSlot: input.context?.currentSlot,
      price: input.context?.price,
      notes: [
        ...(input.context?.notes ?? []),
        ...buildActionNotes(input.action, input.state, input.customerMessage)
      ]
    }
  });

  const candidateReply = cleanHumanReply(brain.reply || input.fallbackReply);
  const validatedReply = isAcceptableBrainReply(input.action, candidateReply, input.customerMessage, input.state, input.fallbackReply) ? candidateReply : input.fallbackReply;
  // Locked-question mode: вопрос всегда от FSM, чтобы brain не подменял план.
  // Brain пишет только подводку (acknowledgment), а финальный вопрос приклеивается из fallback.
  // Это убирает класс багов «brain сам спросил не то» — например, «контемп или классику?»
  // вместо «контемп — попробуем?», или «поактивнее/поспокойнее» после уже выбранного direction.
  const reply = lockFsmQuestion(input.action, validatedReply, input.fallbackReply, input.state);
  return { reply, source: brain.source, cacheUsage: brain.cacheUsage };
}

/**
 * Заменяет финальный вопрос brain'а на финальный вопрос FSM. Brain остаётся источником
 * подводки/контекста (acknowledgment), но какой именно вопрос задать клиенту — решает FSM.
 *
 * Случаи без вопроса (booked, handoff) проходят без изменений.
 *
 * Особый случай ask_direction_confirm: эта стадия больше всего страдает от дрейфа brain
 * (предложение двух направлений сразу, замена direction'а на собственный вариант), поэтому
 * здесь возвращаем fallback целиком — никакой подводки от brain не нужно.
 */
function lockFsmQuestion(
  action: SalesBrainAction,
  brainReply: string,
  fallbackReply: string,
  state: SalesBrainState
): string {
  if (action === "booked" || action === "handoff") return brainReply;
  // На ask_direction_confirm brain слишком часто подсовывает «или», «классика», другие
  // направления — поэтому используем план FSM как есть.
  if (action === "ask_direction_confirm") return fallbackReply;

  const fsmQuestion = extractFinalQuestion(fallbackReply);
  if (!fsmQuestion) return brainReply;
  // Если у brain нет осмысленной подводки — используем fallback как есть.
  const brainLeadIn = stripFinalQuestion(brainReply).trim();
  if (brainLeadIn.length < 8) return fallbackReply;

  let result = brainLeadIn;
  if (!/[.!?]$/u.test(result)) result += ".";
  result += " " + fsmQuestion.trim();

  // Дедуп обращения по имени: brain мог начать «Андрей, поняла.», и FSM-вопрос
  // тоже начинается с «Андрей,». Убираем второе вхождение.
  const name = state.customerName;
  if (name) {
    const namePrefix = `${name},`;
    const first = result.indexOf(namePrefix);
    if (first !== -1) {
      const second = result.indexOf(namePrefix, first + namePrefix.length);
      if (second !== -1) {
        result = result.slice(0, second) + result.slice(second + namePrefix.length).trimStart();
      }
    }
  }
  return result;
}

function extractFinalQuestion(text: string): string | null {
  // Берём ПОСЛЕДНЮЮ группу символов от точки/!/? до финального «?».
  const match = text.match(/(?:^|[.!?])\s*([^.!?]+\?)\s*$/u);
  return match ? match[1].trim() : null;
}

function stripFinalQuestion(text: string): string {
  return text.replace(/[^.!?]+\?\s*$/u, "");
}

function buildActionNotes(action: SalesBrainAction, state: SalesBrainState, customerMessage: string): string[] {
  const notes: string[] = [];
  const explicitGenderedStyle = customerExplicitlyAskedForGenderedStyle(customerMessage, state.need);

  notes.push(
    "Этот ответ потом озвучит ElevenLabs. Пиши коротко, простым русским языком и без слов с неочевидным ударением.",
    "Не используй слова вроде 'большая', 'большое', 'большой', если можно сказать яснее: 'много', 'побольше', 'крупный' или иначе по-простому."
  );

  // Customer profile guidance — добавляется одним предложением, чтобы не перегружать промпт.
  const fullState = state as SalesDialogState;
  if (isFlagOn("useCustomerProfile") && fullState.customerProfile && fullState.customerProfile !== "unknown") {
    notes.push(profileGuidanceForBrain(fullState.customerProfile as CustomerProfile));
  }

  // КРИТИЧНО: hard reminder для brain про пол ребёнка. Иначе Claude путает «сын/дочка»,
  // даже если в state есть child_gender. Дублирую сюда, в action notes — это последний
  // слой, который brain видит ближе к outputу.
  if (fullState.learnerType === "child" && fullState.childGender === "girl") {
    notes.push("ВНИМАНИЕ: ребёнок — ДЕВОЧКА. Запрещены слова «сын», «сыну», «сына», «мальчик», «мальчику». Используй только «дочка», «дочке», «дочери», «девочка», «ей», «её».");
  } else if (fullState.learnerType === "child" && fullState.childGender === "boy") {
    notes.push("ВНИМАНИЕ: ребёнок — МАЛЬЧИК. Запрещены слова «дочка», «дочке», «дочери», «девочка», «девочке». Используй только «сын», «сыну», «сына», «мальчик», «ему», «его».");
  } else if (fullState.learnerType === "child") {
    // childGender ещё не известен — НЕЛЬЗЯ угадывать пол. Используй нейтральные формы.
    notes.push("ВНИМАНИЕ: пол ребёнка пока неизвестен. Запрещены слова «сын», «сыну», «дочка», «дочке», «мальчик», «девочка». Используй только нейтральное «ребёнок», «ребёнку», «ему/ей» избегай.");
  }

  // Если есть отвергнутые направления — напомнить brain'у не предлагать их.
  if (fullState.rejectedDirections && fullState.rejectedDirections.length > 0) {
    notes.push(`Клиент уже ОТКАЗАЛСЯ от: ${fullState.rejectedDirections.join(", ")}. Не предлагай их повторно, не упоминай как опцию.`);
  }

  // Long-term memory: prior contact summary
  if (isFlagOn("useLongTermMemory") && fullState.previousContactSummary) {
    notes.push(`Прошлый контакт клиента: ${fullState.previousContactSummary}. Используй естественно, не повторяй вопросы, на которые уже знаешь ответ.`);
  }

  // Success-story hint — пробрасываем как подсказку «если уместно — упомяни».
  // НЕ передаём, если направление уже было описано в одной из последних 2 реплик бота —
  // иначе brain снова разворачивает описание и клиент слышит то же самое второй раз подряд.
  const turnNow = fullState.turnIndex ?? 0;
  const recentlyDescribed =
    fullState.directionDescribedAtTurn !== undefined &&
    turnNow - fullState.directionDescribedAtTurn <= 2;
  if (isFlagOn("useSuccessStories") && fullState.relevantStoryHint && !recentlyDescribed) {
    notes.push(`Если уместно, можешь органично вплести в ответ короткую жизненную историю (НЕ обязательно): «${fullState.relevantStoryHint}». Не цитируй дословно, пересказывай естественно. Не используй на технических шагах.`);
  }
  if (recentlyDescribed) {
    notes.push(`Ты уже описывала направление "${fullState.direction}" буквально пару реплик назад — НЕ повторяй описание ("активный/силовой/плавный/связки/трюки" и подобное). Переходи к сути: место, время, запись.`);
  }

  // Supervisor verdict — если есть и свежий
  if (isFlagOn("useStrategySupervisor") && fullState.supervisorVerdict) {
    const v = fullState.supervisorVerdict;
    notes.push(`Стратегический контекст: «теплота» клиента ≈ ${v.warmth.toFixed(2)}${v.mainObjection ? `, главное возражение: ${v.mainObjection}` : ""}. Совет: ${v.advice}`);
  }

  // Контекст прерывания: если клиент перебил предыдущую реплику, brain должен это учесть.
  const interruption = fullState.lastInterruption;
  if (interruption?.previousReply) {
    notes.push(
      `Клиент перебил предыдущую реплику. Ассистент успел произнести: «${interruption.spokenSoFar}». Не успел: «${interruption.unsaidPart}». Учти новую реплику клиента и продолжи разговор естественно — не повторяй то, что уже сказала, но если что-то важное (время, цена, филиал) не успели — упомяни кратко.`
    );
  }

  if (!explicitGenderedStyle) {
    notes.push(
      "Не используй слова 'женственное', 'женственность', 'поженственнее', 'мужественное', 'для девушек' или 'для мужчин'. Держись нейтральных формулировок."
    );
  }

  if (state.customerGender === "male") {
    notes.push("Клиент, скорее всего, мужчина. Не предлагай варианты через женственность и не уводи разговор в стереотипные гендерные формулировки.");
  } else if (state.customerGender === "female") {
    notes.push("Даже если клиент, скорее всего, женщина, не уводи разговор автоматически в тему женственности. Сначала используй нейтральный язык.");
  }

  switch (action) {
    case "ask_name":
      notes.push("В первой реплике обязательно представь компанию: упомяни Studio 108. Например: 'Здравствуйте! Это Studio 108.' Без этого ответ не принимаю.");
      return notes;
    case "ask_need":
      notes.push(
        "Не давай длинный каталог направлений. Лучше мягко проясни цель клиента.",
        "Не спрашивай про онлайн, индивидуально, аренду или формат занятий."
      );
      notes.push("Говори очень просто, как администратор в переписке. Не используй слова вроде 'уверенность', 'раскрепоститься', 'самовыражение', 'выразительность' и другие психологические формулировки, если можно сказать проще.");
      if (state.customerGender === "male" && !explicitGenderedStyle) {
        notes.push("Если клиент просто хочет танцевать и не назвал направление, спроси по-человечески: хочется что-то поактивнее, что-то спокойнее, или уже есть конкретное направление.");
      }
      return notes;
    case "offer_solution":
      notes.push(
        "Если есть слот, предложи только один лучший вариант и закончи одним коротким вопросом.",
        "Не нужно упоминать уровень группы, если без этого можно обойтись."
      );
      return notes;
    case "ask_learner":
      if (isPriceQuestion(customerMessage.toLowerCase())) {
        notes.push("Клиент спросил цену. Сохрани в ответе короткий факт о стоимости пробного, а потом мягко уточни, подбираем занятие для клиента или для ребенка.");
      }
      return notes;
    case "ask_branch":
      if (isAddressQuestion(customerMessage.toLowerCase())) {
        notes.push("Клиент спросил, где вы находитесь. Коротко назови основные филиалы или районы, а потом спроси, какой район удобнее.");
      }
      notes.push("Спроси только про удобный район или филиал.");
      return notes;
    case "ask_direction_confirm": {
      const msgLower = customerMessage.toLowerCase();
      const asksAboutDirection =
        /(?:что\s+(?:такое|это)|это\s+что|расскаж\w*\s+про|поясн\w*\s+про|какой\s+это|объясн)/i.test(msgLower);
      const pending = (fullState as SalesDialogState)._pendingDirection;
      if (asksAboutDirection && pending) {
        notes.push(
          `Клиент спрашивает, что такое направление "${pending}". Сначала коротко (одно предложение) объясни, что это за танец. Сразу после — мягко спроси, попробуем ли это направление. НЕ переходи к филиалу или времени, пока клиент явно не подтвердит интерес к направлению.`
        );
      } else {
        notes.push(
          "Предложи направление и заверши коротким вопросом «попробуем?» / «как вам такой вариант?». Не упоминай филиал, время и цену."
        );
      }
      notes.push("Используй обращение к конкретному ребёнку (сыну/дочке/ребёнку), а не обобщения «для мальчиков/девочек».");
      return notes;
    }
    case "ask_phone":
      notes.push("Коротко попроси номер телефона для записи без лишнего текста.");
      return notes;
    case "ask_consent":
      notes.push("Попроси разрешение сохранить данные просто и спокойно.");
      return notes;
    case "booked":
      notes.push("Подтверди запись по-человечески и не задавай вопрос в конце.");
      return notes;
    case "handoff":
      notes.push("Спокойно объясни, что дальше подключится администратор.");
      return notes;
    default:
      return notes;
  }
}

function isAcceptableBrainReply(
  action: SalesBrainAction,
  reply: string,
  customerMessage: string,
  state: SalesBrainState,
  fallbackReply: string
): boolean {
  const lower = reply.toLowerCase();
  const fallbackLower = fallbackReply.toLowerCase();
  const messageLower = customerMessage.toLowerCase();
  const explicitGenderedStyle = customerExplicitlyAskedForGenderedStyle(customerMessage, state.need);

  if (containsAny(lower, ["онлайн", "индивидуаль", "аренд"])) {
    return false;
  }

  if (!explicitGenderedStyle && containsAny(lower, ["женствен", "поженствен", "мужествен", "для девушек", "для мужчин"])) {
    return false;
  }

  if (!explicitGenderedStyle && state.customerGender === "male" && containsAny(lower, ["леди", "lady style"])) {
    return false;
  }

  if (containsBannedSpeechWords(lower)) {
    return false;
  }

  if (action === "ask_name" && !containsAny(lower, ["studio", "студи", "108", "сто восемь"])) {
    return false;
  }

  // Brain не должен начинать ответ с самоподтверждения / благодарности.
  // Это излишне ("Спасибо за что?") и часто звучит роботом.
  if (action !== "booked" && /^[А-ЯЁ][а-яё]+,\s*(?:поняла|ага|так[,.]|хорошо|спасибо)[,.]?/iu.test(reply)) {
    return false;
  }
  if (action !== "booked" && /^(?:Поняла|Ага|Так,|Хорошо|Спасибо|Благодарю)[,.\s]/u.test(reply)) {
    return false;
  }

  // Brain не должен задавать ask_need-вопрос («поактивнее/поспокойнее», «что вам ближе»,
  // «уже есть конкретное направление»), если FSM уже вышел из стадии ask_need.
  // Случай из лога: клиент принял предложенное направление, FSM ушёл на ask_branch,
  // а brain зациклил вопрос про активность и проигнорировал план FSM.
  if (action !== "ask_need") {
    const looksLikeAskNeedQuestion =
      /(?:поактивн|поспокойн|более\s+актив|более\s+спок)/i.test(lower) ||
      /(?:что\s+(?:вам|больше)\s+(?:нравится|ближе|подходит|интересно|хочется))/i.test(lower) ||
      /(?:уже\s+есть\s+конкретн\w*\s+направ|конкретн\w*\s+направление\s+в\s+голове)/i.test(lower) ||
      /(?:вам\s+ближе\s+(?:что-то|что\s+то)\s+поактив|вам\s+ближе\s+(?:что-то|что\s+то)\s+поспок)/i.test(lower);
    if (looksLikeAskNeedQuestion) {
      return false;
    }
  }

  // Per-branch schema check: каждый филиал, упомянутый в fallback, должен сохраниться в reply.
  // Иначе brain превращает "у озера" в "Зерно", "Школьная" в "Шольная" и т.п.
  const branchPatterns: Array<RegExp> = [
    /(?:озер|псекупск)/i,        // «Озеро» / «у озера» / «Псекупская»
    /развилк/i,                   // «Развилка»
    /(?:первой\s+школ|школьн)/i  // «возле первой школы» / «Школьная»
  ];
  for (const pattern of branchPatterns) {
    if (pattern.test(fallbackReply) && !pattern.test(reply)) {
      return false;
    }
  }
  // Запрет на словесный мусор от brain ("Зерно", "Зера", "Зерне" и т.п.) — таких слов в нашем словаре нет.
  // Использую lookbehind/lookahead с явным русским алфавитом, потому что \b в JS не работает с кириллицей.
  const RU_BOUND = "(?<![а-яёА-ЯЁ])";
  const RU_BOUND_END = "(?![а-яёА-ЯЁ])";
  const garbagePatterns = [
    new RegExp(`${RU_BOUND}[ЗзСс]ерн[оаеум]${RU_BOUND_END}`, "u"),
    new RegExp(`${RU_BOUND}[Зз]ер[аеоуы]${RU_BOUND_END}`, "u"),
    new RegExp(`${RU_BOUND}[Шш]ольн[аяойуюе]${RU_BOUND_END}`, "u"),  // «Шольная» вместо «Школьная»
    new RegExp(`${RU_BOUND}[Рр]азв[ае]лк[ауеио]${RU_BOUND_END}`, "u")  // «Развалка»
  ];
  for (const pattern of garbagePatterns) {
    if (pattern.test(reply)) return false;
  }

  // Reply не должен переспрашивать факты, которые уже есть в state.
  if (state.customerName && /\bкак\s+(?:к\s+)?вам\s+(?:можно\s+)?обращ/i.test(reply)) {
    return false;
  }
  if (state.age && /\bсколько\s+(?:вам|ему|ей|ребен|ребён)/i.test(reply)) {
    return false;
  }
  if (state.branch && /(?:какой|где)\s+(?:вам\s+)?(?:район|филиал)/i.test(reply)) {
    return false;
  }
  if (state.phone && /\bподскажите\s+(?:номер|телефон)/i.test(reply)) {
    return false;
  }
  if (state.learnerType && state.learnerType !== "unknown" && /для\s+(?:вас|себя)\s+или\s+для\s+ребен/i.test(reply)) {
    return false;
  }

  // КРИТИЧНО: пол ребёнка. Если в state.childGender = girl, а reply содержит «сын/мальчик» —
  // это явная hallucination brain. Отвергаем и используем fallback.
  const childGender = (state as SalesDialogState).childGender;
  const learnerType = (state as SalesDialogState).learnerType;
  if (childGender === "girl" && /(?<![а-яёa-z])(?:сын(?:у|а|ом|е|ы)?|мальчик(?:у|а|ом|и|ам|ов|е)?)(?![а-яёa-z])/iu.test(reply)) {
    return false;
  }
  if (childGender === "boy" && /(?<![а-яёa-z])(?:дочк(?:а|и|е|у|ой)?|девочк(?:а|и|е|у|ой|и|ами)?|дочер(?:и|ью|ей|ям))(?![а-яёa-z])/iu.test(reply)) {
    return false;
  }
  // Если пол ребёнка не установлен — brain не имеет права использовать «сын» / «дочка» / «мальчик» / «девочка».
  if (learnerType === "child" && (childGender === undefined || childGender === "unknown")) {
    const genderedRef = /(?<![а-яёa-z])(?:сын(?:у|а|ом|е|ы)?|дочк(?:а|и|е|у|ой)?|мальчик(?:у|а|ом|и|ам|ов|е)?|девочк(?:а|и|е|у|ой|и|ами)?|дочер(?:и|ью|ей|ям))(?![а-яёa-z])/iu;
    if (genderedRef.test(reply)) {
      return false;
    }
  }

  // Если direction из rejectedDirections упомянут в reply как предложение — отвергаем.
  const rejected = (state as SalesDialogState).rejectedDirections ?? [];
  for (const rejectedDir of rejected) {
    // ищем алиасы этого direction
    const aliasesSimple: Record<string, RegExp> = {
      "Hip-hop":    /(?<![а-яёa-z])хип[-\s]?хоп(?![а-яёa-z])/iu,
      "Breakdance": /(?<![а-яёa-z])(?:брейк(?:данс)?|break)(?![а-яёa-z])/iu,
      "Contemporary": /(?<![а-яёa-z])(?:контемп(?:орари)?|contemporary)(?![а-яёa-z])/iu,
      "Йога":       /(?<![а-яёa-z])йог[ауеи](?![а-яёa-z])/iu,
      "Zumba":      /(?<![а-яёa-z])(?:зумб[ауы]|zumba)(?![а-яёa-z])/iu,
      "Lady style": /(?<![а-яёa-z])(?:леди\s*стайл|lady\s*style)(?![а-яёa-z])/iu,
      "Salsa/Bachata": /(?<![а-яёa-z])(?:сальс[ауы]|бачат[ауы])(?![а-яёa-z])/iu,
      "Стрип-пластика": /(?<![а-яёa-z])стрип(?![а-яёa-z])/iu,
      "K-pop":      /(?<![а-яёa-z])(?:k-?pop|кей[-\s]?поп|кпоп)(?![а-яёa-z])/iu,
      "Jazz funk":  /(?<![а-яёa-z])(?:джаз(?:[-\s]фанк)?|jazz)(?![а-яёa-z])/iu,
      "Восточные танцы": /(?<![а-яёa-z])восточн[аыеи][а-яё]*\s+танц/iu,
      "Детская хореография": /(?<![а-яёa-z])(?:детская\s+хореограф|хореограф)/iu
    };
    const pattern = aliasesSimple[rejectedDir];
    if (pattern && pattern.test(reply)) {
      return false;
    }
  }

  // Banned promises: бот не имеет права обещать скидки и стопроцентные результаты.
  if (/\b(?:гаранти|обяз[ау]тельно\s+(?:понравится|подойд[её]т|поможет)|сто\s+процент|100\s*%|акция|скидк|бесплатн)/i.test(reply)) {
    return false;
  }

  // Shadow-проверка: в перспективе хотим запретить ещё ряд формулировок.
  // Сейчас — только лог в shadow-events. Когда соберём данных — включим флаг.
  const extendedBan = /\b(?:точно подойд|стопроцентно|самое лучше(?:е|го)|идеально\s+вам)/i;
  if (extendedBan.test(reply)) {
    if (isFlagOn("shadowSchemaValidation")) {
      return false;
    }
    void recordShadowEvent({
      flag: "shadowSchemaValidation",
      rule: "extended_banned_promises",
      outcome: "would_block",
      context: { reply: reply.slice(0, 200), action }
    });
  }

  // Schema validation: проверяем что цена в reply согласована со state/slots.
  const priceMatch = reply.match(/(\d{3,5})\s*(?:руб|₽|р\b)/i);
  if (priceMatch) {
    const replyPrice = Number(priceMatch[1]);
    const allowedPrices = collectAllowedPrices(state, fallbackReply);
    if (allowedPrices.length && !allowedPrices.includes(replyPrice)) {
      return false;
    }
  }

  if (/\b(рублей|рубля|рубль|стоит)\s+\1\b/i.test(lower)) {
    return false;
  }

  if (isPriceQuestion(messageLower) && containsAny(fallbackLower, ["руб", "стоит", "цена"]) && !containsAny(lower, ["руб", "стоит", "цена"])) {
    return false;
  }

  if (
    isAddressQuestion(messageLower) &&
    containsAny(fallbackLower, ["развил", "озер", "первой школ"]) &&
    !containsAny(lower, ["развил", "озер", "первой школ"])
  ) {
    return false;
  }

  if (["ask_name", "ask_learner", "ask_need", "ask_age", "ask_branch", "offer_solution", "ask_slot_choice", "ask_phone", "ask_consent"].includes(action) && !reply.includes("?")) {
    return false;
  }

  return true;
}

/** «1 цифру», «2 цифры», «5 цифр» — корректное склонение. */
function pluralizeDigits(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return "цифр";
  if (mod10 === 1) return "цифру";
  if (mod10 >= 2 && mod10 <= 4) return "цифры";
  return "цифр";
}

/**
 * Извлекает цифры из произвольной реплики и аккумулирует с предыдущими попытками
 * (state.phoneDigitsBuffer). Возвращает нормализованный российский номер вида
 * "+7XXXXXXXXXX", когда в буфере достаточно цифр, иначе undefined.
 *
 * Принимает все встречающиеся варианты диктовки:
 *  - "+7 925 123 45 67", "8 925 1234567", "(925) 123-45-67"
 *  - "восемь девятьсот двадцать пять..." и "два два шесть пять..." (STT часто оставляет слова)
 *  - "9 2 5  1 2 3  4 5  6 7" (очень медленно с пробелами между цифрами)
 *  - кусками по нескольким ходам: "восемь девятьсот", "двадцать пять...", и т.д.
 */
function mergePhoneDigits(state: SalesDialogState, original: string): string | undefined {
  // Считаем релевантной только речь на стадии ask_phone — иначе цифры из адресов,
  // возрастов и времени слотов попадут в номер.
  const onPhoneStage = state.stage === "ask_phone" || state.stage === "ask_consent";

  // Быстрый путь: классический формат — сразу извлекаем целиком.
  const direct = original.match(/(?:\+\s*7|8)[\d\s().\-]{9,}/);
  if (direct) {
    const digits = direct[0].replace(/\D/g, "");
    if (digits.length >= 10) {
      const normalized = normalizeRussianPhone(digits);
      if (normalized) {
        state.phoneDigitsBuffer = undefined;
        return normalized;
      }
    }
  }

  if (!onPhoneStage) return undefined;

  // Медленный путь: тащим ВСЕ цифры (и литералы, и проговорённые словами) и копим в буфер.
  const literalDigits = original.replace(/\D/g, "");
  const spelledDigits = extractRussianNumeralWordsAsDigits(original);
  const incoming = `${literalDigits}${spelledDigits}`;
  if (!incoming) return undefined;

  const buffer = `${state.phoneDigitsBuffer ?? ""}${incoming}`;
  // Защита от переполнения — храним не больше 20 цифр (хватит на любой формат).
  state.phoneDigitsBuffer = buffer.slice(-20);

  const normalized = normalizeRussianPhone(state.phoneDigitsBuffer);
  if (normalized) {
    state.phoneDigitsBuffer = undefined;
    return normalized;
  }
  return undefined;
}

/**
 * Конвертирует русские числительные в реплике в строку цифр.
 * Поддерживает диктовку как одиночными цифрами («два два шесть пять три»),
 * так и группами («восемь девятьсот двадцать пять», «сто двадцать три»).
 * Ноль и «плюс семь» тоже считаем.
 */
export function _testExtractRussianNumeralWordsAsDigits(text: string): string {
  return extractRussianNumeralWordsAsDigits(text);
}
export function _testNormalizeRussianPhone(digits: string): string | undefined {
  return normalizeRussianPhone(digits);
}

function extractRussianNumeralWordsAsDigits(text: string): string {
  const SINGLE: Record<string, number> = {
    "ноль": 0, "нуль": 0,
    "один": 1, "одну": 1, "одна": 1, "первый": 1,
    "два": 2, "две": 2, "двойка": 2,
    "три": 3, "тройка": 3,
    "четыре": 4, "четверка": 4, "четвёрка": 4,
    "пять": 5, "пятёрка": 5, "пятерка": 5,
    "шесть": 6, "шестёрка": 6, "шестерка": 6,
    "семь": 7, "семёрка": 7, "семерка": 7,
    "восемь": 8, "восьмёрка": 8, "восьмерка": 8,
    "девять": 9, "девятка": 9
  };
  const TEENS: Record<string, number> = {
    "десять": 10, "одиннадцать": 11, "двенадцать": 12, "тринадцать": 13,
    "четырнадцать": 14, "пятнадцать": 15, "шестнадцать": 16,
    "семнадцать": 17, "восемнадцать": 18, "девятнадцать": 19
  };
  const TENS: Record<string, number> = {
    "двадцать": 20, "тридцать": 30, "сорок": 40, "пятьдесят": 50,
    "шестьдесят": 60, "семьдесят": 70, "восемьдесят": 80, "девяносто": 90
  };
  const HUNDREDS: Record<string, number> = {
    "сто": 100, "двести": 200, "триста": 300, "четыреста": 400,
    "пятьсот": 500, "шестьсот": 600, "семьсот": 700, "восемьсот": 800, "девятьсот": 900
  };

  // Pad-zero нужен только для младших разрядов в трёхзначной группе: «девятьсот двадцать пять» → "925",
  // а вот «пять» в начале → "5", не "005". Поэтому собираем не общее число, а группами.
  const tokens = text.toLowerCase().replace(/[^а-яё+\s]/g, " ").split(/\s+/).filter(Boolean);
  let out = "";
  let group = 0;          // сумма текущей трёхзначной группы (h+t+u)
  let groupHasParts = false;
  let pendingPlus = false;

  const flushGroup = () => {
    if (groupHasParts) {
      // Решаем — это компактная группа (девятьсот двадцать пять) или одиночная цифра.
      if (group >= 100) out += String(group).padStart(3, "0");
      else if (group >= 10) out += String(group).padStart(2, "0");
      else out += String(group);
    }
    group = 0;
    groupHasParts = false;
  };

  for (const raw of tokens) {
    // нормализуем падежи: «двух» → «два», «пяти» → «пять», и т.п. - упрощённая регистрация ключевых форм.
    const t = raw
      .replace(/^плюс$/, "+")
      .replace(/^одного$|^одному$|^одним$|^одном$/, "один")
      .replace(/^двух$|^двум$|^двумя$/, "два")
      .replace(/^трёх$|^трех$|^трём$|^трем$|^тремя$/, "три")
      .replace(/^четырёх$|^четырех$|^четырём$|^четырем$|^четырьмя$/, "четыре")
      .replace(/^пяти$|^пятью$/, "пять")
      .replace(/^шести$|^шестью$/, "шесть")
      .replace(/^семи$|^семью$/, "семь")
      .replace(/^восьми$|^восьмью$|^восемью$/, "восемь")
      .replace(/^девяти$|^девятью$/, "девять");

    if (t === "+") { pendingPlus = true; continue; }

    if (HUNDREDS[t] !== undefined) {
      // если уже начали группу с сотен — флашим старую
      if (group >= 100) flushGroup();
      group += HUNDREDS[t];
      groupHasParts = true;
      continue;
    }
    if (TENS[t] !== undefined) {
      // если в группе уже есть десятки — флашим
      if ((group % 100) >= 10) flushGroup();
      group += TENS[t];
      groupHasParts = true;
      continue;
    }
    if (TEENS[t] !== undefined) {
      if ((group % 100) !== 0) flushGroup();
      group += TEENS[t];
      groupHasParts = true;
      continue;
    }
    if (SINGLE[t] !== undefined) {
      // Если последняя цифра единиц уже была — новая цифра уходит в отдельную группу.
      if ((group % 10) !== 0 || (group !== 0 && group % 10 === 0 && SINGLE[t] === 0 && group >= 10)) {
        flushGroup();
      }
      // Если «плюс семь» — пишем как 7 (нормализатор телефонов потом сам поймёт +7)
      if (pendingPlus && SINGLE[t] === 7 && !groupHasParts) {
        out += "7";
        pendingPlus = false;
        continue;
      }
      group += SINGLE[t];
      groupHasParts = true;
      // Одиночные цифры подряд — каждая своя группа. Флашим сразу.
      flushGroup();
      continue;
    }
    // Слово не относится к числительным — флашим текущую группу.
    flushGroup();
    pendingPlus = false;
  }
  flushGroup();
  return out;
}

function normalizeRussianPhone(digitsRaw: string): string | undefined {
  const digits = digitsRaw.replace(/\D/g, "");
  if (digits.length < 10) return undefined;

  // Берём ПОСЛЕДНИЕ 10–11 цифр: если клиент сказал лишние числа в начале (например,
  // повторил «один» от слова «один номер»), они не сломают парс.
  // Случаи:
  //  - 11 цифр, начинаются на 7 или 8 → код страны → +7XXXXXXXXXX
  //  - 10 цифр, начинаются на 9 → мобильный без префикса → +7XXXXXXXXXX
  //  - больше 11 → берём последние 11 (если начинаются на 7/8) или последние 10 (если на 9).
  const last11 = digits.slice(-11);
  if (last11.length === 11 && (last11.startsWith("7") || last11.startsWith("8"))) {
    return `+7${last11.slice(1)}`;
  }
  const last10 = digits.slice(-10);
  if (last10.length === 10 && last10.startsWith("9")) {
    return `+7${last10}`;
  }
  // Иногда STT теряет ведущую "8" — но клиент явно надиктовал 10 цифр другого региона.
  // Принимаем 10 цифр как есть, добавляя +7 (best-effort).
  if (digits.length === 10) {
    return `+7${digits}`;
  }
  // 11 цифр, но не начинается на 7/8 — на всякий случай добавляем +7 к последним 10,
  // если они начинаются на 9.
  if (digits.length >= 11) {
    const tail10 = digits.slice(-10);
    if (tail10.startsWith("9")) return `+7${tail10}`;
  }
  return undefined;
}

function collectAllowedPrices(state: SalesBrainState, fallback: string): number[] {
  const prices = new Set<number>();
  const fallbackNumbers = fallback.match(/\d{3,5}/g);
  if (fallbackNumbers) for (const value of fallbackNumbers) prices.add(Number(value));
  if (state.direction) {
    const sample = getPrice(state.direction, state.branch);
    if (sample.trial) prices.add(sample.trial);
    if (sample.single) prices.add(sample.single);
    if (sample.subscription) prices.add(sample.subscription);
  }
  return [...prices];
}

async function mergeExtractedFields(state: SalesDialogState, lower: string, original: string) {
  const name = extractName(original, state.stage);
  let extractedName = false;
  if (name && !isNotAName(name)) {
    state.customerName = capitalize(name);
    state.customerGender = inferGenderByName(state.customerName);
    extractedName = true;
  }

  // Phone extraction — терпимый к разным форматам диктовки и медленной/быстрой речи.
  // Сценарии: "+7 925 ...", "8 925 ...", "9 2 5 ...", "восемь девятьсот..." (STT уже отдаёт цифры),
  // и кейс с диктовкой по частям через несколько ходов (буферим цифры между turn'ами).
  let extractedPhone = false;
  {
    const phoneResult = mergePhoneDigits(state, original);
    if (phoneResult) {
      state.phone = phoneResult;
      extractedPhone = true;
    }
  }

  let age = parseAge(lower);
  if (!age && state.stage === "ask_age") {
    const fallbackDigits = lower.match(/(?<!\d)(\d{1,2})(?!\d)/)?.[1];
    if (fallbackDigits) {
      const candidate = Number(fallbackDigits);
      if (candidate >= 2 && candidate <= 99) age = candidate;
    }
  }
  let extractedAge = false;
  if (age) {
    state.age = age;
    extractedAge = true;
  }

  const branch = detectBranch(lower);
  if (branch) {
    state.branch = branch;
  }

  const direction = detectDirection(lower);
  if (direction) {
    // Не выставляем direction молча, если клиент СПРАШИВАЕТ про него:
    //   «А что такое брейк-данс?», «расскажите про йогу?», «йога это что?».
    // Иначе бот считает, что клиент выбрал направление, и пропускает ask_direction_confirm.
    const isClarifyAboutDirection =
      isClarifyingUserQuestion(original) ||
      /(?:что\s+(?:такое|это)|это\s+что|расскаж\w*\s+про|поясн\w*\s+про|какой\s+это)/i.test(lower);
    if (!isClarifyAboutDirection) {
      state.direction = direction;
    } else {
      // Сохраняем как pending: бот должен ответить «X — это…» и спросить «попробуем?».
      state._pendingDirection = direction;
    }
  }

  const cleanedLower = lower.replace(/[.!?,]+/g, "").trim();
  const greetingPhrases = ["здравствуйте", "здрасте", "здрасьте", "добрый день", "добрый вечер", "доброе утро", "привет", "приветик", "приветствую", "здарова", "хай", "хеллоу", "алло", "аллё"];
  const isPureGreeting = greetingPhrases.some((p) => cleanedLower === p || cleanedLower.startsWith(`${p} `) && cleanedLower.split(/\s+/).length <= 2);
  const isCatalogRequest = /\b(?:что\s+(?:у\s+вас\s+)?есть|что\s+(?:можете|может)\s+предлож|какие\s+(?:есть|у\s+вас|варианты|направлен)|расскажите|перечислите|какие\s+направлен)/i.test(lower);

  const isLikelyNeed =
    lower.length > 8 &&
    !extractedPhone &&
    !(extractedAge && lower.length < 12) &&
    !isPureGreeting &&
    !isCatalogRequest &&
    !["здравствуйте", "добрый день", "привет", "да", "нет", "согласна", "согласен"].includes(cleanedLower) &&
    (!lower.endsWith("?") || hasClearNeed(lower) || Boolean(direction)) &&
    !isPriceQuestion(lower) &&
    !isAddressQuestion(lower) &&
    !isTeacherQuestion(lower) &&
    (!extractedName || hasClearNeed(lower) || Boolean(direction));

  if (isLikelyNeed && (!state.need || state.stage === "ask_need")) {
    state.need = original;
  }

  const learnerType = detectLearnerType(lower);
  if (learnerType) {
    // Lock на learnerType: после явного указания (child/adult) НЕ переключаем учётной речью.
    // Иначе фраза «нам не подходит» переключает с child на adult.
    // Сменить можно только явной формулировкой "нет, на самом деле для меня/ребёнка".
    const hasExplicitSwitch = /(?:нет[,\s]+(?:на\s+самом\s+деле|это)|на\s+самом\s+деле\s+для|перепутал)/i.test(lower);
    if (!state.learnerTypeLocked || hasExplicitSwitch) {
      state.learnerType = learnerType;
      // Lock устанавливаем только когда clearly indicators child/adult, не unknown.
      if (learnerType === "child" || learnerType === "adult") {
        state.learnerTypeLocked = true;
      }
    }
  }

  const childGender = detectChildGender(lower);
  if (childGender) {
    state.childGender = childGender;
  }

  const customerGender = detectCustomerGender(lower, state.customerName);
  if (customerGender !== "unknown") {
    state.customerGender = customerGender;
  } else if (!state.customerGender && state.customerName) {
    state.customerGender = inferGenderByName(state.customerName);
  }

  const preferences = detectSchedulePreferences(lower);
  if (preferences.preferredTime) {
    state.preferredTime = preferences.preferredTime;
  }
  if (preferences.preferredWeekday) {
    state.preferredWeekday = preferences.preferredWeekday;
  }
  if (preferences.preferredDayType) {
    state.preferredDayType = preferences.preferredDayType;
  }

  // Temporal parser обрабатывает «завтра», «послезавтра», «через неделю», «в эти выходные».
  const temporalHint = parseTemporalHint(lower);
  if (temporalHint.weekday && !state.preferredWeekday) {
    state.preferredWeekday = temporalHint.weekday;
  }
  if (temporalHint.dayType && !state.preferredDayType) {
    state.preferredDayType = temporalHint.dayType;
  }
  if (temporalHint.time && !state.preferredTime) {
    state.preferredTime = temporalHint.time;
  }

  const extractionAttempt = shouldUseSemanticAssist({
    original,
    lower,
    stage: state.stage,
    extractedName,
    extractedAge,
    hasLearnerType: Boolean(state.learnerType && state.learnerType !== "unknown"),
    hasNeed: Boolean(state.need && hasClearNeed(state.need)),
    hasDirection: Boolean(state.direction),
    hasBranch: Boolean(state.branch),
    hasSchedulePreference: Boolean(state.preferredTime || state.preferredWeekday || state.preferredDayType)
  })
    ? await extractWithOpenAi({
        message: original,
        stage: state.stage,
        currentState: {
          customerName: state.customerName,
          learnerType: state.learnerType,
          age: state.age,
          need: state.need,
          direction: state.direction,
          branch: state.branch,
          preferredTime: state.preferredTime,
          preferredWeekday: state.preferredWeekday,
          preferredDayType: state.preferredDayType
        }
      })
    : null;
  const aiExtraction = extractionAttempt?.result ?? null;
  if (extractionAttempt?.cacheUsage) {
    state.lastExtractionCache = extractionAttempt.cacheUsage;
  }

  if (aiExtraction) {
    if (!state.customerName && aiExtraction.customerName && !isNotAName(aiExtraction.customerName)) {
      state.customerName = capitalize(aiExtraction.customerName);
    }

    if ((!state.learnerType || state.learnerType === "unknown") && aiExtraction.learnerType) {
      state.learnerType = aiExtraction.learnerType;
    }

    if (!state.age && aiExtraction.age) {
      state.age = aiExtraction.age;
    }

    if ((!state.need || state.stage === "ask_need") && aiExtraction.need) {
      state.need = aiExtraction.need;
    }

    if (!state.direction && aiExtraction.direction && hasExplicitDirectionCue(lower)) {
      // Та же защита, что и в regex-detection: если клиент СПРАШИВАЕТ про направление
      // («что такое брейк-данс?»), а не подтверждает — кладём в _pendingDirection.
      const isClarifyAboutDirection =
        isClarifyingUserQuestion(lower) ||
        /(?:что\s+(?:такое|это)|это\s+что|расскаж\w*\s+про|поясн\w*\s+про|какой\s+это|че\s+это|чё\s+это)/i.test(lower);
      if (isClarifyAboutDirection) {
        state._pendingDirection = aiExtraction.direction;
      } else {
        state.direction = aiExtraction.direction;
      }
    }

    if (!state.branch && aiExtraction.branch) {
      state.branch = aiExtraction.branch;
    }

    if (!state.preferredTime && aiExtraction.preferredTime) {
      state.preferredTime = aiExtraction.preferredTime;
    }

    if (!state.preferredWeekday && aiExtraction.preferredWeekday) {
      state.preferredWeekday = aiExtraction.preferredWeekday;
    }

    if (!state.preferredDayType && aiExtraction.preferredDayType) {
      state.preferredDayType = aiExtraction.preferredDayType;
    }
  }
}

// Чистит кандидата на имя: убирает хвостовые дефисы (обрыв слова — "Ан--"),
// отбрасывает слишком короткие и filler-токены ("э-э", "м-м").
function sanitizeNameCandidate(raw: string): string | undefined {
  const cleaned = raw.replace(/-+$/u, "").trim();
  if (cleaned.length < 2) return undefined;
  if (isLikelyFiller(cleaned)) return undefined;
  // Имя, заканчивающееся согласной без гласной (как "Бр" из "Брайан--") — скорее обрыв.
  // Простая эвристика: должна быть хоть одна гласная.
  if (!/[аеёиоуыэюяa-z]/iu.test(cleaned)) return undefined;
  return cleaned;
}

function extractName(original: string, stage?: string): string | undefined {
  const trimmed = original.trim();

  // Самокоррекция клиента: «Ан-- э-э-э, Татьяна», «Сергей, ой нет, Андрей»,
  // «Аня, точнее Анна» — берём ПОСЛЕДНЕЕ имя после маркера поправки.
  // Маркеры: filler (а-а, э-э, м-м), «ой», «нет», «точнее», «то есть», «не», обрыв тире.
  // Это надо проверить ДО общих паттернов, иначе они захватят первое (обрыванное) имя.
  const correction = trimmed.match(
    /[А-ЯЁ][а-яё]+(?:-+)?\s*[,.]?\s+(?:[аэом]+(?:[-\s]?[аэом]+)+|ой|нет|точнее|то\s+есть|не|извините|простите)\s*[,.]?\s+([А-ЯЁ][а-яё]+)/u
  );
  if (correction?.[1]) {
    const sanitized = sanitizeNameCandidate(correction[1]);
    if (sanitized && !isNotAName(sanitized)) return sanitized;
  }

  // "это" специально НЕ включён в pattern представления — он часто появляется в вопросах
  // «Это где?», «Это что?», «Это сколько?», и захватывал вопросительное слово как имя.
  // Если клиент действительно говорит «Это Андрей», то pattern с "я" / "меня зовут" обычно тоже сработает.
  const explicitPatterns = [
    /([А-ЯЁа-яё]{2,})\s+(?:меня\s+звать|меня\s+зовут|зовут|звать)/i,  // "Пётр меня звать", "Анна зовут"
    /(?:меня\s+зовут|меня\s+звать|на\s+связи)\s+([А-ЯЁа-яёA-Za-z-]{2,})(?=[\s,.!?]|$)/i,
    /(?:^|[,.!?\s])я\s+([А-ЯЁа-яёA-Za-z-]{2,})(?=[\s,.!?]|$)/i
  ];

  for (const pattern of explicitPatterns) {
    const raw = trimmed.match(pattern)?.[1];
    const sanitized = raw ? sanitizeNameCandidate(raw) : undefined;
    if (sanitized && !isNotAName(sanitized)) return sanitized;
  }

  const afterGreetingRaw = trimmed.match(/^(?:здравствуйте|здрасьте|добрый день|добрый вечер|доброго времени суток|привет)[,!.\s-]+([А-ЯЁа-яёA-Za-z-]{2,})(?=[\s,.!?]|$)/i)?.[1];
  const afterGreeting = afterGreetingRaw ? sanitizeNameCandidate(afterGreetingRaw) : undefined;
  if (afterGreeting && !isGreetingWord(afterGreeting) && !isNotAName(afterGreeting)) return afterGreeting;

  if (stage === "ask_name") {
    const firstTokenRaw = trimmed.match(/^([А-ЯЁа-яёA-Za-z-]{2,})(?=[\s,.!?]|$)/)?.[1];
    const firstToken = firstTokenRaw ? sanitizeNameCandidate(firstTokenRaw) : undefined;
    if (firstToken && !isGreetingWord(firstToken) && !isNotAName(firstToken)) return firstToken;
  }

  return undefined;
}

function isGreetingWord(value: string): boolean {
  return [
    "здравствуйте", "здрасти", "здрасьте", "здарова", "здаров",
    "привет", "приветик", "приветствую", "приветули",
    "добрый", "доброго", "день", "вечер", "утро",
    "дратути", "хеллоу", "хай", "алло", "аллё"
  ].includes(value.toLowerCase());
}

function isLikelyFiller(value: string): boolean {
  const lower = value.toLowerCase().trim();
  // Повтор одной и той же буквы через дефис: "а-а-а", "э-э-э", "м-м-м", "у-у-у".
  if (/^([а-яёa-z])([\s-]?\1){1,}$/i.test(lower)) return true;
  // Чисто гласные/мычание-звуки.
  if (/^[аэоиыуёюя]+$/iu.test(lower) && lower.length <= 4) return true;
  if (/^м+$/iu.test(lower) || /^н+$/iu.test(lower)) return true;
  return false;
}

function isNotAName(value: string): boolean {
  if (isLikelyFiller(value)) return true;
  return [
    "подумаю",
    "хочу",
    "нужно",
    "интересует",
    "согласен",
    "согласна",
    "могу",
    "буду",
    "меня",
    "у",
    "вас",
    "для",
    "сына",
    "сыну",
    "дочки",
    "дочери",
    "ребенка",
    "ребёнка",
    "танцы",
    "подскажите",
    "скажите",
    "можно",
    "приветик",
    "приветули",
    "здарова",
    "здаров",
    "дратути",
    "хеллоу",
    "хай",
    "алло",
    "аллё",
    "слушаю",
    "говорите",
    "ага",
    "угу",
    "угум",
    "ладно",
    "хорошо",
    "ок",
    "окей",
    "озеро",
    "озера",
    "озере",
    "развилка",
    "развилке",
    "школьная",
    "школьной",
    "первая",
    "первой",
    "школа",
    "школу",
    "район",
    "филиал",
    "адрес",
    "цена",
    "стоимость",
    // Слова-связки и вопросительные — часто стоят сразу после "Здравствуйте, ..." или "Это ...".
    "ну", "так", "вот", "это", "то", "там", "тут", "здесь",
    "где", "что", "как", "почему", "зачем", "кто", "куда", "когда", "сколько",
    "какой", "какая", "какие", "получается", "значит", "слушайте", "давайте",
    "извините", "простите"
  ].includes(value.toLowerCase());
}

function detectBranch(text: string): Branch | undefined {
  if (text.includes("развил")) return "Развилка";
  if (text.includes("озер") || text.includes("псекуп")) return "Озеро";
  if (text.includes("школь") || text.includes("первой школ") || text.includes("1 школ")) return "Школьная";
  if (text.includes("чернях")) return "Черняховского";
  return undefined;
}

function detectDirection(text: string): string | undefined {
  const direct = [
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
    ["k-pop", "K-pop"],
    ["к-поп", "K-pop"],
    ["кей-поп", "K-pop"],
    ["восточ", "Восточные танцы"],
    ["джаз", "Jazz funk"],
    ["lady", "Lady style"],
    ["леди", "Lady style"],
    ["heels", "Lady style"],
    ["хилс", "Lady style"],
    ["dancehall", "Dancehall"],
    ["дэнс", "Dancehall"],
    ["хореограф", "Детская хореография"]
  ] as const;

  return direct.find(([needle]) => text.includes(needle))?.[1];
}

function hasExplicitDirectionCue(text: string): boolean {
  return Boolean(detectDirection(text));
}

function matchDirection(state: SalesDialogState): { direction: string; pitch: string } | undefined {
  const lower = (state.need ?? "").toLowerCase();
  const rejected = new Set(state.rejectedDirections ?? []);

  // Список кандидатов в порядке приоритета. Каждый кандидат фильтруется:
  // (а) не в rejectedDirections; (б) реально доступен для age/branch.
  const candidates: Array<{ direction: string; pitch: string; needlesMatch: boolean }> = [];

  if (isChildLead(state)) {
    // Для ребёнка матчим только child-friendly направления.
    candidates.push({
      direction: "Breakdance",
      pitch: "для активных детей хорошо подходит брейкданс: силовой формат и много движения.",
      needlesMatch: containsAny(lower, ["брейк", "трюк", "сила", "соревн", "актив"])
    });
    candidates.push({
      direction: "Детская хореография",
      pitch: "для спокойного начала подойдёт детская хореография: спокойный формат, ребёнку обычно проще включиться.",
      needlesMatch: containsAny(lower, ["хореограф", "мягк", "база", "поспок", "спок", "медлен", "плавн"])
    });
    candidates.push({
      direction: "Hip-hop",
      pitch: "для начала детям обычно хорошо заходит хип-хоп: много движения, понятный формат, можно спокойно попробовать без подготовки.",
      needlesMatch: containsAny(lower, ["увер", "координац", "ритм", "энерг", "танц", "попроб", "понрав", "втян", "стесня", "раскрепост", "поактив"])
    });
    // Contemporary — пластика и эмоции; матчит «женственное/красивое/плавное».
    // Стоит ВПЕРЕДИ Lady style: контемп универсальнее, подходит большему диапазону возрастов.
    // Lady style сработает только если клиент явно сказал «леди/lady/heels/хилс».
    candidates.push({
      direction: "Contemporary",
      pitch: "для пластики и плавных движений хорошо подходит контемп: ребята учатся выражать эмоции через движение, мягкая женственная подача.",
      needlesMatch: containsAny(lower, ["пласт", "плавн", "выраж", "современ", "женствен", "поженствен", "красив", "девочк", "девуш"])
    });
    // Lady style — если клиент прямо назвал «леди/lady/heels». Контемп уже покрывает мягкое «женственное».
    // Доступность по возрасту проверит isDirectionAvailable (в студии Lady style — от 12+).
    candidates.push({
      direction: "Lady style",
      pitch: "если хочется именно такой формат, можно попробовать леди стайл: красивые связки и плавная пластика.",
      needlesMatch: containsAny(lower, ["леди", "lady", "heels", "хилс"])
    });
    // ИНТЕРВЕНЦИЯ: если ни один needle не сматчился — выдаём Hip-hop по умолчанию.
    // Раньше pitch упоминал «для этого возраста» даже когда age был неизвестен — это вело
    // к фразам бота про возраст, которого нет. Теперь age-нейтральная формулировка.
    if (!candidates.some((c) => c.needlesMatch)) {
      const ageHint = state.age ? `для ${state.age} лет ` : "";
      candidates.push({ direction: "Hip-hop", pitch: `${ageHint}хорошо подходит хип-хоп — самое популярное и для начала простое направление.`.trim(), needlesMatch: true });
    }
  } else {
    // Для взрослого матчим из общего списка directionByNeed.
    for (const [needles, dir, pitch] of directionByNeed) {
      candidates.push({
        direction: dir,
        pitch,
        needlesMatch: needles.some((needle) => lower.includes(needle))
      });
    }
  }

  // Перебираем кандидатов: совпавшие с needles в приоритете, но с фильтрами.
  for (const c of [...candidates].sort((a, b) => Number(b.needlesMatch) - Number(a.needlesMatch))) {
    if (!c.needlesMatch) continue;
    if (rejected.has(c.direction)) continue;
    // Sanity-check: реально ли есть слоты для этого направления под age/branch.
    if (!isDirectionAvailable(c.direction, { age: state.age, branch: state.branch })) continue;
    return { direction: c.direction, pitch: c.pitch };
  }

  return undefined;
}

function getCandidateSlots(state: SalesDialogState, limit: number): Slot[] {
  const slots = findSlots({
    direction: state.direction,
    branch: state.branch,
    age: state.age,
    preferredTime: state.preferredTime,
    limit: 20
  });

  return slots
    .filter((slot) => !state.preferredWeekday || slot.weekday === state.preferredWeekday)
    .filter((slot) => {
      if (state.preferredDayType === "weekend") return slot.weekday === "Сб" || slot.weekday === "Вс";
      if (state.preferredDayType === "weekday") return slot.weekday !== "Сб" && slot.weekday !== "Вс";
      return true;
    })
    .slice(0, limit);
}

function buildSolutionText(state: SalesDialogState, slots: Slot[]): string {
  // Не упоминаем цену в первом предложении слота — сначала пусть согласится со временем.
  // Цена прозвучит позже, в момент подтверждения записи.
  // КРИТИЧНО: pitch берём из state.direction (то, что выбрали и подтвердили), а не из
  // повторного matchDirection(state.need). Иначе reply говорит «йога», а слот для хип-хопа.
  const actualDirection = state.direction ?? slots[0].direction;
  const directionName = directionForSpeech(actualDirection);
  const pitch = pitchForDirection(actualDirection, state) ??
    `направление ${directionName} хорошо подходит как первое пробное занятие: можно спокойно прийти, посмотреть группу и решить, нравится ли.`;
  const firstSlot = slots[0];
  state.offeredSlotIndex = 0;

  const namePart = maybeName(state.customerName, "offer");
  return `${namePart}${lowercaseFirst(pitch)} Из ближайшего могу предложить ${formatSlotTimeOnly(firstSlot)}. Подойдёт это время?`;
}

/**
 * Подбирает короткую "продающую" фразу для уже выбранного direction.
 * Используется в buildSolutionText вместо повторного matchDirection — чтобы reply
 * не рассинхронизировался со state.direction.
 */
function pitchForDirection(direction: string, state: SalesDialogState): string | undefined {
  const isChild = isChildLead(state);
  const map: Record<string, { child?: string; adult?: string }> = {
    "Hip-hop":              { child: "хип-хоп — самое популярное и для начала простое: много движения и понятный формат.", adult: "хип-хоп — самое популярное у взрослых: понятный формат и хорошая нагрузка." },
    "Breakdance":           { child: "брейкданс — силовой и активный формат, ребёнок отлично себя проявляет.", adult: "брейкданс — сила, координация, понятный вход для новичка." },
    "Contemporary":         { child: "контемп — пластика и плавные движения, ребёнок учится выражать эмоции через движение.", adult: "контемп — пластика и плавные движения, понятная база и работа с эмоциями." },
    "Детская хореография":  { child: "детская хореография — спокойный формат и хорошая база, ребёнку обычно проще начать." },
    "Йога":                 { adult: "йога — растяжка и хорошая нагрузка без спешки, спокойный формат." },
    "Lady style":           { adult: "леди стайл — плавная пластика и простой вход для новичков." },
    "Zumba":                { adult: "зумба — бодрая музыка и хорошая нагрузка за час." },
    "Salsa/Bachata":        { adult: "сальса и бачата — парные танцы, прийти можно и без партнёра." },
    "Jazz funk":            { adult: "джаз-фанк — яркие связки и сценический формат." },
    "K-pop":                { child: "K-pop — современные танцы под знакомые треки, ритмично и весело.", adult: "K-pop — современные танцы под знакомые треки, яркий формат." },
    "Восточные танцы":      { adult: "восточные танцы — мягкая пластика и понятный вход для новичка." },
    "Стрип-пластика":       { adult: "стрип-пластика — плавная женственная пластика." },
    "Dancehall":            { adult: "дэнсхолл — активный современный формат." }
  };
  const entry = map[direction];
  if (!entry) return undefined;
  return isChild ? (entry.child ?? entry.adult) : (entry.adult ?? entry.child);
}

function formatSlotForBooking(slot: Slot): string {
  return `${formatSlotTimeOnly(slot)} ${branchPrepositional(slot.branch)}`;
}

function formatSlotTimeOnly(slot: Slot): string {
  return `${weekdayWithPreposition(slot.weekday)} ${slot.time}`;
}

function pickSlotByText(slots: Slot[], text: string): Slot | undefined {
  if (/\bперв(ый|ого|ом|ому)?\b/.test(text)) return slots[0];
  if (/\bвтор(ой|ого|ом|ому)?\b/.test(text)) return slots[1];
  if (/\bтрет(ий|ьего|ьем|ьему)?\b/.test(text)) return slots[2];
  return slots.find((slot) => {
    const fullWeekday = weekdayFull(slot.weekday);
    return hasAnyToken(text, [slot.weekday.toLowerCase()]) || text.includes(fullWeekday) || text.includes(slot.time);
  });
}

function isPositive(text: string): boolean {
  if (isNegative(text)) return false;
  return hasAnyPhrase(text, [
    "давайте",
    "подходит",
    "удобно",
    "хорошо",
    "согласен",
    "согласна",
    "записывайте",
    "запишите",
    "фиксируйте",
    "зафиксируйте"
  ]) || hasAnyToken(text, ["да", "ок"]);
}

function isNegative(text: string): boolean {
  return hasAnyPhrase(text, [
    "не подходит",
    "не удобно",
    "неудобно",
    "не можем",
    "не сможем",
    "не получится"
  ]) || hasAnyToken(text, ["нет"]) || hasAnyPhrase(text, ["другое время", "другой день"]);
}

function rejectsAllOptions(text: string): boolean {
  return ["ни один", "никакой", "ничего не подходит", "оба не", "все не подходят", "всё не подходит"].some((word) => text.includes(word));
}

function isTeacherQuestion(text: string): boolean {
  return ["кто вед", "кто будет", "педагог", "преподавател", "тренер"].some((word) => text.includes(word));
}

function isPriceQuestion(text: string): boolean {
  return ["сколько стоит", "цена", "стоимость", "почем", "по чем", "оплата"].some((word) => text.includes(word));
}

/** Клиент задаёт общий вопрос «расскажите про студию / что у вас за / что вы из себя». */
function isStudioInfoQuestion(text: string): boolean {
  const t = text.toLowerCase();
  // 1) «расскажите ... про/о/об ... студию/школу/...» — любые слова между «расскажите» и «про X».
  //    Ловит: «расскажите про вашу школу», «расскажите подробнее про студию»,
  //           «расскажите что-нибудь ещё про вашу студию», «расскажите-ка о школе».
  if (/(?:расскаж\w+|поведай\w*|опиши\w*|поясн\w*)\b[\s\S]{0,40}?(?:про|о|об)\s+(?:вашу?\s+|вашей\s+|вашем\s+|свою\s+|своей\s+|своей\s+)?(?:студи|школ|компани|зал|клуб|вас|себ)/i.test(t)) {
    return true;
  }
  // 2) «что/кто у вас за студия» и подобное.
  if (/(?:что|кто)\s+(?:у\s+вас\s+)?(?:за|такое|такие)\s+(?:студи|школа|зал|клуб|компани)/i.test(t)) {
    return true;
  }
  // 3) «больше про студию», «информацию о школе», «подробнее о вас».
  if (/(?:подробн\w+|больше|информаци\w+|деталь\w+)\s+(?:про|о|об)\s+(?:вашу?\s+|вашей\s+|свою\s+|своей\s+)?(?:студи|школ|зал|вас|себ)/i.test(t)) {
    return true;
  }
  // 4) «что вы предлагаете», «расскажите о себе/о вас».
  if (/(?:что\s+(?:вы|у\s+вас)\s+(?:предлаг|за\s+места)|расскажите\s+(?:вообще|о\s+себе|о\s+вас|подробн))/i.test(t)) {
    return true;
  }
  // 5) «кто вы такие», «что вы такое», «чем занимаетесь».
  if (/(?:кто\s+вы|что\s+вы)\b/i.test(t) && /(?:такие|такое|такая|занимаетесь|делаете)/i.test(t)) {
    return true;
  }
  return false;
}

/** Клиент спрашивает про график/расписание/часы работы (но без привязки к конкретному слоту). */
function isScheduleQuestionGeneric(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /(?:когда|во\s+сколько|в\s+какое\s+время)\s+(?:проход(?:ят|ит)|идут|идёт|идет|бывают|бывает|будут|можно\s+прийти|можно\s+приехать|у\s+вас)/i.test(t) ||
    /(?:расписани|график\s+(?:занятий|работы)|часы\s+работы|режим\s+работы)/i.test(t) ||
    /(?:вы\s+(?:работаете|открыты)\s+(?:когда|во\s+сколько|до\s+скольки))/i.test(t)
  );
}

/** Клиент явно говорит, что бот его не слышит / игнорирует / не отвечает. */
function isFrustrationSignal(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /(?:я\s+(?:же|ж)\s+(?:вам|у\s+вас|тебе)?\s*(?:еще|ещё)?\s*(?:спросил|спраши|говорил|сказал))/i.test(t) ||
    /(?:вы\s+(?:меня\s+)?(?:не\s+услышали|не\s+слышите|не\s+отвечаете|не\s+поняли|игнорируете))/i.test(t) ||
    /(?:я\s+(?:же\s+|про|о)\s+друго(?:м|е))/i.test(t) ||
    /(?:не\s+про\s+это|не\s+об\s+этом|я\s+не\s+про\s+это)/i.test(t) ||
    /(?:вы\s+меня\s+(?:слыш|понимает|поняли))/i.test(t)
  );
}

function isAddressQuestion(text: string): boolean {
  const phrases = [
    "адрес", "адресок", "местонахождение",
    "где находится", "где находитесь", "где вы находитесь", "где вы расположены",
    "где это", "это где", "где у вас", "вы где",
    "как добраться", "куда ехать", "куда подъезжать", "куда приезжать", "куда подъехать",
    "в каком районе", "какой район", "какое место"
  ];
  if (phrases.some((p) => text.includes(p))) return true;
  // Короткий уточняющий вопрос «Где?» / «А где?» в отрыве — тоже про адрес.
  if (/^(?:а\s+)?где\??$/i.test(text.trim())) return true;
  return false;
}

function isThinkingObjection(text: string): boolean {
  return ["подумаю", "подумаем", "позже", "посовет", "напишу потом", "не знаю пока", "надо подумать", "щас не знаю", "сейчас не знаю"].some((word) => text.includes(word));
}

function isNoTimeObjection(text: string): boolean {
  // Клиент говорит про неудобство времени/слота: «нет времени», «вечер не подходит», «утром неудобно», «другой день».
  if (["нет времени", "не успе", "занят", "плотный график", "некогда", "другой день", "другое время", "поменять время"].some((w) => text.includes(w))) return true;
  if (/(?:утр[оаe]?|днем|днём|вечер[оа]?м?|по\s+утр|по\s+вечер)\s*(?:вообще\s+)?(?:не\s+подход|неудобн|не\s*удобн|не\s+можем)/i.test(text)) return true;
  if (/(?:не\s+подход|неудобн|не\s*удобн|нет)\s*(?:по\s+)?(?:утр|днем|днём|вечер)/i.test(text)) return true;
  return false;
}

function isFarObjection(text: string): boolean {
  return ["далеко", "далековато", "неудобно ехать", "долго ехать"].some((word) => text.includes(word));
}

function isShyObjection(text: string): boolean {
  return ["стесня", "боит", "стрем", "робе"].some((word) => text.includes(word));
}

function isBeginnerObjection(text: string): boolean {
  return ["не уме", "с нуля", "никогда не танцев", "вообще ничего не уме", "никогда не пробов", "ноль", "новичок"].some((word) => text.includes(word));
}

function isExpensiveObjection(text: string): boolean {
  return ["дорого", "дороговато", "слишком дорого", "не по карман", "много стоит", "дорогая цен"].some((word) => text.includes(word));
}

function isCallbackLaterObjection(text: string): boolean {
  return ["перезвон", "перезвоню", "перезвоните", "сейчас не могу", "не могу говорить", "позже наберу", "напишу позже"].some((word) => text.includes(word));
}

function isPartnerObjection(text: string): boolean {
  return ["с подруг", "с друг", "вдвоём", "вдвоем", "с девушк", "с парнем", "с мужем", "с женой", "втроем", "втроём"].some((word) => text.includes(word));
}

function isClothesObjection(text: string): boolean {
  return ["в чем при", "в чём при", "что надеть", "форма", "одежд", "обувь", "что взять с собой"].some((word) => text.includes(word));
}

function priceReply(slot: Slot): string {
  const price = getPrice(slot.direction, slot.branch);
  const subscription = price.subscription ? ` Абонемент по этому направлению — ${price.subscription} рублей в месяц.` : "";
  return `Пробное у нас по ${price.trial} рублей.${subscription} Для начала можно просто прийти на одно занятие и посмотреть группу. ${formatSlotTimeOnly(slot)} удобно?`;
}

function teacherReply(state: SalesDialogState, slot: Slot): string {
  const pitches: Record<string, string> = {
    "Анна": "Занятие ведет Анна. С детьми у нее спокойный и понятный подход, ребятам обычно легко включиться.",
    "Дарина": "Занятие ведет Дарина. У нее живой темп, детям обычно легко включиться в занятие.",
    "Константин": "Занятие ведет Константин. Он сильный по брейкдансу и хорошо дает базу для прогресса.",
    "Виталий": "Занятие ведет Виталий, руководитель школы. Это сильный тренер с большим опытом.",
    "Кристина": "Занятие ведет Кристина. У нее спокойная подача, хорошо подходит для мягких и плавных форматов.",
    "Анастасия Б": "Занятие ведет Анастасия. Очень бережный педагог, хорошо подходит для мягкого входа в занятия.",
    "Оксана": "Занятие ведет Оксана. Она очень опытный педагог по парным направлениям.",
    "Александр": "Занятие ведет Александр. Сильный преподаватель по сальсе и бачате."
  };
  const pitch = pitches[slot.teacher] ?? `Занятие ведет ${slot.teacher}.`;
  return `${state.customerName}, ${pitch} ${formatSlotTimeOnly(slot)} вам подходит?`;
}

function needsAge(direction: string): boolean {
  return ["Hip-hop", "Breakdance", "Contemporary", "Детская хореография", "K-pop"].includes(direction);
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}

function lowercaseFirst(value: string): string {
  return value.slice(0, 1).toLowerCase() + value.slice(1);
}

function weekdayFull(value: Slot["weekday"]): string {
  const map: Record<Slot["weekday"], string> = {
    "Пн": "понедельник",
    "Вт": "вторник",
    "Ср": "среду",
    "Чт": "четверг",
    "Пт": "пятницу",
    "Сб": "субботу",
    "Вс": "воскресенье"
  };
  return map[value];
}

function weekdayWithPreposition(value: Slot["weekday"]): string {
  const map: Record<Slot["weekday"], string> = {
    "Пн": "в понедельник в",
    "Вт": "во вторник в",
    "Ср": "в среду в",
    "Чт": "в четверг в",
    "Пт": "в пятницу в",
    "Сб": "в субботу в",
    "Вс": "в воскресенье в"
  };
  return map[value];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function branchPrepositional(branch: Branch): string {
  const map: Record<Branch, string> = {
    "Развилка": "на Развилке",
    "Озеро": "у озера",
    "Школьная": "возле первой школы",
    "Черняховского": "на Черняховского"
  };
  return map[branch];
}

function directionForSpeech(direction: string): string {
  const normalized = direction.toLowerCase();
  if (normalized.includes("hip-hop")) return "хип-хоп";
  if (normalized.includes("break")) return "брейкданс";
  if (normalized.includes("contemporary")) return "contemporary";
  if (normalized.includes("salsa") || normalized.includes("bachata")) return "сальса и бачата";
  if (normalized.includes("k-pop")) return "K-pop";
  if (normalized.includes("lady")) return "Lady style";
  return direction;
}

function isAmbiguousCenterBranch(text: string): boolean {
  return text.includes("центр") || text.includes("центре");
}

function isVagueBranch(text: string): boolean {
  return text.includes("поближе") || text.includes("рядом") || text.includes("не знаю") || text.includes("без разницы");
}

function isNeedStepClosed(state: SalesDialogState): boolean {
  if (state.direction) return true;
  if (!state.need) return false;
  return hasClearNeed(state.need);
}

function isLearnerStepClosed(state: SalesDialogState): boolean {
  return state.learnerType === "child" || state.learnerType === "adult";
}

function hasClearNeed(value: string): boolean {
  const lower = value.toLowerCase();
  return containsAny(lower, [
    "увер",
    "координац",
    "ритм",
    "энерг",
    "растяж",
    "спин",
    "похуд",
    "пласт",
    "женствен",
    "науч",
    "танц",
    "попроб",
    "понрав",
    "втян",
    "стесня",
    "раскрепост",
    "подготов",
    "выступ",
    "соревн",
    "брейк",
    "хип",
    "hip",
    "йог",
    "зумб",
    "сальс",
    "бачат",
    "контемп",
    // Клиент сам не знает чего хочет — это тоже клозит need step:
    // бот должен взять инициативу, а не переспрашивать.
    "популярн",
    "посовет",
    "не знаю",
    "не определ",
    "без понят",
    "что-нибудь",
    "что нибудь",
    "что нравится дет",
    "хит",
    "что сейчас",
    "k-pop",
    "кей-поп",
    "к-поп",
    "актив",
    "подвиж",
    "динам",
    "темп",
    "бодр",
    "спок",
    "медлен",
    "плавн",
    "мягк",
    "расслаб"
  ]);
}

function detectChildGender(text: string): "boy" | "girl" | undefined {
  if (/(?:доч|девочк|девч|малышк|внучк|сестрёнк|сестрен)/i.test(text)) return "girl";
  if (/(?:сын|мальчик|малыш(?!к)|внук(?!ш)|братишк|братиш)/i.test(text)) return "boy";
  return undefined;
}

function detectLearnerType(text: string): SalesDialogState["learnerType"] | undefined {
  if (containsAny(text, ["сын", "доч", "ребен", "ребён", "малыш", "девочк", "мальчик", "дет", "школьник", "школьниц"])) return "child";
  if (containsAny(text, ["для себя", "для меня", "по мне", "обо мне", "себе", "взросл"])) return "adult";
  if (/(?<![а-яё])(мне|сам|сама)(?![а-яё])/iu.test(text)) return "adult";
  if (containsAny(text, ["хочу", "интересует", "ищу", "нужен", "нужна", "нужно", "хотел", "хотела"])) return "adult";
  return undefined;
}

function detectCustomerGender(text: string, customerName?: string): "male" | "female" | "unknown" {
  if (containsAny(text, ["сама", "хотела", "нужна", "согласна"])) return "female";
  if (containsAny(text, ["сам", "хотел", "нужен", "согласен"])) return "male";
  if (customerName) return inferGenderByName(customerName);
  return "unknown";
}

function inferGenderByName(name: string): "male" | "female" | "unknown" {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return "unknown";

  const maleExceptions = new Set([
    "никита",
    "илья",
    "кузьма",
    "савва",
    "фома",
    "лука",
    "данила"
  ]);
  const femaleSoftSignNames = new Set(["любовь", "николь", "шанталь"]);

  if (maleExceptions.has(normalized)) return "male";
  if (femaleSoftSignNames.has(normalized)) return "female";
  if (/[ая]$/.test(normalized)) return "female";
  if (/(й|н|р|м|л|г|д|б|в|п|с|т|к|ц|ч|ш|щ|ь)$/.test(normalized)) return "male";
  return "unknown";
}

function customerExplicitlyAskedForGenderedStyle(customerMessage: string, need?: string): boolean {
  const combined = `${customerMessage} ${need ?? ""}`.toLowerCase();
  return containsAny(combined, ["женствен", "поженствен", "женственность", "для девушек", "леди", "lady", "heels", "хилс"]);
}

function isChildLead(state: SalesDialogState): boolean {
  return state.learnerType === "child" || Boolean(state.age && state.age < 16);
}

function containsAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-zа-яё0-9+-]+/iu)
    .filter(Boolean);
}

function hasAnyToken(value: string, tokens: string[]): boolean {
  const actual = new Set(tokenize(value));
  return tokens.some((token) => actual.has(token));
}

function hasAnyPhrase(value: string, phrases: string[]): boolean {
  return phrases.some((phrase) => value.includes(phrase));
}

function parseAge(text: string): number | undefined {
  const onlyDigit = text.trim().match(/^(\d{1,2})$/)?.[1];
  if (onlyDigit) return Number(onlyDigit);

  const digit = text.match(/(\d{1,2})\s*(год|года|лет)/)?.[1];
  if (digit) return Number(digit);

  const childDigit = text.match(/(сыну|сын|дочке|дочери|ребенку|ребёнку|мальчику|девочке)\s+(\d{1,2})(\s|,|\.|$)/)?.[2];
  if (childDigit) return Number(childDigit);

  const words: Record<string, number> = {
    "три": 3,
    "трех": 3,
    "трёх": 3,
    "четыре": 4,
    "четырех": 4,
    "четырёх": 4,
    "пять": 5,
    "пяти": 5,
    "шесть": 6,
    "шести": 6,
    "семь": 7,
    "семи": 7,
    "восемь": 8,
    "восьми": 8,
    "девять": 9,
    "девяти": 9,
    "десять": 10,
    "десяти": 10,
    "одиннадцать": 11,
    "одиннадцати": 11,
    "двенадцать": 12,
    "двенадцати": 12,
    "тринадцать": 13,
    "тринадцати": 13,
    "четырнадцать": 14,
    "четырнадцати": 14,
    "пятнадцать": 15,
    "пятнадцати": 15,
    "шестнадцать": 16,
    "шестнадцати": 16,
    "семнадцать": 17,
    "семнадцати": 17,
    "восемнадцать": 18,
    "восемнадцати": 18
  };

  for (const [word, age] of Object.entries(words)) {
    if (text.trim() === word) {
      return age;
    }

    if (new RegExp(`(^|\\s)${word}\\s+(год|года|лет)(\\s|,|\\.|$)`, "i").test(text)) {
      return age;
    }

    if (new RegExp(`(ему|ей|сыну|дочке|дочери|ребенку|ребёнку)\\s+${word}(\\s|,|\\.|$)`, "i").test(text)) {
      return age;
    }
  }

  return undefined;
}

function detectSchedulePreferences(text: string): Pick<SalesDialogState, "preferredTime" | "preferredWeekday" | "preferredDayType"> {
  const preferences: Pick<SalesDialogState, "preferredTime" | "preferredWeekday" | "preferredDayType"> = {};
  const rejectsMention = /(?:не\s+подход|не\s*удобн|неудобн|не\s+можем|не\s+вариант|вообще\s+не|совсем\s+не|нет,?\s+вечер|нет,?\s+утр|нет,?\s+днем|нет,?\s+днём)/i.test(text);
  const rejectsMentionedDay = text.includes("не подходит") || text.includes("неудобно") || text.includes("не удобно");

  // Если фраза в целом про отказ — не фиксируем время как preferred. Иначе «вечер не подходит» → evening, что неверно.
  if (!rejectsMention) {
    if (containsAny(text, ["утр", "до обеда", "пораньше"])) preferences.preferredTime = "morning";
    if (containsAny(text, ["днем", "днём", "после обеда", "в обед"])) preferences.preferredTime = "day";
    if (containsAny(text, ["вечер", "после 18", "после шести", "после семи", "после работы", "попозже"])) preferences.preferredTime = "evening";

    if (containsAny(text, ["выходн", "вых", "суббот", "воскрес", "по субб", "по воскрес"])) preferences.preferredDayType = "weekend";
    if (containsAny(text, ["будн", "после школы", "в будни", "по будням"])) preferences.preferredDayType = "weekday";
  }

  if (!rejectsMentionedDay || containsAny(text, ["нуж", "лучше", "можно", "хотел", "удоб"])) {
    const weekdays: Array<[Slot["weekday"], string[]]> = [
      ["Пн", ["понедельник", "понедельн"]],
      ["Вт", ["вторник", "вторник"]],
      ["Ср", ["сред", "среду"]],
      ["Чт", ["четверг"]],
      ["Пт", ["пятниц"]],
      ["Сб", ["суббот"]],
      ["Вс", ["воскрес"]]
    ];

    const matched = weekdays.find(([, needles]) => containsAny(text, needles));
    if (matched) preferences.preferredWeekday = matched[0];
  }

  return preferences;
}

function shouldUseSemanticAssist(input: {
  original: string;
  lower: string;
  stage?: string;
  extractedName: boolean;
  extractedAge: boolean;
  hasLearnerType: boolean;
  hasNeed: boolean;
  hasDirection: boolean;
  hasBranch: boolean;
  hasSchedulePreference: boolean;
}): boolean {
  const wordCount = tokenize(input.original).length;
  const ruleCoverage = [
    input.extractedName,
    input.extractedAge,
    input.hasLearnerType,
    input.hasNeed,
    input.hasDirection,
    input.hasBranch,
    input.hasSchedulePreference
  ].filter(Boolean).length;

  if (wordCount <= 3) {
    return false;
  }

  if (input.stage === "ask_name" && input.extractedName) {
    return false;
  }

  if (input.stage === "ask_age" && input.extractedAge) {
    return false;
  }

  if (ruleCoverage >= 3) {
    return false;
  }

  if (!input.hasLearnerType && containsAny(input.lower, ["сын", "доч", "ребен", "ребён", "для себя", "мне"])) {
    return true;
  }

  if (!input.hasBranch && containsAny(input.lower, ["район", "центр", "рядом", "поближе"])) {
    return true;
  }

  if (!input.hasNeed && !input.hasDirection && wordCount >= 7) {
    return true;
  }

  if (!input.hasSchedulePreference && containsAny(input.lower, ["после школы", "после шести", "по выхам", "выходн", "будн"])) {
    return true;
  }

  return false;
}
