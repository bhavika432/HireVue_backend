import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { UsageRecord } from "./usage";

export const DEFAULT_USAGE_LOG = "ai-logs/usage.jsonl";

/** Append one usage record as a line of JSON. Logging must never break a run, so errors are swallowed. */
export async function appendUsage(record: UsageRecord, file = DEFAULT_USAGE_LOG): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(record) + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

export async function readUsage(file = DEFAULT_USAGE_LOG): Promise<UsageRecord[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as UsageRecord];
      } catch {
        return [];
      }
    });
}
