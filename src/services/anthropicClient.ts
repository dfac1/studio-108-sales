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
  /** Опциональная история (без текущего user-сообщения) для диалоговых сценариев,
   *  где LLM нужна память о собственных репликах. Передаётся как `messages` перед user. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  cacheTtl?: "5m" | "1h";  // 5m default; 1h дороже на запись, но дольше живёт
}

export interface AnthropicTextResult extends CacheUsage {
  text: string;
  latencyMs: number;
}

export interface AnthropicStreamRequest extends AnthropicTextRequest {
  /** Первый текстовый токен — даёт реальную «time to first audible token» метрику. */
  onFirstToken?: (deltaMs: number) => void;
  /** Каждое завершённое предложение (по `.`/`!`/`?` + пробел/конец).
   *  Используется для будущей подачи в WS-TTS до конца генерации. */
  onSentence?: (sentence: string, index: number) => void;
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
        messages: [
          ...(req.history ?? []).map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: req.user }
        ]
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

/** Streaming-вариант: тот же контракт возврата (полный text + usage в конце),
 *  но дополнительно вызывает `onFirstToken` / `onSentence` по мере прихода токенов.
 *  Не меняет поведение для caller'а — можно подменять `callAnthropicText` точечно.
 *  Маркеры [→step:{...}] не считаются за предложение (отсекаем чтобы не уехали в TTS). */
export async function callAnthropicTextStream(req: AnthropicStreamRequest): Promise<AnthropicTextResult> {
  const apiKey = config.anthropic.apiKey;
  if (!apiKey) throw new Error("Anthropic API key не настроен.");

  const startedAt = Date.now();
  let firstTokenAt = 0;
  let fullText = "";
  let pending = "";
  let sentenceIndex = 0;
  const usage: CacheUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? config.anthropic.dialogTimeoutMs);

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 350,
        temperature: req.temperature ?? 0.6,
        system: buildCachedSystem(req.system, req.cacheTtl),
        messages: [
          ...(req.history ?? []).map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: req.user }
        ],
        stream: true,
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic stream ${response.status}: ${body}`);
    }
    if (!response.body) {
      throw new Error("Anthropic stream: empty body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let eventEnd: number;
      while ((eventEnd = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, eventEnd);
        buf = buf.slice(eventEnd + 2);
        const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const dataStr = dataLine.slice(6).trim();
        if (!dataStr || dataStr === "[DONE]") continue;

        let event: {
          type?: string;
          delta?: { type?: string; text?: string };
          message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
          usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
        };
        try {
          event = JSON.parse(dataStr);
        } catch {
          continue;
        }

        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
          const piece = event.delta.text;
          if (piece) {
            if (firstTokenAt === 0) {
              firstTokenAt = Date.now();
              req.onFirstToken?.(firstTokenAt - startedAt);
            }
            fullText += piece;
            pending += piece;

            // Sentence-boundary: точка/!/? + пробел или конец строки. Не считаем содержимое маркера.
            for (;;) {
              const m = pending.match(/^([\s\S]+?[.!?])(\s|$)/);
              if (!m) break;
              const sentence = m[1].trim();
              pending = pending.slice(m[0].length);
              if (sentence && !sentence.includes("[→")) {
                try { req.onSentence?.(sentence, sentenceIndex); } catch { /* callback errors must not break stream */ }
                sentenceIndex++;
              }
            }
          }
        } else if (event.type === "message_start" && event.message?.usage) {
          usage.inputTokens = event.message.usage.input_tokens ?? 0;
          usage.cacheCreationInputTokens = event.message.usage.cache_creation_input_tokens ?? 0;
          usage.cacheReadInputTokens = event.message.usage.cache_read_input_tokens ?? 0;
        } else if (event.type === "message_delta" && event.usage) {
          usage.outputTokens = event.usage.output_tokens ?? usage.outputTokens;
        }
      }
    }

    // Финальный остаток (текст без терминатора) — тоже считаем предложением.
    const tail = pending.trim();
    if (tail && !tail.includes("[→")) {
      try { req.onSentence?.(tail, sentenceIndex); } catch { /* ignore */ }
    }

    return {
      text: fullText.trim(),
      ...usage,
      latencyMs: Date.now() - startedAt,
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
