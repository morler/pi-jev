/**
 * Keep the Agent Skills catalog out of every model request.
 *
 * Pi generates a <skills> (or legacy <available_skills>) block naming every enabled
 * skill; it grows linearly with the installed catalog and is resent on each request.
 * When stripped, the replacement note is the discovery path: without it the model
 * would not know skills exist, and jev_find_skill would never be called.
 */

const BLOCKS: Array<[open: string, close: string]> = [
  ["<skills>", "</skills>"],
  ["<available_skills>", "</available_skills>"],
];

/** The line that replaces the stripped catalog. Names both discovery paths. */
export function skillStripNote(skillCount: number): string {
  return (
    skillCount + " Agent Skills are installed; their catalog was removed to save context. " +
    "Call jev_find_skill with a task description to discover one."
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
