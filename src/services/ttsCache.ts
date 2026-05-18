import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";

const CACHE_DIR = resolve("data", "tts-cache");
const MAX_AGE_DAYS = 30; // файлы старше — удаляем при старте.

interface CacheKey {
  text: string;
  voiceId: string;
  voicePreset?: string;
  outputFormat: string;
}

export function ttsCacheKey(key: CacheKey): string {
  const normalized = `${key.text.trim()}|${key.voiceId}|${key.voicePreset ?? "default"}|${key.outputFormat}`;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function cachePathFor(hash: string): string {
  return resolve(CACHE_DIR, `${hash}.mp3`);
}

/**
 * Возвращает поток с закэшированным mp3, если файл существует. Иначе undefined.
 * Mtime файла НЕ обновляется при чтении (стандартное поведение FS), но это OK —
 * eviction в нашей реализации только по возрасту, без LRU.
 */
export async function readTtsCache(hash: string): Promise<Readable | undefined> {
  const filePath = cachePathFor(hash);
  try {
    await stat(filePath);
  } catch {
    return undefined;
  }
  return createReadStream(filePath);
}

/** Сохраняет mp3 в кэш. Создаёт директорию при необходимости. */
export async function writeTtsCache(hash: string, audio: Buffer | Uint8Array): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePathFor(hash), audio);
}

/** Чистит файлы старше MAX_AGE_DAYS. Вызывается на старте сервера. */
export async function pruneTtsCache(): Promise<{ removed: number; kept: number }> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
  } catch {}
  let removed = 0;
  let kept = 0;
  const threshold = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = await readdir(CACHE_DIR);
  } catch {
    return { removed: 0, kept: 0 };
  }
  for (const name of entries) {
    if (!name.endsWith(".mp3")) continue;
    const filePath = resolve(CACHE_DIR, name);
    try {
      const stats = await stat(filePath);
      if (stats.mtimeMs < threshold) {
        await unlink(filePath);
        removed++;
      } else {
        kept++;
      }
    } catch {
      // gone or unreadable — пропускаем
    }
  }
  return { removed, kept };
}
