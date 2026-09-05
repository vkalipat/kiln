import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import type { Model } from "@oh-my-pi/pi-catalog";
import { defaultConfig } from "../../src/core/config";
import { isStrictCompatibleSchema, shapeProviderPayload } from "../../src/providers/shaping";

const sourceRoot = join(import.meta.dir, "../../src");
const model = { api: "anthropic-messages", provider: "anthropic", id: "claude-fable-5-1" } as Model;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
}
function field(node: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  const found = node.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText().replace(/["']/g, "") === key);
  return found && ts.isPropertyAssignment(found) ? found.initializer : undefined;
}

/** Interpret only static schema literals; never evaluate module code to discover a contract. */
function literal(node: ts.Expression, constants: Map<string, ts.Expression>): unknown {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return literal(node.expression, constants);
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((entry) => literal(entry, constants));
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map((property) => {
    if (!ts.isPropertyAssignment(property)) throw new Error("decision schema must be a static property map");
    return [property.name.getText().replace(/["']/g, ""), literal(property.initializer, constants)];
  }));
  if (ts.isIdentifier(node) && constants.has(node.text)) return literal(constants.get(node.text)!, constants);
  throw new Error(`uncovered dynamic decision schema: ${node.getText()}`);
}

function decisions(path: string): Array<{ name: string; schema: unknown; path: string }> {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const constants = new Map<string, ts.Expression>();
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const found: Array<{ name: string; schema: unknown; path: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const name = field(node, "name"); const parameters = field(node, "parameters");
      if (name && ts.isStringLiteral(name) && parameters) found.push({ name: name.text, schema: literal(parameters, constants), path: relative(sourceRoot, path) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return found;
}

test("every evaluator and evolution decision schema is closed, fully required, and strict on the wire", () => {
  const tools = [...files(join(sourceRoot, "evals")), ...files(join(sourceRoot, "evolution"))].flatMap(decisions);
  expect(tools.map((tool) => tool.name).sort()).toEqual(["bws", "conflict"]);
  const cfg = defaultConfig();
  for (const tool of tools) {
    expect({ path: tool.path, compatible: isStrictCompatibleSchema(tool.schema) }).toEqual({ path: tool.path, compatible: true });
    const payload = { tools: [{ name: tool.name, input_schema: tool.schema }] };
    const shaped = shapeProviderPayload(payload, model, cfg) as { tools: Array<{ strict?: boolean }> };
    expect(shaped.tools[0]!.strict).toBe(true);
    expect(payload.tools[0]).not.toHaveProperty("strict");
    cfg.provider.strictDecisionTools = false;
    expect(shapeProviderPayload(payload, model, cfg)).toBeUndefined();
    cfg.provider.strictDecisionTools = true;
  }
});

test("a nullable optional output is required; missing closure or required membership is ineligible", () => {
  const schema = { type: "object", properties: { against: { type: ["string", "null"] } }, required: ["against"], additionalProperties: false };
  expect(isStrictCompatibleSchema(schema)).toBe(true);
  expect(isStrictCompatibleSchema({ ...schema, required: [] })).toBe(false);
  expect(isStrictCompatibleSchema({ ...schema, additionalProperties: true })).toBe(false);
  const optional = { type: "object", properties: { optional: { type: "string" } }, required: [], additionalProperties: false };
  for (const name of ["verdict", "audit", "critique", "playbook_delta"]) {
    expect(shapeProviderPayload({ tools: [{ name, input_schema: optional }] }, model, defaultConfig())).toBeUndefined();
  }
});
