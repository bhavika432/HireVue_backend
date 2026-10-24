/**
 * Latency and cost tracking: what one response costs and how long it takes, so the team can estimate
 * the bill and the capacity for the real number of students.
 *
 * Prices are ESTIMATES. Groq's rates below were taken from its speech-to-text docs when this was written;
 * check current pricing before relying on them. Gemini prices are not hardcoded: set
 * GEMINI_INPUT_PRICE_PER_M and GEMINI_OUTPUT_PRICE_PER_M (US dollars per million tokens, from the Google AI
 * Studio pricing page) to include them; without them only token counts are reported.
 */

export const GROQ_PRICE_PER_HOUR_USD: Record<string, number> = {
  "whisper-large-v3-turbo": 0.04,
  "whisper-large-v3": 0.111,
};
/** Groq bills at least this many seconds per request. */
export const GROQ_MIN_BILLED_SECONDS = 10;

export function estimateGroqCostUsd(model: string, audioSeconds: number | undefined): number | null {
  const perHour = GROQ_PRICE_PER_HOUR_USD[model];
  if (perHour === undefined || audioSeconds === undefined || !Number.isFinite(audioSeconds)) return null;
  return (Math.max(audioSeconds, GROQ_MIN_BILLED_SECONDS) / 3600) * perHour;
}

export interface GeminiPrices {
  inputPerMillion?: number;
  outputPerMillion?: number;
}

export function geminiPricesFromEnv(env: Record<string, string | undefined> = process.env): GeminiPrices {
  const num = (v: string | undefined) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return { inputPerMillion: num(env.GEMINI_INPUT_PRICE_PER_M), outputPerMillion: num(env.GEMINI_OUTPUT_PRICE_PER_M) };
}

export function estimateGeminiCostUsd(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  prices: GeminiPrices = geminiPricesFromEnv(),
): number | null {
  if (inputTokens === undefined || outputTokens === undefined) return null;
  if (prices.inputPerMillion === undefined || prices.outputPerMillion === undefined) return null;
  return (inputTokens / 1e6) * prices.inputPerMillion + (outputTokens / 1e6) * prices.outputPerMillion;
}

export interface UsageRecord {
  at: string;
  responseId?: string;
  audioSeconds?: number;
  audioBytes?: number;
  /** Absent when a saved transcript was reused (scoring-only run). */
  transcription?: { model: string; ms?: number; estCostUsd: number | null };
  scoring?: {
    model: string;
    ms?: number;
    /** Model calls needed, 1 when the first response was valid. */
    attempts?: number;
    inputTokens?: number;
    outputTokens?: number;
    estCostUsd: number | null;
  };
  totalMs: number;
  /** Sum of the known stage costs; null when none could be estimated. */
  estCostUsd: number | null;
}

export interface UsageSources {
  responseId?: string;
  transcription?: { model: string; elapsedMs?: number; durationSeconds?: number; audioBytes?: number };
  scored?: {
    model: string;
    elapsedMs?: number;
    attempts?: number;
    usage?: { inputTokens: number; outputTokens: number };
  };
  totalMs: number;
  now?: Date;
  geminiPrices?: GeminiPrices;
}

export function buildUsageRecord(src: UsageSources): UsageRecord {
  const t = src.transcription;
  const s = src.scored;
  const tCost = t ? estimateGroqCostUsd(t.model, t.durationSeconds) : null;
  const sCost = s ? estimateGeminiCostUsd(s.usage?.inputTokens, s.usage?.outputTokens, src.geminiPrices) : null;
  const known = [tCost, sCost].filter((c): c is number => c !== null);

  return {
    at: (src.now ?? new Date()).toISOString(),
    ...(src.responseId ? { responseId: src.responseId } : {}),
    ...(t?.durationSeconds !== undefined ? { audioSeconds: t.durationSeconds } : {}),
    ...(t?.audioBytes !== undefined ? { audioBytes: t.audioBytes } : {}),
    ...(t ? { transcription: { model: t.model, ms: t.elapsedMs, estCostUsd: tCost } } : {}),
    ...(s
      ? {
          scoring: {
            model: s.model,
            ms: s.elapsedMs,
            attempts: s.attempts,
            inputTokens: s.usage?.inputTokens,
            outputTokens: s.usage?.outputTokens,
            estCostUsd: sCost,
          },
        }
      : {}),
    totalMs: src.totalMs,
    estCostUsd: known.length > 0 ? known.reduce((a, b) => a + b, 0) : null,
  };
}

// ---------------------------------------------------------------------------
// Summaries and projections
// ---------------------------------------------------------------------------

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

const mean = (values: readonly number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const defined = (values: Array<number | undefined | null>): number[] =>
  values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));

export interface UsageSummary {
  responses: number;
  totalMs: { mean: number; p50: number; p95: number };
  transcriptionMs: number;
  scoringMs: number;
  audioSeconds: number;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
  groqUsd: number;
  geminiUsd: number | null;
  /** Mean cost per response, or null when no cost could be estimated (Gemini prices not set). */
  costPerResponseUsd: number | null;
}

/** Averages over records. Use full runs (transcription and scoring) for a realistic per-response figure. */
export function summarizeUsage(records: readonly UsageRecord[], geminiPrices?: GeminiPrices): UsageSummary {
  const totals = records.map((r) => r.totalMs);
  const groq = defined(records.map((r) => r.transcription?.estCostUsd));
  const gemini = defined(
    records.map((r) =>
      r.scoring ? estimateGeminiCostUsd(r.scoring.inputTokens, r.scoring.outputTokens, geminiPrices) : null,
    ),
  );
  const groqUsd = mean(groq);
  const geminiUsd = gemini.length > 0 ? mean(gemini) : null;

  return {
    responses: records.length,
    totalMs: { mean: mean(totals), p50: percentile(totals, 50), p95: percentile(totals, 95) },
    transcriptionMs: mean(defined(records.map((r) => r.transcription?.ms))),
    scoringMs: mean(defined(records.map((r) => r.scoring?.ms))),
    audioSeconds: mean(defined(records.map((r) => r.audioSeconds))),
    inputTokens: mean(defined(records.map((r) => r.scoring?.inputTokens))),
    outputTokens: mean(defined(records.map((r) => r.scoring?.outputTokens))),
    attempts: mean(defined(records.map((r) => r.scoring?.attempts))),
    groqUsd,
    geminiUsd,
    costPerResponseUsd: groq.length === 0 && geminiUsd === null ? null : groqUsd + (geminiUsd ?? 0),
  };
}

export interface Projection {
  responses: number;
  audioHours: number;
  inputTokens: number;
  outputTokens: number;
  groqUsd: number;
  geminiUsd: number | null;
  totalUsd: number | null;
  /** Responses one sequential worker can finish per hour at the mean latency. */
  perWorkerPerHour: number;
}

export function projectCosts(
  summary: UsageSummary,
  plan: { students: number; questionsPerStudent: number },
): Projection {
  const responses = plan.students * plan.questionsPerStudent;
  const groqUsd = summary.groqUsd * responses;
  const geminiUsd = summary.geminiUsd === null ? null : summary.geminiUsd * responses;
  return {
    responses,
    audioHours: (summary.audioSeconds * responses) / 3600,
    inputTokens: summary.inputTokens * responses,
    outputTokens: summary.outputTokens * responses,
    groqUsd,
    geminiUsd,
    totalUsd: geminiUsd === null ? null : groqUsd + geminiUsd,
    perWorkerPerHour: summary.totalMs.mean > 0 ? 3_600_000 / summary.totalMs.mean : 0,
  };
}
