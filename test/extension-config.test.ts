import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../src/config.js";
import register from "../extensions/index.js";

/** Minimal ExtensionAPI stub: enough to load the extension and read the flag defaults it registers. */
function loadFlags(): Map<string, any> {
  const flags = new Map<string, any>();
  const pi: any = {
    registerFlag: (name: string, options: any) => flags.set(name, options.default),
    getFlag: (name: string) => flags.get(name),
    registerTool: () => {},
    registerCommand: () => {},
    on: () => {},
    sendMessage: () => {},
    events: { on: () => () => {}, emit: () => {} },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
  };
  register(pi);
  return flags;
}

test("a saved switch is the default a fresh session starts with", () => {
  process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-"));
  for (const env of ["PI_JEV_AUTO", "PI_JEV_AUTO_MODEL", "PI_JEV_COMPACT", "PI_JEV_AGENTS"]) delete process.env[env];

  assert.equal(loadFlags().get("jev-auto"), false, "nothing saved means off");
  assert.equal(loadFlags().get("jev-compact"), true, "fresh install: Jev owns /compact by default");

  saveConfig({ auto: true, compact: true });
  const flags = loadFlags();
  assert.equal(flags.get("jev-auto"), true);
  assert.equal(flags.get("jev-compact"), true);
  assert.equal(flags.get("jev-auto-model"), false, "unsaved switch stays off");

  process.env.PI_JEV_AUTO = "0";
  assert.equal(loadFlags().get("jev-auto"), false, "an env var still overrides the saved file");
  delete process.env.PI_JEV_AUTO;
});
