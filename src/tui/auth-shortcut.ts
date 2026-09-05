export type AuthShortcut =
  | { readonly kind: "onboarding" }
  | { readonly kind: "command"; readonly id: string; readonly args: readonly string[] }
  | { readonly kind: "error"; readonly message: string };

/** Small OMP-style slash surface kept separate from run seeds and steering. */
export function authShortcut(text: string): AuthShortcut | undefined {
  const words = text.trim().split(/\s+/);
  const command = words[0]?.toLowerCase();
  if (command === "/auth") return { kind: "command", id: "auth: status", args: [] };
  if (command === "/logout") return { kind: "command", id: "auth: logout", args: [words[1] ?? "all"] };
  if (command !== "/login") return undefined;
  if (!words[1]) return { kind: "onboarding" };
  const provider = words[1]!.toLowerCase();
  const id = provider === "anthropic" || provider === "claude"
    ? "auth: login anthropic"
    : provider === "openai" || provider === "chatgpt"
      ? "auth: login openai"
      : undefined;
  if (!id) return { kind: "error", message: `Unknown provider: ${words[1]}` };
  const method = words[2]?.toLowerCase();
  if (!method) return { kind: "command", id, args: [] };
  if (method === "key" || method === "api-key") return { kind: "command", id, args: ["--method", "api-key"] };
  if (method === "device" && id.endsWith("openai")) return { kind: "command", id, args: ["--device"] };
  return { kind: "error", message: `Unknown login method: ${words[2]}` };
}
