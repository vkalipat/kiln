import type { ExtensionContext, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import type { ToolContext } from "../brain/tools";
import type { createJevWorkflowService } from "./jev-service";
import { buildBrowserDecisionQuestions, decodeBrowserDecision, type BrowserDecisionPayload, type BrowserTaskInput, type BrowserWorkflowResult } from "./browser-workflow";
import { runResearchTask, type ResearchTaskInput, type ResearchReceipt } from "./research-task";
import { createResearchClassifier } from "./research-classify";

type Extension = Parameters<ExtensionFactory>[0];
export interface OperatorWorkflowToolOptions {
  enabled: boolean;
  jev: ReturnType<typeof createJevWorkflowService>;
  signal: () => AbortSignal;
  assertOriginal: () => void;
  admit: () => () => void;
  toolContext: ToolContext;
  artifactDir: string;
  browser: (input: BrowserTaskInput, execution: { ctx: ExtensionContext; signal: AbortSignal; toolCallId: string; decideToolName: string }) => Promise<BrowserWorkflowResult>;
  onStatus: (activity: string) => void;
  onReceipt: (kind: "browser" | "research", receipt: BrowserWorkflowResult | ResearchReceipt, ctx: ExtensionContext) => Promise<{ path: string; sha256: string }>;
}

/** Domain tools own execution; the internal Jev tool only chooses from supplied observed IDs. */
export function registerOperatorWorkflowTools(extension: Extension, options: OperatorWorkflowToolOptions) {
  if (!options.enabled) return;
  const z = extension.zod;
  const nativeLease = z.object({ token: z.string().min(1).max(128), tab: z.string().min(1).max(80),
    ownerSessionId: z.string().min(1).max(256), targetId: z.string().min(1).max(256) });
  const leaseValid = async (lease: unknown, ctx: ExtensionContext) => {
    const parsed = nativeLease.parse(lease);
    return (await import("./browser-native")).validateNativeBrowserLease(parsed, ctx.sessionManager.getSessionId());
  };
  extension.registerTool({ name: "kiln_browser_guard", label: "Check browser ownership",
    description: "Internal browser workflow lease check. Confirms that the original owned native tab still exists before observing it; grants no new capability.",
    parameters: z.object({ nativeLease }),
    async execute(_id, raw, toolSignal, _update, ctx) {
      options.assertOriginal();
      const signal = AbortSignal.any([options.signal(), ...(toolSignal ? [toolSignal] : [])]);
      const valid = !signal.aborted && await leaseValid((raw as { nativeLease: unknown }).nativeLease, ctx);
      const result = { valid: valid && !signal.aborted };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    } });
  const browserCheck = z.union([
    z.object({ kind: z.enum(["url_equals", "text_includes"]), value: z.string().min(1).max(1000) }),
    z.object({ kind: z.literal("field_equals"), label: z.string().min(1).max(200), value: z.string().min(1).max(1000) }),
  ]);
  const browserTask = z.object({ tab: z.string().min(1).max(80), task: z.string().min(1).max(4000),
    checks: z.array(browserCheck).min(1).max(8),
    allowedActions: z.array(z.object({ kind: z.enum(["click", "fill", "select", "scroll", "wait"]), label: z.string().min(1).max(200).optional() })).max(32),
    values: z.record(z.string(), z.string().min(1).max(2000)).optional(), maxDecisions: z.number().int().min(1).max(8).optional(),
    timeoutMs: z.number().int().min(100).max(30000).optional() });
  const decisionPayload = z.object({ nativeLease: nativeLease.optional(), task: z.string().min(1).max(4000), stateHash: z.string().min(1).max(32000), step: z.number().int().min(0).max(7),
    state: z.object({ url: z.string().max(2048), title: z.string().max(2000), text: z.string().max(16000),
      actions: z.array(z.object({ id: z.string().max(64), kind: z.enum(["click", "fill", "select", "scroll", "wait"]), label: z.string().max(2000),
        node: z.number().int().optional(), value: z.string().max(2000).optional(), delta: z.number().optional(), role: z.string().max(100).optional() })).max(250) }) });

  extension.registerTool({ name: "kiln_browser_decide", label: "Choose browser action",
    description: "Internal bounded browser decision service. Browser workflows supply a fresh observed action table; this tool returns choices only and never executes, verifies or authorizes an action.",
    parameters: decisionPayload,
    async execute(_id, raw, toolSignal, _update, ctx) {
      options.assertOriginal();
      const payload = decisionPayload.parse(raw) as BrowserDecisionPayload;
      const signal = AbortSignal.any([options.signal(), ...(toolSignal ? [toolSignal] : [])]);
      signal.throwIfAborted();
      if (payload.nativeLease && !await leaseValid(payload.nativeLease, ctx)) {
        const decision = { accepted: false, stateHash: payload.stateHash, reason: "Native browser ownership changed" };
        return { content: [{ type: "text", text: JSON.stringify(decision) }], details: decision };
      }
      signal.throwIfAborted();
      options.onStatus(`Choosing browser action ${payload.step + 1}`);
      const batch = buildBrowserDecisionQuestions(payload);
      const result = await options.jev.evaluate({ operation: "browser", sessionId: ctx.sessionManager.getSessionId(), ...batch, signal });
      const decision = decodeBrowserDecision(payload, result);
      return { content: [{ type: "text", text: JSON.stringify(decision) }], details: decision };
    } });

  extension.registerTool({ name: "browser_task", label: "Run browser task",
    description: "Execute a bounded task on an existing native browser tab owned by this session. Call directly, outside eval. Supply exact permitted click/fill/select labels and literal field values. Fresh outcome checks validate only the supplied assertions; the parent must assess full task coverage. Unsupported or ambiguous actions return control without replay.",
    parameters: browserTask,
    async execute(id, raw, toolSignal, _update, ctx) {
      options.assertOriginal();
      const input = browserTask.parse(raw) as BrowserTaskInput;
      const signal = AbortSignal.any([options.signal(), ...(toolSignal ? [toolSignal] : [])]);
      signal.throwIfAborted();
      const release = options.admit();
      try {
        options.onStatus("Running browser task");
        const receipt = await options.browser(input, { ctx, signal, toolCallId: id, decideToolName: "kiln_browser_decide" });
        const artifact = await options.onReceipt("browser", receipt, ctx);
        options.onStatus("Reviewing browser result");
        const result = { ...receipt, artifact };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } finally { release(); }
    } });

  const researchTask = z.object({ question: z.string().min(1).max(4096),
    requiredFields: z.array(z.object({ id: z.string().min(1).max(64), question: z.string().min(1).max(1024) })).min(1).max(12),
    sources: z.array(z.string().max(2048)).max(12), allowedHosts: z.array(z.string().min(1).max(253)).min(1).max(16),
    searchQueries: z.array(z.string().min(1).max(1024)).max(3).optional(), maxSources: z.number().int().min(1).max(12).optional(),
    concurrency: z.number().int().min(1).max(4).optional(), timeoutMs: z.number().int().min(1).max(120000).optional(),
    maxCaptureChars: z.number().int().min(1).max(12000).optional(), maxInlineChars: z.number().int().min(1).max(6000).optional() });
  extension.registerTool({ name: "research_task", label: "Collect cited evidence",
    description: "Collect bounded evidence from explicit HTTPS source hosts using search/fetch and optional Jev passage labels. Returns immutable captured artifacts, evidence locations, contradictions, unknowns and costs. Labels and captured citations do not verify source truth. The parent handles synthesis. Dynamic pages that cannot be fetched remain an explicit gap; use browser_task separately when needed.",
    parameters: researchTask,
    async execute(_id, raw, toolSignal, _update, ctx) {
      options.assertOriginal();
      const input = researchTask.parse(raw) as ResearchTaskInput;
      const signal = AbortSignal.any([options.signal(), ...(toolSignal ? [toolSignal] : [])]);
      signal.throwIfAborted();
      const release = options.admit();
      try {
        options.onStatus("Collecting cited evidence");
        const receipt = await runResearchTask(input, { artifactDir: options.artifactDir, toolContext: options.toolContext, signal,
          classify: createResearchClassifier(options.jev, ctx.sessionManager.getSessionId()) });
        const artifact = await options.onReceipt("research", receipt, ctx);
        options.onStatus("Reviewing research evidence");
        const result = { ...receipt, artifact };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } finally { release(); }
    } });
}
