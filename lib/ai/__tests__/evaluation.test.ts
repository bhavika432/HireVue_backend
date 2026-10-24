import { describe, expect, it, vi } from "vitest";
import {
  CRITERION_COLUMNS,
  evaluationRowFromFailure,
  evaluationRowFromProgress,
  evaluationRowFromResult,
  overallScore,
  saveEvaluationResult,
  saveEvaluation,
  type EvaluationsClient,
} from "../evaluation";
import { CRITERION_IDS } from "../rubric";
import type { ScoringResult } from "../validate";

function makeResult(scores: Array<number | null>): ScoringResult {
  return {
    criteria: CRITERION_IDS.map((id, i) => ({
      id,
      score: scores[i],
      justification: `Because ${id}.`,
      evidence: scores[i] === null ? [] : ["a quote"],
    })),
    overall_comment: "Clear answer.",
    strengths: ["Well structured"],
    weaknesses: ["Few examples"],
    confidence: "medium",
    flags: ["short_answer"],
    rubric_version: "v1",
    prompt_version: "p2",
  };
}

describe("overallScore", () => {
  it("averages non-null scores to one decimal", () => {
    expect(overallScore([4, 3, 4, 4])).toBe(3.8);
    expect(overallScore([5, 4, null, null])).toBe(4.5);
  });
  it("is null when nothing could be scored", () => {
    expect(overallScore([null, null, null, null])).toBeNull();
  });
});

describe("evaluationRowFromResult", () => {
  it("fills the four score columns in CRITERION_IDS order and computes the overall score in code", () => {
    const row = evaluationRowFromResult("resp-1", "my transcript", makeResult([4, 3, 5, 4]));
    expect(row).toMatchObject({
      response_id: "resp-1",
      transcript: "my transcript",
      ai_status: "completed",
      criterion_1_score: 4,
      criterion_2_score: 3,
      criterion_3_score: 5,
      criterion_4_score: 4,
      ai_overall_score: 4,
      error_message: null,
    });
  });

  it("puts summary, strengths, weaknesses, per-criterion evidence and versions in ai_evidence", () => {
    const row = evaluationRowFromResult("r", "t", makeResult([4, 4, 4, 4]), { scoringModel: "gemini-x" });
    const ev = row.ai_evidence as Record<string, any>;
    expect(ev.summary).toBe("Clear answer.");
    expect(ev.strengths).toEqual(["Well structured"]);
    expect(ev.weaknesses).toEqual(["Few examples"]);
    expect(ev.criteria).toHaveLength(4);
    expect(ev.criteria[0]).toMatchObject({ id: "relevance", column: CRITERION_COLUMNS[0], evidence: ["a quote"] });
    expect(ev).toMatchObject({ confidence: "medium", flags: ["short_answer"], rubric_version: "v1", prompt_version: "p2" });
    expect(ev.meta).toEqual({ scoringModel: "gemini-x" });
  });

  it("keeps a null score for insufficient evidence and averages the rest", () => {
    const row = evaluationRowFromResult("r", "t", makeResult([4, null, 4, 5]));
    expect(row.criterion_2_score).toBeNull();
    expect(row.ai_overall_score).toBe(4.3);
  });
});

describe("evaluationRowFromFailure", () => {
  const silence = {
    status: "needs_manual_review" as const,
    reason: "no_speech_detected",
    error: { code: "EMPTY_TRANSCRIPT", message: "No speech detected" },
  };

  it("collapses to 'failed' with the reason in error_message when the enum is not extended", () => {
    const row = evaluationRowFromFailure("r", undefined, silence, { extendedStatuses: false });
    expect(row.ai_status).toBe("failed");
    expect(row.error_message).toContain("[needs_manual_review]");
    expect(row.error_message).toContain("no_speech_detected");
    expect(row.criterion_1_score).toBeNull();
    expect(row.ai_overall_score).toBeNull();
    expect(row.ai_evidence).toBeNull();
    expect(row.transcript).toBeNull();
  });

  it("marks retryable failures so a sweeper can find them", () => {
    const row = evaluationRowFromFailure(
      "r",
      "partial transcript",
      { status: "failed_retryable", error: { code: "RATE_LIMITED", message: "slow down" } },
      { extendedStatuses: false },
    );
    expect(row.ai_status).toBe("failed");
    expect(row.error_message).toMatch(/^\[retryable\]/);
    expect(row.transcript).toBe("partial transcript");
  });

  it("stores the real status when the enum has been extended", () => {
    expect(evaluationRowFromFailure("r", undefined, silence, { extendedStatuses: true }).ai_status).toBe(
      "needs_manual_review",
    );
  });
});

