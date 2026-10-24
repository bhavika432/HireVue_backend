import { describe, expect, it } from "vitest";
import { buildUsageRecord, estimateGeminiCostUsd, estimateGroqCostUsd, percentile, projectCosts, summarizeUsage } from "../usage";

const prices = { inputPerMillion: 0.3, outputPerMillion: 2.5 };

describe("cost estimates", () => {
  it("bills Groq per audio hour with a 10 s minimum", () => {
    expect(estimateGroqCostUsd("whisper-large-v3-turbo", 3600)).toBeCloseTo(0.04);
    expect(estimateGroqCostUsd("whisper-large-v3-turbo", 2)).toBeCloseTo((10 / 3600) * 0.04);
    expect(estimateGroqCostUsd("unknown-model", 60)).toBeNull();
    expect(estimateGroqCostUsd("whisper-large-v3-turbo", undefined)).toBeNull();
  });
  it("estimates Gemini cost only when prices are configured", () => {
    expect(estimateGeminiCostUsd(1_000_000, 1_000_000, prices)).toBeCloseTo(2.8);
    expect(estimateGeminiCostUsd(1000, 1000, {})).toBeNull();
    expect(estimateGeminiCostUsd(undefined, 5, prices)).toBeNull();
  });
});

describe("usage records and summaries", () => {
  const rec = (ms: number, scoreMs: number) =>
    buildUsageRecord({
      transcription: { model: "whisper-large-v3-turbo", elapsedMs: 1000, durationSeconds: 60 },
      scored: { model: "g", elapsedMs: scoreMs, attempts: 1, usage: { inputTokens: 2000, outputTokens: 600 } },
      totalMs: ms,
      geminiPrices: prices,
    });

  it("sums stage costs and keeps a scoring-only run valid", () => {
    expect(rec(3000, 2000).estCostUsd).toBeCloseTo(0.04 / 60 + (2000 * 0.3 + 600 * 2.5) / 1e6, 8);
    const scoringOnly = buildUsageRecord({ scored: { model: "g", elapsedMs: 5 }, totalMs: 5 });
    expect(scoringOnly.transcription).toBeUndefined();
    expect(scoringOnly.estCostUsd).toBeNull();
  });
  it("computes percentiles and projects to the cohort", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBe(0);
    const summary = summarizeUsage([rec(2000, 1000), rec(4000, 3000)], prices);
    expect(summary.totalMs.mean).toBe(3000);
    const p = projectCosts(summary, { students: 100, questionsPerStudent: 5 });
    expect(p.responses).toBe(500);
    expect(p.perWorkerPerHour).toBe(1200);
    expect(p.totalUsd).toBeCloseTo(500 * summary.costPerResponseUsd!, 6);
  });
});
