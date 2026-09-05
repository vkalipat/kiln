import type { M1ArmMetrics, M1Report } from "../evals/m1";
import type { M2ProjectReport, M2Report } from "../evals/m2";
import type { RunSummary } from "../evals/executor";
import type { CliIo } from "./main";
import { table } from "./output";

function value(number: number | null | undefined): string {
  if (number === null || number === undefined) return "-";
  return Number.isInteger(number) ? String(number) : number.toFixed(4);
}

function money(number: number | null | undefined): string {
  return number === null || number === undefined ? "-" : `$${number.toFixed(4)}`;
}

function pair(a: string, b: string): string {
  return `${a}/${b}`;
}

function frontier(metrics: M1ArmMetrics): string {
  return `${metrics.frontier.raw}/${metrics.frontier.shown}/${metrics.frontier.backfilled}`;
}

function counts(values: Record<string, number>): string {
  return Object.entries(values).map(([name, count]) => `${name}:${count}`).join(",") || "none";
}

/** Render the complete human-readable M1 report without reading files or invoking providers. */
export function printM1Report(io: CliIo, report: M1Report): void {
  io.write(`M1 ${report.evalId}\n`);
  for (const comparison of report.comparisons) {
    io.write(`\n${comparison.id} (${comparison.a} vs ${comparison.b})\n`);
    table(io, [[
      "seed", "shape",
      `${comparison.a} frontier raw/shown/backfilled`, `${comparison.b} frontier raw/shown/backfilled`,
      `wins ${comparison.a}/${comparison.b}/ties`, "pairCensored", "pairCensoredBy",
      `collisionRate ${comparison.a}/${comparison.b}`, `probePassRate ${comparison.a}/${comparison.b}`,
      `usdPerSuccess ${comparison.a}/${comparison.b}`, `costUsd ${comparison.a}/${comparison.b}`,
      `tokensPerSuccess ${comparison.a}/${comparison.b}`, `turnsPerSuccess ${comparison.a}/${comparison.b}`,
      `cacheReadRatio ${comparison.a}/${comparison.b}`, "note",
    ], ...comparison.rows.map((row) => {
      const aWins = row.pairs.filter((item) => item.score === 1).length;
      const bWins = row.pairs.filter((item) => item.score === 0).length;
      const ties = row.pairs.filter((item) => item.score === 0.5).length;
      return [
        row.seed, row.shape, frontier(row.aMetrics), frontier(row.bMetrics), `${aWins}/${bWins}/${ties}`,
        String(row.pairCensored), row.pairCensoredBy.join(",") || "none",
        pair(value(row.aMetrics.collisionRate), value(row.bMetrics.collisionRate)),
        pair(value(row.aMetrics.probePassRate), value(row.bMetrics.probePassRate)),
        pair(money(row.aMetrics.usdPerSuccess), money(row.bMetrics.usdPerSuccess)),
        pair(money(row.aMetrics.costUsd), money(row.bMetrics.costUsd)),
        pair(value(row.aMetrics.tokensPerSuccess), value(row.bMetrics.tokensPerSuccess)),
        pair(value(row.aMetrics.turnsPerSuccess), value(row.bMetrics.turnsPerSuccess)),
        pair(value(row.aMetrics.cacheReadRatio), value(row.bMetrics.cacheReadRatio)), row.note ?? "-",
      ];
    })]);

    const summary = comparison.summary;
    const observedWins = summary.wins + summary.ties / 2;
    io.write(`pairWinRate: ${value(summary.rate)}; interval: [${value(summary.wilson.lower)}, ${value(summary.wilson.upper)}]\n`);
    io.write(`n: ${summary.n}; requiredWins: ${summary.requiredWins}; observedWins: ${value(observedWins)}\n`);
    io.write(`seedRate: ${value(summary.seedRate)} (${value(summary.seedWins)}/${summary.uncensoredSeeds}; seeds=${summary.seeds}; pairCensored=${summary.pairCensored})\n`);
    io.write(`perShape: research=${value(summary.perShape.research)}, product=${value(summary.perShape.product)}, creative=${value(summary.perShape.creative)}\n`);
    io.write(`prediction: ${summary.prediction}; kill: ${summary.kill}\n`);
    io.write(`honestExits: ${counts(summary.honestExits)}; failed: ${counts(summary.failed)}\n`);
  }

  io.write(`\njudgeCalibration.status: ${report.judgeCalibration.status}\n`);
  io.write(`effortSwept: ${report.effortSwept} (${report.arms.map((arm) => `${arm}=${report.effortSweptByArm[arm] ?? false}`).join(", ")})\n`);
  io.write(`total cost: ${money(report.costUsd)}\n`);
  io.write(`status: ${report.status}${report.stoppedReason ? ` (${report.stoppedReason})` : ""}\n`);
}

