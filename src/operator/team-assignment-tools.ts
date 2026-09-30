import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import type { OperatorTeamStore } from "./team";
import { TeamAssignmentStore, teamAssignmentFeatureHash, validateTeamAssignment, type TeamAssignmentInput, type TeamAssignmentProducer } from "./team-assignments";
import type { createJevWorkflowService } from "./jev-service";
import { redactText } from "../core/secrets";
import { createHash } from "node:crypto";
import type { ResourceModel, ResourceRoute, ResourceRouteInput } from "./resource-routing";

/** The frontier operator defines responsibilities; Jev chooses only among its compatible shortlist. */
export function registerTeamAssignmentTools(extension: Parameters<ExtensionFactory>[0], options: {
  team: OperatorTeamStore;
  assignments: TeamAssignmentStore;
  admitted: Array<{ modelRef: string; effort: string }>;
  resourceCatalog?: readonly ResourceModel[];
  selectResources?: (input: ResourceRouteInput) => Promise<ResourceRoute>;
  resourcePolicy?: () => { effortPolicy: string; fixedEffort: string };
  resolveProducer?: (featureId: string) => TeamAssignmentProducer;
  catalog?: () => unknown;
  parentSessionId: () => string | undefined;
  jev: ReturnType<typeof createJevWorkflowService>;
  signal: () => AbortSignal;
  assertOriginal: () => void;
  record: (assignment: unknown) => void;
}): void {
  const z = extension.zod;
  extension.registerTool({ name: "team_assign", label: "Assign task-specific responsibility",
    description: options.selectResources
      ? "After team plan, supply task-specific role alternatives (roles: id/description) or one role description and qualityDemand. Jev chooses the responsibility and model/effort from the compatible catalog using task fit, reviewed evidence and compute cost. Do not preselect a model shortlist. exactModelRef and exactEffort are only for explicit user pins. For independent review, pass reviewOfFeatureId to exclude its producer model. Use the saved dispatchName as native task.name, agent=task, with its objective, owned paths and acceptance criteria. Only the parent assigns. Simple work needs no team. catalog exposes capabilities/evidence; query returns decisions."
      : "Compose a team only when independent work helps. catalog lists compatible run-admitted models. After team plan, assign a feature a task-specific role and quality-qualified model shortlist; preferredModelRef is your choice if Jev is unavailable. candidates reasons must explain task fit, quality requirements and throughput tradeoffs, not invented benchmarks. exactModelRef preserves a user's explicit model choice and bypasses Jev. The saved assignment controls actual native task dispatch: use its dispatchName as task.name, agent=task, and include the feature objective, scope and acceptance criteria in the task. Do not change effort unless the user requests it. Query returns saved decisions. Only the parent assigns and dispatches assigned features. Shared reading is allowed; feature scopes describe owned outputs/edits. Simple tasks need no team.",
    parameters: z.object({ action: z.enum(["catalog", "assign", "query"]), featureId: z.string().optional(), role: z.string().optional(),
      candidates: z.array(z.object({ modelRef: z.string(), reason: z.string() })).max(8).optional(),
      preferredModelRef: z.string().optional(), exactModelRef: z.string().optional(),
      roles: z.array(z.object({ id: z.string(), description: z.string() })).min(1).max(8).optional(),
      qualityDemand: z.enum(["simple", "standard", "complex"]).optional(),
      category: z.enum(["general_reasoning", "expert_knowledge", "business", "scientific_coding", "tool_execution", "knowledge_calibration"]).optional(),
      requiredContextTokens: z.number().int().nonnegative().optional(), reviewOfFeatureId: z.string().optional(),
      exactEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional() }),
    async execute(_id, raw, signal, _update, ctx) {
      options.assertOriginal(); options.signal().throwIfAborted(); signal?.throwIfAborted();
      const args = raw as TeamAssignmentInput & { action: "catalog" | "assign" | "query"; roles?: ResourceRouteInput["roles"];
        qualityDemand?: ResourceRouteInput["qualityDemand"]; category?: string; requiredContextTokens?: number; reviewOfFeatureId?: string };
      if (args.action === "catalog") return { content: [{ type: "text", text: JSON.stringify(options.resourceCatalog
        ? { policy: "jev", models: options.resourceCatalog } : options.catalog?.() ?? options.admitted) }] };
      if (args.action === "query") return { content: [{ type: "text", text: JSON.stringify(options.assignments.load()) }] };
      const parent = options.parentSessionId();
      if (!parent || ctx.sessionManager.getSessionId() !== parent) throw new Error("Only the parent operator may assign task-specific roles");
      const feature = options.team.query().features.find(item => item.id === args.featureId);
      if (!feature || feature.status !== "planned") throw new Error("Assign a planned team feature before dispatch");
      if (options.selectResources && options.resourceCatalog) {
        const roles = args.roles ?? [{ id: "responsibility", description: args.role || feature.objective }];
        const producer = args.reviewOfFeatureId ? options.resolveProducer?.(args.reviewOfFeatureId) : undefined;
        if (args.reviewOfFeatureId && !producer) throw new Error("Independent review requires an actual producer dispatch");
        const request: ResourceRouteInput = { task: `${feature.objective}\nAcceptance:\n${feature.acceptance.join("\n")}`.slice(0, 16000),
          sessionId: parent, roles, qualityDemand: args.qualityDemand, category: args.category,
          requiredContextTokens: args.requiredContextTokens, producerRef: producer?.modelRef,
          exactModelRef: args.exactModelRef, exactEffort: args.exactEffort as ResourceRouteInput["exactEffort"] };
        const routingRequestHash = createHash("sha256").update(JSON.stringify({ request, producer, policy: options.resourcePolicy?.() })).digest("hex");
        const previous = options.assignments.load().find(item => item.featureHash === teamAssignmentFeatureHash(feature) && item.routingRequestHash === routingRequestHash);
        if (previous) return { content: [{ type: "text", text: JSON.stringify(previous) }] };
        const selection = await options.selectResources({ ...request, signal });
        options.signal().throwIfAborted(); signal?.throwIfAborted();
        const current = options.team.query().features.find(item => item.id === feature.id);
        if (!current || current.status !== "planned" || teamAssignmentFeatureHash(current) !== teamAssignmentFeatureHash(feature)) throw new Error("Team feature changed during assignment; inspect it before retrying");
        if (producer && JSON.stringify(options.resolveProducer?.(producer.featureId)) !== JSON.stringify(producer)) throw new Error("Review producer changed during assignment; select the reviewer again");
        const input: TeamAssignmentInput = { featureId: feature.id,
          role: roles.find(role => role.id === selection.role)!.description.slice(0, 160),
          candidates: options.resourceCatalog.map(model => ({ modelRef: model.modelRef, reason: "Compatible catalog model; task evidence and compute assessed by Jev" })),
          preferredModelRef: selection.modelRef, routingRequestHash,
          ...(producer ? { reviewOf: producer } : {}),
          ...(args.exactModelRef ? { exactModelRef: args.exactModelRef } : {}), ...(args.exactEffort ? { exactEffort: args.exactEffort } : {}) };
        const assignment = options.assignments.put(input, current, selection);
        options.record(assignment);
        return { content: [{ type: "text", text: JSON.stringify(assignment) }] };
      }
      const input: TeamAssignmentInput = { featureId: args.featureId, role: args.role, candidates: args.candidates,
        preferredModelRef: args.preferredModelRef, ...(args.exactModelRef !== undefined ? { exactModelRef: args.exactModelRef } : {}) };
      validateTeamAssignment(input, feature, options.admitted);
      const previous = options.assignments.load().find(item => item.featureId === feature.id && item.featureHash === teamAssignmentFeatureHash(feature)
        && item.effort === options.admitted.find(model => model.modelRef === item.modelRef)?.effort
        && item.role === input.role && item.preferredModelRef === input.preferredModelRef && item.exactModelRef === input.exactModelRef
        && JSON.stringify(item.candidates) === JSON.stringify(input.candidates));
      if (previous) return { content: [{ type: "text", text: JSON.stringify(previous) }] };
      let modelRef = input.exactModelRef ?? input.preferredModelRef;
      let source: "jev" | "frontier" = "frontier", reason = input.exactModelRef ? "Explicit model preserved" : "Frontier operator selection";
      if (!input.exactModelRef && input.candidates.length > 1) {
        const decision = await options.jev.evaluate({ operation: "team", sessionId: parent,
          state: { role: redactText(input.role), objective: redactText(feature.objective).slice(0, 6000),
            acceptance: feature.acceptance.map(text => redactText(text).slice(0, 1000)),
            dependencies: feature.dependencies, policy: "All candidates satisfy the frontier operator's quality requirements. Prefer task fit and quality, then throughput. Do not invent performance evidence." },
          questions: { model: { instructions: "Choose the best task-specific model from the quality-qualified shortlist. Compatibility and explicit user constraints are already enforced. Optimize quality first, then useful throughput.",
            criteria: Object.fromEntries(input.candidates.map((candidate, index) => [`model_${index}`, `${candidate.modelRef}: ${redactText(candidate.reason)}`])) } },
          signal: signal ? AbortSignal.any([options.signal(), signal]) : options.signal() });
        options.signal().throwIfAborted(); signal?.throwIfAborted();
        const answer = decision.answers?.model;
        if (decision.source === "jev" && answer?.accepted && /^model_\d+$/.test(answer.choice)) {
          const candidate = input.candidates[Number(answer.choice.slice(6))];
          if (candidate) { modelRef = candidate.modelRef; source = "jev"; reason = `Jev accepted task-specific shortlist choice (${decision.reason})`; }
        } else reason = `Frontier operator selection preserved: ${decision.reason}`;
      }
      const current = options.team.query().features.find(item => item.id === feature.id);
      if (!current || current.status !== "planned" || teamAssignmentFeatureHash(current) !== teamAssignmentFeatureHash(feature)) throw new Error("Team feature changed during assignment; inspect it before retrying");
      const assignment = options.assignments.put(input, current, { modelRef, source, reason });
      options.record(assignment);
      return { content: [{ type: "text", text: JSON.stringify(assignment) }] };
    },
  });
}
