/**
 * Summarise logged runs and project the cost for the real cohort.
 *
 *   npm run ai:cost
 *   npm run ai:cost -- --students 300 --questions 5
 *
 * Reads ai-logs/usage.jsonl (written by ai:test, ai:gold and the pipeline). Use runs that include
 * transcription for a realistic per-response figure. Set GEMINI_INPUT_PRICE_PER_M and
 * GEMINI_OUTPUT_PRICE_PER_M (USD per million tokens) to include the Gemini bill.
 */
import { projectCosts, summarizeUsage } from "../lib/ai/usage";
import { DEFAULT_USAGE_LOG, readUsage } from "../lib/ai/usage-log";

const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : undefined;
};
const sec = (n: number) => `${(n / 1000).toFixed(1)}s`;
const usd = (n: number | null) => (n === null ? "n/a" : `$${n.toFixed(n < 1 ? 4 : 2)}`);

async function main() {
  const args = process.argv.slice(2);
  const students = flag(args, "--students") ?? 100;
  const questions = flag(args, "--questions") ?? 5;

  const all = await readUsage().catch(() => []);
  const full = all.filter((r) => r.transcription && r.scoring);
  const records = full.length > 0 ? full : all;
  if (records.length === 0) {
    console.error(`No usage logged yet in ${DEFAULT_USAGE_LOG}. Run npm run ai:test -- path/to/audio.webm first.`);
    process.exit(1);
  }
  if (full.length === 0) console.log("Note: no full runs (transcription + scoring) logged, so transcription cost is missing.\n");

  const s = summarizeUsage(records);
  console.log(`${s.responses} logged response(s)`);
  console.log(`Latency   mean ${sec(s.totalMs.mean)}  p50 ${sec(s.totalMs.p50)}  p95 ${sec(s.totalMs.p95)}  (transcription ${sec(s.transcriptionMs)}, scoring ${sec(s.scoringMs)})`);
  console.log(`Audio     mean ${s.audioSeconds.toFixed(0)}s`);
  console.log(`Tokens    mean ${Math.round(s.inputTokens)} in / ${Math.round(s.outputTokens)} out, ${s.attempts.toFixed(2)} scoring call(s) per response`);
  console.log(`Cost      ${usd(s.costPerResponseUsd)} per response (Groq ${usd(s.groqUsd)}, Gemini ${usd(s.geminiUsd)})`);

  const p = projectCosts(s, { students, questionsPerStudent: questions });
  console.log(`\nProjection: ${students} students x ${questions} questions = ${p.responses} responses`);
  console.log(`  audio ${p.audioHours.toFixed(1)} h, tokens ${Math.round(p.inputTokens).toLocaleString()} in / ${Math.round(p.outputTokens).toLocaleString()} out`);
  console.log(`  Groq ${usd(p.groqUsd)}, Gemini ${usd(p.geminiUsd)}, total ${usd(p.totalUsd)}`);
  console.log(`  one sequential worker handles about ${Math.floor(p.perWorkerPerHour)} responses/hour`);
  console.log("\nEstimates only: check current Groq and Gemini pricing, and rate limits for your tier.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
