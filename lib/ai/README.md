# `/lib/ai/` - transcription and evaluation

Takes a student recording, transcribes it with Groq Whisper, and returns **suggested** 1-5 scores for four criteria, each with evidence quotes. A human reviewer always makes the final decision.

## Modules

| File | Role |
| --- | --- |
| `transcribe.ts` | Groq Whisper transcription (`verbose_json`, with segments); `transcribeFromStorage(path)` |
| `storage.ts` | Contracts Member 2 implements: `AudioFetcher` and `TranscriptStore` |
| `wer.ts` | Word error rate, for comparing transcripts with what was actually said |
| `rubric.ts` | Rubric definition (four criteria, 1-5 levels) and `RUBRIC_VERSION` |
| `prompt.ts` | Builds the system + user prompt (transcript is treated as untrusted data) |
| `score.ts` | Calls the LLM (Google AI Studio), validates output, retries |
| `validate.ts` | Zod schema + check that every evidence quote exists in the transcript |
| `pipeline.ts` | `processRecording()`: orchestrates everything, never throws |
| `errors.ts` | `AIError`, error classification, `withRetry` |

## Environment variables

Server-side only. Put them in `.env.local` and never use a `NEXT_PUBLIC_` prefix. Do not commit them. See `.env.example`.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GROQ_API_KEY` | yes | - | Groq Whisper transcription |
| `GOOGLE_AI_API_KEY` | yes | - | Google AI Studio scoring LLM |
| `GROQ_WHISPER_MODEL` | no | `whisper-large-v3-turbo` | Whisper model (`whisper-large-v3` is more accurate, costs more) |
| `GROQ_WHISPER_LANGUAGE` | no | `en` | ISO-639-1 code; `auto` lets Whisper detect the language |
| `GROQ_WHISPER_PROMPT` | no | empty | Short vocabulary hint (program name, technical terms), max about 224 tokens |
| `GROQ_MAX_AUDIO_MB` | no | `25` | Upload limit: 25 on the free tier, 100 on the dev tier |
| `SUPABASE_SERVICE_ROLE_KEY` | Member 2's helpers | - | Server-only; used by the storage and database helpers, not by `/lib/ai/` itself |
| `GEMINI_MODEL` | no | `gemini-3.8-flash` | Scoring model |

## Usage

```ts
import { processRecording } from "@/lib/ai/pipeline";

const result = await processRecording({
  question: "Tell us about a time you led a team.",
  audio: { data: bytes, filename: "answer.webm", mimeType: "audio/webm" },
});

if (result.ok) {
  // result.transcript, result.scoring (scores + evidence), result.meta
} else {
  // result.status: "failed_retryable" | "failed_permanent" | "needs_manual_review"
  // result.transcript is set if transcription succeeded, so retry scoring only:
  // processRecording({ question, transcript: result.transcript })
}
```

## Failure statuses

`processRecording` and `transcribeResponse` never throw. Failures return:

| Status | When |
| --- | --- |
| `failed_retryable` | Rate limit, timeout, provider 5xx, network error, malformed LLM output |
| `failed_permanent` | Bad API key, unsupported or oversized audio, recording not found |
| `needs_manual_review` | No speech detected (silence, muted mic, under 5 words). `reason` is `no_speech_detected`. The LLM is never called. |

Provider calls already retry up to 3 times with backoff before returning a failure.

## Transcribing from storage (Phase 2)

`transcribeResponse` downloads a recording from the private bucket, transcribes it, saves the transcript and sets the status to `transcribed`. Member 2 supplies two small server-side helpers (service role key, never in the browser):

```ts
import { transcribeResponse } from "@/lib/ai/pipeline";
import type { AudioFetcher, TranscriptStore } from "@/lib/ai/storage";

// Member 2 implements these. They must THROW on failure.
const fetchAudio: AudioFetcher = async (storagePath) => ({ data: bytes });
const store: TranscriptStore = {
  saveTranscript: async ({ responseId, transcript }) => { /* upsert into `transcripts` */ },
  setStatus: async ({ responseId, status, reason, error }) => { /* update response status */ },
};

