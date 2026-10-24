import { at, type AaoI18nKey } from "./i18n.js";

/** Commands added by agent-ai-opencode. Merged into the upstream list in commands/definitions.ts. */
const AAO_COMMANDS: { command: string; descriptionKey: AaoI18nKey }[] = [
  { command: "memory", descriptionKey: "cmd.memory" },
  { command: "undo", descriptionKey: "cmd.undo" },
  { command: "skills_pending", descriptionKey: "cmd.skills_pending" },
];

export function getAaoCommandDefinitions(): { command: string; description: string }[] {
  return AAO_COMMANDS.map(({ command, descriptionKey }) => ({ command, description: at(descriptionKey) }));
}

export const AAO_COMMAND_NAMES = AAO_COMMANDS.map(({ command }) => command);
