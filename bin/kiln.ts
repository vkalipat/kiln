#!/usr/bin/env bun
import { main } from "../src/cli/main";
import { finishProcess } from "../src/cli/exit";
await finishProcess(await main(process.argv.slice(2)));