const result = await transcribeResponse({
  responseId,
  storagePath: "recordings/<attemptId>/<questionId>.webm",
  fetchAudio,
  store,
});
// result.status: "transcribed" | "needs_manual_review" | "failed_retryable" | "failed_permanent"
```

The status values are `transcribed`, `needs_manual_review`, `failed_retryable` and `failed_permanent`. Member 2's status column or enum must accept them.

## Choosing a Whisper model

Put 10-15 recordings in `ai-fixtures/` with a matching `.txt` of what you actually said (see `ai-fixtures/README.md`), then:

```bash
npm run ai:compare                 # both models, word error rate + time per file
npm run ai:compare -- --show       # also print each transcript to eyeball differences
```

Pick the model with the lower error rate on your accented and noisy samples, unless the gap is small enough that the cheaper `whisper-large-v3-turbo` is fine.

## Running the tests

```bash
npm install
npm run ai:unit        # offline unit tests (no API keys needed)
npm run ai:typecheck
```

## Running the pipeline against real APIs

```bash
cp .env.example .env.local   # then fill in the keys
npm run ai:try -- ai-fixtures/answer.webm "Tell us about a time you led a team."
npm run ai:try -- --transcript ai-fixtures/answer.txt "Tell us about a time you led a team."
```

Exit code is `0` on success and `2` if the pipeline returned a failure.

## Notes

- The rubric criteria and level descriptors are a **draft**; confirm them with the team and bump `RUBRIC_VERSION` when they change.
- Only synthetic or consented recordings belong in `/ai-fixtures/`.
- Audio limit is 25 MB per file on Groq's free tier and 100 MB on the dev tier. If students record **video**, a few minutes can exceed 25 MB: record an audio-only stream for transcription (`new MediaStream(stream.getAudioTracks())`) or extract the audio track before upload. Audio-only Opus is roughly 1 MB per minute.
- Groq bills a minimum of 10 seconds per request and downsamples audio to 16 kHz mono.

## Rubric and output contract (Phase 3)

`rubric.ts` holds the four criteria (`relevance`, `structure`, `clarity`, `depth`), the 20 level descriptors and the fairness rules. **The wording is a draft until the interview owner approves it.** After approval, change `RUBRIC_VERSION` from `"v1-draft"` to `"v1"`; any later wording change needs a new version. `PROMPT_VERSION` in `prompt.ts` tracks prompt wording separately. Both are stored with every result.

Fairness rules (inserted into the prompt): score only the transcript; no penalty for accent, dialect or minor grammar slips; no penalty for speech-recognition errors (flag `possible_transcription_issues` instead); nothing inferred from personal traits; `null` score when evidence is insufficient.

Result shape (agree with Member 4):

```json
{
  "criteria": [
    { "id": "relevance", "score": 4, "justification": "...", "evidence": ["exact quote"] }
  ],
  "overall_comment": "...",
  "confidence": "high | medium | low",
  "flags": ["short_answer", "possible_transcription_issues", "insufficient_evidence", "off_topic"],
  "rubric_version": "v1",
  "prompt_version": "p1"
}
```

Notes for Member 4's UI:
- `score` can be **`null`** (insufficient evidence for that criterion). Show "Not enough evidence" and let the reviewer enter a score manually.
- The code adds `short_answer` (under 40 words, and caps confidence at `medium`) and `insufficient_evidence` itself; the model does not decide those.
- Every `evidence` quote is checked to appear in the transcript. A scored criterion always has at least one quote.

Tools: `npm run ai:prompt` prints the exact prompt for Google AI Studio, and `npm run ai:consistency` runs the scorer repeatedly on one transcript and flags criteria that vary by more than 1 point. `GEMINI_TEMPERATURE` (default `0.1`) controls the model temperature.

## Scoring with the LLM and saving to `evaluations` (Phase 4)

**Prompt** (`prompt.ts`, `PROMPT_VERSION` = `p2`): system = role, fairness rules, injection rules, no invented quotes; user = question, transcript in `<transcript>` tags, recording length, rubric with all anchors, and the JSON shape. Delimiter tags typed or spoken inside the transcript or question are stripped so a student cannot close the data block. **Bump `PROMPT_VERSION` whenever the wording changes.**

**Structured output** (`schema.ts`): Gemini is given a JSON response schema (`responseJsonSchema`), and `validate.ts` (zod) is still the source of truth. Temperature comes from `GEMINI_TEMPERATURE` (default `0.1`) and the model from `GEMINI_MODEL`; neither is hardcoded.

**Saving** (`evaluation.ts`, `evaluate.ts`): `evaluateResponse()` downloads the recording, transcribes, scores and upserts one row in `evaluations` (on `response_id`). It never throws and writes failures too, so every response ends with a row.

| Column | Value |
| --- | --- |
| `transcript` | Whisper text |
| `ai_status` | `completed`, or `failed` (see below) |
| `criterion_1_score` ... `criterion_4_score` | relevance, structure, clarity, depth (null when there was insufficient evidence) |
| `ai_overall_score` | Mean of the non-null scores, computed in code, one decimal |
| `ai_evidence` | `summary`, `strengths`, `weaknesses`, plus `criteria` (justification + quotes), `confidence`, `flags`, `rubric_version`, `prompt_version`, `meta` |
| `error_message` | Reason for failed/manual-review rows |

The table's `ai_status` enum currently has only `completed` and `failed`, so silence is stored as `failed` with `[needs_manual_review] no_speech_detected: ...` in `error_message`, and temporary errors as `[retryable] ...`. If Member 2 extends the enum (`processing`, `needs_manual_review`, `failed_retryable`), set `EVALUATION_EXTENDED_STATUSES=true`.

```ts
import { evaluateResponse } from "@/lib/ai/evaluate";

