import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Switches that can be saved globally, each with the env var that overrides it. */
export const SWITCHES = {
  auto: "PI_JEV_AUTO",
  autoModel: "PI_JEV_AUTO_MODEL",
  compact: "PI_JEV_COMPACT",
  agents: "PI_JEV_AGENTS",
} as const;

export type JevConfigKey = keyof typeof SWITCHES;
export type JevConfig = Partial<Record<JevConfigKey, boolean>>;

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Whether an env var holds a truthy value. An unset var is not truthy; a blank one is not either. */
export function isTruthy(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}

/** True for a plain JSON object: not null, not an array. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Global config file, beside Pi's own settings. Honors PI_CODING_AGENT_DIR like Pi does. */
export function configPath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  return path.join(dir, "pi-jev.json");
}

/** Read a JSON object; a missing, corrupt, or non-object file reads as empty. Never throws. */
export function readJsonObject(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Write a JSON object, creating its directory. Throws only if the path is unwritable. */
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Never throws: a missing or corrupt file just means "nothing saved". */
export function loadConfig(): JevConfig {
  return readJsonObject(configPath()) as JevConfig;
}

/** Merge switches into the global file. Throws only if the path is unwritable. */
export function saveConfig(patch: JevConfig): JevConfig {
  const next = { ...loadConfig(), ...patch };
  writeJson(configPath(), next);
  return next;
}

/**
 * A switch default: an env var that is set at all wins (so PI_JEV_AUTO=0 is a hard off),
 * then the saved file, then off. An explicit CLI flag still overrides both.
 */
export function resolveSwitch(key: JevConfigKey, saved: JevConfig): boolean {
  const raw = process.env[SWITCHES[key]];
  if (raw !== undefined) return isTruthy(raw);
  // The file is hand-editable: coerce the way the env path does, so `"compact": "off"` cannot enable a
  // switch just by being a truthy string while `"on"` still means on.
  const value = saved[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return isTruthy(value);
  return false;
}

/** True when a set env var would override `value` on the next start, so a toggle must say so now. */
export function envShadowed(key: JevConfigKey, value: boolean): boolean {
  return process.env[SWITCHES[key]] !== undefined && isTruthy(process.env[SWITCHES[key]]) !== value;
}

/** Env vars currently shadowing the saved switches, for `/jev status`. */
export function envOverrides(): string[] {
  return (Object.keys(SWITCHES) as JevConfigKey[]).flatMap((key) =>
    process.env[SWITCHES[key]] === undefined ? [] : [`$${SWITCHES[key]}`]
  );
}
