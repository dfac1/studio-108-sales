process.env.DISABLE_REMOTE_SEMANTICS = "1";

const [{ handleSalesDialog }, { resetAvailabilityForTests }] = await Promise.all([
  import("../src/services/salesDialog.js"),
  import("../src/services/availabilityService.js")
]);

interface SalesDialogState {
  customerName?: string;
  phone?: string;
  need?: string;
  direction?: string;
  age?: number;
  learnerType?: "child" | "adult" | "unknown";
  preferredTime?: "morning" | "day" | "evening";
  preferredWeekday?: "Пн" | "Вт" | "Ср" | "Чт" | "Пт" | "Сб" | "Вс";
  preferredDayType?: "weekday" | "weekend";
  branch?: "Озеро" | "Развилка" | "Школьная" | "Черняховского";
  offeredSlots?: unknown[];
  offeredSlotIndex?: number;
  selectedSlotId?: string;
  personalDataConsent?: boolean;
  aiVoiceDisclosure?: boolean;
  crossBorderTransfer?: boolean;
  stage?: string;
}

interface Scenario {
  name: string;
  messages: string[];
  mustContain?: string[];
  mustNotContain?: string[];
}

const bannedPhrases = [
  "приятно.",
  "сориентируйте",
  "будущему ученику",
  "под ваш запрос",
  "разовое пробное, чтобы спокойно попробовать группу",
  "уверенност",
  "раскрепост",
  "самовыраж",
  "для души",
  "втянул"
];

