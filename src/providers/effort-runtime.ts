import type { Model } from "@oh-my-pi/pi-catalog";
import type { KilnConfig, Role } from "../core/config";

type Resolver = (role: Role, model: Model) => string | undefined;
const resolvers = new WeakMap<KilnConfig, Resolver>();

/** Runtime-only policy: credentials and measured effort never become config serialization. */
export function registerRuntimeEffort(cfg: KilnConfig, resolver?: Resolver): void {
  if (resolver) resolvers.set(cfg, resolver); else resolvers.delete(cfg);
}

export function runtimeEffort(cfg: KilnConfig, role: Role, model: Model): string | undefined {
  return resolvers.get(cfg)?.(role, model);
}
