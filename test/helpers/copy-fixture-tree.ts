import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Byte copies avoid intermittent macOS clonefileat stalls in Bun's cpSync. */
export function copyFixtureTree(source: string, target: string): void {
  const stat = lstatSync(source);
  if (stat.isFile()) {
    writeFileSync(target, readFileSync(source));
  } else if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) copyFixtureTree(join(source, name), join(target, name));
  } else {
    throw new Error(`fixture source must contain only real files and directories: ${source}`);
  }
}
