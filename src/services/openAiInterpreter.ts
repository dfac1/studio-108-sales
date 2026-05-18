import { config } from "../config.js";
import type { Branch, Slot } from "../types.js";
import { semanticExtractionSystemPrompt } from "./salesPrompts.js";
import { callAnthropicTool, isAnthropicConfigured } from "./anthropicClient.js";

export interface AiExtractionInput {
  message: string;
  stage?: string;
  currentState: {
    customerName?: string;
    learnerType?: "child" | "adult" | "unknown";
    age?: number;
    need?: string;
    direction?: string;
    branch?: Branch;
    preferredTime?: "morning" | "day" | "evening";
    preferredWeekday?: Slot["weekday"];
    preferredDayType?: "weekday" | "weekend";
  };
}

export interface AiExtractionResult {
  customerName?: string;
  learnerType?: "child" | "adult" | "unknown";
  age?: number;
  need?: string;
  direction?: string;
  branch?: Branch;
  preferredTime?: "morning" | "day" | "evening";
  preferredWeekday?: Slot["weekday"];
  preferredDayType?: "weekday" | "weekend";
}

export type AiExtractionSource =
  | "disabled"
  | "openai"
  | "anthropic"
  | "timeout"
  | "network_error"
  | "http_error"
  | "empty_output"
  | "invalid_json";

export interface AiExtractionAttempt {
  result: AiExtractionResult | null;
  source: AiExtractionSource;
  latencyMs: number;
  error?: string;
  cacheUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
}

export function canUseOpenAiInterpreter(): boolean {
  if (process.env.VITEST || process.env.DISABLE_REMOTE_SEMANTICS === "1") {
    return false;
  }
  if (config.voice.semanticMode !== "hybrid") return false;
  if (config.brainProvider === "anthropic") return isAnthropicConfigured();
  return Boolean(config.openai.apiKey);
}

export async function extractWithOpenAi(input: AiExtractionInput): Promise<AiExtractionAttempt> {
  if (!canUseOpenAiInterpreter()) {
    return {
      result: null,
      source: "disabled",
      latencyMs: 0
    };
  }

  if (config.brainProvider === "anthropic") {
    return extractViaAnthropic(input);
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.voice.semanticTimeoutMs);
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.openai.extractionModelId,
        reasoning: {
          effort: "none"
        },
        temperature: 0,
        max_output_tokens: 120,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: semanticExtractionSystemPrompt
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify(input)
              }
            ]
          }
        ],
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: "sales_dialog_extraction",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                customerName: {
                  anyOf: [
                    { type: "string" },
                    { type: "null" }
                  ]
                },
                learnerType: {
                  anyOf: [
                    { type: "string", enum: ["child", "adult", "unknown"] },
                    { type: "null" }
                  ]
                },
                age: {
                  anyOf: [
                    { type: "integer", minimum: 1, maximum: 99 },
                    { type: "null" }
                  ]
                },
                need: {
                  anyOf: [
                    { type: "string" },
                    { type: "null" }
                  ]
                },
                direction: {
                  anyOf: [
                    { type: "string", enum: ["Hip-hop", "Breakdance", "Contemporary", "Йога", "Zumba", "Lady style", "Восточные танцы", "Jazz funk", "K-pop", "Salsa/Bachata", "Стрип-пластика", "Dancehall", "Детская хореография"] },
                    { type: "null" }
                  ]
                },
                branch: {
                  anyOf: [
                    { type: "string", enum: ["Развилка", "Озеро", "Школьная", "Черняховского"] },
                    { type: "null" }
                  ]
                },
                preferredTime: {
                  anyOf: [
                    { type: "string", enum: ["morning", "day", "evening"] },
                    { type: "null" }
                  ]
                },
                preferredWeekday: {
                  anyOf: [
                    { type: "string", enum: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] },
                    { type: "null" }
                  ]
                },
                preferredDayType: {
                  anyOf: [
                    { type: "string", enum: ["weekday", "weekend"] },
                    { type: "null" }
                  ]
                }
              },
              required: [
                "customerName",
                "learnerType",
                "age",
                "need",
                "direction",
                "branch",
                "preferredTime",
                "preferredWeekday",
                "preferredDayType"
              ]
            }
          }
        }
      })
    });
  } catch (error) {
    clearTimeout(timeout);
    return {
      result: null,
      source: error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error",
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : undefined
    };
  }
  clearTimeout(timeout);

  if (!response.ok) {
    return {
      result: null,
      source: "http_error",
      latencyMs: Date.now() - startedAt,
      error: await response.text()
    };
  }

  const data = await response.json();
  const outputText = extractStructuredOutputText(data);
  if (!outputText) {
    return {
      result: null,
      source: "empty_output",
      latencyMs: Date.now() - startedAt
    };
  }

  try {
    return {
      result: compactAiExtraction(JSON.parse(outputText) as Record<string, unknown>),
      source: "openai",
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      result: null,
      source: "invalid_json",
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : undefined
    };
  }
}

