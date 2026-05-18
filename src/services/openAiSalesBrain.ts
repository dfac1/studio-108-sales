import { config } from "../config.js";
import type { Branch, Slot } from "../types.js";
import { salesReplyBrainSystemPrompt } from "./salesPrompts.js";
import { callAnthropicText, isAnthropicConfigured } from "./anthropicClient.js";

export type SalesBrainAction =
  | "ask_name"
  | "ask_learner"
  | "ask_need"
  | "ask_age"
  | "ask_direction_confirm"
  | "ask_branch"
  | "offer_solution"
  | "ask_slot_choice"
  | "ask_phone"
  | "ask_consent"
  | "booked"
  | "handoff";

export interface SalesBrainState {
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
  offeredSlotIndex?: number;
  selectedSlotId?: string;
  personalDataConsent?: boolean;
  stage?: string;
}

export interface SalesReplyBrainInput {
  action: SalesBrainAction;
  customerMessage: string;
  fallbackReply: string;
  state: SalesBrainState;
  slots?: Array<{
    weekday: Slot["weekday"];
    time: string;
    branch: Branch;
    direction: string;
    level?: string;
    teacher?: string;
  }>;
  context?: {
    currentSlot?: {
      weekday: Slot["weekday"];
      time: string;
      branch: Branch;
      direction: string;
      teacher?: string;
      address?: string;
      floor?: string;
    };
    price?: {
      trial?: number;
      subscription?: number | null;
    };
    notes?: string[];
  };
}

export interface SalesReplyBrainResult {
  reply: string;
  source: "disabled" | "anthropic" | "openai" | "timeout" | "network_error" | "http_error" | "empty_output" | "invalid_json";
  latencyMs: number;
  error?: string;
  cacheUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
}

export function canUseOpenAiSalesBrain(): boolean {
  if (process.env.VITEST || process.env.DISABLE_REMOTE_SEMANTICS === "1") {
    return false;
  }
  if (config.brainProvider === "anthropic") return isAnthropicConfigured();
  return Boolean(config.openai.apiKey);
}

export async function generateSalesReply(input: SalesReplyBrainInput): Promise<SalesReplyBrainResult> {
  if (!canUseOpenAiSalesBrain()) {
    return {
      reply: input.fallbackReply,
      source: "disabled",
      latencyMs: 0
    };
  }

  if (config.brainProvider === "anthropic") {
    return generateSalesReplyViaAnthropic(input);
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.openai.dialogTimeoutMs);
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
        model: config.openai.dialogModelId,
        reasoning: {
          effort: "none"
        },
        max_output_tokens: 140,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: salesReplyBrainSystemPrompt
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
            name: "sales_reply_brain",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                reply: { type: "string" }
              },
              required: ["reply"]
            }
          }
        }
      })
    });
  } catch (error) {
    clearTimeout(timeout);
    return {
      reply: input.fallbackReply,
      source: error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error",
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : undefined
    };
  }

  clearTimeout(timeout);

  if (!response.ok) {
    return {
      reply: input.fallbackReply,
      source: "http_error",
      latencyMs: Date.now() - startedAt,
      error: await response.text()
    };
  }

  const data = await response.json();
  const outputText = extractStructuredOutputText(data);
  if (!outputText) {
    return {
      reply: input.fallbackReply,
      source: "empty_output",
      latencyMs: Date.now() - startedAt
    };
  }

  try {
    const parsed = JSON.parse(outputText) as { reply?: string };
    if (typeof parsed.reply !== "string" || !parsed.reply.trim()) {
      return {
        reply: input.fallbackReply,
        source: "invalid_json",
        latencyMs: Date.now() - startedAt
      };
    }

    return {
      reply: parsed.reply.trim(),
      source: "openai",
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      reply: input.fallbackReply,
      source: "invalid_json",
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : undefined
    };
  }
}

