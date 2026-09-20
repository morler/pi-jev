import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SWITCHES, configPath, envOverrides, loadConfig, resolveSwitch, saveConfig } from "../src/config.js";

/** Point the config at a throwaway dir so tests never touch the real one. */
function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

test("switches round-trip through the global config file", () => {
  const dir = sandbox();
  assert.deepEqual(loadConfig(), {});
  assert.equal(configPath(), path.join(dir, "pi-jev.json"));

  saveConfig({ auto: true });
  saveConfig({ compact: true });
  assert.deepEqual(loadConfig(), { auto: true, compact: true });

  // A later write merges instead of dropping the other switch.
  saveConfig({ auto: false });
  assert.deepEqual(loadConfig(), { auto: false, compact: true });
});

test("a corrupt or non-object config file reads as empty instead of throwing", () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, "pi-jev.json"), "{not json");
  assert.deepEqual(loadConfig(), {});
  fs.writeFileSync(path.join(dir, "pi-jev.json"), '"a string"');
  assert.deepEqual(loadConfig(), {});
});

test("precedence: env var set at all > saved file > built-in default", () => {
  sandbox();
  delete process.env[SWITCHES.auto];

  assert.equal(resolveSwitch("auto", { auto: true }), true, "saved on");
  assert.equal(resolveSwitch("compact", { auto: true }), true, "compact defaults on when nothing says otherwise");
  assert.equal(resolveSwitch("agents", { auto: true }), false, "the other switches default off");
  assert.equal(resolveSwitch("compact", { compact: false }), false, "a saved off beats the on default");

  process.env[SWITCHES.auto] = "0";
  assert.equal(resolveSwitch("auto", { auto: true }), false, "explicit env off beats saved on");

  process.env[SWITCHES.compact] = "0";
  assert.equal(resolveSwitch("compact", {}), false, "PI_JEV_COMPACT=0 is a hard off against the on default");
  delete process.env[SWITCHES.compact];

  process.env[SWITCHES.auto] = "yes";
  assert.equal(resolveSwitch("auto", {}), true, "env on without a saved file");

  assert.deepEqual(envOverrides(), ["$PI_JEV_AUTO"]);
  delete process.env[SWITCHES.auto];
  assert.deepEqual(envOverrides(), []);
});

test("a hand-edited saved switch is coerced, so \"off\" cannot read as on", () => {
  const dir = sandbox();
  for (const env of [SWITCHES.auto, SWITCHES.compact, SWITCHES.agents]) delete process.env[env];
  fs.writeFileSync(path.join(dir, "pi-jev.json"), JSON.stringify({ auto: "off", compact: "on", agents: 1 }));

  assert.equal(resolveSwitch("auto", loadConfig()), false, '"off" is a truthy string, but it means off');
  assert.equal(resolveSwitch("compact", loadConfig()), true, '"on" still means on');
  assert.equal(resolveSwitch("agents", loadConfig()), false, "a non-string, non-boolean falls through to the switch's default");
});
