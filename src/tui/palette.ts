import { SelectList, fuzzyFilter, type Component, type SelectItem } from "@oh-my-pi/pi-tui";
import { RoundedOverlay } from "./overlay";
import { selectListTheme } from "./theme";

export interface PaletteCommand {
  /** Stable command identifier, displayed as the Amp-style `noun: verb` name. */
  id: string;
  label: string;
  description: string;
  /** CLI words before any values collected by the caller. */
  argv: readonly string[];
}

export const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  { id: "task: new", label: "task: new", description: "Start a fresh native operator conversation", argv: ["task", "new"] },
  { id: "task: monitor", label: "task: monitor", description: "Inspect native compute and repetition receipts", argv: ["task", "monitor"] },
  { id: "task: limits", label: "task: limits", description: "Inspect or set limits for new native sessions", argv: ["task", "limits"] },
  { id: "integrations: status", label: "integrations: status", description: "Inspect integration readiness", argv: ["doctor", "--json"] },
  { id: "integrations: jev enable", label: "integrations: jev enable", description: "Enable configured Jev for new sessions", argv: ["integrations", "jev", "enable"] },
  { id: "integrations: jev disable", label: "integrations: jev disable", description: "Disable Jev for new sessions", argv: ["integrations", "jev", "disable"] },
  { id: "mode: auto", label: "mode: auto", description: "Restore adaptive reasoning effort", argv: ["mode", "set", "auto"] },
  { id: "run: new", label: "run: new", description: "Start the explicit legacy phase pipeline", argv: ["run", "new"] },
  { id: "run: resume", label: "run: resume", description: "Resume a saved run", argv: ["run", "resume"] },
  { id: "run: show record", label: "run: show record", description: "Show a run record", argv: ["run", "record"] },
  { id: "ideas: frontier", label: "ideas: frontier", description: "Inspect the idea frontier", argv: ["ideas", "frontier"] },
  { id: "ideas: pick", label: "ideas: pick", description: "Choose an idea", argv: ["ideas", "pick"] },
  { id: "ideas: another round", label: "ideas: another round", description: "Continue ideation with steering", argv: ["ideas", "another"] },
  { id: "project: form", label: "project: form", description: "Form the chosen idea", argv: ["project", "form"] },
  { id: "build: start", label: "build: start", description: "Start the build loop", argv: ["build", "start"] },
  { id: "build: pause", label: "build: pause", description: "Pause the build loop", argv: ["build", "pause"] },
  { id: "evolve: eval", label: "evolve: eval", description: "Evaluate a candidate", argv: ["evolve", "eval"] },
  { id: "evolve: promote", label: "evolve: promote", description: "Promote a candidate", argv: ["evolve", "promote"] },
  { id: "evolve: rollback", label: "evolve: rollback", description: "Roll back a promotion", argv: ["evolve", "rollback"] },
  { id: "evals: calibrate", label: "evals: calibrate", description: "Calibrate evaluator thresholds", argv: ["evals", "calibrate"] },
  { id: "auth: login anthropic", label: "auth: login anthropic", description: "Connect Anthropic", argv: ["auth", "login", "anthropic"] },
  { id: "auth: login openai", label: "auth: login openai", description: "Connect OpenAI", argv: ["auth", "login", "openai"] },
  { id: "auth: status", label: "auth: status", description: "Show connected providers", argv: ["auth", "status"] },
  { id: "auth: logout", label: "auth: logout", description: "Disconnect a provider", argv: ["auth", "logout"] },
  { id: "model: roles", label: "model: roles", description: "Show model role routing", argv: ["model", "roles"] },
  { id: "model: adaptive", label: "model: adaptive", description: "Adapt models and budget allocation for new runs", argv: ["model", "routing", "adaptive"] },
  { id: "model: manual", label: "model: manual", description: "Use configured model lists for new runs", argv: ["model", "routing", "manual"] },
  { id: "model: preview", label: "model: preview", description: "Preview routing for the prompt draft without model calls", argv: ["model", "plan"] },
  { id: "mode: toggle", label: "mode: toggle", description: "Cycle the effort mode", argv: ["mode", "toggle"] },
] as const;

const BY_ID = new Map(PALETTE_COMMANDS.map((command) => [command.id, command]));

export function paletteCommandArgv(command: Pick<PaletteCommand, "argv">, args: readonly string[] = []): string[] {
  return [...command.argv, ...args];
}

export function commandToArgv(commandId: string, args: readonly string[] = []): string[] | undefined {
  const command = BY_ID.get(commandId);
  return command ? paletteCommandArgv(command, args) : undefined;
}

export function filterPaletteCommands(query: string, commands: readonly PaletteCommand[] = PALETTE_COMMANDS): PaletteCommand[] {
  if (!query.trim()) return [...commands];
  return fuzzyFilter([...commands], query, (command) => `${command.label} ${command.description} ${command.argv.join(" ")}`);
}

export interface CommandPaletteOptions {
  commands?: readonly PaletteCommand[];
  maxVisible?: number;
  onSelect?: (command: PaletteCommand) => void;
  onCancel?: () => void;
}

export class CommandPalette implements Component {
  readonly commands: readonly PaletteCommand[];
  readonly list: SelectList;
  readonly overlay: RoundedOverlay;
  onSelect?: (command: PaletteCommand) => void;
  onCancel?: () => void;

  constructor(options: CommandPaletteOptions = {}) {
    this.commands = options.commands ?? PALETTE_COMMANDS;
    this.onSelect = options.onSelect;
    this.onCancel = options.onCancel;
    const items: SelectItem[] = this.commands.map((command) => ({
      value: command.id,
      label: command.label,
      description: command.description,
    }));
    this.list = new SelectList(items, options.maxVisible ?? 10, selectListTheme, {
      minPrimaryColumnWidth: 18,
      maxPrimaryColumnWidth: 28,
      overflowSearch: true,
    });
    this.list.onSelect = (item) => {
      const command = this.commands.find((candidate) => candidate.id === item.value);
      if (command) this.onSelect?.(command);
    };
    this.list.onCancel = () => this.onCancel?.();
    this.overlay = new RoundedOverlay(this.list, {
      title: "Command Palette",
      footer: "type to filter · Enter run · Esc close",
    });
  }

  setFilter(query: string): void {
    this.list.setFilter(query);
  }

  getSelectedCommand(): PaletteCommand | undefined {
    const id = this.list.getSelectedItem()?.value;
    return id ? this.commands.find((command) => command.id === id) : undefined;
  }

  render(width: number): readonly string[] {
    return this.overlay.render(width);
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  debugState(): Record<string, unknown> {
    return { ...this.list.debugState(), selectedCommand: this.getSelectedCommand()?.id ?? null };
  }
}
