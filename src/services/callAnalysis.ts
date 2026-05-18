import { promises as fs } from "node:fs";
import path from "node:path";
import type { SttProviderId } from "../types.js";
import { transcribeSpeech } from "./voiceProviders.js";

const audioExtensions = new Set([".mp3", ".wav", ".ogg", ".m4a", ".webm", ".mp4", ".mpeg"]);
const transcriptExtensions = new Set([".txt", ".md"]);
const metadataExtensions = new Set([".json"]);

export interface CallAnalysisPaths {
  baseDir: string;
  inboxDir: string;
  workDir: string;
  transcriptsDir: string;
  reviewsDir: string;
  manifestsDir: string;
  reportsDir: string;
  archiveDir: string;
}

export interface CallSourceMetadata {
  externalId?: string;
  callStartedAt?: string;
  channel?: string;
  callerPhoneMasked?: string;
  managerName?: string;
  branchHint?: string;
  directionHint?: string;
  outcomeHint?: string;
  notes?: string;
}

export interface CallAssetGroup {
  id: string;
  stem: string;
  audioPath?: string;
  transcriptPath?: string;
  metadataPath?: string;
  notesPath?: string;
  metadata?: CallSourceMetadata;
  warnings: string[];
}

export interface PreparedCallRecord {
  id: string;
  stem: string;
  status: "ready_for_transcription" | "ready_for_review" | "missing_source";
  audioPath?: string;
  transcriptPath?: string;
  metadataPath?: string;
  notesPath?: string;
  metadata?: CallSourceMetadata;
  transcriptPreview?: string;
  warnings: string[];
}

export interface PreparedCallBatch {
  generatedAt: string;
  baseDir: string;
  records: PreparedCallRecord[];
  totals: {
    total: number;
    readyForTranscription: number;
    readyForReview: number;
    missingSource: number;
  };
}

export interface ConversationTurn {
  speaker: "manager" | "client" | "unknown";
  text: string;
}

export function getCallAnalysisPaths(baseDir = path.resolve("data", "call-analysis")): CallAnalysisPaths {
  return {
    baseDir,
    inboxDir: path.join(baseDir, "inbox"),
    workDir: path.join(baseDir, "work"),
    transcriptsDir: path.join(baseDir, "work", "transcripts"),
    reviewsDir: path.join(baseDir, "work", "reviews"),
    manifestsDir: path.join(baseDir, "work", "manifests"),
    reportsDir: path.join(baseDir, "reports"),
    archiveDir: path.join(baseDir, "archive")
  };
}

export async function ensureCallAnalysisWorkspace(baseDir?: string): Promise<CallAnalysisPaths> {
  const paths = getCallAnalysisPaths(baseDir);
  const directories = [
    paths.baseDir,
    paths.inboxDir,
    paths.workDir,
    paths.transcriptsDir,
    paths.reviewsDir,
    paths.manifestsDir,
    paths.reportsDir,
    paths.archiveDir
  ];

  await Promise.all(directories.map((directory) => fs.mkdir(directory, { recursive: true })));
  return paths;
}

export async function scanCallAnalysisInbox(baseDir?: string): Promise<CallAssetGroup[]> {
  const paths = await ensureCallAnalysisWorkspace(baseDir);
  const entries = await fs.readdir(paths.inboxDir, { withFileTypes: true });
  const grouped = new Map<string, CallAssetGroup>();

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const fileName = entry.name;
    if (fileName.startsWith(".")) {
      continue;
    }
    const absolutePath = path.join(paths.inboxDir, fileName);
    const extension = path.extname(fileName).toLowerCase();
    const stem = normalizeCallStem(fileName);
    const id = stem;
    const group = grouped.get(id) ?? {
      id,
      stem,
      warnings: []
    };

    if (audioExtensions.has(extension)) {
      group.audioPath = absolutePath;
    } else if (transcriptExtensions.has(extension)) {
      if (/notes?/i.test(fileName)) {
        group.notesPath = absolutePath;
      } else {
        group.transcriptPath = absolutePath;
      }
    } else if (metadataExtensions.has(extension)) {
      if (/manifest/i.test(fileName)) {
        group.warnings.push(`Пропущен служебный JSON в inbox: ${fileName}`);
      } else {
        group.metadataPath = absolutePath;
        group.metadata = await readMetadataFile(absolutePath, group.warnings);
      }
    } else {
      group.warnings.push(`Неизвестный тип файла: ${fileName}`);
    }

    grouped.set(id, group);
  }

  return [...grouped.values()].sort((left, right) => left.stem.localeCompare(right.stem, "ru"));
}

