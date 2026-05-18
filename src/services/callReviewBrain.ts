import { config } from "../config.js";
import type { PreparedCallRecord } from "./callAnalysis.js";
import { realCallReviewSystemPrompt } from "./callReviewPrompts.js";

export type CallReviewCategory =
  | "stage_jump"
  | "missing_name_step"
  | "weak_need_discovery"
  | "too_many_questions"
  | "unnatural_russian"
  | "tts_risky_phrase"
  | "hallucination"
  | "price_logic"
  | "branch_logic"
  | "objection_handling"
  | "weak_offer"
  | "weak_close"
  | "policy_violation";

export interface CallReviewIssue {
  category: CallReviewCategory;
  severity: "low" | "medium" | "high";
  title: string;
  evidence: string;
  recommendation: string;
}

export interface CallReview {
  overallVerdict: "strong" | "ok" | "weak" | "broken";
  outcome: "booked" | "not_booked" | "unknown";
  likelyLeadType: "child" | "adult" | "unknown";
  overallSummary: string;
  stageCompletion: {
    greeting: boolean;
    name: boolean;
    learnerType: boolean;
    need: boolean;
    age: boolean;
    branch: boolean;
    solution: boolean;
    phone: boolean;
    consent: boolean;
    bookingConfirmation: boolean;
  };
  issues: CallReviewIssue[];
  ttsRiskPhrases: string[];
  promptFixes: string[];
  scriptFixes: string[];
}

export interface CallReviewAttempt {
  review: CallReview;
  source: "heuristic" | "openai" | "timeout" | "network_error" | "http_error" | "empty_output" | "invalid_json";
  latencyMs: number;
  error?: string;
}

export interface CallReviewBatchSummary {
  totals: {
    reviewed: number;
    booked: number;
    notBooked: number;
    unknown: number;
  };
  verdicts: Record<CallReview["overallVerdict"], number>;
  categories: Record<CallReviewCategory, number>;
  topPromptFixes: string[];
  topScriptFixes: string[];
  topTtsRisks: string[];
}

export function canUseOpenAiCallReview(): boolean {
  if (process.env.VITEST || process.env.DISABLE_REMOTE_SEMANTICS === "1") {
    return false;
  }

  return Boolean(config.openai.apiKey);
}

export async function reviewCallTranscript(input: {
  record: PreparedCallRecord;
  transcript: string;
}): Promise<CallReviewAttempt> {
  const heuristic = buildHeuristicReview(input.transcript);

  if (!canUseOpenAiCallReview()) {
    return {
      review: heuristic,
      source: "heuristic",
      latencyMs: 0
    };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(config.openai.dialogTimeoutMs, 8000));
  let response: Response;

  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.openai.dialogModelId,
        reasoning: { effort: "low" },
        max_output_tokens: 1400,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: realCallReviewSystemPrompt }]
          },
          {
            role: "user",
            content: [{
              type: "input_text",
              text: JSON.stringify({
                record: {
                  id: input.record.id,
                  stem: input.record.stem,
                  metadata: input.record.metadata,
                  warnings: input.record.warnings
                },
                transcript: input.transcript.slice(0, 18000)
              })
            }]
          }
        ],
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: "real_call_review",
            strict: true,
            schema: buildReviewSchema()
          }
        }
      })
    });
  } catch (error) {
    clearTimeout(timeout);
    return {
      review: heuristic,
      source: error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error",
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : undefined
    };
  }

  clearTimeout(timeout);

  if (!response.ok) {
    return {
      review: heuristic,
      source: "http_error",
      latencyMs: Date.now() - startedAt,
      error: await response.text()
    };
  }

  const payload = await response.json();
  const outputText = extractStructuredOutputText(payload);
  if (!outputText) {
    return {
      review: heuristic,
      source: "empty_output",
      latencyMs: Date.now() - startedAt
    };
  }

  try {
    const parsed = JSON.parse(outputText) as CallReview;
    return {
      review: parsed,
      source: "openai",
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      review: heuristic,
      source: "invalid_json",
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : undefined
    };
  }
}

