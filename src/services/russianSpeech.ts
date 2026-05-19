const pronunciationMap: Array<[RegExp, string]> = [
  [/Studio\s*108/gi, "Студия сто восемь"],
  [/\bStudio\b/gi, "Студия"],
  [/\b108\b/g, "сто восемь"],
  [/ул\.\s*Герцена\s*52Д/gi, "улица Герцена, пятьдесят два дэ"],
  [/ул\.\s*Псекупская\s*149А/gi, "улица Псекупская, сто сорок девять а"],
  [/ул\.\s*Школьная\s*24/gi, "улица Школьная, двадцать четыре"],
  [/ул\.\s*Черняховского/gi, "улица Черняховского"],
  [/\bПсекупская\b/gi, "Псекупская"],
  [/\bРазвилка\b/g, "Развилка"],
  [/\bРазвилке\b/g, "Развилке"],
  // ElevenLabs неустойчиво произносит «Озеро» в одиночку (звучит как «зера»).
  // Дополнительно: на предлог «у» в «у озера» TTS ставит ударение, получается «У́-озера»
  // вместо безударного «у-озера». Поэтому в TTS подменяем форму на безпрозлоговую:
  //   «у озера» → «возле о́зера, на Псекупской»
  //   «на озере» → «возле о́зера, на Псекупской»
  // В чате (display) остаётся «у озера», pronunciation map применяется только перед TTS.
  [/филиал\s+у\s+озера\b/giu, "филиал возле о́зера, на Псекупской"],
  [/у\s+озера\b/giu, "возле о́зера, на Псекупской"],
  [/возле\s+озера\b/giu, "возле о́зера, на Псекупской"],
  [/на\s+озере\b/giu, "возле о́зера, на Псекупской"],
  [/(^|[^А-ЯЁа-яё])(О|о)зеро(?![А-ЯЁа-яё])/g, "$1филиал возле о́зера"],
  [/Hip-hop/gi, "хип-хоп"],
  [/Hip hop/gi, "хип-хоп"],
  [/\bhip\b/gi, "хип"],
  [/Breakdance/gi, "брейкданс"],
  [/\bbreak\b/gi, "брейк"],
  [/Contemporary/gi, "контэмпорари"],
  [/Dancehall/gi, "дэнсхолл"],
  [/Jazz funk/gi, "джаз-фанк"],
  [/\bjazz\b/gi, "джаз"],
  [/K-pop/gi, "кей-поп"],
  [/\bkpop\b/gi, "кей-поп"],
  [/Lady style/gi, "леди стайл"],
  [/\bheels\b/gi, "хилс"],
  [/Salsa\/Bachata/gi, "сальса и бачата"],
  [/\bSalsa\b/gi, "сальса"],
  [/\bBachata\b/gi, "бачата"],
  [/\bZumba\b/gi, "зумба"],
  [/\bPRO\b/g, "про"],
  [/\b52Д\b/gi, "пятьдесят два дэ"],
  [/\b149А\b/gi, "сто сорок девять а"]
];

const moneyMap = [
  ...buildMoneyReplacements("300", "триста", "триста рублей"),
  ...buildMoneyReplacements("400", "четыреста", "четыреста рублей"),
  ...buildMoneyReplacements("1000", "тысяча", "тысяча рублей"),
  ...buildMoneyReplacements("1700", "тысяча семьсот", "тысяча семьсот рублей"),
  ...buildMoneyReplacements("4000", "четыре тысячи", "четыре тысячи рублей"),
  ...buildMoneyReplacements("4250", "четыре тысячи двести пятьдесят", "четыре тысячи двести пятьдесят рублей"),
  ...buildMoneyReplacements("4700", "четыре тысячи семьсот", "четыре тысячи семьсот рублей"),
  ...buildMoneyReplacements("5450", "пять тысяч четыреста пятьдесят", "пять тысяч четыреста пятьдесят рублей")
] as Array<[RegExp, string]>;