describe("saveEvaluation", () => {
  function clientWith(result: { error: { message: string } | null; status?: number }) {
    const upsert = vi.fn().mockResolvedValue(result);
    const from = vi.fn().mockReturnValue({ upsert });
    return { client: { from } as unknown as EvaluationsClient, from, upsert };
  }

  it("upserts into evaluations on response_id", async () => {
    const { client, from, upsert } = clientWith({ error: null });
    await saveEvaluation(client, evaluationRowFromResult("resp-9", "t", makeResult([4, 4, 4, 4])));
    expect(from).toHaveBeenCalledWith("evaluations");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ response_id: "resp-9" }), {
      onConflict: "response_id",
    });
  });

  it("throws when the database returns an error (permanent errors are not retried)", async () => {
    const { client, upsert } = clientWith({ error: { message: "violates check constraint" }, status: 400 });
    await expect(
      saveEvaluation(client, evaluationRowFromResult("r", "t", makeResult([4, 4, 4, 4]))),
    ).rejects.toThrow(/Could not save evaluation/);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe("failed_permanent mapping", () => {
  const permanent = {
    status: "failed_permanent" as const,
    error: { code: "AUTH", message: "bad key" },
  };

  it("is stored as plain 'failed' without a misleading tag, in both modes", () => {
    for (const extendedStatuses of [false, true]) {
      const row = evaluationRowFromFailure("r", undefined, permanent, { extendedStatuses });
      expect(row.ai_status).toBe("failed");
      expect(row.error_message).toBe("AUTH: bad key");
    }
  });
});

describe("evaluationRowFromProgress", () => {
  it("is a 'processing' row with cleared scores, with or without a transcript", () => {
    const empty = evaluationRowFromProgress("r1");
    expect(empty).toMatchObject({ response_id: "r1", ai_status: "processing", transcript: null, ai_overall_score: null });
    const withText = evaluationRowFromProgress("r1", "hello there");
    expect(withText.transcript).toBe("hello there");
    expect(withText.criterion_1_score).toBeNull();
    expect(withText.ai_evidence).toBeNull();
    expect(withText.error_message).toBeNull();
  });
});

describe("saveEvaluationResult", () => {
  function clientSpy() {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    return { client: { from: () => ({ upsert }) } as unknown as EvaluationsClient, upsert };
  }

  it("saves a successful pipeline result as a completed row with merged meta", async () => {
    const { client, upsert } = clientSpy();
    const scoring = makeResult([4, 4, 4, 4]);
    const row = await saveEvaluationResult(
      client,
      "resp-1",
      {
        ok: true,
        status: "scored",
        transcript: "my transcript",
        scoring,
       meta: {
  scoringModel: "gemini-x",
  rubricVersion: "v1",
  promptVersion: "p2",
  elapsedMs: 5,
  durationSeconds: 15,
  usage: {
    at: new Date().toISOString(),
    totalMs: 5,
    estCostUsd: null,
  },
},      },
      { transcriptionModel: "whisper-x" },
    );
    expect(row.ai_status).toBe("completed");
    expect(upsert.mock.calls[0][0]).toMatchObject({ response_id: "resp-1", transcript: "my transcript", ai_overall_score: 4 });
    expect((row.ai_evidence as any).meta).toEqual({
      scoringModel: "gemini-x",
      durationSeconds: 15,
      transcriptionModel: "whisper-x",
    });
  });

  it("saves a failed pipeline result, keeping the transcript from the earlier step", async () => {
    const { client, upsert } = clientSpy();
    const row = await saveEvaluationResult(
      client,
      "resp-2",
      {
        ok: false,
        status: "failed_retryable",
        failedStage: "scoring",
        error: { code: "RATE_LIMITED", message: "slow down", retryable: true },
        transcript: "kept transcript",
      },
      undefined,
      { extendedStatuses: false },
    );
    expect(row.ai_status).toBe("failed");
    expect(upsert.mock.calls[0][0]).toMatchObject({ transcript: "kept transcript", criterion_1_score: null });
    expect(row.error_message).toMatch(/^\[retryable\]/);
  });
});
