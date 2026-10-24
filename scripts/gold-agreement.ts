/**
 * Score the gold set with the current rubric and prompt, and measure agreement with the human scores.
 *
 *   npm run ai:gold
 *   npm run ai:gold -- --notes "tightened depth anchors"
 *   npm run ai:gold -- --file ai-fixtures/gold/gold-set.csv
 *
 * Appends one line per run to ai-logs/agreement-results.csv (open it in Excel or Google Sheets to track
 * progress per rubric and prompt version) and writes per-transcript predictions next to it.
 * Rows without full scores from both humans are skipped.
 */
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { computeAgreement, parseGoldSet, resultsRow, RESULTS_COLUMNS, toCsvLine, type Prediction } from "../lib/ai/agreement";
import { PROMPT_VERSION } from "../lib/ai/prompt";
import { CRITERION_IDS, RUBRIC_VERSION } from "../lib/ai/rubric";
import { scoreTranscript } from "../lib/ai/score";
import { buildUsageRecord } from "../lib/ai/usage";
import { appendUsage } from "../lib/ai/usage-log";

const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const goldFile = flag(args, "--file") ?? "ai-fixtures/gold/gold-set.csv";
  const notes = flag(args, "--notes") ?? "";
  const dir = path.dirname(goldFile);

  const { rows, skipped } = parseGoldSet(await readFile(goldFile, "utf8"));
  if (skipped.length) console.log(`Skipped ${skipped.length} row(s): ${skipped.map((s) => `${s.id} (${s.reason})`).join("; ")}`);
  if (rows.length === 0) {
    console.error("No complete rows to evaluate. Fill in both raters' scores in the gold-set CSV first.");
    process.exit(1);
  }
  if (rows.length < 20) console.log(`Note: only ${rows.length} scored transcripts; the plan calls for 20-30, so treat percentages as rough.`);

  const predictions: Prediction[] = [];
  const failed: string[] = [];
  let model = process.env.GEMINI_MODEL || "gemini-3.8-flash";

  for (const row of rows) {
    const transcript = (await readFile(path.join(dir, row.file), "utf8")).trim();
    const started = Date.now();
    try {
      const scored = await scoreTranscript({ question: row.question || "Describe a time you solved a difficult problem in a team project.", transcript });
      model = scored.model;
      predictions.push({ id: row.id, scores: Object.fromEntries(scored.result.criteria.map((c) => [c.id, c.score])) as Prediction["scores"] });
      await appendUsage(buildUsageRecord({ scored: { model: scored.model, elapsedMs: Date.now() - started, attempts: scored.attempts, usage: scored.usage }, totalMs: Date.now() - started }));
    } catch (err) {
      failed.push(row.id);
      console.error(`${row.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const report = computeAgreement(rows, predictions);
  const temperature = Number(process.env.GEMINI_TEMPERATURE ?? 0.1);

  console.log(`\nrubric ${RUBRIC_VERSION} | prompt ${PROMPT_VERSION} | ${model} | ${report.transcripts} transcripts${failed.length ? ` (${failed.length} failed)` : ""}\n`);
  console.table(
    CRITERION_IDS.map((c) => {
      const a = report.perCriterion[c];
      return { criterion: c, "within ±1 %": a.within1Pct, "humans agree %": report.interRater.perCriterion[c], "mean abs err": a.mae, bias: a.bias, abstained: a.abstained };
    }),
  );
  console.log(`Overall within ±1: ${report.overall.within1Pct}%   (two humans agree within ±1: ${report.interRater.overallWithin1Pct}%)   mean abs error ${report.overall.mae}   abstain ${report.overall.abstainRate}%`);
  console.log("By category:", Object.entries(report.byCategory).map(([k, v]) => `${k} ${v.within1Pct}% (n=${v.n})`).join(", "));
  console.log("Biggest gaps to review by hand:");
  for (const w of report.worst) console.log(`  ${w.id} / ${w.criterion}: AI ${w.ai} vs humans ${w.humanMean} (${w.diff > 0 ? "+" : ""}${w.diff})`);

  await mkdir("ai-logs", { recursive: true });
  const resultsPath = "ai-logs/agreement-results.csv";
  if (!(await exists(resultsPath))) await appendFile(resultsPath, toCsvLine(RESULTS_COLUMNS) + "\n");
  await appendFile(resultsPath, resultsRow(report, { date: new Date().toISOString().slice(0, 10), rubricVersion: RUBRIC_VERSION, promptVersion: PROMPT_VERSION, model, temperature, notes }) + "\n");

  const predLines = [toCsvLine(["id", ...CRITERION_IDS]), ...predictions.map((p) => toCsvLine([p.id, ...CRITERION_IDS.map((c) => p.scores[c])]))];
  await writeFile(`ai-logs/gold-predictions-${RUBRIC_VERSION}-${PROMPT_VERSION}.csv`, predLines.join("\n") + "\n");
  console.log(`\nLogged to ${resultsPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
