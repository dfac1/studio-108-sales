import { config } from "../config.js";

// Стандартный User-Agent для всех исходящих запросов в ElevenLabs.
// Cloudflare значительно реже выдаёт challenge, если клиент выглядит «осмысленно»,
// а не как анонимный fetch без идентификации.
export const ELEVENLABS_UA = "Studio108VoiceSales/1.0 (+server-side; node-fetch)";

let warmTimer: NodeJS.Timeout | undefined;
let lastWarmStatus: number | undefined;
let lastWarmAt: number | undefined;

async function warmPing(): Promise<void> {
  const apiKey = config.elevenLabs.apiKey;
  if (!apiKey) return;
  try {
    // /v1/user — дешёвая ручка, возвращает информацию о подписке. Используем её как «пинг»,
    // чтобы держать TLS-соединение к api.elevenlabs.io тёплым и снижать частоту Cloudflare-challenge.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch("https://api.elevenlabs.io/v1/user", {
      method: "GET",
      headers: {
        "xi-api-key": apiKey,
        "User-Agent": ELEVENLABS_UA,
        "Accept": "application/json"
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    lastWarmStatus = response.status;
    lastWarmAt = Date.now();
    // Дренируем тело, чтобы соединение закрылось чисто и пошло в keep-alive pool.
    try {
      await response.text();
    } catch {}
  } catch {
    // Не критично — следующий тик повторит.
    lastWarmStatus = 0;
    lastWarmAt = Date.now();
  }
}

/**
 * Запускает фоновый «прогрев» к api.elevenlabs.io.
 * Каждые `intervalMs` секунд делает GET /v1/user, чтобы:
 *   1) TLS-соединение в undici keep-alive пуле не остывало;
 *   2) Cloudflare видел нас как активного клиента и реже выдавал managed-challenge.
 */
export function startElevenLabsKeepAlive(intervalMs: number = 45_000): void {
  if (warmTimer) return;
  if (!config.elevenLabs.apiKey) return;
  // Первый пинг — сразу при старте.
  void warmPing();
  warmTimer = setInterval(() => void warmPing(), intervalMs);
  // Не блокируем выход процесса этим таймером.
  if (typeof warmTimer.unref === "function") warmTimer.unref();
}

export function stopElevenLabsKeepAlive(): void {
  if (warmTimer) {
    clearInterval(warmTimer);
    warmTimer = undefined;
  }
}

export function getKeepAliveStatus(): { lastStatus?: number; lastAt?: number } {
  return { lastStatus: lastWarmStatus, lastAt: lastWarmAt };
}
