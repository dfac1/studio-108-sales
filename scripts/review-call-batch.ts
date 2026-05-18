import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ensureCallAnalysisWorkspace,
  prepareCallAnalysisBatch,
  readTranscriptFile,
  type PreparedCallRecord
} from "../src/services/callAnalysis.js";
import { reviewCallTranscript, summarizeCallReviews, type CallReview, type CallReviewAttempt } from "../src/services/callReviewBrain.js";

interface StoredCallReview {
  record: PreparedCallRecord;
  review: CallReview;
  source: CallReviewAttempt["source"];
  latencyMs: number;
  error?: string;
}

const paths = await ensureCallAnalysisWorkspace();
const batch = await prepareCallAnalysisBatch(paths.baseDir);

const storedReviews: StoredCallReview[] = [];
for (const record of batch.records) {
  if (record.status !== "ready_for_review" || !record.transcriptPath) {
    continue;
  }

  const transcript = await readTranscriptFile(record.transcriptPath);
  const attempt = await reviewCallTranscript({ record, transcript });
  const stored: StoredCallReview = {
    record,
    review: attempt.review,
    source: attempt.source,
    latencyMs: attempt.latencyMs,
    error: attempt.error
  };
  storedReviews.push(stored);

  await fs.writeFile(
    path.join(paths.reviewsDir, `${record.stem}.json`),
    `${JSON.stringify(stored, null, 2)}\n`,
    "utf8"
  );

  console.log(`Review: ${record.id} -> ${attempt.review.overallVerdict} (${attempt.source})`);
}

const summary = summarizeCallReviews(storedReviews.map((item) => item.review));
const markdown = buildSummaryMarkdown(summary, storedReviews);

await fs.writeFile(path.join(paths.reportsDir, "latest-review-report.md"), markdown, "utf8");

console.log(`Сводка сохранена: ${path.join(paths.reportsDir, "latest-review-report.md")}`);

function buildSummaryMarkdown(
  summary: ReturnType<typeof summarizeCallReviews>,
  storedReviews: StoredCallReview[]
): string {
  const lines: string[] = [];
  lines.push("# Сводка по реальным звонкам");
  lines.push("");
  lines.push(`Дата: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Итог");
  lines.push("");
  lines.push(`- Разобрано звонков: ${summary.totals.reviewed}`);
  lines.push(`- Booked: ${summary.totals.booked}`);
  lines.push(`- Not booked: ${summary.totals.notBooked}`);
  lines.push(`- Unknown: ${summary.totals.unknown}`);
  lines.push("");
  lines.push("## Вердикты");
  lines.push("");
  lines.push(`- strong: ${summary.verdicts.strong}`);
  lines.push(`- ok: ${summary.verdicts.ok}`);
  lines.push(`- weak: ${summary.verdicts.weak}`);
  lines.push(`- broken: ${summary.verdicts.broken}`);
  lines.push("");
  lines.push("## Частые категории проблем");
  lines.push("");
  for (const [category, count] of Object.entries(summary.categories).sort((left, right) => right[1] - left[1])) {
    if (count > 0) {
      lines.push(`- ${category}: ${count}`);
    }
  }
  lines.push("");
  lines.push("## Топ правок в prompt");
  lines.push("");
  for (const fix of summary.topPromptFixes) {
    lines.push(`- ${fix}`);
  }
  lines.push("");
  lines.push("## Топ правок в скрипт");
  lines.push("");
  for (const fix of summary.topScriptFixes) {
    lines.push(`- ${fix}`);
  }
  lines.push("");
  lines.push("## TTS-риск фразы");
  lines.push("");
  for (const risk of summary.topTtsRisks) {
    lines.push(`- ${risk}`);
  }
  lines.push("");
  lines.push("## По звонкам");
  lines.push("");
  for (const item of storedReviews) {
    lines.push(`### ${item.record.id}`);
    lines.push(`- Verdict: ${item.review.overallVerdict}`);
    lines.push(`- Outcome: ${item.review.outcome}`);
    lines.push(`- Source: ${item.source}`);
    lines.push(`- Summary: ${item.review.overallSummary}`);
    if (item.review.issues.length) {
      lines.push("- Issues:");
      for (const issue of item.review.issues) {
        lines.push(`  - [${issue.severity}] ${issue.title}: ${issue.recommendation}`);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
