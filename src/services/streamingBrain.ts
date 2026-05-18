/**
 * Streaming brain — стримит Claude reply через Anthropic Messages API
 * и резолвит первое предложение раньше, чем закончится полный ответ.
 *
 * Используется во `voicePipeline.ts` под флагом `useStreamingBrain`.
 * Цель — сократить время до первого байта TTS на 400-800 мс на длинных репликах.
 *
 * Контракт:
 *  - Возвращает Promise<{firstSentence, fullReply}>
 *  - firstSentence резолвится как только видим `.`, `?`, `!` или 40+ символов
 *  - fullReply резолвится по завершении stream
 *  - При ошибках — fallback на не-стрим вариант
 */

import { config } from "../config.js";
import { salesReplyBrainSystemPrompt } from "./salesPrompts.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface StreamingBrainRequest {
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface StreamingBrainResult {
  firstSentence: Promise<string>;
  fullReply: Promise<string>;
  abort: () => void;
}

interface PendingResolvers {
  firstSentenceResolve: ((value: string) => void) | null;
  firstSentenceReject: ((reason: unknown) => void) | null;
  fullReplyResolve: ((value: string) => void) | null;
  fullReplyReject: ((reason: unknown) => void) | null;
}

const SENTENCE_TRIGGERS = /[.!?]\s/;
const FIRST_SENTENCE_FALLBACK_CHARS = 60;

export function startStreamingBrain(req: StreamingBrainRequest): StreamingBrainResult {
  const apiKey = config.anthropic.apiKey;
  const controller = new AbortController();

  const pending: PendingResolvers = {
    firstSentenceResolve: null,
    firstSentenceReject: null,
    fullReplyResolve: null,
    fullReplyReject: null
  };

  const firstSentence = new Promise<string>((resolve, reject) => {
    pending.firstSentenceResolve = resolve;
    pending.firstSentenceReject = reject;
  });
  const fullReply = new Promise<string>((resolve, reject) => {
    pending.fullReplyResolve = resolve;
    pending.fullReplyReject = reject;
  });

  if (!apiKey) {
    pending.firstSentenceReject?.(new Error("Anthropic API key не настроен"));
    pending.fullReplyReject?.(new Error("Anthropic API key не настроен"));
    return { firstSentence, fullReply, abort: () => {} };
  }

  void runStreamingPipeline(req, apiKey, controller, pending);

  return {
    firstSentence,
    fullReply,
    abort: () => controller.abort()
  };
}

async function runStreamingPipeline(
  req: StreamingBrainRequest,
  apiKey: string,
  controller: AbortController,
  pending: PendingResolvers
): Promise<void> {
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 8000);

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.anthropic.dialogModel,
        max_tokens: req.maxTokens ?? 250,
        temperature: 0.55,
        stream: true,
        system: [
          { type: "text", text: salesReplyBrainSystemPrompt, cache_control: { type: "ephemeral", ttl: config.anthropic.cacheTtl } }
        ],
        messages: [{ role: "user", content: req.user }]
      })
    });

    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new Error(`Anthropic streaming ${response.status}: ${text}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let firstSentenceResolved = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nlIdx = buffer.indexOf("\n");
      while (nlIdx >= 0) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (line.startsWith("data: ")) {
          const payload = line.slice("data: ".length);
          if (payload === "[DONE]") break;
          try {
            const event = JSON.parse(payload) as { type?: string; delta?: { type?: string; text?: string } };
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
              fullText += event.delta.text;
              if (!firstSentenceResolved) {
                const maybe = tryExtractFirstSentence(fullText);
                if (maybe) {
                  firstSentenceResolved = true;
                  pending.firstSentenceResolve?.(maybe);
                }
              }
            }
          } catch {
            // ignore malformed events
          }
        }
        nlIdx = buffer.indexOf("\n");
      }
    }

    // Если стрим закончился, а firstSentence ещё не резолвилось — берём всё.
    const reply = extractReplyText(fullText);
    if (!firstSentenceResolved) {
      pending.firstSentenceResolve?.(reply);
    }
    pending.fullReplyResolve?.(reply);
  } catch (err) {
    pending.firstSentenceReject?.(err);
    pending.fullReplyReject?.(err);
  } finally {
    clearTimeout(timeout);
  }
}

function tryExtractFirstSentence(accumulated: string): string | null {
  // Сначала ищем границу предложения (точка/! /? + пробел).
  const match = accumulated.match(/^([\s\S]*?[.!?])\s+/);
  if (match) {
    const sentence = extractReplyText(match[1].trim());
    if (sentence.length >= 10) return sentence;
  }
  // Fallback: если уже накопилось много текста — резолвим как есть.
  if (accumulated.length >= FIRST_SENTENCE_FALLBACK_CHARS && /[,\s][а-яёА-ЯЁ]/.test(accumulated)) {
    return extractReplyText(accumulated);
  }
  return null;
}

/** Достаёт `reply` из JSON-обёртки, если Claude вернул {"reply": "..."}. */
function extractReplyText(text: string): string {
  if (!text) return "";
  const trimmed = text.trim();
  // Полный JSON
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as { reply?: string };
      if (typeof parsed.reply === "string") return parsed.reply;
    } catch {}
  }
  // Частичный JSON (`{"reply": "...`)
  const replyMatch = trimmed.match(/"reply"\s*:\s*"([^"]*)/);
  if (replyMatch) {
    return replyMatch[1].replace(/\\"/g, '"').replace(/\\n/g, " ");
  }
  return trimmed;
}