async function generateSalesReplyViaAnthropic(input: SalesReplyBrainInput): Promise<SalesReplyBrainResult> {
  const startedAt = Date.now();
  const userPrompt = buildAnthropicUserPrompt(input);

  try {
    const result = await callAnthropicText({
      model: config.anthropic.dialogModel,
      system: salesReplyBrainSystemPrompt,
      user: userPrompt,
      maxTokens: 250,
      temperature: 0.55,
      timeoutMs: config.anthropic.dialogTimeoutMs,
      cacheTtl: config.anthropic.cacheTtl
    });

    const reply = parseClaudeReply(result.text);
    if (!reply) {
      return {
        reply: input.fallbackReply,
        source: "empty_output",
        latencyMs: result.latencyMs
      };
    }

    return {
      reply,
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

    // При таймауте Sonnet пробуем Haiku — быстрее в 2-3 раза, обычно укладывается в 1.5 сек.
    if (isTimeout) {
      try {
        const fallbackResult = await callAnthropicText({
          model: config.anthropic.extractionModel,  // Haiku 4.5
          system: salesReplyBrainSystemPrompt,
          user: userPrompt,
          maxTokens: 200,
          temperature: 0.5,
          timeoutMs: 3500,
          cacheTtl: config.anthropic.cacheTtl
        });
        const reply = parseClaudeReply(fallbackResult.text);
        if (reply) {
          return {
            reply,
            source: "anthropic",
            latencyMs: Date.now() - startedAt,
            cacheUsage: {
              inputTokens: fallbackResult.inputTokens,
              outputTokens: fallbackResult.outputTokens,
              cacheCreationInputTokens: fallbackResult.cacheCreationInputTokens,
              cacheReadInputTokens: fallbackResult.cacheReadInputTokens
            }
          };
        }
      } catch {
        // fall through к стандартному fallback
      }
    }

    return {
      reply: input.fallbackReply,
      source: isTimeout ? "timeout" : message.includes("Anthropic ") ? "http_error" : "network_error",
      latencyMs: Date.now() - startedAt,
      error: message
    };
  }
}

function buildAnthropicUserPrompt(input: SalesReplyBrainInput): string {
  const { action, customerMessage, fallbackReply, state, slots, context } = input;
  const lines: string[] = [];
  lines.push("<turn>");
  lines.push(`<action>${action}</action>`);
  lines.push(`<customer_message>${escapeXml(customerMessage)}</customer_message>`);
  lines.push(`<fallback_reply>${escapeXml(fallbackReply)}</fallback_reply>`);
  lines.push("<state>");
  if (state.customerName) lines.push(`  <customer_name>${escapeXml(state.customerName)}</customer_name>`);
  if (state.customerGender) lines.push(`  <customer_gender>${state.customerGender}</customer_gender>`);
  if (state.learnerType) lines.push(`  <learner_type>${state.learnerType}</learner_type>`);
  if (state.age) lines.push(`  <age>${state.age}</age>`);
  if (state.direction) lines.push(`  <direction>${escapeXml(state.direction)}</direction>`);
  if (state.branch) lines.push(`  <branch>${escapeXml(state.branch)}</branch>`);
  if (state.need) lines.push(`  <need>${escapeXml(state.need)}</need>`);
  if (state.preferredTime) lines.push(`  <preferred_time>${state.preferredTime}</preferred_time>`);
  if (state.preferredWeekday) lines.push(`  <preferred_weekday>${state.preferredWeekday}</preferred_weekday>`);
  if (state.preferredDayType) lines.push(`  <preferred_day_type>${state.preferredDayType}</preferred_day_type>`);
  lines.push("</state>");

  if (slots && slots.length) {
    lines.push("<slots>");
    for (const s of slots) {
      lines.push(`  <slot weekday="${s.weekday}" time="${s.time}" branch="${escapeXml(s.branch)}" direction="${escapeXml(s.direction)}"${s.teacher ? ` teacher="${escapeXml(s.teacher)}"` : ""}/>`);
    }
    lines.push("</slots>");
  }

  if (context?.currentSlot) {
    const cs = context.currentSlot as { weekday: string; time: string; branch: string; direction: string; teacher?: string; address?: string; floor?: string };
    lines.push(`<current_slot weekday="${cs.weekday}" time="${cs.time}" branch="${escapeXml(cs.branch)}" direction="${escapeXml(cs.direction)}"${cs.teacher ? ` teacher="${escapeXml(cs.teacher)}"` : ""}${cs.address ? ` address="${escapeXml(cs.address)}"` : ""}/>`);
  }

  if (context?.price) {
    lines.push(`<price trial="${context.price.trial ?? ""}" subscription="${context.price.subscription ?? ""}"/>`);
  }

  if (context?.notes && context.notes.length) {
    lines.push("<notes>");
    for (const note of context.notes) lines.push(`  <note>${escapeXml(note)}</note>`);
    lines.push("</notes>");
  }

  lines.push("</turn>");
  lines.push("");
  lines.push("Перепиши fallback_reply по-человечески, согласно правилам в system prompt.");
  lines.push("Ответ верни только в виде JSON: {\"reply\": \"...\"}.");
  return lines.join("\n");
}

function escapeXml(value: string): string {
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

function parseClaudeReply(text: string): string | null {
  if (!text) return null;
  // Claude может вернуть либо чистый JSON, либо обёрнутый в ```json``` блок.
  const jsonMatch = text.match(/\{[\s\S]*"reply"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { reply?: string };
      if (typeof parsed.reply === "string" && parsed.reply.trim()) return parsed.reply.trim();
    } catch {}
  }
  // Иногда модель просто пишет реплику без JSON — берём как есть, но обрезаем кавычки/префиксы.
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  if (cleaned.startsWith("{") || cleaned.startsWith("[")) return null;
  return cleaned || null;
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
