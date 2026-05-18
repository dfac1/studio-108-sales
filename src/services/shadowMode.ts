import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isFlagOn, type FlagKey } from "./featureFlags.js";

const SHADOW_LOG_PATH = resolve(process.env.SHADOW_LOG_PATH ?? "./data/shadow-events.jsonl");

export interface ShadowEvent {
  ts: string;
  flag: FlagKey;
  rule: string;
  outcome: "would_block" | "would_change";
  context: Record<string, unknown>;
}

export async function recordShadowEvent(event: Omit<ShadowEvent, "ts">): Promise<void> {
  try {
    await mkdir(dirname(SHADOW_LOG_PATH), { recursive: true });
    await appendFile(SHADOW_LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, "utf8");
  } catch {
    // Shadow-логи не должны ломать прод-флоу.
  }
}

export async function shadowOrEnforce<T>(input: {
  flag: FlagKey;
  rule: string;
  shouldFail: () => boolean;
  context: Record<string, unknown>;
  enforceValue: T;
  passValue: T;
}): Promise<T> {
  const fails = input.shouldFail();
  if (!fails) return input.passValue;
  if (isFlagOn(input.flag)) {
    return input.enforceValue;
  }
  void recordShadowEvent({
    flag: input.flag,
    rule: input.rule,
    outcome: "would_block",
    context: input.context
  });
  return input.passValue;
}
