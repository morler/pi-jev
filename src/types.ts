// Jev judgment types (questions, requests, answers) come from pi-jev-core.
export * from "pi-jev-core";

/** Tools this extension surfaces (jev_evaluate itself is registered by pi-jev-core).
 *  Never offered as router candidates and toggled together. */
export const JEV_TOOL_NAMES = ["jev_find_tools", "jev_find_skill", "jev_load_skill", "jev_evaluate", "jev_compact_now", "jev_search_gate"] as const;

export function isJevTool(name: string): boolean {
  return (JEV_TOOL_NAMES as readonly string[]).includes(name);
}
