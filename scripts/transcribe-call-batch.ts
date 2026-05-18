import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureCallAnalysisWorkspace, prepareCallAnalysisBatch, transcribePreparedCallRecord, type PreparedCallBatch } from "../src/services/callAnalysis.js";

const provider = (process.env.CALL_ANALYSIS_STT_PROVIDER === "yandex" ? "yandex" : "elevenlabs");
const paths = await ensureCallAnalysisWorkspace();
const batch = await prepareCallAnalysisBatch(paths.baseDir);

const updatedRecords = [];
for (const record of batch.records) {
  if (record.status !== "ready_for_transcription") {
    updatedRecords.push(record);
    continue;
  }

  console.log(`Распознаю: ${record.id}`);
  const updated = await transcribePreparedCallRecord(record, provider, paths.baseDir);
  updatedRecords.push(updated);
}

const updatedBatch: PreparedCallBatch = {
  ...batch,
  generatedAt: new Date().toISOString(),
  records: updatedRecords,
  totals: {
    total: updatedRecords.length,
    readyForTranscription: updatedRecords.filter((record) => record.status === "ready_for_transcription").length,
    readyForReview: updatedRecords.filter((record) => record.status === "ready_for_review").length,
    missingSource: updatedRecords.filter((record) => record.status === "missing_source").length
  }
};

await fs.writeFile(
  path.join(paths.manifestsDir, "batch-manifest.json"),
  `${JSON.stringify(updatedBatch, null, 2)}\n`,
  "utf8"
);

console.log(`Готово. Транскрипты лежат в ${paths.transcriptsDir}`);
