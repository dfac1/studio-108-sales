// Тонкий клиент для Anthropic Messages API без SDK с поддержкой prompt caching.
// System prompt и tools-schema кэшируются (cache_control: ephemeral),
// user message пересчитывается каждый turn.

import { config } from "../config.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface CacheUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface AnthropicTextRequest {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  cacheTtl?: "5m" | "1h";  // 5m default; 1h дороже на запись, но дольше живёт
}

export interface AnthropicTextResult extends CacheUsage {
  text: string;
  latencyMs: number;
}

export interface AnthropicToolRequest<T> {
  model: string;
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  cacheTtl?: "5m" | "1h";
}

export interface AnthropicToolResult<T> extends CacheUsage {
  input: T | null;
  latencyMs: number;
}

function buildCachedSystem(text: string, ttl: "5m" | "1h" = "5m"): Array<Record<string, unknown>> {
  return [
    {
      type: "text",
      text,
      cache_control: { type: "ephemeral", ttl }
    }
  ];
}

function readCacheUsage(payload: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }): CacheUsage {
  return {
    inputTokens: payload.usage?.input_tokens ?? 0,
    outputTokens: payload.usage?.output_tokens ?? 0,
    cacheCreationInputTokens: payload.usage?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: payload.usage?.cache_read_input_tokens ?? 0
  };
}

export function isAnthropicConfigured(): boolean {
  if (process.env.VITEST || process.env.DISABLE_REMOTE_SEMANTICS === "1") return false;
  return Boolean(config.anthropic.apiKey);
}

export async function callAnthropicText(req: AnthropicTextRequest): Promise<AnthropicTextResult> {
  const apiKey = config.anthropic.apiKey;
  if (!apiKey) throw new Error("Anthropic API key не настроен.");

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? config.anthropic.dialogTimeoutMs);

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 350,
        temperature: req.temperature ?? 0.6,
        system: buildCachedSystem(req.system, req.cacheTtl),
        messages: [{ role: "user", content: req.user }]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic ${response.status}: ${body}`);
    }

    const payload = await response.json() as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    };

    const text = (payload.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    return {
      text,
      ...readCacheUsage(payload),
      latencyMs: Date.now() - startedAt
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function callAnthropicTool<T>(req: AnthropicToolRequest<T>): Promise<AnthropicToolResult<T>> {
  const apiKey = config.anthropic.apiKey;
  if (!apiKey) throw new Error("Anthropic API key не настроен.");

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? config.anthropic.dialogTimeoutMs);

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 400,
        temperature: req.temperature ?? 0,
        system: buildCachedSystem(req.system, req.cacheTtl),
        tools: [
          {
            name: req.toolName,
            description: req.toolDescription,
            input_schema: req.inputSchema,
            cache_control: { type: "ephemeral", ttl: req.cacheTtl ?? "5m" }
          }
        ],
        tool_choice: { type: "tool", name: req.toolName },
        messages: [{ role: "user", content: req.user }]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic ${response.status}: ${body}`);
    }

    const payload = await response.json() as {
      content?: Array<{ type: string; name?: string; input?: T }>;
      usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    };

    const toolBlock = (payload.content ?? []).find((b) => b.type === "tool_use" && b.name === req.toolName);
    return {
      input: (toolBlock?.input ?? null) as T | null,
      ...readCacheUsage(payload),
      latencyMs: Date.now() - startedAt
    };
  } finally {
    clearTimeout(timeout);
  }
}
