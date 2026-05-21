import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { branches } from "./data/branches.js";
import { getPrice } from "./data/pricing.js";
import { getAllAvailability } from "./services/availabilityService.js";
import { createBooking, bookingInputSchema } from "./services/bookingService.js";
import { validateCompliance } from "./services/complianceService.js";
import { calculateCallCostBreakdown, estimateCallCostFromConversationProfile } from "./services/callCostModel.js";
import { synthesizeSpeech, getVoiceProvidersStatus, transcribeSpeech, streamWithElevenLabs } from "./services/voiceProviders.js";
import { readTtsCache, ttsCacheKey, writeTtsCache } from "./services/ttsCache.js";
import { config as runtimeConfig } from "./config.js";
import { PassThrough } from "node:stream";
import { ensureBackchannels, getBackchannelManifest } from "./services/backchannelService.js";
import { buildDashboardStats } from "./services/dashboardStats.js";
import { lookupPreviousContact } from "./services/customerHistory.js";
import { dueReminders, markReminder, readReminderQueue } from "./services/reminderService.js";
import { listFlags } from "./services/featureFlags.js";
import { findSlots } from "./services/slotService.js";
import { handleVoiceTurn } from "./services/voicePipeline.js";
import { respondToInboundLead } from "./services/voiceAgent.js";
import { handleSalesDialog } from "./services/salesDialog.js";
import { extractWithOpenAi } from "./services/openAiInterpreter.js";
import { buildQaDigest, getConversationTurns, readQaRatings, recordQaRating } from "./services/qaService.js";
import { isFlagOn } from "./services/featureFlags.js";
import { ensurePreGeneratedReplies, listPreGeneratedReplies } from "./services/preGeneratedReplies.js";

const branchSchema = z.enum(["Озеро", "Развилка", "Школьная", "Черняховского"]);

