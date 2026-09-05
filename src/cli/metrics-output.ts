import { METRIC_KEYS, METRIC_SHAPES, type MetricsReport } from "../evals/metrics";
import type { CliIo } from "./main";
import { table } from "./output";

const value = (number: number | null | undefined) => number === null || number === undefined ? "-" : Number.isInteger(number) ? String(number) : number.toFixed(4);
const counts = (values: Record<string, number>) => Object.entries(values).map(([kind, count]) => `${kind}:${count}`).join(", ") || "none";

/** Human-readable counterpart of the JSON report; no provider or filesystem work. */
export function printMetricsReport(io: CliIo, report: MetricsReport): void {
  table(io, [["runs", "done", "paused", "running", "skipped"], [String(report.runs.total), String(report.runs.done), String(report.runs.paused), String(report.runs.running), String(report.skipped.length)]]);
  io.write(`stopped: ${counts(report.runs.stopped)}\nfailed: ${counts(report.runs.failed)}\nhonest exits: ${counts(report.runs.honestExits)}\n`);
  for (const shape of METRIC_SHAPES) {
    const bucket = report.buckets[shape];
    io.write(`\n${shape} (${bucket.runs.total} runs; ${bucket.runs.done} successful)\n`);
    const keys = METRIC_KEYS.filter((key) => bucket.metrics[key].all.n > 0);
    if (!keys.length) { io.write("no numeric observations\n"); continue; }
    table(io, [["metric", "done n", "done mean", "done median", "done sum", "all n", "all mean", "all median", "all sum"], ...keys.map((key) => {
      const { done, all } = bucket.metrics[key];
      return [key, String(done.n), value(done.mean), value(done.median), value(done.sum), String(all.n), value(all.mean), value(all.median), value(all.sum)];
    })]);
  }
  if (report.rows.length) {
    io.write("\nRun provenance (run censorship and paired censorship are separate)\n");
    table(io, [["run", "shape", "state", "evalId", "arm", "censored", "pairCensored", "pairCensoredBy"], ...report.rows.map((row) => [
      row.runId, row.shape, row.state, row.evalId ?? "-", row.arm ?? "-", String(row.values.censored ?? "-"), String(row.pairCensored ?? "-"), row.pairCensoredBy?.join(",") || "-",
    ])]);
    for (const row of report.rows) for (const pair of row.pairCensoring ?? []) {
      io.write(`${row.runId} vs ${pair.arm}: pairCensored=${pair.pairCensored}; by=${pair.pairCensoredBy.join(",") || "none"}\n`);
    }
  }
  io.write(`\njudgeCalibration.status: ${report.judgeCalibration.status}\n`);
  if (report.skipped.length) io.write(`skipped unreadable/missing metric records: ${report.skipped.join(", ")}\n`);
}