const weekdayMap: Array<[RegExp, string]> = [
  [/(^|[\s,.;:!?()])Пн(?=$|[\s,.;:!?()])/g, "$1в понедельник"],
  [/(^|[\s,.;:!?()])Вт(?=$|[\s,.;:!?()])/g, "$1во вторник"],
  [/(^|[\s,.;:!?()])Ср(?=$|[\s,.;:!?()])/g, "$1в среду"],
  [/(^|[\s,.;:!?()])Чт(?=$|[\s,.;:!?()])/g, "$1в четверг"],
  [/(^|[\s,.;:!?()])Пт(?=$|[\s,.;:!?()])/g, "$1в пятницу"],
  [/(^|[\s,.;:!?()])Сб(?=$|[\s,.;:!?()])/g, "$1в субботу"],
  [/(^|[\s,.;:!?()])Вс(?=$|[\s,.;:!?()])/g, "$1в воскресенье"]
];

const floorMap: Array<[RegExp, string]> = [
  [/(^|[\s,.;:!?()])1-?й этаж(?=$|[\s,.;:!?()])/gi, "$1первый этаж"],
  [/(^|[\s,.;:!?()])2-?й этаж(?=$|[\s,.;:!?()])/gi, "$1второй этаж"],
  [/(^|[\s,.;:!?()])3-?й этаж(?=$|[\s,.;:!?()])/gi, "$1третий этаж"]
];

const speechSafePhraseMap: Array<[RegExp, string]> = [
  // Слова, в которых ElevenLabs стабильно ставит ударение не туда
  [/уже\s+смотрите\s+конкретное/gi, "уже знаете направление"],
  [/уже\s+смотрите/gi, "уже знаете"],
  [/смотрите\s+что-то/gi, "ищете что-то"],
  // «стоит» — омограф (стои́т=находится / сто́ит=цена). TTS ставит на конец → меняем на «по N рублей».
  [/(?:Пробное\s+занятие\s+|Пробное\s+|пробное\s+)(?:у\s+нас\s+)?стоит\s+(\d+)\s+рублей/gi, "пробное у нас по $1 рублей"],
  [/стоит\s+(\d+)\s+рублей/gi, "по $1 рублей"],
  [/стои́т/gi, "стоит"],
  [/что-то более активное/gi, "что-то поактивнее"],
  [/что-то более мягкое/gi, "что-то спокойнее"],
  [/что-то пластичное и мягкое/gi, "что-то спокойнее"],
  [/что-то пластичное/gi, "что-то спокойнее"],
  [/ближайший вариант/gi, "из ближайшего есть"],
  [/ближайшая группа/gi, "из ближайшего есть группа"],
  [/ближайшее решение/gi, "подходящий вариант"],
  [/с большим опытом/gi, "опытный тренер"],
  [/большая нагрузка/gi, "хорошая нагрузка"],
  [/большой выбор/gi, "много вариантов"],
  [/большое количество/gi, "много"],
  [/большие группы/gi, "группы побольше"],
  [/выразительное движение/gi, "плавное движение"],
  [/выразительностью/gi, "подачей"],
  [/выразительность/gi, "подача"],
  [/красивую подачу/gi, "красивый стиль"],
  [/красивая подача/gi, "красивый стиль"],
  [/более сценический характер/gi, "более яркий формат"],
  [/мягкий формат и хорошая нагрузка без спешки/gi, "спокойный формат без спешки"],
  [/мягкий формат/gi, "спокойный формат"],
  [/силовой формат и много движения/gi, "активный формат и много движения"]
];

const bannedPsychologicalWords = [
  "уверенн",
  "раскрепост",
  "самовыраж",
  "выразительн",
  "для души",
  "втянул",
  "втянуть",
  // Studio 108 — танцевальная студия. Brain (Claude) часто галлюцинирует «фитнес»,
  // «спортзал», «тренажёрный» по аналогии с обычными студиями, но у нас этого нет.
  "фитнес",
  "спортзал",
  "тренажер",
  "тренажёр",
  "пилатес",
  "кроссфит"
];

const bannedStressWords = [
  "большая",
  "большое",
  "большой",
  "большие",
  "большую",
  "замок",
  "атлас",
  "мука"
];