async function extractViaAnthropic(input: AiExtractionInput): Promise<AiExtractionAttempt> {
  const startedAt = Date.now();
  try {
    const result = await callAnthropicTool<Record<string, unknown>>({
      model: config.anthropic.extractionModel,
      system: semanticExtractionSystemPrompt,
      user: buildAnthropicExtractionUserPrompt(input),
      toolName: "record_extracted_facts",
      toolDescription: "Записать извлечённые из реплики клиента факты. Не угадывай: если факта явно нет, ставь null.",
      inputSchema: {
        type: "object",
        properties: {
          customerName: { type: ["string", "null"] },
          learnerType: { type: ["string", "null"], enum: ["child", "adult", "unknown", null] },
          age: { type: ["integer", "null"], minimum: 1, maximum: 99 },
          need: { type: ["string", "null"] },
          direction: { type: ["string", "null"], enum: ["Hip-hop", "Breakdance", "Contemporary", "Йога", "Zumba", "Lady style", "Восточные танцы", "Jazz funk", "K-pop", "Salsa/Bachata", "Стрип-пластика", "Dancehall", "Детская хореография", null] },
          branch: { type: ["string", "null"], enum: ["Развилка", "Озеро", "Школьная", "Черняховского", null] },
          preferredTime: { type: ["string", "null"], enum: ["morning", "day", "evening", null] },
          preferredWeekday: { type: ["string", "null"], enum: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс", null] },
          preferredDayType: { type: ["string", "null"], enum: ["weekday", "weekend", null] }
        },
        required: ["customerName", "learnerType", "age", "need", "direction", "branch", "preferredTime", "preferredWeekday", "preferredDayType"]
      },
      maxTokens: 350,
      temperature: 0,
      timeoutMs: config.voice.semanticTimeoutMs,
      cacheTtl: config.anthropic.cacheTtl
    });

    if (!result.input) {
      return {
        result: null,
        source: "empty_output",
        latencyMs: result.latencyMs
      };
    }

    return {
      result: compactAiExtraction(result.input),
      source: "anthropic",
      latencyMs: result.latencyMs,
      cacheUsage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === "AbortError";
    return {
      result: null,
      source: isTimeout ? "timeout" : message.includes("Anthropic ") ? "http_error" : "network_error",
      latencyMs: Date.now() - startedAt,
      error: message
    };
  }
}

function buildAnthropicExtractionUserPrompt(input: AiExtractionInput): string {
  const lines: string[] = [];
  lines.push("<turn>");
  lines.push(`<message>${escapeXmlForExtraction(input.message)}</message>`);
  if (input.stage) lines.push(`<stage>${input.stage}</stage>`);
  lines.push("<known_state>");
  for (const [k, v] of Object.entries(input.currentState ?? {})) {
    if (v != null && v !== "") lines.push(`  <${k}>${escapeXmlForExtraction(String(v))}</${k}>`);
  }
  lines.push("</known_state>");
  lines.push("</turn>");
  lines.push("");
  lines.push("Извлеки только те факты, которые явно есть в message. Не угадывай по контексту known_state.");
  lines.push("Если фразой клиент только спрашивает что-то (например, «какие направления есть?»), не заполняй поля need/direction.");
  lines.push("Не считай приветствия (\"здравствуйте\", \"привет\") за need.");
  lines.push("Если факт отсутствует — ставь null.");
  return lines.join("\n");
}

function escapeXmlForExtraction(value: string): string {
  return value.replace(/[<>&"]/g, (ch) => {
    switch (ch) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "\"": return "&quot;";
      default: return ch;
    }
  });
}

function extractStructuredOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const direct = Reflect.get(payload, "output_text");
  if (typeof direct === "string" && direct.trim()) {
    return direct;
  }

  const output = Reflect.get(payload, "output");
  if (!Array.isArray(output)) {
    return "";
  }

  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const content = Reflect.get(item, "content");
    if (!Array.isArray(content)) {
      continue;
    }

    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }

      if (Reflect.get(block, "type") === "output_text") {
        const text = Reflect.get(block, "text");
        if (typeof text === "string" && text.trim()) {
          return text;
        }
      }
    }
  }

  return "";
}

function compactAiExtraction(raw: Record<string, unknown>): AiExtractionResult {
  const result: AiExtractionResult = {};

  if (typeof raw.customerName === "string" && raw.customerName.trim()) {
    result.customerName = raw.customerName.trim();
  }
  if (raw.learnerType === "child" || raw.learnerType === "adult" || raw.learnerType === "unknown") {
    result.learnerType = raw.learnerType;
  }
  if (typeof raw.age === "number") {
    result.age = raw.age;
  }
  if (typeof raw.need === "string" && raw.need.trim()) {
    result.need = raw.need.trim();
  }
  if (typeof raw.direction === "string" && raw.direction.trim()) {
    result.direction = raw.direction.trim();
  }
  if (typeof raw.branch === "string" && raw.branch.trim()) {
    result.branch = raw.branch as Branch;
  }
  if (raw.preferredTime === "morning" || raw.preferredTime === "day" || raw.preferredTime === "evening") {
    result.preferredTime = raw.preferredTime;
  }
  if (raw.preferredWeekday === "Пн" || raw.preferredWeekday === "Вт" || raw.preferredWeekday === "Ср" || raw.preferredWeekday === "Чт" || raw.preferredWeekday === "Пт" || raw.preferredWeekday === "Сб" || raw.preferredWeekday === "Вс") {
    result.preferredWeekday = raw.preferredWeekday;
  }
  if (raw.preferredDayType === "weekday" || raw.preferredDayType === "weekend") {
    result.preferredDayType = raw.preferredDayType;
  }

  return result;
}
