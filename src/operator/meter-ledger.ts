import { constants, closeSync, existsSync, fstatSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { OperatorMeterRow, OperatorMeterSnapshot } from "./meter";

type Summary = Omit<OperatorMeterSnapshot, "rows">;
type Checkpoint = OperatorMeterSnapshot & { journalSequence?: number };
interface Change { version: 1; sequence: number; runId: string; limitUsd: number | null; chargedUsd: number; knownCostUsd: number; row?: OperatorMeterRow; gaps: string[]; seenMaintenance: string[] }

/** Read the checkpoint and every durable delta. Never treat a damaged journal as a fresh budget. */
export function readOperatorLedger(path: string): Checkpoint | undefined {
  const journal = `${path}.jsonl`;
  if (!existsSync(path)) {
    if (existsSync(journal) && statSync(journal).size) throw new Error("Operator ledger checkpoint missing; refuse reset");
    return undefined;
  }
  const read = (file: string, limit: number) => {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > limit) throw new Error("Invalid operator ledger file"); return readFileSync(fd, "utf8"); }
    finally { closeSync(fd); }
  };
  const snapshot: Checkpoint = JSON.parse(read(path, 512 * 1024 * 1024));
  if (!Array.isArray(snapshot.rows) || !Array.isArray(snapshot.gaps) || !Array.isArray(snapshot.seenMaintenance)
    || !Number.isSafeInteger(snapshot.journalSequence ?? 0) || (snapshot.journalSequence ?? 0) < 0) throw new Error("Invalid operator ledger checkpoint");
  if (!existsSync(journal)) return snapshot;
  if (statSync(journal).size > 16 * 1024 * 1024) throw new Error("Operator ledger journal exceeds bounds");
  const text = read(journal, 16 * 1024 * 1024);
  if (text && !text.endsWith("\n")) throw new Error("Incomplete operator ledger journal; refuse dispatch");
  let sequence = snapshot.journalSequence ?? 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const entry: Change = JSON.parse(line);
    if (entry.version !== 1 || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1
      || entry.runId !== snapshot.runId || entry.limitUsd !== snapshot.limitUsd) throw new Error("Invalid or mismatched operator ledger journal");
    if (entry.sequence <= (snapshot.journalSequence ?? 0)) continue;
    if (entry.sequence !== sequence + 1 || !Number.isFinite(entry.chargedUsd) || entry.chargedUsd < 0
      || !Number.isFinite(entry.knownCostUsd) || entry.knownCostUsd < 0 || !Array.isArray(entry.gaps) || !Array.isArray(entry.seenMaintenance)) throw new Error("Invalid operator ledger journal sequence or totals");
    if (entry.row) {
      const id = entry.row.id;
      if (!Number.isSafeInteger(id) || id < 1 || id > snapshot.rows.length + 1) throw new Error("Invalid operator ledger journal row");
      snapshot.rows[id - 1] = entry.row;
    }
    snapshot.chargedUsd = entry.chargedUsd; snapshot.knownCostUsd = entry.knownCostUsd;
    snapshot.gaps.push(...entry.gaps); snapshot.seenMaintenance.push(...entry.seenMaintenance);
    sequence = entry.sequence;
  }
  snapshot.journalSequence = sequence;
  return snapshot;
}

/** A small append is flushed before dispatch. Full JSON remains a periodic compatibility checkpoint. */
export function createMeterLedger(path: string, initialSequence: number, snapshot: () => OperatorMeterSnapshot) {
  const journal = `${path}.jsonl`;
  let sequence = initialSequence, gapCount = 0, seenCount = 0;
  let failed = false;
  const flush = (file: string) => { const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } };
  const durableWrite = (file: string, text: string) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, file);
      if (process.platform !== "win32") flush(dirname(file));
    }
    finally { rmSync(temporary, { force: true }); }
  };
  const checkpoint = () => {
    const value = snapshot();
    if (failed) throw new Error("Operator ledger persistence failed; refuse further dispatch");
    durableWrite(path, JSON.stringify({ ...value, journalSequence: sequence }));
    // Checkpoint sequence makes old deltas harmless if a crash occurs before journal rotation.
    durableWrite(journal, "");
    gapCount = value.gaps.length; seenCount = value.seenMaintenance.length;
  };
  checkpoint();
  return {
    append(summary: Summary, row?: OperatorMeterRow) {
      if (failed) throw new Error("Operator ledger persistence failed; refuse further dispatch");
      const entry: Change = { version: 1, sequence: ++sequence, runId: summary.runId, limitUsd: summary.limitUsd,
        chargedUsd: summary.chargedUsd, knownCostUsd: summary.knownCostUsd, ...(row ? { row } : {}),
        gaps: summary.gaps.slice(gapCount), seenMaintenance: summary.seenMaintenance.slice(seenCount) };
      try {
        const fd = openSync(journal, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        try { if (!fstatSync(fd).isFile()) throw new Error("Invalid operator ledger journal"); writeFileSync(fd, JSON.stringify(entry) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
        gapCount = summary.gaps.length; seenCount = summary.seenMaintenance.length;
        // Keep tiny ledgers immediately readable by older inspection tools, then amortize history serialization.
        if (sequence <= 32 || sequence % 128 === 0) checkpoint();
      } catch (error) { failed = true; throw error; }
    },
    checkpoint,
  };
}
