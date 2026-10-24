
import { GoogleGenAI } from "@google/genai";
import { buildEvidenceFeedback, finalizeScoring, findUnverifiedEvidence } from "./checks";
import { AIError, classifyError, requireEnv, withRetry } from "./errors";
import { buildRepairPrompt, buildScoringPrompt, PROMPT_VERSION } from "./prompt";
import { RUBRIC_VERSION } from "./rubric";
import { SCORING_RESPONSE_SCHEMA } from "./schema";
import { parseScoringJson, type ScoringOutput, type ScoringResult } from "./validate";
const DEFAULT_MODEL = "gemini-3.8-flash";
const DEFAULT_TEMPERATURE = 0.1;

/** Extra model calls allowed after the first when the response is invalid (so 3 calls at most). */
export const MAX_REPAIR_ATTEMPTS = 2;
/** Of those, how many may be spent on quotes that are not in the transcript. */
export const MAX_EVIDENCE_RETRIES = 1;

function resolveTemperature(): number {
  const raw = process.env.GEMINI_TEMPERATURE;
  const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 2 ? value : DEFAULT_TEMPERATURE;
}

export interface ScoreInput {
  question: string;
  transcript: string;
  /** Recording length in seconds, if known. */
  durationSeconds?: number;
  /** Passages Whisper was unsure about; they are shown to the model so it does not penalize them. */
  lowConfidenceSpans?: string[];
}

export interface ScoreOutput {
  result: ScoringResult;
  model: string;
  attempts: number;
  elapsedMs: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}
/**
 * Ask the LLM for suggested scores. Nothing it returns is accepted unchecked:
 *
 * - Invalid JSON or schema: retried up to MAX_REPAIR_ATTEMPTS times, each time telling the
 *   model what was wrong. If it is still invalid, throws SCORING_FAILED.
 * - Evidence quotes not found in the transcript (fuzzy match): retried once with feedback.
 *   If still not found, the result is kept but flagged "unverified_evidence" with low confidence.
 * - Sanity rules (very short answers, all-5 scores) cap scores or flag the result.
 *
 * Temporary provider errors (429, 5xx, timeouts) are retried separately, with backoff, and do
 * not use up repair attempts.
 */
export async function scoreTranscript(input: ScoreInput): Promise<ScoreOutput> {
  const ai = new GoogleGenAI({
  apiKey: requireEnv("GOOGLE_AI_API_KEY"),
  httpOptions: {
    timeout: 60_000,
    retryOptions: {
      attempts: 1,
    },
  },
});
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const temperature = resolveTemperature();
  const { system, user } = buildScoringPrompt(input);

  let scoringElapsedMs = 0;
let inputTokens = 0;
let outputTokens = 0;

const generate = (contents: string): Promise<string> =>
  withRetry(
    async () => {
      const started = Date.now();

      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: system,
            responseMimeType: "application/json",
            responseJsonSchema: SCORING_RESPONSE_SCHEMA,
            temperature,
          },
        });

        scoringElapsedMs += Date.now() - started;

        inputTokens += response.usageMetadata?.promptTokenCount ?? 0;
        outputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;

        return response.text ?? "";
      } catch (error) {
        scoringElapsedMs += Date.now() - started;
        throw error;
      }
    },
    { stage: "scoring" },
  );
  let prompt = user;
  let evidenceRetries = 0;
  let problems: string[] = [];

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const raw = await generate(prompt);

    let parsed: ScoringOutput;
    try {
      parsed = parseScoringJson(raw);
    } catch (err) {
      const error = classifyError(err, "scoring");
      if (error.code !== "INVALID_OUTPUT") throw error;
      problems = [error.message];
      if (attempt < MAX_REPAIR_ATTEMPTS) prompt = buildRepairPrompt(user, raw, problems);
      continue;
    }

    const unverified = findUnverifiedEvidence(parsed, input.transcript);
    if (unverified.length > 0 && evidenceRetries < MAX_EVIDENCE_RETRIES && attempt < MAX_REPAIR_ATTEMPTS) {
      evidenceRetries++;
      problems = buildEvidenceFeedback(unverified);
      prompt = buildRepairPrompt(user, raw, problems);
      continue;
    }

    const { output, adjustments } = finalizeScoring(parsed, input.transcript, unverified);
    return {
      result: {
        rubric_version: RUBRIC_VERSION,
        prompt_version: PROMPT_VERSION,
        ...output,
        unverified_evidence: unverified,
        adjustments,
      },
      model,
      attempts: attempt + 1,
      elapsedMs: scoringElapsedMs,
      usage: {
    	inputTokens,
    	outputTokens,
      },
    };
  }

  throw new AIError(
    `Scoring failed: the model's response was still invalid after ${MAX_REPAIR_ATTEMPTS} repair attempts (${problems.join("; ")})`,
    "SCORING_FAILED",
    "scoring",
    false,
  );
}