const scenarios: Scenario[] = [
  {
    name: "child vague need must stay in discovery",
    messages: ["Здравствуйте", "Сергей", "для сына 6 лет"],
    mustContain: ["что хотите от занятий для ребенка"],
    mustNotContain: ["Где вам удобнее", "Ближайший"]
  },
  {
    name: "child confidence need",
    messages: ["Здравствуйте", "Сергей", "для сына 6 лет", "хочется, чтобы попробовал танцы и втянулся", "Развилка"],
    mustContain: ["вторник в 17:30", "Пробное стоит 300 рублей"],
    mustNotContain: ["педагог", "свободных мест"]
  },
  {
    name: "child specific breakdance",
    messages: ["Добрый день", "Ольга", "сыну 9 лет интересен брейкданс", "Развилка"],
    mustContain: ["брейк", "вторник"],
    mustNotContain: ["педагог", "свободных мест"]
  },
  {
    name: "adult yoga",
    messages: ["Привет", "Марина", "для себя хочу мягко для спины и растяжку", "Развилка"],
    mustContain: ["йог", "вторник"],
    mustNotContain: ["сколько лет"]
  },
  {
    name: "adult plastic request stays neutral until direction is clearer",
    messages: ["Здравствуйте, Ирина", "хочу больше пластики и уверенности", "у озера"],
    mustContain: ["актив", "конкретное направление"],
    mustNotContain: ["леди", "сколько лет"]
  },
  {
    name: "not suitable time suggests next",
    messages: ["Здравствуйте", "Анна", "сын 6 лет хочет попробовать танцы, чтобы раскрепостился", "Развилка", "нет, вторник не подходит"],
    mustContain: ["четверг в 17:30"],
    mustNotContain: ["педагог", "свободных мест"]
  },
  {
    name: "full booking",
    messages: ["Здравствуйте", "Анна", "сын 6 лет хочет попробовать танцы, чтобы раскрепостился", "Развилка", "да, подходит", "+79990001010", "да"],
    mustContain: ["готово", "записала", "хип-хоп"],
    mustNotContain: ["педагог", "свободных мест"]
  },
  {
    name: "unknown branch wording",
    messages: ["Здравствуйте", "Наталья", "дочке 5 лет, просто попробовать танцы", "где-нибудь поближе"],
    mustContain: ["Развилка", "озера", "первой школы"],
    mustNotContain: ["Ближайший"]
  },
  {
    name: "only direction no branch",
    messages: ["Здравствуйте", "Маша", "интересует K-pop"],
    mustContain: ["сколько вам лет"],
    mustNotContain: ["Где вам удобнее"]
  },
  {
    name: "salsa no age required",
    messages: ["Здравствуйте", "Алексей", "хочу сальсу или бачату", "Развилка"],
    mustContain: ["воскресенье", "400 рублей"],
    mustNotContain: ["сколько лет"]
  },
  {
    name: "word age in full first request",
    messages: ["Здравствуйте, Сергей", "сыну шесть лет, хочет хип-хоп, любит что-то активное", "Развилка"],
    mustContain: ["вторник в 17:30"],
    mustNotContain: ["сколько лет", "педагог", "свободных мест"]
  },
  {
    name: "center branch must clarify exact center location",
    messages: ["Здравствуйте", "Елена", "дочери пять лет, просто попробовать танцы и координацию", "в центре"],
    mustContain: ["у озера", "возле первой школы"],
    mustNotContain: ["Ближайший"]
  },
  {
    name: "adult vague dance must not jump to branch",
    messages: ["Здравствуйте", "Павел", "для себя хочу просто танцы"],
    mustContain: ["актив"],
    mustNotContain: ["Где вам удобнее", "Ближайший"]
  },
  {
    name: "male generic dance request stays neutral",
    messages: ["привет инокентий я хочу танцевать"],
    mustContain: ["актив"],
    mustNotContain: ["женствен", "для девушек", "леди"]
  },
  {
    name: "age as one digit answer closes age step",
    messages: ["Здравствуйте", "Сергей", "сын хочет хип-хоп, любит что-то активное", "6", "Развилка"],
    mustContain: ["вторник в 17:30"],
    mustNotContain: ["сколько лет"]
  },
  {
    name: "age as word answer closes age step",
    messages: ["Здравствуйте", "Сергей", "сын хочет хип-хоп, любит что-то активное", "шесть", "Развилка"],
    mustContain: ["вторник в 17:30"],
    mustNotContain: ["сколько лет"]
  },
  {
    name: "standalone child digit in need",
    messages: ["Здравствуйте", "Сергей", "дочке 6, хочет танцы, чтобы раскрепостилась", "Развилка"],
    mustContain: ["вторник в 17:30"],
    mustNotContain: ["сколько лет"]
  },
  {
    name: "asks evening before branch",
    messages: ["Здравствуйте", "Сергей", "сын 6 лет хочет хип-хоп, лучше вечером", "Развилка"],
    mustContain: ["17:30"],
    mustNotContain: ["утро"]
  },
  {
    name: "asks saturday after offer",
    messages: ["Здравствуйте", "Сергей", "сын 6 лет хочет хип-хоп", "Развилка", "нет, нужна суббота"],
    mustContain: ["другой день", "администратора"],
    mustNotContain: ["Напишите, пожалуйста, номер"]
  },
  {
    name: "asks price after offer",
    messages: ["Здравствуйте", "Сергей", "сын 6 лет хочет попробовать танцы, чтобы раскрепостился", "Развилка", "а сколько стоит?"],
    mustContain: ["300 рублей", "вторник в 17:30"],
    mustNotContain: ["какой вариант"]
  },
  {
    name: "asks teacher after offer",
    messages: ["Здравствуйте", "Сергей", "сын 6 лет хочет попробовать танцы, чтобы раскрепостился", "Развилка", "а кто ведет?"],
    mustContain: ["Анна"],
    mustNotContain: ["свободных мест"]
  },
  {
    name: "thinks after offer",
    messages: ["Здравствуйте", "Сергей", "сын 6 лет хочет попробовать танцы, чтобы раскрепостился", "Развилка", "я подумаю"],
    mustContain: ["пробное", "место"],
    mustNotContain: ["Напишите, пожалуйста, номер"]
  },
  {
    name: "all current branch times rejected",
    messages: ["Здравствуйте", "Сергей", "сын 6 лет хочет попробовать танцы, чтобы раскрепостился", "Развилка", "ни один вариант не подходит"],
    mustContain: ["другой филиал"],
    mustNotContain: ["Напишите, пожалуйста, номер"]
  },
  {
    name: "no time objection",
    messages: ["Здравствуйте", "Сергей", "сын 6 лет хочет попробовать танцы, чтобы раскрепостился", "Развилка", "нет времени"],
    mustContain: ["будни", "выходные"],
    mustNotContain: ["Напишите, пожалуйста, номер"]
  },
  {
    name: "far objection returns to branch choice",
    messages: ["Здравствуйте", "Сергей", "сын 6 лет хочет попробовать танцы, чтобы раскрепостился", "Развилка", "далеко ехать"],
    mustContain: ["филиал ближе", "Развилка", "озера"],
    mustNotContain: ["Напишите, пожалуйста, номер"]
  },
  {
    name: "shy objection",
    messages: ["Здравствуйте", "Сергей", "сын 6 лет хочет попробовать танцы, чтобы раскрепостился", "Развилка", "он стесняется и не умеет"],
    mustContain: ["с нуля", "Пробное"],
    mustNotContain: ["Напишите, пожалуйста, номер"]
  },
  {
    name: "subscription price question",
    messages: ["Здравствуйте", "Марина", "для себя хочу мягко для спины и растяжку", "Развилка", "а абонемент сколько стоит?"],
    mustContain: ["Пробное", "абонемент", "4000"],
    mustNotContain: ["Напишите, пожалуйста, номер"]
  },
  {
    name: "typo in hip hop",
    messages: ["Привет", "антон", "сыну 6 лет нужен хип хоп, любит что-то активное", "Развилка"],
    mustContain: ["хип-хоп", "вторник в 17:30"],
    mustNotContain: ["сколько лет"]
  },
  {
    name: "broken phrase with filler words",
    messages: ["здрасьте", "я антон", "короче ребенку 6, ну просто попробовать танцы", "развилка"],
    mustContain: ["вторник в 17:30"],
    mustNotContain: ["сколько лет"]
  },
  {
    name: "voice-like short answers",
    messages: ["Здравствуйте", "Антон", "ребенку", "6", "хочется, чтобы понравилось и втянулся", "Развилка"],
    mustContain: ["вторник в 17:30"],
    mustNotContain: ["сколько лет"]
  },
  {
    name: "messy typo branch",
    messages: ["Здравствуйте", "Антон", "сын 6 лет хочет танцы, чтобы раскрепостился", "развилк"],
    mustContain: ["вторник в 17:30"],
    mustNotContain: ["Где вам удобнее"]
  },
  {
    name: "adult message with no punctuation",
    messages: ["привет меня зовут ирина", "хочу для себя что то женственное и пластичное", "озеро"],
    mustContain: ["леди", "вторник"],
    mustNotContain: ["сколько лет"]
  },
  {
    name: "asks weekend in messy form",
    messages: ["Здравствуйте", "Антон", "сын 6 лет хочет хип-хоп", "Развилка", "а по выхам есть че?"],
    mustContain: ["другой день", "администратора"],
    mustNotContain: ["Напишите, пожалуйста, номер"]
  },
  {
    name: "price slang",
    messages: ["Здравствуйте", "Антон", "сын 6 лет хочет танцы, чтобы раскрепостился", "Развилка", "че по цене"],
    mustContain: ["300 рублей"],
    mustNotContain: ["Напишите, пожалуйста, номер"]
  },
  {
    name: "early price question before direction",
    messages: ["Здравствуйте", "Анна", "сколько стоит?"],
    mustContain: ["от 300 рублей", "для вас или для ребенка"],
    mustNotContain: ["номер телефона"]
  },
  {
    name: "too young child handoff",
    messages: ["Здравствуйте", "Анна", "для ребенка", "просто попробовать танцы", "3 года"],
    mustContain: ["с 4 лет", "администратор"],
    mustNotContain: ["вторник", "четверг"]
  },
  {
    name: "address question before branch choice",
    messages: ["Здравствуйте", "Ирина", "где вы находитесь?"],
    mustContain: ["три основных филиала", "какой район"],
    mustNotContain: ["номер телефона"]
  },
  {
    name: "packed first message with all main facts",
    messages: ["Здравствуйте, меня зовут Анна. Хочу записать ребенка 5 лет, чтобы раскрепостился и втянулся в танцы."],
    mustContain: ["Где вам удобнее заниматься"],
    mustNotContain: ["Как к вам можно обращаться"]
  },
  {
    name: "ozero should not trigger yes by accident",
    messages: ["Здравствуйте, меня зовут Анна. Хочу что-нибудь поженственнее для себя, у озера после шести."],
    mustContain: ["Пробное стоит 300 рублей"],
    mustNotContain: ["Напишите, пожалуйста, номер телефона"]
  },
  {
    name: "natural child phrasing with 'ему шесть'",
    messages: ["Привет, я Инокентий. Для сына, ему шесть, лучше в районе озера после школы, хочет раскрепоститься и просто попробовать танцы."],
    mustContain: ["Пробное стоит 300 рублей"],
    mustNotContain: ["Как к вам можно обращаться"]
  },
  {
    name: "teacher slang",
    messages: ["Здравствуйте", "Антон", "сын 6 лет хочет танцы, чтобы раскрепостился", "Развилка", "а кто тренер"],
    mustContain: ["Анна"],
    mustNotContain: ["свободных мест"]
  },
  {
    name: "hesitation slang",
    messages: ["Здравствуйте", "Антон", "сын 6 лет хочет танцы, чтобы раскрепостился", "Развилка", "щас не знаю надо подумать"],
    mustContain: ["оставить место"],
    mustNotContain: ["Напишите, пожалуйста, номер"]
  },
  {
    name: "far slang",
    messages: ["Здравствуйте", "Антон", "сын 6 лет хочет танцы, чтобы раскрепостился", "Развилка", "блин далековато"],
    mustContain: ["филиал ближе"],
    mustNotContain: ["Напишите, пожалуйста, номер"]
  }
];

