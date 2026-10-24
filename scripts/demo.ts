/**
 * The demo: recording in, transcript and suggested scores out.
 *
 *   npm run ai:test -- path/to/audio.webm
 *   npm run ai:test -- path/to/audio.webm "Tell us about a time you led a team."
 *   npm run ai:test -- --transcript ai-fixtures/transcripts/strong.txt
 *   npm run ai:test -- path/to/audio.webm --json        (full JSON instead of the readable report)
 *
 * Prints the transcript, each criterion's score with its evidence, flags, and time/cost per stage.
 * Every run is appended to ai-logs/usage.jsonl for `npm run ai:cost`.
 * Requires GROQ_API_KEY (audio only) and GOOGLE_AI_API_KEY in .env.local.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { overallScore } from "../lib/ai/evaluation";
import { processRecording } from "../lib/ai/pipeline";
import { mimeFromPath } from "../lib/ai/storage";
import { appendUsage } from "../lib/ai/usage-log";

const DEFAULT_QUESTION = "Tell us about yourself.";

const ms = (n?: number) => (n === undefined ? "-" : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);
const usd = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `$${n < 0.01 ? n.toFixed(5) : n.toFixed(4)}`);

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const transcriptMode = args.includes("--transcript");
  const positional = args.filter((a) => !a.startsWith("--"));
  const [filePath, question = DEFAULT_QUESTION] = positional;

  if (!filePath) {
    console.error('Usage: npm run ai:test -- path/to/audio.webm ["question"]\n       npm run ai:test -- --transcript file.txt ["question"]');
    process.exit(1);
  }

  const buffer = await readFile(filePath);
  const result = await processRecording(
    transcriptMode
      ? { question, transcript: buffer.toString("utf8") }
      : {
          question,
          audio: { data: new Uint8Array(buffer), filename: path.basename(filePath), mimeType: mimeFromPath(filePath) },
        },
  );

  if (result.ok) await appendUsage(result.meta.usage);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 2;
    return;
  }

  console.log(`\nQuestion: ${question}`);

  if (!result.ok) {
    console.log(`\nFAILED at ${result.failedStage}: [${result.status}] ${result.error.code}: ${result.error.message}`);
    if (result.transcript) console.log(`\nTranscript:\n${result.transcript}`);
    process.exitCode = 2;
    return;
  }

  const { scoring, meta } = result;
  console.log(`\n--- Transcript ---\n${result.transcript}`);

  console.log(`\n--- Suggested scores (rubric ${scoring.rubric_version}, prompt ${scoring.prompt_version}) ---`);
  for (const c of scoring.criteria) {
    console.log(`\n${c.id.padEnd(10)} ${c.score ?? "n/a"} / 5`);
    console.log(`  ${c.justification}`);
    for (const q of c.evidence) console.log(`  > "${q}"`);
  }
  console.log(`\nOverall: ${overallScore(scoring.criteria.map((c) => c.score)) ?? "n/a"}   Confidence: ${scoring.confidence}`);
  console.log(`Flags: ${scoring.flags.join(", ") || "none"}`);
  if (scoring.unverified_evidence?.length) console.log(`Unverified quotes: ${scoring.unverified_evidence.length}`);
  if (scoring.adjustments?.length) console.log(`Adjustments: ${JSON.stringify(scoring.adjustments)}`);
  console.log(`\nComment: ${scoring.overall_comment}`);

  const u = meta.usage;
  console.log("\n--- Time and cost ---");
  if (u.transcription) console.log(`Transcription  ${ms(u.transcription.ms).padStart(7)}  ${u.transcription.model}  ~${usd(u.transcription.estCostUsd)}`);
  if (u.scoring) {
    const tokens = u.scoring.inputTokens !== undefined ? `${u.scoring.inputTokens} in / ${u.scoring.outputTokens} out tokens` : "tokens not reported";
    console.log(`Scoring        ${ms(u.scoring.ms).padStart(7)}  ${u.scoring.model}  ${tokens}, ${u.scoring.attempts} call(s)  ~${usd(u.scoring.estCostUsd)}`);
  }
  console.log(`Total          ${ms(u.totalMs).padStart(7)}  ~${usd(u.estCostUsd)}${u.scoring?.estCostUsd === null ? "  (set GEMINI_INPUT_PRICE_PER_M / GEMINI_OUTPUT_PRICE_PER_M for Gemini cost)" : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
