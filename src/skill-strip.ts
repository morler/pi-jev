/**
 * Keep the Agent Skills catalog out of every model request.
 *
 * Pi generates a <skills> (or legacy <available_skills>) block naming every enabled
 * skill; it grows linearly with the installed catalog and is resent on each request.
 * When stripped, the replacement note is the discovery path: without it the model
 * would not know skills exist, and jev_find_skill would never be called.
 *
 * Two pi generations carry the catalog differently:
 * - pi <= 0.85 ships it inside event.systemPrompt (strip the string).
 * - pi >= 0.87 assembles it AFTER the hook from event.systemPromptOptions via
 *   buildSystemPromptSections, so the string never contains it — clear
 *   options.skills in place instead (the runner hands the same object back).
 */

const BLOCKS: Array<[open: string, close: string]> = [
  ["<skills>", "</skills>"],
  ["<available_skills>", "</available_skills>"],
];

/** The line that replaces the stripped catalog. Names both discovery paths. */
export function skillStripNote(skillCount: number): string {
  return (
    skillCount + " Agent Skills are installed; their catalog was removed to save context. " +
    "Call jev_find_skill with a task description to discover one, or call jev_load_skill directly when you know the name."
  );
}

/**
 * Remove every catalog block (pi may emit built-in and global skills as separate
 * sections) and put the discovery note where the first block stood. Both tags must
 * start at a line boundary: real sections do, prose mentions of the tag usually do
 * not, so a literal "<skills>" inside a sentence or code sample never matches.
 */
export function stripSkillCatalog(systemPrompt: string, skillCount: number): string {
  let out = systemPrompt;
  let first = true;
  for (const [openTag, closeTag] of BLOCKS) {
    const pattern = new RegExp("^" + openTag + "[\\s\\S]*?^" + closeTag + "[ \\t]*$", "gm");
    for (;;) {
      // `out` was rewritten by the previous iteration: the g-flag cursor is stale.
      pattern.lastIndex = 0;
      const match = pattern.exec(out);
      if (!match) break;
      // Swallow trailing blank lines, then keep exactly one blank line around the
      // note so the surrounding prompt stays tidy.
      const before = out.slice(0, match.index).replace(/\n+$/, "");
      const after = out.slice(match.index + match[0].length);
      const note = first ? "\n\n" + skillStripNote(skillCount) : "";
      first = false;
      out = before + note + (after.startsWith("\n") ? "" : "\n") + after;
    }
  }
  return out;
}

/** Outcome of stripping one before_agent_start event. */
export interface SkillStripResult {
  /** Set when the catalog was removed from the systemPrompt string (pi <= 0.85 path). */
  systemPrompt?: string;
  /** True when systemPromptOptions.skills was cleared in place (pi >= 0.87 path). */
  clearedOptionsSkills: boolean;
  /** How many skills the event carried when it arrived. */
  skillCount: number;
}

/**
 * One entry point for both pi generations. The options mutation only fires when
 * the string path had nothing to strip, so a host that carries the catalog in
 * the string is never double-handled.
 */
export function stripSkillCatalogFromEvent(event: {
  systemPrompt: string;
  systemPromptOptions?: { skills?: unknown[]; sections?: Record<string, string> };
}): SkillStripResult {
  const count = event.systemPromptOptions?.skills?.length ?? 0;
  const stripped = stripSkillCatalog(event.systemPrompt, count);
  if (stripped !== event.systemPrompt) {
    return { systemPrompt: stripped, clearedOptionsSkills: false, skillCount: count };
  }
  const options = event.systemPromptOptions;
  if (count > 0 && options) {
    options.skills = [];
    // The note keeps the discovery path visible: without it the model would not
    // know skills exist and would never call jev_find_skill. Rendered as a
    // <jev_skills_note> section (pi validates: lowercase, digits, _ or -).
    // ponytail: some hosts re-render the prompt at request time and drop custom
    // sections — observed on this machine's full config, where sections,
    // appendSystemPrompt and promptGuidelines set in the hook never reached the
    // payload while skills=[] did. The catalog removal itself holds everywhere,
    // and tool descriptions ride in the tools array, which such hosts preserve.
    // If the note matters on such a host, deliver it via forceSystemPrompt
    // (the string path), which replaces the whole rendered prompt.
    options.sections = { ...options.sections, jev_skills_note: skillStripNote(count) };
    return { clearedOptionsSkills: true, skillCount: count };
  }
  return { clearedOptionsSkills: false, skillCount: count };
}