export async function prepareCallAnalysisBatch(baseDir?: string): Promise<PreparedCallBatch> {
  const paths = await ensureCallAnalysisWorkspace(baseDir);
  const groups = await scanCallAnalysisInbox(paths.baseDir);

  const records: PreparedCallRecord[] = [];
  for (const group of groups) {
    const transcriptPath = group.transcriptPath;
    const transcriptPreview = transcriptPath ? buildTranscriptPreview(await readTranscriptFile(transcriptPath)) : undefined;
    const status: PreparedCallRecord["status"] = transcriptPath
      ? "ready_for_review"
      : group.audioPath
        ? "ready_for_transcription"
        : "missing_source";

    records.push({
      id: group.id,
      stem: group.stem,
      status,
      audioPath: group.audioPath,
      transcriptPath,
      metadataPath: group.metadataPath,
      notesPath: group.notesPath,
      metadata: group.metadata,
      transcriptPreview,
      warnings: group.warnings
    });
  }

  const batch: PreparedCallBatch = {
    generatedAt: new Date().toISOString(),
    baseDir: paths.baseDir,
    records,
    totals: {
      total: records.length,
      readyForTranscription: records.filter((record) => record.status === "ready_for_transcription").length,
      readyForReview: records.filter((record) => record.status === "ready_for_review").length,
      missingSource: records.filter((record) => record.status === "missing_source").length
    }
  };

  await fs.writeFile(
    path.join(paths.manifestsDir, "batch-manifest.json"),
    `${JSON.stringify(batch, null, 2)}\n`,
    "utf8"
  );

  return batch;
}

export async function transcribePreparedCallRecord(
  record: PreparedCallRecord,
  provider: SttProviderId = "elevenlabs",
  baseDir?: string
): Promise<PreparedCallRecord> {
  if (!record.audioPath) {
    throw new Error(`У записи ${record.id} нет аудио для распознавания.`);
  }

  const paths = await ensureCallAnalysisWorkspace(baseDir);
  const audio = await fs.readFile(record.audioPath);
  const mimeType = guessMimeType(record.audioPath);
  const fileName = path.basename(record.audioPath);
  const result = await transcribeSpeech({
    provider,
    audio,
    mimeType,
    fileName,
    languageCode: "ru"
  });

  const transcriptPath = path.join(paths.transcriptsDir, `${record.stem}.txt`);
  await fs.writeFile(transcriptPath, `${result.text.trim()}\n`, "utf8");

  return {
    ...record,
    transcriptPath,
    transcriptPreview: buildTranscriptPreview(result.text),
    status: "ready_for_review",
    warnings: record.warnings
  };
}

export async function readTranscriptFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, "utf8");
  return content.replace(/\r\n/g, "\n").trim();
}

export function splitTranscriptIntoTurns(transcript: string): ConversationTurn[] {
  return transcript
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (/^(менеджер|администратор|оператор|агент)\s*[:\-]/i.test(line)) {
        return {
          speaker: "manager" as const,
          text: line.replace(/^(менеджер|администратор|оператор|агент)\s*[:\-]\s*/i, "").trim()
        };
      }

      if (/^(клиент|лид|родитель|ученик)\s*[:\-]/i.test(line)) {
        return {
          speaker: "client" as const,
          text: line.replace(/^(клиент|лид|родитель|ученик)\s*[:\-]\s*/i, "").trim()
        };
      }

      return {
        speaker: "unknown" as const,
        text: line
      };
    });
}

export function buildTranscriptPreview(transcript: string, maxLength = 180): string {
  const normalized = transcript.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function normalizeCallStem(fileName: string): string {
  const extension = path.extname(fileName);
  return path.basename(fileName, extension).replace(/\.(transcript|meta|metadata|notes)$/i, "");
}

async function readMetadataFile(filePath: string, warnings: string[]): Promise<CallSourceMetadata | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    return {
      externalId: getOptionalString(parsed.externalId),
      callStartedAt: getOptionalString(parsed.callStartedAt),
      channel: getOptionalString(parsed.channel),
      callerPhoneMasked: getOptionalString(parsed.callerPhoneMasked),
      managerName: getOptionalString(parsed.managerName),
      branchHint: getOptionalString(parsed.branchHint),
      directionHint: getOptionalString(parsed.directionHint),
      outcomeHint: getOptionalString(parsed.outcomeHint),
      notes: getOptionalString(parsed.notes)
    };
  } catch (error) {
    warnings.push(`Не удалось прочитать metadata JSON: ${filePath}`);
    return undefined;
  }
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function guessMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".wav") return "audio/wav";
  if (extension === ".ogg") return "audio/ogg";
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".webm") return "audio/webm";
  if (extension === ".mp4") return "audio/mp4";
  return "audio/mpeg";
}