export async function registerRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ ok: true, service: "studio-108-voice-sales" }));

  app.get("/api/branches", async () => branches);

  app.get("/api/test-field", async () => ({
    branches,
    availability: getAllAvailability(),
    message: "Тестовое поле слотов создано: у каждого клиентского группового слота есть вместимость и свободные места."
  }));

  app.get("/api/slots", async (request) => {
    const query = z.object({
      direction: z.string().optional(),
      branch: branchSchema.optional(),
      age: z.coerce.number().int().positive().optional(),
      preferredTime: z.enum(["morning", "day", "evening"]).optional(),
      limit: z.coerce.number().int().positive().max(10).optional()
    }).parse(request.query);

    return { slots: findSlots(query) };
  });

  app.get("/api/prices", async (request) => {
    const query = z.object({
      direction: z.string().min(2),
      branch: branchSchema.optional()
    }).parse(request.query);

    return getPrice(query.direction, query.branch);
  });

  app.post("/api/bookings", async (request, reply) => {
    const input = bookingInputSchema.parse(request.body);
    const booking = await createBooking(input);
    return reply.code(201).send({ booking });
  });

  app.post("/api/voice/respond", async (request) => {
    const body = z.object({
      transcript: z.string().default(""),
      known: z.object({
        name: z.string().optional(),
        phone: z.string().optional(),
        age: z.number().int().positive().optional(),
        direction: z.string().optional(),
        branch: branchSchema.optional()
      }).optional()
    }).parse(request.body);

    return respondToInboundLead(body);
  });

  app.get("/api/providers/voice", async () => getVoiceProvidersStatus());

  app.get("/api/backchannels", async () => ({ backchannels: getBackchannelManifest() }));

  app.post("/api/backchannels/refresh", async () => ({ backchannels: await ensureBackchannels() }));

  app.get("/api/pregenerated", async () => ({ phrases: listPreGeneratedReplies() }));

  app.post("/api/pregenerated/refresh", async () => ({ phrases: await ensurePreGeneratedReplies() }));

  app.get("/api/dashboard/stats", async (request) => {
    const query = z.object({ windowDays: z.coerce.number().int().positive().max(90).optional() }).parse(request.query);
    return buildDashboardStats(query.windowDays ?? 7);
  });

  app.get("/api/customer/history", async (request) => {
    const query = z.object({ phone: z.string().min(5) }).parse(request.query);
    return lookupPreviousContact(query.phone);
  });

  app.get("/api/flags", async () => ({ flags: listFlags() }));

  app.get("/api/shadow/events", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve: resolvePath } = await import("node:path");
    try {
      const path = resolvePath(process.env.SHADOW_LOG_PATH ?? "./data/shadow-events.jsonl");
      const text = await readFile(path, "utf8");
      const lines = text.split("\n").filter(Boolean).slice(-100);
      return { events: lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).reverse() };
    } catch {
      return { events: [] };
    }
  });

  app.get("/api/reminders", async () => ({ reminders: await readReminderQueue() }));

  app.get("/api/reminders/due", async () => ({ due: await dueReminders() }));

  app.post("/api/reminders/mark", async (request) => {
    const body = z.object({
      id: z.string().min(3),
      status: z.enum(["sent", "cancelled", "failed"]),
      error: z.string().optional()
    }).parse(request.body);
    await markReminder(body.id, body.status, body.error);
    return { ok: true };
  });

  app.get("/api/handoffs", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve: resolvePath } = await import("node:path");
    try {
      const path = resolvePath(process.env.HANDOFF_LOG_PATH ?? "./data/handoffs.jsonl");
      const text = await readFile(path, "utf8");
      const lines = text.split("\n").filter(Boolean).slice(-50);
      const records = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      return { handoffs: records.reverse() };
    } catch {
      return { handoffs: [] };
    }
  });

  app.post("/api/voice/turn", async (request) => {
    const body = z.object({
      message: z.string().default(""),
      state: z.record(z.string(), z.unknown()).optional(),
      providers: z.object({
        stt: z.enum(["elevenlabs", "yandex"]).optional(),
        tts: z.enum(["elevenlabs", "yandex"]).optional()
      }).optional(),
      meta: z.object({
        sttProvider: z.string().optional(),
        sttConfidence: z.number().optional(),
        sttDurationMs: z.number().optional()
      }).optional()
    }).parse(request.body);

    return handleVoiceTurn(body);
  });

  // Streaming-вариант /api/voice/turn. NDJSON (одна JSON-строка на строку).
  // События:
  //   {"type":"start","conversationId","turnIndex","currentStep"}
  //   {"type":"sentence","text","index"}   — по мере прихода от Claude
  //   {"type":"final", ... весь VoiceTurnResult ... }
  //   {"type":"error","message"}           — в случае ошибки внутри handler'а
  // Контракт response.body совместим со старым app.js'ным fetch-reader'ом: одна строка = одно событие.
  app.post("/api/voice/turn-stream", async (request, reply) => {
    const body = z.object({
      message: z.string().default(""),
      state: z.record(z.string(), z.unknown()).optional(),
      providers: z.object({
        stt: z.enum(["elevenlabs", "yandex"]).optional(),
        tts: z.enum(["elevenlabs", "yandex"]).optional()
      }).optional(),
      meta: z.object({
        sttProvider: z.string().optional(),
        sttConfidence: z.number().optional(),
        sttDurationMs: z.number().optional()
      }).optional()
    }).parse(request.body);

    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const write = (evt: Record<string, unknown>) => {
      try { reply.raw.write(JSON.stringify(evt) + "\n"); } catch { /* client gone */ }
    };

    try {
      const result = await handleVoiceTurn(body, {
        onStart: (meta) => write({ type: "start", ...meta }),
        onSentence: (text, index) => write({ type: "sentence", text, index })
      });
      write({ type: "final", ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      write({ type: "error", message });
    } finally {
      reply.raw.end();
    }
  });

  app.post("/api/sales-dialog/message", async (request) => {
    const body = z.object({
      message: z.string().default(""),
      state: z.record(z.string(), z.unknown()).optional()
    }).parse(request.body);

    return handleSalesDialog(body);
  });

  app.post("/api/semantic/extract", async (request) => {
    const body = z.object({
      message: z.string().default(""),
      stage: z.string().optional(),
      currentState: z.object({
        customerName: z.string().optional(),
        learnerType: z.enum(["child", "adult", "unknown"]).optional(),
        age: z.number().int().positive().optional(),
        need: z.string().optional(),
        direction: z.string().optional(),
        branch: branchSchema.optional(),
        preferredTime: z.enum(["morning", "day", "evening"]).optional(),
        preferredWeekday: z.enum(["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]).optional(),
        preferredDayType: z.enum(["weekday", "weekend"]).optional()
      }).optional()
    }).parse(request.body);

    return extractWithOpenAi({
      message: body.message,
      stage: body.stage,
      currentState: body.currentState ?? {}
    });
  });

  app.post("/api/compliance/check", async (request) => {
    const body = z.object({
      channel: z.enum(["inbound_call", "inbound_form", "manual_test"]),
      provider: z.enum(["elevenlabs", "yandex", "local_only"]),
      callRecording: z.boolean(),
      hasPersonalDataConsent: z.boolean(),
      hasAiDisclosure: z.boolean(),
      hasCrossBorderConsent: z.boolean()
    }).parse(request.body);

    const issues = validateCompliance(body);
    return { ok: issues.length === 0, issues };
  });

  app.post("/api/cost/call", async (request) => {
    const body = z.object({
      mode: z.enum(["profile", "usage"]).default("profile"),
      profile: z.object({
        callMinutes: z.number().positive(),
        assistantMessages: z.number().int().nonnegative(),
        assistantCharacters: z.number().int().nonnegative(),
        semanticExtractions: z.number().int().nonnegative(),
        ttsModel: z.enum(["flash_v2_5", "multilingual_v2_v3"]).optional(),
        sttMode: z.enum(["realtime", "batch"]).optional(),
        useEntityDetection: z.boolean().optional(),
        useKeytermPrompting: z.boolean().optional(),
        telephonyInboundPerMinuteUsd: z.number().nonnegative().optional(),
        telephonyBridgePerMinuteUsd: z.number().nonnegative().optional(),
        recordingStorageUsdPerCall: z.number().nonnegative().optional(),
        mediaStorageUsdPerCall: z.number().nonnegative().optional(),
        includePostCallSummary: z.boolean().optional()
      }).optional(),
      usage: z.object({
        callMinutes: z.number().positive(),
        ttsCharacters: z.number().int().nonnegative(),
        ttsModel: z.enum(["flash_v2_5", "multilingual_v2_v3"]),
        sttMode: z.enum(["realtime", "batch"]),
        sttMinutes: z.number().positive().optional(),
        useEntityDetection: z.boolean().optional(),
        useKeytermPrompting: z.boolean().optional(),
        dialogInputTokens: z.number().int().nonnegative(),
        dialogCachedInputTokens: z.number().int().nonnegative().optional(),
        dialogOutputTokens: z.number().int().nonnegative(),
        extractionInputTokens: z.number().int().nonnegative(),
        extractionCachedInputTokens: z.number().int().nonnegative().optional(),
        extractionOutputTokens: z.number().int().nonnegative(),
        postCallSummaryInputTokens: z.number().int().nonnegative().optional(),
        postCallSummaryCachedInputTokens: z.number().int().nonnegative().optional(),
        postCallSummaryOutputTokens: z.number().int().nonnegative().optional(),
        telephonyInboundPerMinuteUsd: z.number().nonnegative().optional(),
        telephonyBridgePerMinuteUsd: z.number().nonnegative().optional(),
        recordingStorageUsdPerCall: z.number().nonnegative().optional(),
        mediaStorageUsdPerCall: z.number().nonnegative().optional()
      }).optional()
    }).parse(request.body);

    if (body.mode === "usage") {
      if (!body.usage) {
        return { error: "usage payload is required when mode=usage" };
      }
      return calculateCallCostBreakdown(body.usage);
    }

    if (!body.profile) {
      return { error: "profile payload is required when mode=profile" };
    }
    return estimateCallCostFromConversationProfile(body.profile);
  });

  app.post("/api/tts/speak", async (request, reply) => {
    const body = z.object({
      text: z.string().min(1).max(2000),
      provider: z.enum(["elevenlabs", "yandex"]).optional(),
      voiceId: z.string().optional(),
      outputFormat: z.string().optional(),
      action: z.string().optional()
    }).parse(request.body);

    let result;
    try {
      result = await synthesizeSpeech(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось синтезировать речь.";
      return reply.code(400).send({ error: message });
    }
    reply.header("Content-Type", result.contentType);
    return reply.send(result.audio);
  });

  app.post("/api/stt/transcribe", async (request, reply) => {
    const body = z.object({
      provider: z.enum(["elevenlabs", "yandex"]).optional(),
      audioBase64: z.string().min(1),
      mimeType: z.string().optional(),
      fileName: z.string().optional(),
      languageCode: z.string().optional(),
      formatHint: z.enum(["oggopus", "lpcm"]).optional(),
      sampleRateHertz: z.number().int().positive().optional()
    }).parse(request.body);

    const startedAt = Date.now();
    const audioBytes = Math.floor(body.audioBase64.length * 0.75);
    try {
      const result = await transcribeSpeech({
        provider: body.provider,
        audio: Buffer.from(body.audioBase64, "base64"),
        mimeType: body.mimeType,
        fileName: body.fileName,
        languageCode: body.languageCode,
        formatHint: body.formatHint,
        sampleRateHertz: body.sampleRateHertz
      });
      console.log(JSON.stringify({
        tag: "perf",
        stage: "stt",
        ms: Date.now() - startedAt,
        provider: result.provider,
        audioBytes,
        textLen: result.text.length,
      }));
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось распознать аудио.";
      console.log(JSON.stringify({
        tag: "perf",
        stage: "stt_error",
        ms: Date.now() - startedAt,
        provider: body.provider,
        audioBytes,
        err: message,
      }));
      app.log.error({
        provider: body.provider,
        mimeType: body.mimeType,
        fileName: body.fileName,
        audioBytes,
        err: message
      }, "stt failed");
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/api/tts/stream", async (request, reply) => {
    const body = z.object({
      text: z.string().min(1).max(2000),
      voiceId: z.string().optional(),
      outputFormat: z.string().optional(),
      voicePreset: z.enum(["default", "greeting", "business", "empathic", "joyful", "clarification"]).optional(),
      action: z.string().optional()
    }).parse(request.body);

    const outputFormat = body.outputFormat ?? "mp3_44100_128";
    const voiceId = body.voiceId ?? runtimeConfig.elevenLabs.voiceId;
    const cacheHash = ttsCacheKey({
      text: body.text,
      voiceId,
      voicePreset: body.voicePreset,
      outputFormat
    });

    const startedAt = Date.now();
    const textLen = body.text.length;

    // Слой 3: кэш-проверка ПЕРЕД походом в ElevenLabs.
    // Если этот же текст с тем же голосом/пресетом уже синтезировался — отдаём mp3 с диска,
    // без сетевого запроса. Покрывает повторы шаблонных реплик (ask_branch, ask_phone и т.п.).
    try {
      const cached = await readTtsCache(cacheHash);
      if (cached) {
        reply.header("Content-Type", "audio/mpeg");
        reply.header("Cache-Control", "no-cache");
        reply.header("X-Output-Format", outputFormat);
        reply.header("X-TTS-Cache", "hit");
        console.log(JSON.stringify({
          tag: "perf",
          stage: "tts_cache_hit",
          ms: Date.now() - startedAt,
          textLen,
        }));
        return reply.send(cached);
      }
    } catch {
      // кэш — best-effort, идём к ElevenLabs
    }

    try {
      const result = await streamWithElevenLabs({
        text: body.text,
        voiceId: body.voiceId,
        outputFormat,
        voicePreset: body.voicePreset,
        action: body.action,
        provider: "elevenlabs"
      });
      reply.header("Content-Type", result.contentType);
      reply.header("Cache-Control", "no-cache");
      reply.header("X-Output-Format", result.outputFormat);
      reply.header("X-TTS-Cache", "miss");

      // Параллельно собираем mp3 в буфер для записи в кэш.
      // PassThrough транслирует данные клиенту и копит в Buffer для последующей записи.
      const chunks: Buffer[] = [];
      const passthrough = new PassThrough();
      let firstByteLogged = false;
      result.stream.on("data", (chunk: Buffer) => {
        if (!firstByteLogged) {
          firstByteLogged = true;
          console.log(JSON.stringify({
            tag: "perf",
            stage: "tts_first_byte",
            ms: Date.now() - startedAt,
            textLen,
            preset: body.voicePreset ?? "default",
            action: body.action,
          }));
        }
        chunks.push(chunk);
        passthrough.write(chunk);
      });
      result.stream.on("end", () => {
        passthrough.end();
        if (chunks.length) {
          const audio = Buffer.concat(chunks);
          console.log(JSON.stringify({
            tag: "perf",
            stage: "tts_end",
            ms: Date.now() - startedAt,
            textLen,
            bytes: audio.length,
            preset: body.voicePreset ?? "default",
            action: body.action,
          }));
          // Не блокируем ответ — пишем в кэш фоном.
          void writeTtsCache(cacheHash, audio).catch((err) => {
            request.log.warn({ err: err instanceof Error ? err.message : String(err) }, "tts cache write failed");
          });
        }
      });
      result.stream.on("error", (err) => {
        console.log(JSON.stringify({
          tag: "perf",
          stage: "tts_error",
          ms: Date.now() - startedAt,
          textLen,
          err: err instanceof Error ? err.message : String(err),
        }));
        passthrough.destroy(err);
      });
      return reply.send(passthrough);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось стримить речь.";
      console.log(JSON.stringify({
        tag: "perf",
        stage: "tts_error",
        ms: Date.now() - startedAt,
        textLen,
        err: message,
      }));
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/api/qa/digest", async (request) => {
    if (!isFlagOn("useDailyQADigest")) return { enabled: false, summary: null };
    const query = z.object({
      windowHours: z.coerce.number().int().positive().max(168).optional()
    }).parse(request.query);
    return buildQaDigest(query.windowHours ?? 24);
  });

  app.get("/api/qa/conversation/:id", async (request) => {
    const params = z.object({ id: z.string().min(3) }).parse(request.params);
    const turns = await getConversationTurns(params.id);
    return { conversationId: params.id, turns };
  });

  app.post("/api/qa/rate", async (request) => {
    const body = z.object({
      conversationId: z.string().min(3),
      rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      comment: z.string().optional(),
      reviewerEmail: z.string().email().optional()
    }).parse(request.body);
    await recordQaRating({
      ts: new Date().toISOString(),
      ...body
    });
    return { ok: true };
  });

  app.get("/api/qa/ratings", async () => {
    return { ratings: await readQaRatings() };
  });

  app.post("/api/tts/elevenlabs", async (request, reply) => {
    const body = z.object({
      text: z.string().min(1).max(2000),
      voiceId: z.string().optional(),
      outputFormat: z.string().optional()
    }).parse(request.body);

    let result;
    try {
      result = await synthesizeSpeech({ ...body, provider: "elevenlabs" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось синтезировать речь.";
      return reply.code(400).send({ error: message });
    }
    reply.header("Content-Type", result.contentType);
    return reply.send(result.audio);
  });
}