export function normalizeForRussianSpeech(text: string): string {
  return applyReplacements(text, [...pronunciationMap, ...moneyMap])
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeForElevenLabsRussianSpeech(text: string): string {
  return applySpeechSafeRussian(text)
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (_match, hours, minutes) => timeToSpeech(Number(hours), Number(minutes)))
    .replace(/(^|[\s,.;:!?()])(\d{1,2})\s*(лет|год|года)(?=$|[\s,.;:!?()])/gi, (_match, prefix, age) => `${prefix}${ageToSpeech(Number(age))}`)
    .replace(/[()]/g, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s*\/\s*/g, " и ")
    .replace(/\s+,/g, ",")
    // Убираем двойной предлог «в в» (возникает когда «в 17:30» → «в пять тридцать вечера»
    // и перед уже стоял «в»). JS \b не работает с кириллицей — используем (?<![а-яёa-z]).
    .replace(/(?<![а-яёa-z])в\s+в\s+(?=[а-яёa-z])/giu, "в ")
    .replace(/(?<![а-яёa-z])во\s+в\s+(?=[а-яёa-z])/giu, "в ")
    .replace(/(?<![а-яёa-z])на\s+на\s+(?=[а-яёa-z])/giu, "на ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Вставляет естественные интонационные паузы внутри реплики, чтобы фраза звучала живее.
 *
 * ElevenLabs Flash v2.5 (наша основная модель) НЕ поддерживает `<break time>` теги полноценно:
 * они либо игнорируются, либо озвучиваются буквально. Поэтому используем natural prosody
 * маркеры, которые TTS обрабатывает корректно:
 *   - многоточие «…» — длинная пауза «думаю»
 *   - тире « — » — средняя пауза
 *   - двойная запятая «, , » не работает, поэтому ставим «… »
 *
 * Только для Eleven v3+ можно вернуться к `<break>` (через флаг).
 *
 * Правила prosody:
 * - между названием дня и временем («во вторник, …, в 17:30») — мини-пауза «гляну расписание»;
 * - перед финальным вопросом — короткая пауза «чтобы клиент дослушал факт»;
 * - после обращения по имени в длинной реплике — небольшая пауза;
 * - на offer_solution — лёгкая пауза перед адресом/филиалом.
 *
 * Функция чистая: пустые/короткие реплики возвращаются без изменений.
 */
export function injectProsodyBreaks(text: string, options?: { action?: string; preferSsmlBreaks?: boolean }): string {
  if (!text || text.trim().length < 25) return text;

  // Eleven v3 / multilingual_v2/v3 поддерживают <break> — оставляем SSML.
  // Flash v2.5 — используем многоточия и тире.
  const useSsml = options?.preferSsmlBreaks === true;
  const SHORT = useSsml ? '<break time="160ms"/>' : "…";
  const MED   = useSsml ? '<break time="220ms"/>' : "…";
  const LONG  = useSsml ? '<break time="320ms"/>' : "… ";

  let out = text;

  // 1. Перед временем после дня недели: «во вторник, в 17:30» → «во вторник… в 17:30»
  out = out.replace(
    /(во\s+вторник|в\s+понедельник|в\s+среду|в\s+четверг|в\s+пятницу|в\s+субботу|в\s+воскресенье),\s+(в\s+\d{1,2}:\d{2})/gi,
    `$1${MED} $2`
  );

  // 2. Перед финальным коротким вопросом — пауза «чтобы клиент дослушал факт».
  out = out.replace(
    /([.!])\s+(Подойд[её]т|Удобно|Так\s+подойд|Такое\s+время\s+удобно|Удобно\s+вам)([^?.!\n]{0,40}[?.])/giu,
    `$1 ${LONG}$2$3`
  );

  // 3. Длинная вводная часть «Из ближайшего могу предложить … » — пауза перед «Пробное стоит ...»
  out = out.replace(
    /(\.)\s+(Пробное\s+(?:у\s+нас\s+)?(?:по|стоит)\s+\d)/gi,
    `$1 ${MED} $2`
  );

  // 4. После обращения по имени в начале длинной реплики — короткая пауза.
  if (out.length > 80) {
    out = out.replace(/^([А-ЯЁA-Z][а-яёa-z]{2,12}),\s+/u, `$1${SHORT} `);
  }

  // 5. На offer_solution — лёгкая пауза перед адресом/филиалом.
  if (options?.action === "offer_solution" || options?.action === "booked") {
    out = out.replace(
      /\s+(на\s+(?:Развилке|Псекупской|Школьной))/gi,
      `${SHORT} $1`
    );
  }

  return out;
}

/**
 * Strip SSML-подобных тегов `<break time="..."/>` и `<...>` если по какой-то причине
 * ElevenLabs не поддерживает их в текущем профиле — fallback для деградации.
 */
export function stripSsmlBreaks(text: string): string {
  return text.replace(/<break\s+time="[^"]+"\s*\/?>/gi, " ").replace(/\s{2,}/g, " ").trim();
}

/**
 * ElevenLabs v3 audio tags — управляющие пометки `[мягко]`, `[улыбаясь]` и т.п.
 * На моделях ниже v3 они должны быть удалены до отправки в TTS, иначе озвучатся буквально.
 */
export function stripAudioTags(text: string): string {
  // Удаляем только наши контролируемые теги — список фиксирован, чтобы не съесть полезные [квадратные] вставки
  const allowedTags = [
    "мягко", "улыбаясь", "понимающе", "спокойно", "быстрее", "тише", "тёпло", "тепло",
    "laughs softly", "laughs", "sighs", "breath", "warm", "smiling", "soft"
  ];
  const pattern = new RegExp(`\\[\\s*(?:${allowedTags.map(escapeRegex).join("|")})\\s*\\]`, "giu");
  return text.replace(pattern, "").replace(/\s{2,}/g, " ").trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripInternalSlotDetails(text: string): string {
  return text
    .replace(/свободных мест\s+\d+/gi, "")
    .replace(/педагог\s+[А-ЯЁA-Z][^,.!?;:]*/gi, "")
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function cleanHumanReply(text: string): string {
  // Reply возвращается клиенту "как есть" — с audio-тегами, если они там есть.
  // Стрипанием тегов занимается отдельная функция:
  //   - stripAudioTagsForChat() — перед показом в чате
  //   - buildElevenLabsRequestBody() — перед отправкой в TTS под флагом
  // Если стрипать теги здесь, они не дойдут до TTS pipeline.
  const cleaned = applyDisplaySafeRussian(text)
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(leadingFillerPattern, "")
    .replace(innerFillerPattern, "$1")
    .replace(/\bприятно\.\s*/gi, "")
    .replace(/\bсориентируйте\b/gi, "подскажите")
    .replace(/\bбудущий ученик\b/gi, "клиент")
    .replace(femaleAssistantPattern, (match) => preserveCase(match, femaleAssistantSubstitutions[match.toLowerCase().replace(/\s+/g, " ")] ?? match))
    .replace(/\s{2,}/g, " ")
    .trim();
  // После точки/восклицания/вопроса первое слово должно начинаться с заглавной.
  // Brain иногда выдаёт «...Виталий. пробное у нас по 300...» — режет глаз в чате.
  // Не трогаем многоточия, цифры и латиницу в URL-подобных конструкциях.
  return capitalizeAfterSentenceEnd(cleaned);
}

function capitalizeAfterSentenceEnd(text: string): string {
  // Первая буква самого reply.
  let result = text.replace(/^(\s*)([а-яёa-z])/u, (_, ws: string, ch: string) => ws + ch.toUpperCase());
  // После одиночного . ! ? + пробел + строчная буква.
  result = result.replace(
    /([.!?])(\s+)([а-яёa-z])/gu,
    (_, punct: string, ws: string, ch: string) => `${punct}${ws}${ch.toUpperCase()}`
  );
  return result;
}

/**
 * Отдельная очистка reply ПЕРЕД показом в чате.
 * Удаляет audio-теги ([мягко], [улыбаясь] и т.п.), которые предназначены только для TTS v3.
 * В чате эти теги озвучивать незачем и выглядят они как текст.
 */
export function stripAudioTagsForChat(text: string): string {
  return stripAudioTags(text);
}

// IMPORTANT: между гласными требуем именно дефис, а не пробел. Иначе "у озера" ловится
// как filler-кластер "у о" и срезается до ",зера" в reply.
const leadingFillerPattern = /^\s*(?:[аэоуы](?:-+[аэоуы]){1,}|м-?м(?:-?м)*|н-?н(?:-?н)*|во+т|так-так|эммм+|эээ+|ах+|ох+|ага+)[\s,.\-—…]+/giu;
const innerFillerPattern = /([,.!?])\s+(?:[аэоуы](?:-+[аэоуы]){1,}|м-?м(?:-?м)*|эммм+|эээ+|ну да|ну вот)\s*[,.\-—…]?\s*/giu;

const femaleAssistantSubstitutions: Record<string, string> = {
  "понял": "поняла",
  "записал": "записала",
  "посмотрел": "посмотрела",
  "уточнил": "уточнила",
  "передал": "передала",
  "услышал": "услышала",
  "увидел": "увидела",
  "нашёл": "нашла",
  "нашел": "нашла",
  "подобрал": "подобрала",
  "проверил": "проверила",
  "отправил": "отправила",
  "забронировал": "забронировала",
  "оформил": "оформила",
  "зафиксировал": "зафиксировала",
  "напомнил": "напомнила",
  "хотел": "хотела",
  "был рад": "была рада",
  "рад": "рада",
  "готов": "готова",
  "уверен": "уверена"
};

const femaleAssistantPattern = new RegExp(
  `(?<![А-Яа-яЁё])(${Object.keys(femaleAssistantSubstitutions).map((word) => word.replace(/ /g, "\\s+")).join("|")})(?![А-Яа-яЁё])`,
  "giu"
);

function preserveCase(source: string, replacement: string): string {
  if (!source || !replacement) return replacement;
  const firstChar = source.charAt(0);
  if (firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function applyDisplaySafeRussian(text: string): string {
  return applyReplacements(text, speechSafePhraseMap);
}

function applySpeechSafeRussian(text: string): string {
  return applyReplacements(text, [...pronunciationMap, ...moneyMap, ...weekdayMap, ...floorMap, ...speechSafePhraseMap]);
}

function applyReplacements(text: string, map: Array<[RegExp, string]>): string {
  return map.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

function buildMoneyReplacements(amount: string, spokenBare: string, spokenWithCurrency: string): Array<[RegExp, string]> {
  const currencyPattern = String.raw`(?:₽|р\.?|руб(?:\.|ля|лей)?)`;

  return [
    [new RegExp(String.raw`\b${amount}\s*${currencyPattern}(?=$|[\s,.;!?])`, "gi"), spokenWithCurrency],
    [new RegExp(String.raw`\b${amount}\b(?!\s*${currencyPattern})`, "gi"), spokenBare]
  ];
}

function timeToSpeech(hours24: number, minutes: number): string {
  const dayPart = getDayPart(hours24);
  const spokenHour = normalizeHour(hours24);

  if (minutes === 0) {
    return `в ${spokenHour} ${dayPart}`.replace(/\s+/g, " ").trim();
  }

  return `в ${spokenHour} ${numberToRussianWords(minutes)} ${dayPart}`.replace(/\s+/g, " ").trim();
}

function normalizeHour(hours24: number): string {
  const hours12 = hours24 % 12 || 12;

  if (hours12 === 1) {
    return "час";
  }

  return numberToRussianWords(hours12);
}

function getDayPart(hours24: number): string {
  if (hours24 >= 5 && hours24 < 12) return "утра";
  if (hours24 >= 12 && hours24 < 17) return "дня";
  if (hours24 >= 17 && hours24 < 23) return "вечера";
  return "ночи";
}

function numberToRussianWords(value: number): string {
  const units = [
    "ноль",
    "один",
    "два",
    "три",
    "четыре",
    "пять",
    "шесть",
    "семь",
    "восемь",
    "девять"
  ];
  const teens = [
    "десять",
    "одиннадцать",
    "двенадцать",
    "тринадцать",
    "четырнадцать",
    "пятнадцать",
    "шестнадцать",
    "семнадцать",
    "восемнадцать",
    "девятнадцать"
  ];
  const tens = [
    "",
    "",
    "двадцать",
    "тридцать",
    "сорок",
    "пятьдесят"
  ];

  if (value < 10) return units[value] ?? String(value);
  if (value < 20) return teens[value - 10] ?? String(value);
  if (value < 60) {
    const ten = Math.floor(value / 10);
    const unit = value % 10;
    return [tens[ten], unit > 0 ? units[unit] : ""].filter(Boolean).join(" ");
  }

  return String(value);
}

function ageToSpeech(age: number): string {
  const spoken = numberToRussianWords(age);

  if (age % 10 === 1 && age % 100 !== 11) {
    return `${spoken} год`;
  }

  if ([2, 3, 4].includes(age % 10) && ![12, 13, 14].includes(age % 100)) {
    return `${spoken} года`;
  }

  return `${spoken} лет`;
}

export function containsBannedSpeechWords(text: string): boolean {
  const lower = text.toLowerCase();
  const words = tokenizeRussian(lower);

  return bannedPsychologicalWords.some((word) => lower.includes(word))
    || bannedStressWords.some((word) => words.includes(word));
}

function tokenizeRussian(value: string): string[] {
  return value.split(/[^a-zа-яё0-9-]+/iu).filter(Boolean);
}
