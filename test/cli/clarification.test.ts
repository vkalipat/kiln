import { expect, test } from "bun:test";
import { clarificationFor } from "../../src/cli/clarification";

test("interactive clarification uses the UI seam while autonomous mode cannot ask", async () => {
  const questions: string[] = []; const io = { write: () => {}, ask: async (question: string) => { questions.push(question); return "the public dataset"; } };
  expect(await clarificationFor(io, {}, { interactive: true })!("Which dataset?")).toBe("the public dataset");
  expect(questions).toEqual(["Which dataset?\n> "]);
  expect(clarificationFor(io, {}, { interactive: false })).toBeUndefined();
});
