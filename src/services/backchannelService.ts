import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../config.js";
import { synthesizeWithElevenLabs } from "./elevenLabsService.js";

export type BackchannelKey =
  | "ugu"
  | "aga"
  | "tak"
  | "smotru"
  | "sek"
  | "ponyala"
  | "udobno"
  | "ponimayu"
  | "horosho"
  | "konechno"
  | "aga_aga"
  | "yasno"
  | "vizhu"
  | "minutochku"
  | "davaite"
  | "otlichno"
  | "horosho_davaite"
  // Нейтральные «угу» для активного слушания, пока клиент ещё говорит.
  // Не претендуют на понимание сказанного — просто «я с тобой, продолжай».
  | "ugu_short"
  | "ugu_soft"
  | "ugu_low";

interface BackchannelDef {
  key: BackchannelKey;
  text: string;
  voiceSettings: {
    stability: number;
    similarity_boost: number;
    style: number;
    speed: number;
  };
}

const BACKCHANNELS: BackchannelDef[] = [
  // Подтверждение услышанного, нейтральное
  { key: "ugu",      text: "Угу-угу,",          voiceSettings: { stability: 0.45, similarity_boost: 0.9,  style: 0.5,  speed: 0.96 } },
  { key: "aga",      text: "Ага, поняла.",       voiceSettings: { stability: 0.45, similarity_boost: 0.9,  style: 0.5,  speed: 0.96 } },
  { key: "aga_aga",  text: "Ага, ага.",          voiceSettings: { stability: 0.45, similarity_boost: 0.9,  style: 0.5,  speed: 0.96 } },
  // Короткие односложные подтверждения звучат резко. Используем смягчённые формы из 2 слов
  // с явной паузой запятой — TTS даёт более плавное звучание.
  { key: "yasno",    text: "Ясно, поняла,",      voiceSettings: { stability: 0.55, similarity_boost: 0.9,  style: 0.45, speed: 0.95 } },
  { key: "vizhu",    text: "Угу, понимаю,",      voiceSettings: { stability: 0.55, similarity_boost: 0.9,  style: 0.45, speed: 0.95 } },
  // Переход к следующему шагу. «Так,» само по себе резкое — смягчаем до «Так, поняла,»
  // и снижаем speed, чтобы было плавнее. Используется только на ask_slot_choice как мягкое подведение.
  { key: "tak",      text: "Так, поняла,",       voiceSettings: { stability: 0.55, similarity_boost: 0.9,  style: 0.4,  speed: 0.95 } },
  { key: "ponyala",  text: "Так, поняла.",       voiceSettings: { stability: 0.45, similarity_boost: 0.9,  style: 0.4,  speed: 0.96 } },
  // Обработка / поиск в системе
  { key: "smotru",        text: "Так, секунду, гляну.", voiceSettings: { stability: 0.5,  similarity_boost: 0.85, style: 0.4,  speed: 0.96 } },
  { key: "sek",           text: "Секундочку.",          voiceSettings: { stability: 0.5,  similarity_boost: 0.85, style: 0.4,  speed: 0.96 } },
  { key: "minutochku",    text: "Минуточку, посмотрю.", voiceSettings: { stability: 0.5,  similarity_boost: 0.85, style: 0.4,  speed: 0.95 } },
  // Согласие / удовлетворение от ответа клиента
  { key: "udobno",            text: "Хорошо, удобно.",     voiceSettings: { stability: 0.5,  similarity_boost: 0.9,  style: 0.4,  speed: 0.96 } },
  { key: "horosho",           text: "Хорошо.",             voiceSettings: { stability: 0.5,  similarity_boost: 0.9,  style: 0.4,  speed: 0.96 } },
  { key: "konechno",          text: "Конечно.",            voiceSettings: { stability: 0.5,  similarity_boost: 0.9,  style: 0.45, speed: 0.96 } },
  { key: "davaite",           text: "Давайте.",            voiceSettings: { stability: 0.5,  similarity_boost: 0.9,  style: 0.4,  speed: 0.97 } },
  { key: "otlichno",          text: "Отлично.",            voiceSettings: { stability: 0.45, similarity_boost: 0.9,  style: 0.5,  speed: 0.97 } },
  { key: "horosho_davaite",   text: "Хорошо, давайте.",    voiceSettings: { stability: 0.5,  similarity_boost: 0.9,  style: 0.4,  speed: 0.96 } },
  // Эмпатия — клиент сомневается, переживает, возражает
  { key: "ponimayu", text: "Понимаю,",           voiceSettings: { stability: 0.55, similarity_boost: 0.9,  style: 0.5,  speed: 0.93 } },
  // Нейтральные «угу» для активного слушания. Чисто «я слушаю», без претензии на понимание.
  // Три варианта чтобы один и тот же не повторялся подряд:
  { key: "ugu_short", text: "Угу.",     voiceSettings: { stability: 0.4,  similarity_boost: 0.9,  style: 0.35, speed: 1.0  } }, // быстрый, отрывистый
  { key: "ugu_soft",  text: "У-гу-у.",  voiceSettings: { stability: 0.55, similarity_boost: 0.9,  style: 0.4,  speed: 0.92 } }, // мягкий, чуть протяжный
  { key: "ugu_low",   text: "Угу...",   voiceSettings: { stability: 0.6,  similarity_boost: 0.9,  style: 0.3,  speed: 0.88 } }  // задумчивый, тихий
];

