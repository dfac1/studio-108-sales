import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCallAnalysisWorkspace, prepareCallAnalysisBatch, splitTranscriptIntoTurns } from "./callAnalysis.js";

const tempDirs: string[] = [];

describe("call analysis workspace", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
  });

  it("prepares a manifest from raw inbox files", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "sales-call-analysis-"));
    tempDirs.push(baseDir);

    const paths = await ensureCallAnalysisWorkspace(baseDir);
    await fs.writeFile(path.join(paths.inboxDir, "call-001.mp3"), Buffer.from([1, 2, 3]));
    await fs.writeFile(path.join(paths.inboxDir, "call-001.meta.json"), JSON.stringify({ managerName: "Анна" }), "utf8");
    await fs.writeFile(path.join(paths.inboxDir, "call-002.transcript.txt"), "Менеджер: Здравствуйте\nКлиент: Добрый день", "utf8");

    const batch = await prepareCallAnalysisBatch(baseDir);

    expect(batch.totals.total).toBe(2);
    expect(batch.totals.readyForTranscription).toBe(1);
    expect(batch.totals.readyForReview).toBe(1);
    expect(batch.records.find((record) => record.id === "call-001")?.metadata?.managerName).toBe("Анна");
    expect(batch.records.find((record) => record.id === "call-002")?.transcriptPreview).toContain("Менеджер:");
  });

  it("splits a transcript into turns when speaker labels are present", () => {
    const turns = splitTranscriptIntoTurns("Менеджер: Здравствуйте\nКлиент: Добрый день\nПросто текст");

    expect(turns).toHaveLength(3);
    expect(turns[0].speaker).toBe("manager");
    expect(turns[1].speaker).toBe("client");
    expect(turns[2].speaker).toBe("unknown");
  });
});
