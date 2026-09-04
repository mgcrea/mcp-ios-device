import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/**
 * There are no credentials here. What this server needs instead is a *device*,
 * and the two lanes it drives reach it differently:
 *
 *   * `xcrun devicectl` — Apple's own tool, already on any Mac with Xcode. It
 *     covers app lifecycle and device facts, and needs nothing configured.
 *   * WebDriverAgent — an HTTP server running on the phone. Everything that
 *     sees or touches the screen goes through it.
 *
 * WDA is reached over the tunnel CoreDevice already maintains: a connected
 * device reports a `tunnelIPAddress` (an `fd…::1` ULA on a `utun` interface)
 * that plain TCP from this process can route to. That is what makes this server
 * TypeScript-only — no `iproxy`, no usbmux client, no Python.
 */
const ConfigSchema = z
  .object({
    /**
     * CoreDevice identifier, hardware UDID, or device name. Left unset, a single
     * connected device is used automatically and two or more is an error that
     * names them, rather than a coin flip.
     */
    deviceId: z.string().min(1).optional(),
    /**
     * Explicit WebDriverAgent base URL, e.g. `http://127.0.0.1:8100` when
     * something else is already forwarding the port. Unset means "derive it from
     * the device's CoreDevice tunnel address", which is the path that needs no
     * setup at all.
     */
    wdaUrl: z.url().optional(),
    wdaPort: z.number().int().min(1).max(65535).default(8100),
    /** WDA answers `/source` on a busy screen slowly; 30s is not generous. */
    wdaTimeoutMs: z.number().int().min(1000).max(600_000).default(30_000),
    /** `devicectl install` on a large app genuinely takes minutes. */
    execTimeoutMs: z.number().int().min(1000).max(1_800_000).default(120_000),
    allowWrites: z.boolean().default(false),
    /**
     * Prepended to every `ios_device_launch` that does not pass its own
     * `arguments`. This exists for one specific class of accident: an app whose
     * normal launch opens the owner's real account, and whose debug build has a
     * flag that opens fixtures instead. Setting that flag here makes the safe
     * launch the default one rather than the one you have to remember.
     */
    launchArgs: z.array(z.string()).default([]),
    /** Where screenshots and pulled containers land. */
    outputDir: z.string().min(1).default(join(tmpdir(), "mcp-ios-device")),
    /**
     * Byte cap on a `ios_device_ui_tree` payload. An unpruned WDA `/source` for
     * a real screen is tens of KB of JSON; this is the last line of defence
     * behind the pruning itself.
     */
    maxTreeBytes: z.number().int().min(1000).max(500_000).default(24_000),
    xcrunPath: z.string().min(1).default("/usr/bin/xcrun"),
    sipsPath: z.string().min(1).default("/usr/bin/sips"),
  })
  .strict()
  .superRefine((_cfg, _ctx) => {
    // Deliberately NOT an error when there is no device, no WDA and no Xcode. An
    // MCP server that exits on startup shows up in the client as a bare
    // "MCP error -32000: Connection closed", with stderr swallowed — so the one
    // message that would have explained the problem never reaches anyone.
    // ios_device_diagnostics reports all of it as data instead.
  });

export type Config = z.infer<typeof ConfigSchema>;

const parseBool = (value: string | undefined): boolean | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(t.toLowerCase());
};

const parseIntOpt = (value: string | undefined): number | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  const n = Number(t);
  return Number.isInteger(n) ? n : undefined;
};

/** Whitespace-separated, so `IOS_DEVICE_LAUNCH_ARGS="-DemoMode -NoCloud"` works. */
const parseArgs = (value: string | undefined): string[] | undefined => {
  const t = trimmed(value);
  return t === undefined ? undefined : t.split(/\s+/);
};

/** Maps "" to undefined, so an empty env var means "unset" rather than "empty". */
const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

export const defaultConfigPath = (env: NodeJS.ProcessEnv = process.env): string =>
  trimmed(env.IOS_DEVICE_CONFIG) ?? join(homedir(), ".config", "ios-device-mcp", "config.json");

/**
 * `.strict()` on purpose: a typo'd `wdaPort` spelled `wda_port` must be an
 * error. Silently ignoring an unknown key looks exactly like "that setting had
 * no effect", which is the worst possible way to learn where your config came
 * from.
 */
const FileSchema = ConfigSchema;

const readConfigFile = (path: string): Partial<Config> => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  return FileSchema.partial().strict().parse(JSON.parse(raw)) as Partial<Config>;
};

/**
 * Environment first, config file second, **per field** — not whole-source.
 * A one-off `IOS_DEVICE_ALLOW_WRITES=0` has to beat a file that says `true`,
 * while a file that sets `deviceId` keeps working when the environment says
 * nothing about it. Merging field by field is the only rule that gives both.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = defaultConfigPath(env),
): Config => {
  const file = readConfigFile(configPath);
  const pick = <K extends keyof Config>(
    fromEnv: Config[K] | undefined,
    key: K,
  ): Config[K] | undefined => fromEnv ?? file[key];

  return ConfigSchema.parse({
    deviceId: pick(trimmed(env.IOS_DEVICE_ID), "deviceId"),
    wdaUrl: pick(trimmed(env.IOS_DEVICE_WDA_URL), "wdaUrl"),
    wdaPort: pick(parseIntOpt(env.IOS_DEVICE_WDA_PORT), "wdaPort"),
    wdaTimeoutMs: pick(parseIntOpt(env.IOS_DEVICE_WDA_TIMEOUT_MS), "wdaTimeoutMs"),
    execTimeoutMs: pick(parseIntOpt(env.IOS_DEVICE_TIMEOUT_MS), "execTimeoutMs"),
    allowWrites: pick(parseBool(env.IOS_DEVICE_ALLOW_WRITES), "allowWrites"),
    launchArgs: pick(parseArgs(env.IOS_DEVICE_LAUNCH_ARGS), "launchArgs"),
    outputDir: pick(trimmed(env.IOS_DEVICE_OUTPUT_DIR), "outputDir"),
    maxTreeBytes: pick(parseIntOpt(env.IOS_DEVICE_MAX_TREE_BYTES), "maxTreeBytes"),
    xcrunPath: pick(trimmed(env.IOS_DEVICE_XCRUN_PATH), "xcrunPath"),
    sipsPath: pick(trimmed(env.IOS_DEVICE_SIPS_PATH), "sipsPath"),
  });
};