async function runScenario(scenario: Scenario) {
  resetAvailabilityForTests();
  let state: SalesDialogState = {};
  const transcript: Array<{ user: string; action: string; reply: string }> = [];

  for (const message of scenario.messages) {
    const result = await handleSalesDialog({ message, state });
    state = result.state;
    transcript.push({ user: message, action: result.action, reply: result.reply });
  }

  const finalReply = transcript.at(-1)?.reply ?? "";
  const errors: string[] = [];

  for (const part of scenario.mustContain ?? []) {
    if (!finalReply.toLowerCase().includes(part.toLowerCase())) {
      errors.push(`missing "${part}"`);
    }
  }

  for (const part of scenario.mustNotContain ?? []) {
    if (finalReply.toLowerCase().includes(part.toLowerCase())) {
      errors.push(`forbidden "${part}"`);
    }
  }

  for (const step of transcript) {
    for (const phrase of bannedPhrases) {
      if (step.reply.toLowerCase().includes(phrase.toLowerCase())) {
        errors.push(`style "${phrase}"`);
      }
    }
  }

  return { scenario, transcript, errors };
}

let failed = 0;
for (const scenario of scenarios) {
  const result = await runScenario(scenario);
  if (result.errors.length) {
    failed += 1;
    console.log(`FAIL: ${scenario.name}`);
    console.log(result.errors.join("; "));
    console.log(result.transcript.map((step) => `${step.user} -> [${step.action}] ${step.reply}`).join("\n"));
    console.log("");
  } else {
    console.log(`OK: ${scenario.name}`);
  }
}

if (failed) {
  process.exitCode = 1;
}
