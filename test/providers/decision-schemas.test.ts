import { describe, expect, test } from "bun:test";
import { PROBE_REQUEST_SCHEMA } from "../../src/brain/tools/probe-request";
import { NOVELTY_SCHEMA } from "../../src/ideation/archive";
import { axisMapSchema } from "../../src/ideation/axes";
import { VERDICT_SCHEMA } from "../../src/ideation/judge";
import { PROBE_SPEC_SCHEMA } from "../../src/ideation/probe";
import { isStrictCompatibleSchema } from "../../src/providers/shaping";

describe("authored total decision schemas", () => {
  test.each([
    ["verdict", VERDICT_SCHEMA],
    ["novelty", NOVELTY_SCHEMA],
    ["axis_map", axisMapSchema(["solo", "teams", "enterprise"])],
    ["probe_request", PROBE_REQUEST_SCHEMA],
    ["probe_spec", PROBE_SPEC_SCHEMA],
  ] as const)("%s is recursively closed and strict-compatible", (_name, schema) => {
    expect(isStrictCompatibleSchema(schema)).toBe(true);
  });
});
