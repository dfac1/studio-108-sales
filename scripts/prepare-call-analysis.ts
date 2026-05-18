import { ensureCallAnalysisWorkspace, prepareCallAnalysisBatch } from "../src/services/callAnalysis.js";

const paths = await ensureCallAnalysisWorkspace();
const batch = await prepareCallAnalysisBatch(paths.baseDir);

console.log(`Inbox: ${paths.inboxDir}`);
console.log(`Manifest: ${paths.manifestsDir}\\batch-manifest.json`);
console.log(`Всего записей: ${batch.totals.total}`);
console.log(`Готовы к транскрибации: ${batch.totals.readyForTranscription}`);
console.log(`Готовы к review: ${batch.totals.readyForReview}`);
console.log(`Не хватает исходников: ${batch.totals.missingSource}`);

for (const record of batch.records) {
  const warnings = record.warnings.length ? ` | warnings: ${record.warnings.join("; ")}` : "";
  console.log(`- ${record.id}: ${record.status}${warnings}`);
}
