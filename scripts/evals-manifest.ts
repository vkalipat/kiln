#!/usr/bin/env bun
import { resolve } from "node:path";
import { verifyEvalsManifest, writeEvalsManifest } from "../src/evals/manifest";

const home = resolve(process.argv[2] ?? resolve(import.meta.dir, ".."));
const manifest = writeEvalsManifest(home);
const verification = verifyEvalsManifest(home);
if (!verification.ok) throw new Error(`generated manifest failed self-verification: ${JSON.stringify(verification)}`);
console.log(`wrote ${Object.keys(manifest.files).length} hashes to ${resolve(home, "evals", "manifest.json")}`);
