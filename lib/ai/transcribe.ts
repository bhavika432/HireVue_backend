import Groq from "groq-sdk";
import { AIError, requireEnv, withRetry } from "./errors";
import { mimeFromPath, type AudioFetcher } from "./storage";

export const WHISPER_MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"] as const;

const DEFAULT_MODEL = "whisper-large-v3-turbo";
const DEFAULT_LANGUAGE = "en";
const DEFAULT_MAX_AUDIO_MB = 25; // Groq free tier; the dev tier allows 100 MB
/** Fewer words than this means silence / mic problem: do not send to the LLM. */
export const MIN_TRANSCRIPT_WORDS = 5;
/** Whisper hallucinates text on silence; treat the clip as empty if every segment is this likely non-speech. */
const NO_SPEECH_PROB_THRESHOLD = 0.8;

export interface TranscribeInput {
  audio: Uint8Array;
  filename: string; // extension matters, e.g. answer.webm
  mimeType: string; // e.g. audio/webm, video/mp4
  /** ISO-639-1 code. Defaults to GROQ_WHISPER_LANGUAGE or "en"; "auto" lets Whisper detect it. */
  language?: string;
  /** Short vocabulary hint (program name, technical terms). Max ~224 tokens. Defaults to GROQ_WHISPER_PROMPT. */
  prompt?: string;
  /** Overrides GROQ_WHISPER_MODEL. */
  model?: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** Closer to 1 means silence / non-speech. */
  noSpeechProb?: number;
  /** Closer to 0 means higher confidence; below about -1 is suspect. */
  avgLogprob?: number;
}

export interface TranscribeOutput {
  text: string;
  language?: string;
  durationSeconds?: number;
  segments: TranscriptSegment[];
  model: string;
  /** Time spent on the Groq call, including retries. */
  elapsedMs?: number;
  audioBytes?: number;
}

interface VerboseTranscription {
  text: string;
  language?: string;
  duration?: number;
  segments?: Array<{
    start: number;
    end: number;
    text: string;
    no_speech_prob?: number;
    avg_logprob?: number;
  }>;
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function resolveLanguage(explicit?: string): string | undefined {
  const value = (explicit ?? process.env.GROQ_WHISPER_LANGUAGE ?? DEFAULT_LANGUAGE).trim().toLowerCase();
  return value === "" || value === "auto" ? undefined : value;
}

function resolveMaxBytes(): number {
  const mb = Number(process.env.GROQ_MAX_AUDIO_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_AUDIO_MB) * 1024 * 1024;
}

export async function transcribeAudio(input: TranscribeInput): Promise<TranscribeOutput> {
  if (input.audio.byteLength === 0) {
    throw new AIError("Audio file is empty", "BAD_INPUT", "transcription", false);
  }
  const maxBytes = resolveMaxBytes();
  if (input.audio.byteLength > maxBytes) {
    const sizeMb = (input.audio.byteLength / 1024 / 1024).toFixed(1);
    const limitMb = (maxBytes / 1024 / 1024).toFixed(0);
    throw new AIError(
      `Audio file is ${sizeMb} MB, over the ${limitMb} MB transcription limit`,
      "BAD_INPUT",
      "transcription",
      false,
    );
  }

  const groq = new Groq({ apiKey: requireEnv("GROQ_API_KEY") });
  const model = input.model || process.env.GROQ_WHISPER_MODEL || DEFAULT_MODEL;
  const language = resolveLanguage(input.language);
  const prompt = (input.prompt ?? process.env.GROQ_WHISPER_PROMPT ?? "").trim();

  const startedAt = Date.now();
  const response = await withRetry(
    async () => {
      const file = new File([input.audio as BlobPart], input.filename, { type: input.mimeType });
      return groq.audio.transcriptions.create({
        file,
        model,
        response_format: "verbose_json",
        temperature: 0,
        ...(language ? { language } : {}),
        ...(prompt ? { prompt } : {}),
      });
    },
    { stage: "transcription" },
  );

  const verbose = response as unknown as VerboseTranscription;
  const text = cleanText(verbose.text ?? "");
  const segments: TranscriptSegment[] = (verbose.segments ?? [])
    .map((s) => ({
      start: s.start,
      end: s.end,
      text: cleanText(s.text ?? ""),
      noSpeechProb: s.no_speech_prob,
      avgLogprob: s.avg_logprob,
    }))
    .filter((s) => s.text.length > 0);

  const allNoSpeech =
    segments.length > 0 &&
    segments.every((s) => s.noSpeechProb !== undefined && s.noSpeechProb > NO_SPEECH_PROB_THRESHOLD);

  if (countWords(text) < MIN_TRANSCRIPT_WORDS || allNoSpeech) {
    throw new AIError(
      "No speech detected: the recording is silent, too short or unintelligible",
      "EMPTY_TRANSCRIPT",
      "transcription",
      false,
    );
  }

  return {
    text,
    language: verbose.language,
    durationSeconds: verbose.duration,
    segments,
    model,
    elapsedMs: Date.now() - startedAt,
    audioBytes: input.audio.byteLength,
  };
}

export interface TranscribeFromStorageOptions {
  /** Member 2's server-side download helper. */
  fetchAudio: AudioFetcher;
  language?: string;
  prompt?: string;
  model?: string;
}

/** transcribeAudio(storagePath): download from the private bucket, then transcribe. */
export async function transcribeFromStorage(
  storagePath: string,
  options: TranscribeFromStorageOptions,
): Promise<TranscribeOutput> {
  const fetched = await withRetry(() => options.fetchAudio(storagePath), { stage: "transcription" });

  const filename = storagePath.split("/").pop() || "recording.webm";
  return transcribeAudio({
    audio: fetched.data,
    filename,
    mimeType: fetched.mimeType ?? mimeFromPath(storagePath),
    language: options.language,
    prompt: options.prompt,
    model: options.model,
  });
}