const result = await evaluateResponse({
  responseId, storagePath, question, durationSeconds,
  fetchAudio,            // Member 2's download helper (throws on failure)
  client: supabaseAdmin, // supabase-js with the service role key, server only
});
// result.ok, result.saved (false => the DB write failed, retry), result.row
```

**Prompt prototyping and checks**
- `npm run ai:prompt -- <transcript.txt> "<question>" [seconds]` prints the exact prompt to paste into Google AI Studio.
- `npm run ai:fixtures` scores every file in `ai-fixtures/transcripts/` (strong, medium, weak, off-topic, short and two injection attempts) and fails with exit code 3 if an injection fixture raises its scores.
- `npm run ai:consistency -- <transcript.txt> "<question>"` runs the scorer 5 times and flags criteria that vary by more than 1 point.

## Evaluating one stored recording end to end

`npm run ai:supabase -- <video_storage_path>` runs the six persisted steps:

1. Look up the `student_responses` row by `video_storage_path` (`id`, `duration_seconds`, recording path = `audio_storage_path` if set, else the video path) and the question text.
2. Upsert the `evaluations` row with `ai_status = "processing"`.
3. Download the recording and call `transcribeAudio()` once.
4. Save `evaluations.transcript`; the status stays `processing`.
5. `processRecording({ question, transcript, durationSeconds })` scores the saved transcript without transcribing again.
6. `saveEvaluationResult()` upserts the final scores, evidence, status and any `error_message`.

If transcription fails (silence, missing file, bad key), the failure is saved on the row too. The question text comes from the `questions` table (`QUESTIONS_TABLE`, `QUESTION_TEXT_COLUMN` if the column is not auto-detected) or from `--question "..."`.

Requires `processing` in the `ai_status` enum: `alter type ai_status add value if not exists 'processing';`

## Validation (Phase 5)

Model output is never stored unchecked. `scoreTranscript()` applies these layers in order:

1. **Schema (zod, `validate.ts`)**: exactly the four criterion ids, each once; integer score 1-5 (or `null` for insufficient evidence); justification non-empty and at most 600 characters; 1-3 evidence quotes (each at most 400 characters) for every scored criterion; `confidence` is high, medium or low. Unknown flags, and flags only the code may set, are dropped.
2. **Evidence (`checks.ts`)**: every quote is normalized (lowercase, punctuation and apostrophes removed, whitespace collapsed) and must appear in the transcript. Quotes of 4+ words may differ slightly (word-level similarity of at least 0.85), because Whisper text and model quoting differ; shorter quotes must match exactly.
3. **Sanity rules**: under 15 words, every score is capped at 3 (`score_capped`, with the original scores in `adjustments`); perfect 5s on all scored criteria for an answer under 40 words get `suspicious_scores`; both lower confidence to `low`. Under 40 words always gets `short_answer`.
4. **Repair loop**: an invalid response is retried up to 2 times, with the validation error and the rejected response in the retry prompt. After that, `SCORING_FAILED` is thrown and the row is saved as failed with `scoring_failed` in `error_message`. Missing quotes get one retry naming each quote that was not found; if they are still missing, the result is kept but flagged `unverified_evidence` (confidence `low`, quotes listed in `unverified_evidence`). Provider errors (429, 5xx, timeouts) are retried separately and do not use up repair attempts.

At most 3 model calls are made per transcript. `ai_evidence` also carries `unverified_evidence` and `adjustments` when present, for Member 4 to show. Thresholds live in `rubric.ts` (`SHORT_ANSWER_WORDS`, `VERY_SHORT_ANSWER_WORDS`, `VERY_SHORT_SCORE_CAP`) and `checks.ts` (`FUZZY_THRESHOLD`).

## Resumable processing: `runPipeline(responseId)` (Phase 6, step 4)

`run-pipeline.ts` processes one response in two separate stages and writes the status at every transition:

```
claim -> transcribing -> transcribed -> scoring -> completed
                \-> failed_retryable | failed | needs_manual_review (from any stage)
