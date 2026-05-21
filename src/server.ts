import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { config } from "./config.js";
import { registerRoutes } from "./routes.js";
import { ensureBackchannels } from "./services/backchannelService.js";
import { ensurePreGeneratedReplies } from "./services/preGeneratedReplies.js";
import { startElevenLabsKeepAlive } from "./services/elevenLabsKeepAlive.js";
import { startAnthropicKeepAlive } from "./services/anthropicKeepAlive.js";

const app = Fastify({
  logger: true
});

await app.register(cors, {
  origin: true
});

await app.register(fastifyStatic, {
  root: resolve("public"),
  prefix: "/"
});

await registerRoutes(app);

ensureBackchannels()
  .then((statuses) => app.log.info({ backchannels: statuses }, "backchannels ready"))
  .catch((err) => app.log.warn({ err }, "backchannel warmup failed"));

ensurePreGeneratedReplies()
  .then((statuses) => app.log.info({ pregenerated: statuses.length }, "pregenerated replies ready"))
  .catch((err) => app.log.warn({ err }, "pregenerated warmup failed"));

// Слой 2 защиты от Cloudflare 403: фоновый «прогрев» TLS-соединения к api.elevenlabs.io
// и постоянный осмысленный User-Agent на всех запросах (см. elevenLabsKeepAlive.ts).
startElevenLabsKeepAlive(45_000);
app.log.info({ intervalMs: 45_000 }, "ElevenLabs keep-alive started");

// То же для api.anthropic.com — без пинга idle TLS-сокет закрывался и первый
// токен после паузы платил 200-500мс за хэндшейк (видели разбросы first_token до 3.4с).
startAnthropicKeepAlive(45_000);
app.log.info({ intervalMs: 45_000 }, "Anthropic keep-alive started");

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
