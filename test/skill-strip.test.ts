import test from "node:test";
import assert from "node:assert/strict";
import { skillStripNote, stripSkillCatalog } from "../src/skill-strip.js";

const MODERN = [
  "You are a coding agent.",
  "",
  "<skills>",
  "  <skill><name>fleet</name><description>Fast git fleet ops</description></skill>",
  "</skills>",
  "",
  "Follow the user's instructions.",
].join("\n");

const LEGACY = [
  "You are a coding agent.",
  "",
  "<available_skills>",
  "  <skill><name>fleet</name></skill>",
  "</available_skills>",
  "",
  "Follow the user's instructions.",
].join("\n");

test("strips the modern catalog and appends the discovery note with the skill count", () => {
  const out = stripSkillCatalog(MODERN, 27);
  assert.ok(!out.includes("<skills>"), "catalog block must be gone");
  assert.ok(!out.includes("fleet"), "skill entries must be gone");
  assert.ok(out.includes(skillStripNote(27)));
  assert.ok(out.includes("jev_find_skill"), "note must name the discovery tool");
  assert.ok(out.includes("jev_load_skill"), "note must name the direct-path tool");
  assert.ok(out.startsWith("You are a coding agent."), "prompt before the block must survive");
  assert.ok(out.trimEnd().endsWith("Follow the user's instructions."), "prompt after the block must survive");
});

test("strips the legacy available_skills block the same way", () => {
  const out = stripSkillCatalog(LEGACY, 3);
  assert.ok(!out.includes("<available_skills>"));
  assert.ok(out.includes(skillStripNote(3)));
});

test("strips every catalog block when both formats appear in one prompt", () => {
  const both = "Top.\n\n<skills>\n<skill><name>a</name></skill>\n</skills>\nmid\n<available_skills>\n<skill><name>b</name></skill>\n</available_skills>\nBottom.";
  const out = stripSkillCatalog(both, 9);
  assert.ok(!out.includes("<skills") && !out.includes("available_skills"), "both blocks must be gone");
  assert.ok(!out.includes(">a<") && !out.includes(">b<"), "no entries may leak");
  assert.equal(out.split(skillStripNote(9)).length - 1, 1, "note appears exactly once");
  assert.ok(out.includes("Top.") && out.includes("Bottom."));
});

test("prose mentions of the tag mid-line are never stripped", () => {
  const prose = "Header.\nSee the <skills> tag docs for details; </skills> closes it.\nFooter with <available_skills> mention.";
  const out = stripSkillCatalog(prose, 4);
  assert.equal(out, prose, "a mid-line mention is not a catalog block");
});

test("a full line-anchored example block in prose is still stripped", () => {
  const example = "Header.\n<skills>\nexample entry\n</skills>\nFooter.";
  const out = stripSkillCatalog(example, 2);
  assert.ok(!out.includes("example entry"));
  assert.ok(out.includes(skillStripNote(2)));
});

test("strips both blocks when the same tag appears twice", () => {
  // The first block must outgrow the note (~200 chars) so the stale g-flag lastIndex
  // would land past the second block's opening tag in the rewritten string.
  const filler = "x".repeat(300);
  const twice = "Top.\n<skills>\n" + filler + "\n</skills>\nmiddle\n<skills>\nblock two entry\n</skills>\nBottom.";
  const out = stripSkillCatalog(twice, 5);
  assert.ok(!out.includes("block one entry") && !out.includes("block two entry"), "both same-tag blocks must go");
  assert.equal(out.split(skillStripNote(5)).length - 1, 1, "note appears exactly once");
  assert.ok(out.includes("Top.") && out.includes("Bottom."));
});

test("leaves a prompt without any catalog untouched", () => {
  assert.equal(stripSkillCatalog("No catalog here.", 27), "No catalog here.");
  assert.equal(stripSkillCatalog("", 0), "");
});

test("swallows one preceding blank line so spacing stays tidy", () => {
  const out = stripSkillCatalog("Header.\n\n<skills>x</skills>\nFooter.", 2);
  assert.ok(!out.includes("Header.\n\n\n"), "no triple newline where the block was");
  assert.ok(out.startsWith("Header.\n"));
});

test("an unterminated catalog is left alone rather than truncating the prompt", () => {
  const broken = "Header.\n<skills>\nnever closed";
  assert.equal(stripSkillCatalog(broken, 5), broken);
});

test("note text interpolates the count and stays one line", () => {
  assert.match(skillStripNote(0), /^0 Agent Skills/);
  assert.ok(!skillStripNote(5).includes("\n"));
});
