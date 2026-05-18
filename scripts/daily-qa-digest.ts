#!/usr/bin/env tsx
/**
 * Daily QA digest — выводит в консоль сводку диалогов за последние 24ч.
 * Запуск: `npm run qa:digest` или `tsx scripts/daily-qa-digest.ts [windowHours]`.
 */

import { buildQaDigest } from "../src/services/qaService.js";

async function main() {
  const windowHours = Number(process.argv[2] ?? "24") || 24;
  const digest = await buildQaDigest(windowHours);

  console.log("\n=== Studio 108 — QA Digest ===");
  console.log(`Окно: последние ${windowHours} ч`);
  console.log("");
  console.log(`Диалогов всего:        ${digest.summary.totalConversations}`);
  console.log(`Booked:                ${digest.summary.totalBooked}`);
  console.log(`Handoff:               ${digest.summary.totalHandoff}`);
  console.log(`Средние turn'ов:       ${digest.summary.averageTurns.toFixed(1)}`);
  console.log(`Средняя латентность:   ${Math.round(digest.summary.averageLatencyMs)} мс`);
  console.log(`Brain hit rate:        ${(digest.summary.brainHitRate * 100).toFixed(1)} %`);

  if (digest.summary.warnings.length) {
    console.log("\nПредупреждения:");
    for (const w of digest.summary.warnings) console.log(`  • ${w}`);
  }

  if (digest.topWeird.length) {
    console.log("\n--- Топ-странных диалогов (на ревью) ---");
    for (const c of digest.topWeird) {
      console.log(`  ${c.conversationId} | ${c.customerName ?? "?"} | turn=${c.turns} | final=${c.finalAction} | score=${c.weirdnessScore}`);
      for (const w of c.warnings) console.log(`     ${w}`);
    }
  }

  console.log("\nДля детальной разметки откройте admin.html, вкладка QA.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
