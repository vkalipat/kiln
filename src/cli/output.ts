import type { CliIo } from "./main";

export function printJson(io: CliIo, v: unknown) {
  io.write(`${JSON.stringify(v, null, 2)}\n`);
}

export function table(io: CliIo, rows: string[][]) {
  const w = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  for (const r of rows) io.write(`${r.map((c, i) => c.padEnd(w[i] ?? 0)).join("  ")}\n`);
}
