/**
 * Measuring how well the AI agrees with human reviewers on a gold set.
 *
 * Gold set = transcripts scored 1-5 on every criterion by TWO humans. For each criterion we count how
 * often the AI is within 1 point of the human average, and compare with how often the two humans are within
 * 1 point of each other (the realistic ceiling: the AI cannot be expected to agree more than humans do).
 */
import { CRITERION_IDS, type CriterionId } from "./rubric";

export type CriterionScores = Record<CriterionId, number>;

export interface GoldRow {
  id: string;
  file: string;
  category: string;
  question: string;
  rater1: CriterionScores;
  rater2: CriterionScores;
}

export interface SkippedRow {
  id: string;
  reason: string;
}

/** Minimal CSV parser: quoted fields, escaped quotes, commas and newlines inside quotes, BOM, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export function toCsvLine(values: ReadonlyArray<string | number | null | undefined>): string {
  return values
    .map((v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

/** Column names the gold-set CSV must have: id,file,category,question,rater1_<criterion>...,rater2_<criterion>... */
export const GOLD_COLUMNS = [
  "id",
  "file",
  "category",
  "question",
  ...CRITERION_IDS.map((c) => `rater1_${c}`),
  ...CRITERION_IDS.map((c) => `rater2_${c}`),
];

function readScores(get: (name: string) => string, prefix: "rater1" | "rater2"): CriterionScores | null {
  const scores = {} as CriterionScores;
  for (const c of CRITERION_IDS) {
    const raw = get(`${prefix}_${c}`).trim();
    const n = Number(raw);
    if (raw === "" || !Number.isInteger(n) || n < 1 || n > 5) return null;
    scores[c] = n;
  }
  return scores;
}

/** Rows without complete, valid scores from both raters are skipped (and reported), never guessed. */
export function parseGoldSet(csvText: string): { rows: GoldRow[]; skipped: SkippedRow[] } {
  const [header, ...records] = parseCsv(csvText);
  if (!header) return { rows: [], skipped: [] };
  const index = new Map(header.map((h, i) => [h.trim(), i]));
  const missing = GOLD_COLUMNS.filter((c) => !index.has(c));
  if (missing.length > 0) throw new Error(`Gold-set CSV is missing columns: ${missing.join(", ")}`);

  const rows: GoldRow[] = [];
  const skipped: SkippedRow[] = [];
  for (const record of records) {
    const get = (name: string) => record[index.get(name)!] ?? "";
    const id = get("id").trim() || "(no id)";
    const file = get("file").trim();
    if (!file) {
      skipped.push({ id, reason: "no transcript file" });
      continue;
    }
    const rater1 = readScores(get, "rater1");
    const rater2 = readScores(get, "rater2");
    if (!rater1 || !rater2) {
      skipped.push({ id, reason: "scores missing or not whole numbers 1-5 from both raters" });
      continue;
    }
    rows.push({ id, file, category: get("category").trim() || "uncategorized", question: get("question").trim(), rater1, rater2 });
  }
  return { rows, skipped };
}

export const humanMean = (row: GoldRow, criterion: CriterionId): number => (row.rater1[criterion] + row.rater2[criterion]) / 2;

export interface Prediction {
  id: string;
  /** null = the AI abstained (insufficient evidence) or the run failed */
  scores: Record<CriterionId, number | null>;
}

export interface CriterionAgreement {
  /** Items the AI scored (abstentions excluded). */
  n: number;
  within1: number;
  within1Pct: number;
  exactPct: number;
  /** Mean absolute difference from the human average. */
  mae: number;
  /** Mean (AI minus human average): positive means the AI is more generous. */
  bias: number;
  abstained: number;
}

export interface AgreementReport {
  transcripts: number;
  perCriterion: Record<CriterionId, CriterionAgreement>;
  overall: { n: number; within1Pct: number; mae: number; abstainRate: number };
  interRater: { perCriterion: Record<CriterionId, number>; overallWithin1Pct: number };
  byCategory: Record<string, { n: number; within1Pct: number }>;
  /** Largest disagreements, to review by hand. */
  worst: Array<{ id: string; criterion: CriterionId; ai: number; humanMean: number; diff: number }>;
}

