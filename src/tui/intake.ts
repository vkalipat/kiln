/** Deliberately exact: a greeting followed by a task must still start that task. */
export function localIntakeReply(text: string): string | undefined {
  const value = text.trim().toLowerCase().replace(/[.!?]+$/, "").trim().replace(/\s+/g, " ");
  if (/^(hi|hello|hey)( there| kiln)?$/.test(value)) {
    return "Hi! Describe what you want to build, research, or explore, and I’ll help you get started.";
  }
  if (["help", "what can you do", "how do i use kiln", "how do i get started"].includes(value)) {
    return "Describe a task to start a run—for example, ‘Build a timer app’ or ‘Explore ways to reduce food waste.’ Use the command palette for settings, authentication, and existing runs.";
  }
  return undefined;
}