```

- **Resumable:** if a transcript is already saved, transcription is skipped, so a scoring failure never costs a second Groq call. `retranscribe: true` forces it.
- **Idempotent:** the claim is one atomic database update (`claim_evaluation()` in `sql/phase6-migration.sql`); a second runner is turned away with `already_running`. Results overwrite the single row for the response.
- **Retry accounting:** a temporary error sets `failed_retryable`, `retry_count + 1`, `last_error` and `next_retry_at` (30 s after the first failure, 2 min after the second). The third failure sets `failed` with reason `retries_exhausted`. Silence or other permanent errors do not touch the count.
- **Never throws:** the result is `completed`, `skipped` (with a reason) or `failed` (with status, error and `statusPersisted`).
- **Triggers:** `trigger: "auto"` (submit handler, sweeper) claims `queued`, `transcribed`, due `failed_retryable` and stuck runs; `trigger: "admin"` (the Retry button) also claims failed and manual-review rows and resets `retry_count`.

```ts
import { runPipeline } from "@/lib/ai/run-pipeline";
import { createSupabaseStore } from "@/lib/ai/supabase-store";

const result = await runPipeline(responseId, {
  store: createSupabaseStore(supabaseAdmin), // service role client, server only
  fetchAudio,                                // Member 2's download helper
  trigger: "admin",                          // from the admin Retry route; omit for automatic runs
});
```

Before it can run against the real database, Member 2 must run `lib/ai/sql/phase6-migration.sql`: the new status values, the columns `retry_count`, `last_error`, `last_error_code`, `next_retry_at` and `status_changed_at`, a unique `response_id`, and the `claim_evaluation` function. Not yet done (later Phase 6 steps): the 2 s / 8 s / 30 s in-request backoff, audio missing or corrupt mapping to `needs_manual_review`, the async trigger and sweeper, and the admin route.

## Triggering the pipeline (Phase 7)

Three layers, so a response is never lost and the student never waits:

1. **Guarantee, in the database:** `sql/phase7-triggers.sql` creates a `queued` evaluation row in the same transaction as every `student_responses` insert.
2. **Safety net, the sweeper:** `POST /api/cron/sweep` (every minute, via pg_cron + pg_net, or your host's cron) runs `findDueResponses()` and processes up to 5 responses one after another inside a time budget. It picks up `queued` and `transcribed` rows, due `failed_retryable` rows (under 3 attempts) and runs that look crashed.
3. **Speed-up, immediate trigger:** `POST /api/process` with `{ responseId }` (from the submit handler through `triggerProcessing()`, or from a Supabase database webhook on insert, whose `record.id` is read automatically). It is best-effort: if it is lost, the sweeper handles it.

Every request must carry `PIPELINE_SECRET` as `x-pipeline-secret` (or `Authorization: Bearer`). A missing secret setting rejects everything. The routes live in `app/api/process/route.ts` and `app/api/cron/sweep/route.ts`; move them if your project's route folder differs.

**Serverless time limits.** Each request gets a budget (`PIPELINE_BUDGET_MS`, default 50 s) that must stay below the function's `maxDuration` (set to 60 in the routes: confirm what your hosting plan allows). If transcription finishes but less than 20 s remain, the run stops with status `transcribed` and the next run only scores, so work is queue-friendly and a long recording can never be half-saved. Set `PIPELINE_STALE_MINUTES` to about twice the time limit so a crashed run is taken over quickly. A single Groq call that itself takes longer than the limit cannot be split: cap answer length in the frontend, or move processing to a worker.

Status names: Phase 7 calls the final status `scored` and the first one `uploaded`; in the database these are `completed` and `queued` (Member 2's enum), and `responses` is `student_responses`.

## Phase 8: demo, gold set, cost

```bash
npm run ai:test -- path/to/audio.webm "Question text"   # demo: transcript, scores with evidence, time and cost
npm run ai:test -- --transcript file.txt                 # same, from a transcript
npm run ai:gold -- --notes "what changed"                # score the gold set, log agreement per rubric/prompt version
npm run ai:cost -- --students 300 --questions 5          # latency summary and cost projection
```

- `ai:test` is now the demo; the vitest suite moved to `npm run ai:unit`.
- Gold set: `ai-fixtures/gold/` (see its README). Two humans score each transcript independently; results append to `ai-logs/agreement-results.csv`, one row per run, ready for a spreadsheet.
- Usage log: every run appends to `ai-logs/usage.jsonl` (time per stage, tokens, estimated cost). Set `GEMINI_INPUT_PRICE_PER_M` and `GEMINI_OUTPUT_PRICE_PER_M` to include the Gemini bill; Groq rates in `usage.ts` are estimates, so check current pricing.
- Validator and retry unit tests: `validate`, `checks`, `score-repair` and `errors` tests.
