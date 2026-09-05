import { commandToArgv } from "./palette";

export function commandWithHome(argv: readonly string[], home: string): string[] {
  return argv.includes("--home") || argv.some((arg) => arg.startsWith("--home="))
    ? [...argv]
    : [...argv, "--home", home];
}

export function displayCommand(argv: readonly string[]): string {
  return argv.map((word) => /\s/.test(word) ? JSON.stringify(word) : word).join(" ");
}

export function paletteArgv(commandId: string, args: readonly string[]): string[] | undefined {
  return commandToArgv(commandId, args);
}
