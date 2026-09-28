import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import type { OperatorTeamStore, TeamArtifact, TeamDocument, TeamFeaturePlan, TeamCriterionEvidence } from "./team";

/** Register in the existing native extension; identity is supplied by the host session. */
export function registerOperatorTeamTools(extension: Parameters<ExtensionFactory>[0], options: {
  store: OperatorTeamStore;
  parentSessionId: () => string | undefined;
  assertOriginal: () => void;
  onChange?: (document: TeamDocument) => void;
}): void {
  const z = extension.zod;
  const artifact = z.object({ path: z.string(), sha256: z.string() });
  extension.registerTool({ name: "team", label: "Feature team", description: "Coordinate scoped feature ownership using native task workers. Parent plans and independently accepts evidence. Scopes are literal relative file or directory paths; glob patterns are rejected. Claim before editing; handoffs remain unverified claims until parent review. Query is a historical ledger, not a fresh verification certificate. Use review_packet with a feature id to read all stable criterion IDs and current evidence identity; handoff coverage can map each criterionId to exact artifacts and zero-based checkIndices. Check text remains an unverified worker claim; a packet never proves completeness or replaces parent checks. Only workers claim features; the parent reviews. Acceptance records parent assessment, not machine proof that checks ran. Parent may reopen failed or abandoned work with a reason. This advisory ledger does not enforce filesystem isolation, launch workers, or change original requirements.",
    parameters: z.object({ action: z.enum(["query", "plan", "claim", "handoff", "accept", "reopen", "review_packet"]), expectedRevision: z.number().int().nonnegative().optional(),
      id: z.string().optional(), plans: z.array(z.object({ id: z.string(), objective: z.string(), scopes: z.array(z.string()), dependencies: z.array(z.string()), acceptance: z.array(z.string()) })).optional(),
      coverage: z.array(z.object({ criterionId: z.string(), artifacts: z.array(artifact).max(64), checkIndices: z.array(z.number().int().nonnegative()).max(64) })).max(64).optional(),
      summary: z.string().optional(), checks: z.array(z.string()).optional(), artifacts: z.array(artifact).optional(), criteria: z.array(z.string()).optional() }),
    async execute(_id, raw, _signal, _update, ctx) {
      options.assertOriginal();
      const args = raw as { action: "query" | "plan" | "claim" | "handoff" | "accept" | "reopen" | "review_packet"; expectedRevision?: number; id?: string; plans?: TeamFeaturePlan[]; summary?: string; checks?: string[]; artifacts?: TeamArtifact[]; criteria?: string[]; coverage?: TeamCriterionEvidence[] };
      const actor = ctx.sessionManager.getSessionId();
      if ((args.action === "plan" || args.action === "accept" || args.action === "reopen") && (!options.parentSessionId() || actor !== options.parentSessionId())) throw new Error("Only the parent operator session may plan or accept features");
      if (args.action === "review_packet") {
        if (!args.id) throw new Error("Feature id required");
        const packet = options.store.reviewPacket(args.id);
        return { content: [{ type: "text", text: JSON.stringify(packet) }], details: { path: options.store.path, revision: packet.revision } };
      }
      let result: TeamDocument;
      if (args.action === "query") result = options.store.query();
      else {
        if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision! < 0) throw new Error("A current expectedRevision is required");
        const rev = args.expectedRevision!;
        if (args.action === "plan") result = await options.store.plan(args.plans ?? [], rev);
        else {
          if (!args.id) throw new Error("Feature id required");
          if (args.action === "claim") {
            if (!options.parentSessionId() || actor === options.parentSessionId()) throw new Error("Only native worker sessions may claim features after the parent starts");
            result = await options.store.claim(args.id, actor, rev);
          }
          else if (args.action === "reopen") result = await options.store.reopen(args.id, actor, args.summary ?? "", rev);
          else if (args.action === "handoff") result = await options.store.handoff(args.id, actor, { summary: args.summary ?? "", checks: args.checks ?? [], artifacts: args.artifacts ?? [], ...(args.coverage !== undefined ? { coverage: args.coverage } : {}) }, rev);
          else result = await options.store.accept(args.id, actor, args.criteria ?? [], args.artifacts ?? [], rev);
        }
        options.onChange?.(result);
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { path: options.store.path, revision: result.revision } };
    },
  });
}
