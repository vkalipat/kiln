import type { AuditSnapshot, GitCommitOptions, GitDiffOptions, GitRunner } from "../../src/build/git";

export type FakeGitCall =
  | { method: "init"; dir: string }
  | { method: "commit"; dir: string; options: GitCommitOptions }
  | { method: "log"; dir: string; n?: number }
  | { method: "statusPorcelain"; dir: string }
  | { method: "statusPorcelainZ"; dir: string }
  | { method: "diff"; dir: string; options: GitDiffOptions }
  | { method: "revParseHead"; dir: string }
  | { method: "revert"; dir: string; sha: string; options: { noCommit: true } }
  | { method: "checkoutAndClean"; dir: string; restoreRef?: string }
  | { method: "hasTrailer"; dir: string; key: string; value: string }
  | { method: "trailerValues"; dir: string; key: string; n?: number }
  | { method: "createAuditSnapshot"; dir: string; tempDir: string }
  | { method: "rebuildAuditSnapshot"; snapshot: AuditSnapshot }
  | { method: "removeAuditSnapshot"; snapshot: AuditSnapshot };

/** Scriptable Git seam shared by the later build-loop unit tests. */
export class FakeGitRunner implements GitRunner {
  readonly calls: FakeGitCall[] = [];
  readonly commits: Array<{ dir: string; options: GitCommitOptions; sha: string }> = [];
  head = "0".repeat(40);
  status = "";
  statusZ?: string;
  diffText = "";
  logText = "";
  failMethod?: FakeGitCall["method"];
  private commitNumber = 0;

  private call<T extends FakeGitCall>(value: T): T {
    this.calls.push(value);
    if (this.failMethod === value.method) throw new Error(`fake git failure: ${value.method}`);
    return value;
  }

  async init(dir: string): Promise<void> {
    this.call({ method: "init", dir });
  }

  async commit(dir: string, options: GitCommitOptions): Promise<string> {
    this.call({ method: "commit", dir, options });
    this.commitNumber += 1;
    this.head = this.commitNumber.toString(16).padStart(40, "0");
    this.commits.push({ dir, options, sha: this.head });
    const trailer = (name: string) => Object.entries(options.trailers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
    const features = String(trailer("kiln-feature") ?? "");
    const runId = String(trailer("kiln-run") ?? "");
    const checkId = String(trailer("kiln-check") ?? "");
    const attempt = String(trailer("kiln-attempt") ?? "");
    this.logText = `${this.head}\0${features}\0${runId}\0${checkId}\0${attempt}\0${this.logText}`;
    this.status = "";
    return this.head;
  }

  async log(dir: string, options: { n?: number } = {}): Promise<string> {
    this.call({ method: "log", dir, n: options.n });
    return this.logText;
  }

  async statusPorcelain(dir: string): Promise<string> {
    this.call({ method: "statusPorcelain", dir });
    return this.status;
  }

  async statusPorcelainZ(dir: string): Promise<string> {
    this.call({ method: "statusPorcelainZ", dir });
    return this.statusZ ?? this.status.split("\n").filter(Boolean).map((line) => `${line}\0`).join("");
  }

  async diff(dir: string, options: GitDiffOptions = {}): Promise<string> {
    this.call({ method: "diff", dir, options });
    return this.diffText;
  }

  async revParseHead(dir: string): Promise<string> {
    this.call({ method: "revParseHead", dir });
    return this.head;
  }

  async revert(dir: string, sha: string, options: { noCommit: true }): Promise<void> {
    this.call({ method: "revert", dir, sha, options });
    this.status = "M  reverted-file\n";
  }

  async checkoutAndClean(dir: string, restoreRef?: string): Promise<void> {
    this.call({ method: "checkoutAndClean", dir, restoreRef });
    if (restoreRef) this.head = restoreRef;
    this.status = "";
  }

  async hasTrailer(dir: string, key: string, value: string): Promise<boolean> {
    this.call({ method: "hasTrailer", dir, key, value });
    return this.commits.some((commit) => Object.entries(commit.options.trailers ?? {}).some(([heldKey, heldValue]) => heldKey.toLowerCase() === key.toLowerCase() && String(heldValue) === value));
  }

  async trailerValues(dir: string, key: string, options: { n?: number } = {}): Promise<string[]> {
    this.call({ method: "trailerValues", dir, key, n: options.n });
    const commits = options.n === undefined ? [...this.commits] : this.commits.slice(-Math.max(0, options.n));
    return commits.reverse().flatMap((commit) => Object.entries(commit.options.trailers ?? {})
      .filter(([heldKey]) => heldKey.toLowerCase() === key.toLowerCase()).map(([, value]) => String(value)));
  }

  async createAuditSnapshot(dir: string, tempDir: string): Promise<AuditSnapshot> {
    this.call({ method: "createAuditSnapshot", dir, tempDir });
    return {
      producerDir: dir,
      tempDir,
      indexFile: `${tempDir}/audit.index`,
      payloadDir: `${tempDir}/payload`,
      commit: this.head,
      worktree: `${tempDir}/worktree`,
      entries: [],
    };
  }

  async rebuildAuditSnapshot(snapshot: AuditSnapshot): Promise<void> {
    this.call({ method: "rebuildAuditSnapshot", snapshot });
  }

  async removeAuditSnapshot(snapshot: AuditSnapshot): Promise<void> {
    this.call({ method: "removeAuditSnapshot", snapshot });
  }
}