export function summarizeCallReviews(reviews: CallReview[]): CallReviewBatchSummary {
  const categories = emptyCategoryCounter();
  const verdicts = {
    strong: 0,
    ok: 0,
    weak: 0,
    broken: 0
  } satisfies Record<CallReview["overallVerdict"], number>;
  const promptFixes = new Map<string, number>();
  const scriptFixes = new Map<string, number>();
  const ttsRisks = new Map<string, number>();

  let booked = 0;
  let notBooked = 0;
  let unknown = 0;

  for (const review of reviews) {
    verdicts[review.overallVerdict] += 1;
    if (review.outcome === "booked") booked += 1;
    else if (review.outcome === "not_booked") notBooked += 1;
    else unknown += 1;

    for (const issue of review.issues) {
      categories[issue.category] += 1;
    }

    for (const fix of review.promptFixes) {
      promptFixes.set(fix, (promptFixes.get(fix) ?? 0) + 1);
    }
    for (const fix of review.scriptFixes) {
      scriptFixes.set(fix, (scriptFixes.get(fix) ?? 0) + 1);
    }
    for (const risk of review.ttsRiskPhrases) {
      ttsRisks.set(risk, (ttsRisks.get(risk) ?? 0) + 1);
    }
  }

  return {
    totals: {
      reviewed: reviews.length,
      booked,
      notBooked,
      unknown
    },
    verdicts,
    categories,
    topPromptFixes: topMapKeys(promptFixes),
    topScriptFixes: topMapKeys(scriptFixes),
    topTtsRisks: topMapKeys(ttsRisks)
  };
}

function buildHeuristicReview(transcript: string): CallReview {
  const lower = transcript.toLowerCase();
  const greeting = /(здравствуйте|добрый день|привет)/i.test(transcript);
  const name = /(как к вам обращаться|как вас зовут|меня зовут)/i.test(transcript);
  const learnerType = /(для вас|для себя|для ребенка|для ребёнка|сын|дочка|ребенку|ребёнку)/i.test(transcript);
  const need = /(что хотите|что вам ближе|какое направление|что-то поактивнее|что-то спокойнее|просто попробовать)/i.test(transcript);
  const age = /(сколько лет|ему \d+|ей \d+|\d+\s*(лет|года|год))/i.test(transcript);
  const branch = /(развилк|озер|школь|где удобнее заниматься|какой район)/i.test(transcript);
  const solution = /(могу предложить|подойдет|подойдёт|пробное стоит|во вторник|в четверг|в субботу)/i.test(transcript);
  const phone = /(номер телефона|телефон)/i.test(transcript);
  const consent = /(согласие|разрешение|сохранить данные)/i.test(transcript);
  const bookingConfirmation = /(записал|записала|готово|ждем вас|ждём вас)/i.test(transcript);

  const issues: CallReviewIssue[] = [];
  if (!name) {
    issues.push({
      category: "missing_name_step",
      severity: "medium",
      title: "Не видно шага с именем",
      evidence: "В разговоре не найден явный шаг, где менеджер узнает имя клиента.",
      recommendation: "Проверить, что ask_name не пропускается после приветствия и не съедается длинным первым сообщением клиента."
    });
  }
  if (/\?\s*[^\n?.!]+\?/g.test(transcript)) {
    issues.push({
      category: "too_many_questions",
      severity: "medium",
      title: "Похоже, есть двойные вопросы",
      evidence: "В тексте есть реплики, где подряд встречаются два вопросительных блока.",
      recommendation: "Ужать prompt и reply-layer до одного основного вопроса за сообщение."
    });
  }
  if (/(уверенн|раскрепост|самовыраж|для души|выразительн)/i.test(transcript)) {
    issues.push({
      category: "unnatural_russian",
      severity: "medium",
      title: "Есть неестественные формулировки",
      evidence: "В разговоре встречаются психологические или книжные слова.",
      recommendation: "Переписать клиентские фразы на более бытовой русский и добавить такие слова в speech blacklist."
    });
  }

  const outcome: CallReview["outcome"] = bookingConfirmation ? "booked" : solution ? "unknown" : "not_booked";
  const likelyLeadType: CallReview["likelyLeadType"] = /(сын|дочка|ребенк|ребёнк|лет)/i.test(transcript)
    ? "child"
    : /(для себя|для вас)/i.test(transcript)
      ? "adult"
      : "unknown";

  return {
    overallVerdict: issues.length === 0 ? "ok" : issues.some((issue) => issue.severity === "high") ? "broken" : "weak",
    outcome,
    likelyLeadType,
    overallSummary: issues.length === 0
      ? "Базовая структура разговора выглядит рабочей, можно смотреть глубже на стиль и конверсию."
      : "Есть явные точки для правки в шагах разговора или в языке менеджера.",
    stageCompletion: {
      greeting,
      name,
      learnerType,
      need,
      age,
      branch,
      solution,
      phone,
      consent,
      bookingConfirmation
    },
    issues,
    ttsRiskPhrases: findTtsRiskPhrases(transcript),
    promptFixes: issues.map((issue) => issue.recommendation),
    scriptFixes: issues.map((issue) => issue.recommendation)
  };
}

function buildReviewSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      overallVerdict: { type: "string", enum: ["strong", "ok", "weak", "broken"] },
      outcome: { type: "string", enum: ["booked", "not_booked", "unknown"] },
      likelyLeadType: { type: "string", enum: ["child", "adult", "unknown"] },
      overallSummary: { type: "string" },
      stageCompletion: {
        type: "object",
        additionalProperties: false,
        properties: {
          greeting: { type: "boolean" },
          name: { type: "boolean" },
          learnerType: { type: "boolean" },
          need: { type: "boolean" },
          age: { type: "boolean" },
          branch: { type: "boolean" },
          solution: { type: "boolean" },
          phone: { type: "boolean" },
          consent: { type: "boolean" },
          bookingConfirmation: { type: "boolean" }
        },
        required: ["greeting", "name", "learnerType", "need", "age", "branch", "solution", "phone", "consent", "bookingConfirmation"]
      },
      issues: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            category: {
              type: "string",
              enum: [
                "stage_jump",
                "missing_name_step",
                "weak_need_discovery",
                "too_many_questions",
                "unnatural_russian",
                "tts_risky_phrase",
                "hallucination",
                "price_logic",
                "branch_logic",
                "objection_handling",
                "weak_offer",
                "weak_close",
                "policy_violation"
              ]
            },
            severity: { type: "string", enum: ["low", "medium", "high"] },
            title: { type: "string" },
            evidence: { type: "string" },
            recommendation: { type: "string" }
          },
          required: ["category", "severity", "title", "evidence", "recommendation"]
        }
      },
      ttsRiskPhrases: { type: "array", items: { type: "string" } },
      promptFixes: { type: "array", items: { type: "string" } },
      scriptFixes: { type: "array", items: { type: "string" } }
    },
    required: ["overallVerdict", "outcome", "likelyLeadType", "overallSummary", "stageCompletion", "issues", "ttsRiskPhrases", "promptFixes", "scriptFixes"]
  };
}

function extractStructuredOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const direct = Reflect.get(payload, "output_text");
  if (typeof direct === "string" && direct.trim()) {
    return direct;
  }

  const output = Reflect.get(payload, "output");
  if (!Array.isArray(output)) {
    return "";
  }

  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const content = Reflect.get(item, "content");
    if (!Array.isArray(content)) {
      continue;
    }

    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }

      if (Reflect.get(block, "type") === "output_text") {
        const text = Reflect.get(block, "text");
        if (typeof text === "string" && text.trim()) {
          return text;
        }
      }
    }
  }

  return "";
}

function findTtsRiskPhrases(transcript: string): string[] {
  const risks = ["большая", "большой", "большое", "раскрепоститься", "уверенность", "самовыражение", "выразительность"];
  const lower = transcript.toLowerCase();
  return risks.filter((risk) => lower.includes(risk)).slice(0, 8);
}

function emptyCategoryCounter(): Record<CallReviewCategory, number> {
  return {
    stage_jump: 0,
    missing_name_step: 0,
    weak_need_discovery: 0,
    too_many_questions: 0,
    unnatural_russian: 0,
    tts_risky_phrase: 0,
    hallucination: 0,
    price_logic: 0,
    branch_logic: 0,
    objection_handling: 0,
    weak_offer: 0,
    weak_close: 0,
    policy_violation: 0
  };
}

function topMapKeys(map: Map<string, number>, limit = 8): string[] {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([key]) => key);
}
