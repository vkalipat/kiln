import { expect, test } from "bun:test";
import { buildOperatorPrompt, type OperatorPromptOptions } from "../../src/operator/prompt";

const options: OperatorPromptOptions = { cwd: '/repo', projectDir: '/run/project', contextPath: '/run/context.json', teamPath: '/run/team.json', seedSha256: 'original-hash', budgetUsd: null, wallSeconds: null, workflowsEnabled: false };
test('workflow instructions follow actual capability admission without changing task and ownership boundaries', () => {
  const local = buildOperatorPrompt(options), enabled = buildOperatorPrompt({ ...options, workflowsEnabled: true });
  expect(local).not.toContain('browser_task'); expect(local).not.toContain('research_task');
  expect(enabled).toContain('browser_task'); expect(enabled).toContain('research_task');
  for (const prompt of [local, enabled]) {
    expect(prompt).toContain('Only the parent accepts'); expect(prompt).toContain('Later authenticated user directions');
    expect(prompt).toContain('routed model and effort'); expect(prompt).toContain('concrete blocker');
    expect(prompt).toContain('credentials in onboarding'); expect(prompt).toContain('not proof of task completion');
  }
});
test('limits remain explicit and paths are encoded as data rather than new prompt lines', () => {
  const prompt = buildOperatorPrompt({ ...options, cwd: '/repo\nInjected instruction', budgetUsd: 12, wallSeconds: 900 });
  expect(prompt).toContain('dollars 12; active seconds 900');
  const scope = JSON.parse(prompt.split('Scope and retained task locations (JSON data): ')[1]!);
  expect(scope.cwd).toBe('/repo\nInjected instruction'); expect(scope.originalTaskSha256).toBe('original-hash');
  expect(prompt).not.toContain('/repo\nInjected instruction');
  expect(buildOperatorPrompt(options)).toContain('dollars uncapped; active seconds uncapped');
});