const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);
const EPS = 1e-9;

export function computeAgreement(rows: readonly GoldRow[], predictions: readonly Prediction[], tolerance = 1): AgreementReport {
  const byId = new Map(predictions.map((p) => [p.id, p]));
  const perCriterion = {} as Record<CriterionId, CriterionAgreement>;
  const interRater = {} as Record<CriterionId, number>;
  const categories = new Map<string, { n: number; within: number }>();
  const worst: AgreementReport["worst"] = [];
  let allN = 0, allWithin = 0, allAbs = 0, allAbstained = 0, allItems = 0, irWithin = 0, irTotal = 0;

  for (const criterion of CRITERION_IDS) {
    let n = 0, within = 0, exact = 0, abs = 0, signed = 0, abstained = 0, irOk = 0;

    for (const row of rows) {
      if (Math.abs(row.rater1[criterion] - row.rater2[criterion]) <= tolerance + EPS) irOk++;

      allItems++;
      const ai = byId.get(row.id)?.scores[criterion] ?? null;
      if (ai === null) {
        abstained++;
        allAbstained++;
        continue;
      }
      const human = humanMean(row, criterion);
      const diff = ai - human;
      n++;
      abs += Math.abs(diff);
      signed += diff;
      const ok = Math.abs(diff) <= tolerance + EPS;
      if (ok) within++;
      if (Math.abs(diff) < EPS) exact++;
      worst.push({ id: row.id, criterion, ai, humanMean: human, diff: Math.round(diff * 100) / 100 });

      const cat = categories.get(row.category) ?? { n: 0, within: 0 };
      cat.n++;
      if (ok) cat.within++;
      categories.set(row.category, cat);
    }

    perCriterion[criterion] = {
      n,
      within1: within,
      within1Pct: pct(within, n),
      exactPct: pct(exact, n),
      mae: n === 0 ? 0 : Math.round((abs / n) * 100) / 100,
      bias: n === 0 ? 0 : Math.round((signed / n) * 100) / 100,
      abstained,
    };
    interRater[criterion] = pct(irOk, rows.length);
    allN += n;
    allWithin += within;
    allAbs += abs;
    irWithin += irOk;
    irTotal += rows.length;
  }

  worst.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  return {
    transcripts: rows.length,
    perCriterion,
    overall: {
      n: allN,
      within1Pct: pct(allWithin, allN),
      mae: allN === 0 ? 0 : Math.round((allAbs / allN) * 100) / 100,
      abstainRate: pct(allAbstained, allItems),
    },
    interRater: { perCriterion: interRater, overallWithin1Pct: pct(irWithin, irTotal) },
    byCategory: Object.fromEntries([...categories].map(([k, v]) => [k, { n: v.n, within1Pct: pct(v.within, v.n) }])),
    worst: worst.slice(0, 5),
  };
}

export const RESULTS_COLUMNS = [
  "date",
  "rubric_version",
  "prompt_version",
  "model",
  "temperature",
  "transcripts",
  ...CRITERION_IDS.map((c) => `${c}_within1_pct`),
  "overall_within1_pct",
  "mean_abs_error",
  "abstain_rate_pct",
  "human_vs_human_within1_pct",
  "notes",
];

/** One line for the tracking spreadsheet (CSV opens directly in Excel or Google Sheets). */
export function resultsRow(
  report: AgreementReport,
  meta: { date: string; rubricVersion: string; promptVersion: string; model: string; temperature: number; notes?: string },
): string {
  return toCsvLine([
    meta.date,
    meta.rubricVersion,
    meta.promptVersion,
    meta.model,
    meta.temperature,
    report.transcripts,
    ...CRITERION_IDS.map((c) => report.perCriterion[c].within1Pct),
    report.overall.within1Pct,
    report.overall.mae,
    report.overall.abstainRate,
    report.interRater.overallWithin1Pct,
    meta.notes ?? "",
  ]);
}
