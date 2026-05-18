import {
  estimateCallCostFromConversationProfile,
  formatUsd
} from "../src/services/callCostModel.js";

const telephonyInboundPerMinuteUsd = Number(process.env.TELEPHONY_INBOUND_PER_MINUTE_USD ?? 0);
const telephonyBridgePerMinuteUsd = Number(process.env.TELEPHONY_BRIDGE_PER_MINUTE_USD ?? 0);

const baseProfile = {
  callMinutes: 4,
  assistantMessages: 8,
  assistantCharacters: 650,
  semanticExtractions: 2,
  includePostCallSummary: false,
  brainProvider: "anthropic" as const,
  cacheTtl: "5m" as const
};

const scenarios = [
  {
    name: "web_voice_short_warm",
    label: "Короткий веб-диалог, warm cache (предыдущий звонок был <5 мин назад)",
    profile: {
      ...baseProfile,
      callMinutes: 2.5,
      assistantMessages: 5,
      assistantCharacters: 320,
      semanticExtractions: 1,
      warmCache: true
    }
  },
  {
    name: "web_voice_short_cold",
    label: "Короткий веб-диалог, cold cache (первый звонок за 5+ мин)",
    profile: {
      ...baseProfile,
      callMinutes: 2.5,
      assistantMessages: 5,
      assistantCharacters: 320,
      semanticExtractions: 1,
      warmCache: false
    }
  },
  {
    name: "phone_standard_warm",
    label: "Стандартный звонок 4 минуты, warm cache",
    profile: {
      ...baseProfile,
      warmCache: true
    }
  },
  {
    name: "phone_standard_cold",
    label: "Стандартный звонок 4 минуты, cold cache",
    profile: {
      ...baseProfile,
      warmCache: false
    }
  },
  {
    name: "phone_standard_with_carrier",
    label: "Стандартный звонок 4 минуты + телефония",
    profile: {
      ...baseProfile,
      warmCache: true,
      telephonyInboundPerMinuteUsd,
      telephonyBridgePerMinuteUsd
    }
  },
  {
    name: "phone_long_messy_cold",
    label: "Длинный звонок (6 мин, 10 turns), cold cache",
    profile: {
      ...baseProfile,
      callMinutes: 6,
      assistantMessages: 10,
      assistantCharacters: 1050,
      semanticExtractions: 4,
      warmCache: false
    }
  },
  {
    name: "openai_baseline",
    label: "Старая схема (OpenAI gpt-5.4) — для сравнения",
    profile: {
      ...baseProfile,
      brainProvider: "openai" as const
    }
  }
];

for (const scenario of scenarios) {
  const breakdown = estimateCallCostFromConversationProfile(scenario.profile);
  console.log(`\n=== ${scenario.label} ===`);
  for (const item of breakdown.items) {
    console.log(`${item.label.padEnd(48)} ${formatUsd(item.withTopUpUsd)} (base ${formatUsd(item.baseUsd)})`);
  }
  console.log(`${"".padEnd(48)} ${"-".repeat(35)}`);
  console.log(`${"ИТОГО".padEnd(48)} ${formatUsd(breakdown.totals.withTopUpUsd)} (base ${formatUsd(breakdown.totals.baseUsd)})`);
}

console.log("\nНапоминание: курс 95 ₽/$ → ~$0.10 = ~9.5 ₽");