function buildMetrics(run: RunSummary | undefined) {
  return run?.metrics;
}

function executed(run: RunSummary | undefined): string {
  return value(buildMetrics(run)?.featuresPassed?.executed);
}

function contextPressure(run: RunSummary | undefined, arm: "fresh" | "single_session"): string {
  return value(buildMetrics(run)?.contextPressureByArm?.[arm]);
}

function buildCost(run: RunSummary | undefined): { usdPerSuccess: string; usd: string } {
  const cost = buildMetrics(run)?.cost?.build;
  return { usdPerSuccess: money(cost?.usdPerSuccess), usd: money(cost?.usd) };
}

function honestExits(run: RunSummary | undefined): string {
  if (!run) return "-";
  if (run.outcome?.kind === "honest_exit") return run.outcome.exitKind ?? "unknown";
  const exits = buildMetrics(run)?.honestExits;
  if (!exits || exits.total === 0) return "none";
  const cannot = exits.cannot_be_satisfied?.declared ?? 0;
  const notFormable = (exits.not_formable?.mechanical ?? 0) + (exits.not_formable?.declared ?? 0);
  const kinds = [
    ...(cannot > 0 ? [`cannot_be_satisfied:${cannot}`] : []),
    ...(notFormable > 0 ? [`not_formable:${notFormable}`] : []),
  ];
  return kinds.join(",") || `total:${exits.total}`;
}

function m2Row(project: M2ProjectReport): string[] {
  const freshCost = buildCost(project.fresh);
  const singleCost = buildCost(project.singleSession);
  return [
    project.seedId, project.shape, String(project.pairCensored), project.pairCensoredBy.join(",") || "none",
    pair(executed(project.fresh), executed(project.singleSession)),
    pair(contextPressure(project.fresh, "fresh"), contextPressure(project.singleSession, "single_session")),
    pair(honestExits(project.fresh), honestExits(project.singleSession)),
    pair(freshCost.usdPerSuccess, singleCost.usdPerSuccess), pair(freshCost.usd, singleCost.usd),
  ];
}

/** Render the complete human-readable M2 report without reading files or invoking providers. */
export function printM2Report(io: CliIo, report: M2Report): void {
  io.write(`M2 ${report.evalId}\n`);
  table(io, [[
    "seed", "shape", "pairCensored", "pairCensoredBy",
    "featuresPassed.executed fresh/single_session", "contextPressure fresh/single_session",
    "honestExits fresh/single_session", "cost.build.usdPerSuccess fresh/single_session",
    "cost.build.usd fresh/single_session",
  ], ...report.projects.map(m2Row)]);
  io.write(`projection per project: expected=${money(report.projection.perSeedPair.expectedUsd)}, ceiling=${money(report.projection.perSeedPair.ceilingUsd)}\n`);
  io.write(`projection total: expected=${money(report.projection.expectedUsd)}, ceiling=${money(report.projection.ceilingUsd)}\n`);
  io.write(`status: ${report.status}${report.stoppedReason ? ` (${report.stoppedReason})` : ""}\n`);
  io.write(`judgeCalibration.status: ${report.judgeCalibration.status}\n`);
  io.write(`effortSwept: ${report.effortSwept} (fresh=${report.effortSweptByArm.fresh}, single_session=${report.effortSweptByArm.single_session})\n`);
  io.write(`total cost: ${money(report.costUsd)}\n`);
}
