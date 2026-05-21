import { config } from "../config.js";

// Фоновый «прогрев» TLS+TCP-соединения к api.anthropic.com.
// Native fetch в Node 18+ через undici пулит keep-alive соединения, но если бот
// простаивает >15-30 секунд без запросов, idle-сокет закрывается и следующий
// первый_токен заплатит за TLS-handshake (200-500мс) + TCP slow-start.
// Этот пинг каждые 45 сек удерживает сокет в пуле живым.
//
// По логам видели разброс first_token от 685 до 3444мс (5x), причём кэш-хиты
// тоже попадали в верх диапазона — значит проблема не в Anthropic backend,
// а в нашем сетевом стеке. Параллель elevenLabsKeepAlive.

let warmTimer: NodeJS.Timeout | undefined;
let lastWarmStatus: number | undefined;
let lastWarmAt: number | undefined;

async function warmPing(): Promise<void> {
  const apiKey = config.anthropic.apiKey;
  if (!apiKey) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    // GET /v1/models — самая дешёвая аутентифицированная ручка.
    // Возвращает список доступных моделей, кэшируется на стороне Anthropic.
    const response = await fetch("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Accept": "application/json"
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    lastWarmStatus = response.status;
    lastWarmAt = Date.now();
    // Дренируем тело чтобы соединение вернулось в keep-alive пул.
    try {
      await response.text();
    } catch {}
  } catch {
    lastWarmStatus = 0;
    lastWarmAt = Date.now();
  }
}

/**
 * Стартует фоновый прогрев соединения к api.anthropic.com.
 * Каждые `intervalMs` мс делает GET /v1/models, чтобы:
 *   1) undici keep-alive пул не закрывал idle-сокет;
 *   2) TLS-сессия оставалась переиспользуемой (no full handshake).
 */
export function startAnthropicKeepAlive(intervalMs: number = 45_000): void {
  if (warmTimer) return;
  if (!config.anthropic.apiKey) return;
  void warmPing();
  warmTimer = setInterval(() => void warmPing(), intervalMs);
  if (typeof warmTimer.unref === "function") warmTimer.unref();
}

export function stopAnthropicKeepAlive(): void {
  if (warmTimer) {
    clearInterval(warmTimer);
    warmTimer = undefined;
  }
}

export function getAnthropicKeepAliveStatus(): { lastStatus?: number; lastAt?: number } {
  return { lastStatus: lastWarmStatus, lastAt: lastWarmAt };
}
