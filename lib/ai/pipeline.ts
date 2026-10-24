import { AIError, classifyError, withRetry, type AIErrorCode, type AIStage } from "./errors";
import { scoreTranscript } from "./score";
import type { AudioFetcher, TranscriptStore } from "./storage";
import { buildUsageRecord, type UsageRecord } from "./usage";
import { transcribeAudio, transcribeFromStorage, type TranscribeOutput } from "./transcribe";
import type { ScoringResult } from "./validate";

// The error -> status mapping lives in errors.ts (it needs no external packages); re-exported here.
import { statusForError, type FailureStatus } from "./errors";
export { statusForError, type FailureStatus };

// ---------------------------------------------------------------------------
// Phase 2: transcription step (storage -> Groq -> transcripts table)
// ---------------------------------------------------------------------------

export interface TranscribeResponseInput {
  responseId: string;
  storagePath: string;
  fetchAudio: AudioFetcher;
  store: TranscriptStore;
  language?: string;
  prompt?: string;
}

export type TranscribeResponseResult =
  | { ok: true; status: "transcribed"; transcript: TranscribeOutput }
  | {
      ok: false;
      status: FailureStatus;
      reason?: string;
      error: { code: AIErrorCode; message: string; retryable: boolean };
      /** False if even the failure status could not be saved; a retry sweeper should pick this up. */
      statusPersisted: boolean;
    };

/**
 * Download a recording, transcribe it, save the transcript and set the status
 * to `transcribed`. Silence sets `needs_manual_review` (reason `no_speech_detected`)
 * and never reaches the LLM. Never throws.
 */
export async function transcribeResponse(input: TranscribeResponseInput): Promise<TranscribeResponseResult> {
  const { responseId, store } = input;
  try {
    const transcript = await transcribeFromStorage(input.storagePath, {
      fetchAudio: input.fetchAudio,
      language: input.language,
      prompt: input.prompt,
    });
    await withRetry(() => store.saveTranscript({ responseId, transcript }), { stage: "transcription" });
    await withRetry(() => store.setStatus({ responseId, status: "transcribed" }), { stage: "transcription" });
    return { ok: true, status: "transcribed", transcript };
  } catch (err) {
    const error = classifyError(err, "transcription");
    const { status, reason } = statusForError(error);

    let statusPersisted = true;
    try {
      await store.setStatus({ responseId, status, reason, error: { code: error.code, message: error.message } });
    } catch {
      statusPersisted = false;
    }

    return {
      ok: false,
      status,
      reason,
      error: { code: error.code, message: error.message, retryable: error.retryable },
      statusPersisted,
    };
  }
}

// ---------------------------------------------------------------------------
// Full pipeline: recording (or transcript) -> transcript + suggested scores
// ---------------------------------------------------------------------------

export interface PipelineInput {
  question: string;
  /** Provide audio to transcribe... */
  audio?: { data: Uint8Array; filename: string; mimeType: string };
  /** ...or an existing transcript (e.g. to retry scoring without re-transcribing). */
  transcript?: string;
  language?: string;
  prompt?: string;
  /** Recording length, used as scoring context when scoring an existing transcript (e.g. student_responses.duration_seconds). */
  durationSeconds?: number;
  /** Passages Whisper was unsure about, when scoring an existing transcript (derived from segments otherwise). */
  lowConfidenceSpans?: string[];
}

export interface PipelineMeta {
  transcriptionModel?: string;
  scoringModel: string;
  rubricVersion: string;
  promptVersion: string;
  durationSeconds?: number;
  language?: string;
  elapsedMs: number;
  /** Time per stage, tokens and rough cost estimate for this response. */
  usage: UsageRecord;
}

export interface PipelineFailure {
  ok: false;
  /** Maps to the backend status: retry later, permanent, or a human must look. */
  status: FailureStatus;
  /** e.g. "no_speech_detected" when status is needs_manual_review. */
  reason?: string;
  failedStage: AIStage;
  error: { code: AIErrorCode; message: string; retryable: boolean };
  /** Present if transcription succeeded, so scoring can be retried alone. */
  transcript?: string;
}

export interface PipelineSuccess {
  ok: true;
  status: "scored";
  transcript: string;
  transcription?: TranscribeOutput;
  scoring: ScoringResult;
  meta: PipelineMeta;
}

export type PipelineResult = PipelineSuccess | PipelineFailure;

/** Recording (or transcript) in, transcript + suggested scores out. Never throws. */
export async function processRecording(input: PipelineInput): Promise<PipelineResult> {
  const started = Date.now();
  let transcript = input.transcript?.trim() || undefined;
  let transcription: TranscribeOutput | undefined;
  let stage: AIStage = "transcription";

  try {
    if (!transcript) {
      if (!input.audio) {
        throw new AIError("Provide either audio or a transcript", "BAD_INPUT", "config", false);
      }
      transcription = await transcribeAudio({
        audio: input.audio.data,
        filename: input.audio.filename,
        mimeType: input.audio.mimeType,
        language: input.language,
        prompt: input.prompt,
      });
      transcript = transcription.text;
    }

    stage = "scoring";
    // Passages Whisper was unsure about (avg log-probability below -1), so the LLM won't penalize them.
    const lowConfidenceSpans =
      input.lowConfidenceSpans ??
      transcription?.segments
      .filter((s) => s.avgLogprob !== undefined && s.avgLogprob < -1)
      .map((s) => s.text);
    const scored = await scoreTranscript({
      question: input.question,
      transcript,
      durationSeconds: transcription?.durationSeconds ?? input.durationSeconds,
      lowConfidenceSpans,
    });

    return {
      ok: true,
      status: "scored",
      transcript,
      transcription,
      scoring: scored.result,
      meta: {
        transcriptionModel: transcription?.model,
        scoringModel: scored.model,
        rubricVersion: scored.result.rubric_version,
        promptVersion: scored.result.prompt_version,
        durationSeconds: transcription?.durationSeconds ?? input.durationSeconds,
        language: transcription?.language,
        elapsedMs: Date.now() - started,
        usage: buildUsageRecord({
          transcription: transcription
            ? {
                model: transcription.model,
                elapsedMs: transcription.elapsedMs,
                durationSeconds: transcription.durationSeconds,
                audioBytes: transcription.audioBytes,
              }
            : undefined,
          scored: { model: scored.model, elapsedMs: scored.elapsedMs, attempts: scored.attempts, usage: scored.usage },
          totalMs: Date.now() - started,
        }),
      },
    };
  } catch (err) {
    const error = classifyError(err, stage);
    const { status, reason } = statusForError(error);
    return {
      ok: false,
      status,
      reason,
      failedStage: error.stage,
      error: { code: error.code, message: error.message, retryable: error.retryable },
      transcript,
    };
  }
}
