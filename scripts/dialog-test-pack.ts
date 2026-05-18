// Test pack проверяет детерминированную FSM-логику, без зависимостей от OpenAI/ElevenLabs.
process.env.DISABLE_REMOTE_SEMANTICS = "1";
process.env.SEMANTIC_MODE = "rules_only";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { handleSalesDialog, type SalesDialogState } from "../src/services/salesDialog.js";

interface TestCase {
  id: string;
  messages: string[];
  expectAction?: string;
  expectState?: Partial<Record<keyof SalesDialogState, unknown>>;
  expectReplyContains?: string;
}

const PACK_PATH = resolve("./data/dialog-test-pack.json");

interface CaseResult {
  id: string;
  pass: boolean;
  failures: string[];
  finalAction: string;
  finalReply: string;
}

async function main() {
  const raw = await readFile(PACK_PATH, "utf8");
  const cases = JSON.parse(raw) as TestCase[];

  let passed = 0;
  const results: CaseResult[] = [];

  for (const tc of cases) {
    const failures: string[] = [];
    let state: SalesDialogState = {};
    let lastReply = "";
    let lastAction = "";
    for (const message of tc.messages) {
      const result = await handleSalesDialog({ message, state });
      state = result.state;
      lastReply = result.reply;
      lastAction = result.action;
    }

    if (tc.expectAction && lastAction !== tc.expectAction) {
      failures.push(`action: ожидали ${tc.expectAction}, получили ${lastAction}`);
    }
    if (tc.expectState) {
      for (const [key, expected] of Object.entries(tc.expectState)) {
        const actual = (state as Record<string, unknown>)[key];
        if (actual !== expected) {
          failures.push(`state.${key}: ожидали ${JSON.stringify(expected)}, получили ${JSON.stringify(actual)}`);
        }
      }
    }
    if (tc.expectReplyContains && !lastReply.toLowerCase().includes(tc.expectReplyContains.toLowerCase())) {
      failures.push(`reply не содержит "${tc.expectReplyContains}". Reply: "${lastReply.slice(0, 120)}"`);
    }

    const pass = failures.length === 0;
    if (pass) passed += 1;
    results.push({ id: tc.id, pass, failures, finalAction: lastAction, finalReply: lastReply.slice(0, 100) });
  }

  console.log(`\n=== Test pack: ${passed}/${cases.length} прошли ===\n`);
  for (const r of results) {
    const status = r.pass ? "✓" : "✗";
    console.log(`${status} ${r.id} → ${r.finalAction}`);
    if (!r.pass) {
      for (const f of r.failures) console.log(`    └─ ${f}`);
      console.log(`    └─ reply: "${r.finalReply}..."`);
    }
  }

  if (passed < cases.length) {
    console.log(`\nНе прошло ${cases.length - passed} кейсов. Это нормальный baseline — фиксируйте по одному.`);
    process.exit(1);
  }
  console.log(`\nВсе ${cases.length} кейсов прошли.`);
}

await main();
