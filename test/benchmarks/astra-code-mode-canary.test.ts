import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import { CANARY, CanaryExposure, decodedCanaryWire, inspectCanaryWire, parseCanaryArgs, prepareCanary, validCanaryResult } from "../../scripts/benchmarks/astra-code-mode-canary";

const model = getBundledModel("openai-codex", "gpt-6-astra")!;
const wire = () => JSON.stringify({ model: CANARY.model, input: [{ role: "user", content: "arithmetic" }], tools: [{ type: "custom", name: "exec" }] });

describe("Astra canary provider-free protocol", () => {
  test("live is opt-in with output directory and both approval hashes", () => {
    for (const args of [[], ["--out", "/tmp/x"], ["--live", "--out", "/tmp/x"], ["--prepare", "--live", "--out", "/tmp/x"],
      ["--prepare", "--out"], ["--prepare", "--out", "/tmp/x", "--unknown"]]) expect(() => parseCanaryArgs(args)).toThrow();
    expect(parseCanaryArgs(["--prepare", "--out", "/tmp/example-canary"]).live).toBe(false);
    const h = "a".repeat(64);
    expect(parseCanaryArgs(["--live", "--out", "/tmp/example-canary", "--expected-source-sha", h, "--expected-driver-sha", h]).live).toBe(true);
  });
  test("reserves catalog maximum128000 output even for tiny arithmetic request", () => {
    expect(model.maxTokens).toBe(128000);
    const inspected = inspectCanaryWire(wire(), model.cost);
    expect(inspected.reservedOutputTokens).toBe(128000);
    expect(inspected.actualOutputCap).toBeNull();
    expect(inspected.reservedUsd).toBeGreaterThanOrEqual(128000 * model.cost.output / 1e6);
    expect(inspected.reservedUsd).toBeGreaterThan(6.4);
    expect(inspectCanaryWire(wire().replace("arithmetic", "x".repeat(10000)), model.cost).reservedUsd).toBeGreaterThan(inspected.reservedUsd);
    expect(inspected.wireBytes).toBe(Buffer.byteLength(wire()));
  });
  test("decodes transformed plain, byte, Request, and zstd wire bodies without logging", async () => {
    const body = wire();
    expect(await decodedCanaryWire("https://example.invalid", { body })).toBe(body);
    expect(await decodedCanaryWire("https://example.invalid", { body: new TextEncoder().encode(body) })).toBe(body);
    expect(await decodedCanaryWire(new Request("https://example.invalid", { method: "POST", body }))).toBe(body);
    const compressed = new Uint8Array(Bun.zstdCompressSync(body));
    expect(await decodedCanaryWire("https://example.invalid", { headers: { "content-encoding": "zstd" }, body: compressed })).toBe(body);
    await expect(decodedCanaryWire("https://example.invalid", { headers: { "content-encoding": "gzip" }, body })).rejects.toThrow();
  });
  test("rejects incorrect model, noncustom tools and changed outputcap assumptions", () => {
    for (const value of [{ model: "wrong", tools: [{ type: "custom", name: "exec" }] },
      { model: CANARY.model, tools: [{ type: "function", name: "exec" }] },
      { ...JSON.parse(wire()), max_output_tokens: 2048 }, { ...JSON.parse(wire()), max_tokens: 2048 }]) {
      expect(() => inspectCanaryWire(JSON.stringify(value), model.cost)).toThrow();
    }
  });
  test("max3requests and25dollar exposure; unknowns retain full reservation", () => {
    const ledger = new CanaryExposure();
    const first = ledger.reserve(7); expect(first(NaN, "error")).toBe(7);
    expect(ledger.chargedUsd).toBe(7);
    const second = ledger.reserve(7); expect(second(0.2, "stop")).toBe(0.2);
    expect(ledger.chargedUsd).toBeCloseTo(7.2);
    const third = ledger.reserve(7); third(1, "aborted");
    expect(ledger.chargedUsd).toBeCloseTo(14.2);
    expect(() => ledger.reserve(0.1)).toThrow();
    expect(() => first(0, "stop")).toThrow();
    const full = new CanaryExposure(); full.reserve(20);
    expect(() => full.reserve(6)).toThrow();
    expect(full.requests).toBe(1);
    expect(() => full.reserve(NaN)).toThrow();
  });
  test("terminal answer is exact, not a model success assertion", () => {
    expect(validCanaryResult('{"sum":42}')).toBe(true);
    for (const value of ['{"sum":41}', '{"sum":"42"}', '{"sum":42,"success":true}', "42", "null", "[]", "done"]) {
      expect(validCanaryResult(value)).toBe(false);
    }
  });
  test("prepare is credential-free, frozen and refuses directory/ledger reuse", () => {
    const parent = mkdtempSync(join(tmpdir(), "kiln-canary-test-")); const out = join(parent, "artifact");
    const protocol = prepareCanary(out);
    expect(readdirSync(out)).toEqual(["protocol.json"]);
    expect(protocol.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(protocol.driverSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(protocol.reservedOutputTokens).toBe(128000);
    expect(protocol.exposureUsd).toBe(25);
    expect(protocol.wallMs).toBe(180000);
    expect(JSON.parse(readFileSync(join(out, "protocol.json"), "utf8"))).toEqual(protocol);
    expect(() => prepareCanary(out)).toThrow();
  });
});