const BACKCHANNEL_DIR = resolve("public", "audio", "backchannels");

export interface BackchannelStatus {
  key: BackchannelKey;
  cached: boolean;
  url: string;
  bytes?: number;
}

export async function ensureBackchannels(): Promise<BackchannelStatus[]> {
  await mkdir(BACKCHANNEL_DIR, { recursive: true });
  const results: BackchannelStatus[] = [];

  for (const def of BACKCHANNELS) {
    const filePath = resolve(BACKCHANNEL_DIR, `${def.key}.mp3`);
    const url = `/audio/backchannels/${def.key}.mp3`;
    try {
      const info = await stat(filePath);
      results.push({ key: def.key, cached: true, url, bytes: info.size });
      continue;
    } catch {}

    if (!config.elevenLabs.apiKey || !config.elevenLabs.voiceId) {
      results.push({ key: def.key, cached: false, url });
      continue;
    }

    try {
      const audio = await renderBackchannel(def);
      await writeFile(filePath, audio);
      results.push({ key: def.key, cached: true, url, bytes: audio.byteLength });
    } catch {
      results.push({ key: def.key, cached: false, url });
    }
  }

  return results;
}

async function renderBackchannel(def: BackchannelDef): Promise<Buffer> {
  const result = await synthesizeWithElevenLabs({
    provider: "elevenlabs",
    text: def.text,
    outputFormat: "mp3_44100_128"
  });
  return result.audio;
}

export function getBackchannelManifest(): Array<{ key: BackchannelKey; url: string; text: string }> {
  return BACKCHANNELS.map((def) => ({
    key: def.key,
    url: `/audio/backchannels/${def.key}.mp3`,
    text: def.text
  }));
}

