/**
 * Success-stories RAG (легковесный, in-memory).
 *
 * KB живёт в `success-stories.md` в корне проекта. На старте сервиса парсим один раз,
 * далее каждый turn ищем по тегам наиболее релевантную историю и возвращаем
 * её текст как ПОДСКАЗКУ brain'у (необязательно использовать).
 *
 * Скоринг — простой матч по тегам:
 *  - direction match: +3
 *  - age range match: +2
 *  - objection match (по словам в customer message): +3
 *  - profile match: +1
 *
 * Story возвращается только если score >= 4 — иначе шум.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface SuccessStory {
  id: number;
  title: string;
  body: string;
  tags: Record<string, string[]>;
  weight: number;
}

let cache: SuccessStory[] | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;
const KB_PATH = resolve(process.env.SUCCESS_STORIES_PATH ?? "./success-stories.md");

async function loadStories(): Promise<SuccessStory[]> {
  if (cache && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return cache;
  try {
    const text = await readFile(KB_PATH, "utf8");
    cache = parseStories(text);
    cacheLoadedAt = Date.now();
    return cache;
  } catch {
    cache = [];
    cacheLoadedAt = Date.now();
    return cache;
  }
}

export function parseStories(markdown: string): SuccessStory[] {
  const stories: SuccessStory[] = [];
  // Делим по `### N.` заголовкам
  const sections = markdown.split(/\n###\s+/);
  for (const section of sections) {
    if (!section.includes("tags:")) continue;
    const lines = section.split("\n");
    const titleMatch = lines[0].match(/^(\d+)\.\s*(.+)$/);
    if (!titleMatch) continue;
    const id = Number(titleMatch[1]);
    const title = titleMatch[2].trim();

    const tagsLine = lines.find((l) => l.startsWith("tags:")) ?? "";
    const tagsRaw = tagsLine.replace(/^tags:\s*/, "");
    const tags: Record<string, string[]> = {};
    for (const part of tagsRaw.split(",").map((p) => p.trim()).filter(Boolean)) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!tags[key]) tags[key] = [];
      tags[key].push(value);
    }

    const weightLine = lines.find((l) => l.startsWith("weight:")) ?? "";
    const weight = Number(weightLine.replace(/^weight:\s*/, "")) || 1.0;

    const bodyLines = lines.filter((l) =>
      !l.startsWith("tags:") &&
      !l.startsWith("weight:") &&
      !/^\d+\./.test(l) &&
      l.trim() !== ""
    );
    const body = bodyLines.join(" ").trim();
    if (!body) continue;

    stories.push({ id, title, body, tags, weight });
  }
  return stories;
}

interface RetrievalInput {
  direction?: string;
  age?: number;
  learnerType?: "child" | "adult" | "unknown";
  customerMessage: string;
  stage?: string;
}

const OBJECTION_KEYWORDS: Record<string, RegExp> = {
  shy:      /(стесня|стесн|боюсь|неловк|неудобн)/i,
  time:     /(нет\s+времени|занят|после\s+работы|некогда|вечером\s+только)/i,
  skill:    /(не\s+умею|не\s+тян|не\s+гибк|нулев|с\s+нуля|без\s+опыта|новичок)/i,
  age:      /(возраст|подойд[её]т\s+ли|маленьк|поздно|стар)/i,
  partner:  /(парн|партн|вдво[её]м|с\s+подруг)/i,
  energy:   /(гиперактив|непосед|энерги|устаю)/i,
  fitness:  /(похуд|кардио|форм)/i
};

function detectObjections(message: string): string[] {
  const out: string[] = [];
  for (const [key, pattern] of Object.entries(OBJECTION_KEYWORDS)) {
    if (pattern.test(message)) out.push(key);
  }
  return out;
}

function normalizeDirection(direction?: string): string | undefined {
  if (!direction) return undefined;
  const map: Record<string, string> = {
    "hip-hop": "hip-hop",
    "breakdance": "breakdance",
    "contemporary": "contemporary",
    "йога": "yoga",
    "zumba": "zumba",
    "lady style": "lady style",
    "восточные танцы": "lady style",
    "jazz funk": "jazz funk",
    "k-pop": "k-pop",
    "salsa/bachata": "salsa",
    "стрип-пластика": "lady style",
    "dancehall": "hip-hop",
    "детская хореография": "any"
  };
  const lower = direction.toLowerCase();
  return map[lower] ?? lower;
}

function ageInRange(age: number | undefined, rangeStr: string): boolean {
  if (age === undefined) return false;
  if (rangeStr === "any") return true;
  const plus = rangeStr.match(/^(\d+)\+$/);
  if (plus) return age >= Number(plus[1]);
  const range = rangeStr.match(/^(\d+)-(\d+)$/);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    return age >= lo && age <= hi;
  }
  return false;
}

function scoreStory(story: SuccessStory, input: RetrievalInput, profile: string | undefined): number {
  let score = 0;
  const normDir = normalizeDirection(input.direction);
  const directionTags = story.tags.direction ?? [];
  if (normDir && directionTags.some((d) => d === normDir || d === "any")) score += 3;

  const ageTags = story.tags.age ?? [];
  if (input.age !== undefined && ageTags.some((range) => ageInRange(input.age, range))) {
    score += 2;
  }

  const objections = detectObjections(input.customerMessage);
  const storyObjections = story.tags.objection ?? [];
  if (objections.some((o) => storyObjections.includes(o))) {
    score += 3;
  }

  if (profile && story.tags.profile?.includes(profile)) {
    score += 1;
  }

  if (input.learnerType && story.tags.learner_type?.includes(input.learnerType)) {
    score += 1;
  }

  score *= story.weight;
  return score;
}

export async function findRelevantSuccessStory(
  input: RetrievalInput & { profile?: string }
): Promise<string | null> {
  const stories = await loadStories();
  if (!stories.length) return null;

  // На определённых stage истории не помогают — экономим контекст.
  if (input.stage && ["ask_name", "ask_phone", "ask_consent", "booked", "handoff"].includes(input.stage)) {
    return null;
  }

  let best: { story: SuccessStory; score: number } | null = null;
  for (const story of stories) {
    const score = scoreStory(story, input, input.profile);
    if (score < 4) continue;
    if (!best || score > best.score) best = { story, score };
  }
  return best ? best.story.body : null;
}

export async function getAllStories(): Promise<SuccessStory[]> {
  return loadStories();
}

export function clearStoriesCache(): void {
  cache = null;
  cacheLoadedAt = 0;
}
