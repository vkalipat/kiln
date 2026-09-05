#!/usr/bin/env bun
import { main } from "../src/cli/main";
process.exitCode = await main(process.argv.slice(2));