export function getBackchannelKeyForAction(action: string, lastUserText?: string): BackchannelKey | null {
  const lower = (lastUserText ?? "").toLowerCase().trim();
  const meaningful = lower.replace(/[^\p{L}\p{N}]+/gu, "");

  // Очень короткие ответы ("да", "нет", "ок") — без backchannel, чтобы не растягивать.
  // Раньше порог был 6 — слишком строго (срезались "Озеро", "Сергей"). Снизил до 4.
  if (meaningful.length < 4 && !isEmotionalUserText(lower)) {
    return null;
  }

  // ВАЖНО: эмпатия / неуверенность побеждает «вопрос» — клиент может задать вопрос
  // в середине переживания («не уверен, что нам подходит... что ещё у вас есть?»),
  // и тогда «понимаю,» уместнее, чем тишина.
  if (isEmotionalUserText(lower)) {
    if (action === "offer_solution" || action === "ask_branch" || action === "ask_need" || action === "ask_phone" || action === "ask_direction_confirm") {
      return "ponimayu";
    }
  }
  if (isHesitantUserText(lower)) {
    if (action === "ask_need" || action === "ask_branch" || action === "offer_solution" || action === "ask_direction_confirm") {
      return "ponimayu";
    }
  }

  // Клиент задал вопрос ("что значит посмотреть?", "сколько стоит?") — «ага, поняла»
  // звучит как издевательство. Сразу к делу, без backchannel.
  if (lower.includes("?") || /(?:что\s+значит|как\s+это|не\s+поняла|не\s+понял|объясн)/i.test(lower)) {
    return null;
  }

  switch (action) {
    case "ask_name":              return null;
    case "ask_learner":           return null;
    case "ask_need":              return pickWithoutRepeat("ask_need", ["aga", "ponyala", "vizhu"] as BackchannelKey[]);
    case "ask_age":               return null;        // короткий вопрос про возраст — без preview
    case "ask_direction_confirm": return pickWithoutRepeat("ask_direction_confirm", ["smotru", "sek", "minutochku"] as BackchannelKey[]);
    case "ask_branch":            return pickWithoutRepeat("ask_branch", ["horosho", "davaite", "horosho_davaite", "ponyala"] as BackchannelKey[]);
    case "offer_solution":        return pickWithoutRepeat("offer_solution", ["smotru", "minutochku", "sek"] as BackchannelKey[]);
    case "ask_slot_choice":       return "tak";
    case "ask_phone":             return pickWithoutRepeat("ask_phone", ["udobno", "horosho", "otlichno"] as BackchannelKey[]);
    case "ask_consent":           return null;
    case "booked":                return null;
    case "handoff":               return null;
    default:                      return null;
  }
}

// Память последнего pick'а по action — чтобы один и тот же backchannel не звучал
// два turn'а подряд. Это даёт клиенту ощущение, что менеджер каждый раз реагирует
// по-разному, а не молотит одну фразу.
const lastBackchannelByAction = new Map<string, BackchannelKey>();

function pickWithoutRepeat(action: string, items: BackchannelKey[]): BackchannelKey {
  const last = lastBackchannelByAction.get(action);
  let candidate = items[Math.floor(Math.random() * items.length)];
  if (items.length > 1 && candidate === last) {
    const alternatives = items.filter((it) => it !== last);
    candidate = alternatives[Math.floor(Math.random() * alternatives.length)];
  }
  lastBackchannelByAction.set(action, candidate);
  return candidate;
}

function pickOne<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function isEmotionalUserText(lower: string): boolean {
  if (!lower) return false;
  const cues = [
    "не уверен", "не уверена", "сомнева", "не знаю",
    "дорого", "слишком", "не по карман",
    "стесня", "боит", "стрем", "робе",
    "подумаю", "посовет",
    "далеко", "неудобно ехать",
    "нет времени", "занят",
    "не получится", "не смогу", "не выйдет",
    // Отказы — клиент эмоционально отвергает, эмпатичный «понимаю» уместен.
    "не нрав", "не особо нрав", "не очень нрав", "не пойд", "не моё", "не мое",
    "не для нас", "не наш", "не айс", "не подход"
  ];
  return cues.some((cue) => lower.includes(cue));
}

function isHesitantUserText(lower: string): boolean {
  if (!lower) return false;
  // Считаем мямлящим, если есть 2+ кластера филлеров или явная "я не определился" интонация.
  const fillers = (lower.match(/(?:а-?а-?а|э-?э-?э|м-?м-?м|нну+|вот\s+чтобы|типа|короче|это самое)/gi) || []).length;
  if (fillers >= 2) return true;
  // Один филлер + явная неуверенность по словам.
  if (fillers >= 1 && /(?:ну\s+|вот\s+|кажется|может|наверное)/i.test(lower)) return true;
  return false;
}

export async function readBackchannelFile(key: BackchannelKey): Promise<Buffer | null> {
  const filePath = resolve(BACKCHANNEL_DIR, `${key}.mp3`);
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}
