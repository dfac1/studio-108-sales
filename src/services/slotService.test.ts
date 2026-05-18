import { describe, expect, it } from "vitest";
import { getPrice } from "../data/pricing.js";
import { bookingInputSchema } from "./bookingService.js";
import { validateCompliance } from "./complianceService.js";
import { findSlots } from "./slotService.js";
import { respondToInboundLead } from "./voiceAgent.js";
import { handleSalesDialog } from "./salesDialog.js";

describe("Studio 108 sales rules", () => {
  it("does not offer strip plastic on Shkolnaya", () => {
    const result = findSlots({ direction: "Стрип-пластика", branch: "Школьная", limit: 10 });
    expect(result).toHaveLength(0);
  });

  it("uses special trial price for Salsa/Bachata", () => {
    expect(getPrice("Salsa/Bachata", "Озеро").trial).toBe(400);
  });

  it("uses Razvilka Breakdance subscription exception", () => {
    expect(getPrice("Breakdance", "Развилка").subscription).toBe(4700);
  });

  it("requires personal data consent for bookings", () => {
    const parsed = bookingInputSchema.safeParse({
      customerName: "Анна",
      phone: "+79990000000",
      direction: "Йога",
      branch: "Развилка",
      slotId: "test",
      source: "manual_test",
      consent: {
        aiVoiceDisclosure: true
      }
    });

    expect(parsed.success).toBe(false);
  });

  it("flags ElevenLabs cross-border risk when consent is missing", () => {
    const issues = validateCompliance({
      channel: "inbound_call",
      provider: "elevenlabs",
      callRecording: true,
      hasPersonalDataConsent: true,
      hasAiDisclosure: false,
      hasCrossBorderConsent: false
    });

    expect(issues.some((issue) => issue.includes("трансграничной"))).toBe(true);
  });

  it("offers matching inbound slots in Russian", () => {
    const response = respondToInboundLead({
      transcript: "Добрый день, хочу записать ребенка 5 лет на хип-хоп на Развилке"
    });

    expect(response.nextAction).toBe("offer_slots");
    expect(response.reply).toMatch(/Пробное\s*(?:занятие\s*)?стоит/);
    expect(response.reply).not.toContain("PRO");
    expect(response.reply).toContain("свободных мест");
  });

  it("does not expose the internal branch on the public slot search", () => {
    const result = findSlots({ branch: "Черняховского", limit: 10 });
    expect(result).toHaveLength(0);
  });

  it("walks through the classic sales flow and books automatically", async () => {
    let state = {};

    const step = async (message: string) => {
      const result = await handleSalesDialog({ message, state });
      state = result.state;
      return result;
    };

    const greeting = await step("Здравствуйте");
    expect(greeting.action).toBe("ask_name");
    expect(greeting.reply).not.toContain("AI");
    expect((await step("Меня зовут Анна")).action).toBe("ask_learner");
    // Бот теперь объявляет предложенное direction и просит подтвердить (ask_direction_confirm),
    // вместо того чтобы молча выбрать и переходить дальше. Это UX-фикс — клиент не должен
    // обнаруживать, что его записывают на хип-хоп, без явного подтверждения.
    expect((await step("Хочу для ребенка, чтобы раскрепостился и ему понравились танцы")).action).toBe("ask_direction_confirm");
    // Возраст пришёл — это implicit accept предложенного direction.
    expect((await step("5 лет")).action).toBe("ask_branch");
    expect((await step("Развилка")).action).toBe("offer_solution");
    expect((await step("Первый вариант подходит")).action).toBe("ask_phone");
    expect((await step("+79990000002")).action).toBe("ask_consent");
    const booked = await step("Да, согласна");

    expect(booked.action).toBe("booked");
    expect(booked.booking?.customerName).toBe("Анна");
  });

  it("recognizes a name from a greeting with comma", async () => {
    let state = {};
    const first = await handleSalesDialog({ message: "Здравствуйте", state });
    state = first.state;

    const second = await handleSalesDialog({ message: "Здравствуйте, Сергей", state });

    expect(second.action).toBe("ask_learner");
    expect(second.state.customerName).toBe("Сергей");
  });

  it("recognizes a name from a greeting with extra text", async () => {
    const result = await handleSalesDialog({
      message: "Здравствуйте, Инокентий. У вас танцы?",
      state: {}
    });

    expect(result.action).toBe("ask_learner");
    expect(result.state.customerName).toBe("Инокентий");
    expect(result.reply).not.toContain("Как к вам можно обращаться");
  });

  it("extracts a lowercase name after a simple greeting", async () => {
    const result = await handleSalesDialog({
      message: "привет инокентий",
      state: {}
    });

    expect(result.action).toBe("ask_learner");
    expect(result.state.customerName).toBe("Инокентий");
  });

  it("keeps discovery neutral for a male customer with a generic dance request", async () => {
    const result = await handleSalesDialog({
      message: "привет инокентий я хочу танцевать",
      state: {}
    });

    expect(result.state.customerName).toBe("Инокентий");
    expect(result.state.customerGender).toBe("male");
    expect(result.action).toBe("ask_need");
    expect(result.reply.toLowerCase()).not.toContain("женствен");
    expect(result.reply.toLowerCase()).not.toContain("для девушек");
    expect(result.reply.toLowerCase()).not.toContain("леди");
    expect(result.reply.toLowerCase()).not.toContain("уверенн");
    expect(result.reply.toLowerCase()).not.toContain("раскрепост");
  });

  it("keeps a soft need from a full first message with the customer name", async () => {
    const result = await handleSalesDialog({
      message: "Здравствуйте, меня зовут Анна. Хочу записать ребенка 5 лет, чтобы раскрепостился и втянулся в танцы.",
      state: {}
    });

    expect(result.state.customerName).toBe("Анна");
    expect(result.state.learnerType).toBe("child");
    expect(result.state.age).toBe(5);
    expect(result.state.need?.toLowerCase()).toContain("раскреп");
    expect(result.action).not.toBe("ask_name");
  });

  it("does not confuse 'озера' with a positive confirmation", async () => {
    const result = await handleSalesDialog({
      message: "Здравствуйте, меня зовут Анна. Хочу что-нибудь поженственнее для себя, у озера после шести.",
      state: {}
    });

    expect(result.action).toBe("offer_solution");
    expect(result.slots?.length ?? 0).toBeGreaterThan(0);
    expect(result.reply.toLowerCase()).toMatch(/(?:подойд|удобн|можно)/);
  });

  it("does not map confidence alone to lady style for an adult lead", async () => {
    const result = await handleSalesDialog({
      message: "Здравствуйте, меня зовут Сергей. Хочу для себя просто начать танцевать и раскрепоститься.",
      state: {}
    });

    expect(result.state.customerName).toBe("Сергей");
    expect(result.state.customerGender).toBe("male");
    expect(result.state.direction).toBeUndefined();
    expect(result.action).toBe("ask_need");
    expect(result.reply.toLowerCase()).not.toContain("леди");
    expect(result.reply.toLowerCase()).not.toContain("женствен");
    expect(result.reply.toLowerCase()).not.toContain("уверенн");
    expect(result.reply.toLowerCase()).not.toContain("раскрепост");
  });

  it("parses age from natural phrasing like 'ему шесть'", async () => {
    const result = await handleSalesDialog({
      message: "Привет, я Инокентий. Для сына, ему шесть, лучше в районе озера после школы, хочет раскрепоститься и просто попробовать танцы.",
      state: {}
    });

    expect(result.state.customerName).toBe("Инокентий");
    expect(result.state.age).toBe(6);
    expect(result.state.learnerType).toBe("child");
    expect(result.state.branch).toBe("Озеро");
    expect(result.action).not.toBe("ask_name");
  });

  it("parses a packed first message with name, age, direction and branch", async () => {
    const result = await handleSalesDialog({
      message: "Здравствуйте, меня зовут Анна. Хочу записать ребенка 5 лет на хип-хоп на Развилке.",
      state: {}
    });

    expect(result.state.customerName).toBe("Анна");
    expect(result.state.learnerType).toBe("child");
    expect(result.state.age).toBe(5);
    expect(result.state.direction).toBe("Hip-hop");
    expect(result.state.branch).toBe("Развилка");
    expect(result.action).toBe("offer_solution");
  });

  it("answers early price question and keeps the flow moving", async () => {
    const result = await handleSalesDialog({
      message: "сколько стоит?",
      state: { customerName: "Анна" }
    });

    expect(result.reply).toContain("от 300 рублей");
    expect(result.action).toBe("ask_learner");
  });

  it("does not offer a group younger than the minimum age", async () => {
    let state = {};

    const step = async (message: string) => {
      const result = await handleSalesDialog({ message, state });
      state = result.state;
      return result;
    };

    await step("Здравствуйте");
    await step("Анна");
    await step("для ребенка");
    await step("просто попробовать танцы");
    const result = await step("3 года");

    expect(result.action).toBe("handoff");
    expect(result.reply).toContain("стартуют примерно с 4 лет");
  });

  it("does not leave discovery when the need is not clear", async () => {
    let state = {};

    const step = async (message: string) => {
      const result = await handleSalesDialog({ message, state });
      state = result.state;
      return result;
    };

    await step("Здравствуйте");
    await step("Сергей");
    const unclear = await step("для сына 6 лет");

    expect(unclear.action).toBe("ask_need");
    // askNeedChild имеет несколько вариантов: «для сына/дочки/ребёнка» либо «чтобы ему/ей/ребёнку понравилось».
    // Принимаем оба паттерна, чтобы тест не зависел от случайного выбора варианта.
    expect(unclear.reply.toLowerCase()).toMatch(/(для\s+(?:ребенка|ребёнка|сына|сыну|дочки|дочке)|ребенку|ребёнку|сыну|дочке|чтобы\s+(?:ему|ей|ребёнку|ребенку))/);

    const clarified = await step("хочется, чтобы просто попробовал и втянулся");
    // Need был размытый (без явного направления). После уточнения бот предлагает направление
    // и просит подтвердить — это UX-фикс, чтобы клиент не обнаруживал, что его записывают
    // на неизвестное направление.
    expect(clarified.action).toBe("ask_direction_confirm");
  });

  it("accepts age as a short answer when age is the current step", async () => {
    let state = {};

    const step = async (message: string) => {
      const result = await handleSalesDialog({ message, state });
      state = result.state;
      return result;
    };

    await step("Здравствуйте");
    await step("Сергей");
    await step("сын хочет хип-хоп, любит что-то активное");
    const age = await step("6");

    expect(age.action).toBe("ask_branch");
  });

  it("answers teacher questions without moving to booking", async () => {
    let state = {};

    const step = async (message: string) => {
      const result = await handleSalesDialog({ message, state });
      state = result.state;
      return result;
    };

    await step("Здравствуйте");
    await step("Сергей");
    await step("сын 6 лет хочет попробовать танцы, чтобы раскрепостился");
    await step("Развилка");
    const teacher = await step("а кто ведет?");

    expect(teacher.action).toBe("offer_solution");
    expect(teacher.reply).toContain("Анна");
    expect(teacher.reply).not.toContain("свободных мест");
  });

  it("handles thinking objection without overwriting customer name", async () => {
    let state = {};

    const step = async (message: string) => {
      const result = await handleSalesDialog({ message, state });
      state = result.state;
      return result;
    };

    await step("Здравствуйте");
    await step("Сергей");
    await step("сын 6 лет хочет попробовать танцы, чтобы раскрепостился");
    await step("Развилка");
    const objection = await step("я подумаю");

    expect(objection.state.customerName).toBe("Сергей");
    expect(objection.reply.toLowerCase()).toMatch(/(?:подержать|оставить)\s+место/);
  });
});
