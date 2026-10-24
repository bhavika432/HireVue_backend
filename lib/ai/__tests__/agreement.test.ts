import { describe, expect, it } from "vitest";
import { computeAgreement, parseCsv, parseGoldSet, resultsRow, toCsvLine, GOLD_COLUMNS, type GoldRow, type Prediction } from "../agreement";
import { CRITERION_IDS } from "../rubric";

const all = (n: number) => Object.fromEntries(CRITERION_IDS.map((c) => [c, n])) as GoldRow["rater1"];
const row = (id: string, a: number, b: number, category = "x"): GoldRow => ({ id, file: `${id}.txt`, category, question: "q", rater1: all(a), rater2: all(b) });
const pred = (id: string, n: number | null): Prediction => ({ id, scores: Object.fromEntries(CRITERION_IDS.map((c) => [c, n])) as Prediction["scores"] });

describe("computeAgreement", () => {
  it("counts within-1 of the human average and compares with inter-rater agreement", () => {
    const rows = [row("a", 4, 4), row("b", 2, 3), row("c", 1, 5)];
    const report = computeAgreement(rows, [pred("a", 5), pred("b", 4), pred("c", 5)]);
    const c = report.perCriterion[CRITERION_IDS[0]];
    // a: |5-4|=1 ok, b: |4-2.5|=1.5 no, c: |5-3|=2 no
    expect(c.within1).toBe(1);
    expect(c.within1Pct).toBe(33.3);
    expect(c.bias).toBeCloseTo((1 + 1.5 + 2) / 3, 1);
    // humans: a 0 apart, b 1 apart, c 4 apart
    expect(report.interRater.perCriterion[CRITERION_IDS[0]]).toBe(66.7);
  });

  it("excludes abstentions and reports the abstain rate", () => {
    const report = computeAgreement([row("a", 3, 3), row("b", 3, 3)], [pred("a", 3), pred("b", null)]);
    expect(report.perCriterion[CRITERION_IDS[0]].n).toBe(1);
    expect(report.overall.abstainRate).toBe(50);
  });

  it("treats a missing prediction as an abstention", () => {
    expect(computeAgreement([row("a", 3, 3)], []).overall.abstainRate).toBe(100);
  });

  it("groups by category and lists the worst gaps first", () => {
    const report = computeAgreement([row("a", 5, 5, "strong"), row("b", 1, 1, "weak")], [pred("a", 5), pred("b", 5)]);
    expect(report.byCategory.strong.within1Pct).toBe(100);
    expect(report.byCategory.weak.within1Pct).toBe(0);
    expect(report.worst[0].id).toBe("b");
  });
});

describe("gold-set CSV", () => {
  const header = GOLD_COLUMNS.join(",");
  it("parses quoted fields with commas and quotes", () => {
    expect(parseCsv('a,"b, ""c""",d\r\n1,2,3\n')).toEqual([["a", 'b, "c"', "d"], ["1", "2", "3"]]);
  });
  it("skips rows with missing or invalid scores instead of guessing", () => {
    const good = ["g1", "a.txt", "strong", "q", ...Array(8).fill("4")].join(",");
    const blank = ["g2", "b.txt", "weak", "q", ...Array(8).fill("")].join(",");
    const bad = ["g3", "c.txt", "weak", "q", "6", ...Array(7).fill("3")].join(",");
    const { rows, skipped } = parseGoldSet([header, good, blank, bad].join("\n"));
    expect(rows.map((r) => r.id)).toEqual(["g1"]);
    expect(skipped.map((s) => s.id)).toEqual(["g2", "g3"]);
  });
  it("throws a clear error when columns are missing", () => {
    expect(() => parseGoldSet("id,file\n1,a")).toThrow(/missing columns/);
  });
  it("writes one results line per run, quoting notes", () => {
    const report = computeAgreement([row("a", 3, 3)], [pred("a", 3)]);
    const line = resultsRow(report, { date: "2026-10-24", rubricVersion: "v1", promptVersion: "p2", model: "m", temperature: 0.1, notes: "a, b" });
    expect(line.startsWith("2026-10-24,v1,p2,m,0.1,1,")).toBe(true);
    expect(line.endsWith('"a, b"')).toBe(true);
    expect(toCsvLine(["x", null, 'q"q'])).toBe('x,,"q""q"');
  });
});
