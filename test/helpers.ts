import { copyFile, writeFile } from "node:fs/promises";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import type { ExecImpl, ExecResult } from "#/client/exec";
import { loadConfig, type Config } from "#/config";
import { createServer } from "#/server";
import type { SpawnRunner } from "#/tools/runner";

/**
 * A config path that cannot exist, passed on every `loadConfig` in the suite.
 * Without it a developer's real `~/.config/ios-device-mcp/config.json` leaks
 * into the run, and the suite passes on one machine and fails on another — or,
 * worse, the reverse.
 */
export const ABSENT_CONFIG = "/nonexistent/ios-device-mcp.json";

// ------------------------------------------------------------ exec fixtures --

export const DEVICE_ID = "DAC88BCC-D5EA-5860-9D51-E40C579DFAB8";

export const connectedDevice = {
  identifier: DEVICE_ID,
  connectionProperties: {
    pairingState: "paired",
    tunnelState: "connected",
    tunnelIPAddress: "fd1f:8710:610c::1",
    transportType: "localNetwork",
  },
  deviceProperties: {
    name: "Olivier's iPhone",
    osVersionNumber: "26.6.1",
    developerModeStatus: "enabled",
    ddiServicesAvailable: true,
  },
  hardwareProperties: {
    udid: "00008150-000A43CE1447801C",
    marketingName: "iPhone 17 Pro Max",
    productType: "iPhone18,2",
    platform: "iOS",
  },
};

export const displaysResult = {
  backlightState: "activeOn",
  displays: [
    {
      displayId: 1,
      primary: true,
      nativeSize: [1320, 2868],
      pointScale: 3,
      currentOrientation: "rot0",
    },
  ],
  orientation: { currentDeviceOrientation: "portrait" },
};

export const appsResult = {
  apps: [
    {
      bundleIdentifier: "io.mgcrea.Canopy",
      name: "Canopy",
      version: "1.0.0",
      bundleVersion: "28",
      builtByDeveloper: true,
      url: "file:///private/var/containers/Bundle/Application/5E13C557/Canopy.app/",
    },
  ],
};

export const processesResult = {
  runningProcesses: [
    { processIdentifier: 190, executable: "file:///Applications/PosterBoard.app/PosterBoard" },
    {
      processIdentifier: 4242,
      executable: "file:///private/var/containers/Bundle/Application/5E13C557/Canopy.app/Canopy",
    },
  ],
};

/** The default responses, keyed by the devicectl subcommand path. */
export const defaultDevicectl: Record<string, unknown> = {
  "list devices": { devices: [connectedDevice] },
  "device info displays": displaysResult,
  "device info lockState": { passcodeRequired: false, unlockedSinceBoot: true },
  "device info apps": appsResult,
  "device info processes": processesResult,
  "device install app": { installedApplications: [{ bundleID: "io.mgcrea.Canopy" }] },
  "device process launch": { process: { processIdentifier: 4242 } },
  "device process terminate": {},
  "device copy from": {},
};

/**
 * A mock `exec` that behaves like the real process boundary rather than
 * standing in front of it: devicectl's answer is written to the `--json-output`
 * path the client chose, so the temp-file round trip, the envelope unwrapping
 * and the error mapping all still run for real.
 */
export const execMock = (
  overrides: Record<string, unknown> = {},
  log: string[][] = [],
): ExecImpl => {
  const table = { ...defaultDevicectl, ...overrides };
  return async (path: string, args: string[]): Promise<ExecResult> => {
    log.push([path, ...args]);

    // `ps` is read by the runner tool to find an existing WebDriverAgent. It
    // takes no --json-output, so it must be answered before the devicectl path.
    // Matched on the whole basename, not a suffix: `sips` ends in "ps" too, and
    // swallowing it here breaks every screenshot in the suite.
    if (path.split("/").pop() === "ps") {
      return { stdout: (overrides["__ps"] as string | undefined) ?? "", stderr: "" };
    }

    if (path.endsWith("sips")) {
      // `-g pixelWidth -g pixelHeight <file>` reads dimensions; anything else is
      // a conversion, which has to leave a file behind for the caller to read.
      if (args.includes("-g")) {
        const file = args[args.length - 1] as string;
        const dims = file.endsWith(".png") ? [1320, 2868] : [440, 956];
        return { stdout: `/x\n  pixelWidth: ${dims[0]}\n  pixelHeight: ${dims[1]}\n`, stderr: "" };
      }
      const out = args[args.indexOf("--out") + 1] as string;
      const source = args[args.indexOf("--out") - 1] as string;
      await copyFile(source, out);
      return { stdout: "", stderr: "" };
    }

    const jsonPath = args[args.indexOf("--json-output") + 1] as string;
    const key = Object.keys(table).find(
      (candidate) =>
        args.join(" ").includes(` ${candidate} `) || args.join(" ").includes(`${candidate} `),
    );
    await writeFile(jsonPath, JSON.stringify({ info: {}, result: key ? table[key] : {} }));
    return { stdout: "", stderr: "" };
  };
};

// ------------------------------------------------------------- wda fixtures --

/** 1x1 transparent PNG; `sips` is mocked, so only "non-empty" matters. */
export const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Shaped like a real `GET /source?format=json`, measured against WDA 16.12.3 on
 * iOS 26.6.1: booleans are the strings "1"/"0", and `type` comes back already
 * stripped of its `XCUIElementType` prefix.
 */
export const sampleSource = {
  type: "Application",
  name: "Canopy",
  rect: { x: 0, y: 0, width: 440, height: 956 },
  isVisible: "1",
  isEnabled: "1",
  children: [
    {
      type: "Button",
      name: "garden.tab",
      label: "Garden",
      rawIdentifier: "garden.tab",
      rect: { x: 20, y: 900, width: 100, height: 40 },
      isVisible: "1",
      isEnabled: "1",
    },
    {
      type: "Button",
      label: "Today",
      rect: { x: 140, y: 900, width: 100, height: 40 },
      isVisible: "1",
      isEnabled: "0",
    },
    {
      type: "StaticText",
      label: "Monstera deliciosa",
      rect: { x: 20, y: 200, width: 300, height: 24 },
      isVisible: "1",
      isEnabled: "1",
    },
    {
      type: "Button",
      label: "Hidden",
      rect: { x: 0, y: 2000, width: 40, height: 40 },
      isVisible: "0",
      isEnabled: "1",
    },
  ],
};

export type FetchLike = (url: unknown, init?: unknown) => Promise<Response>;

const json = (value: unknown, extra: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ value, sessionId: "S1", ...extra }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * A WebDriverAgent stand-in. Routes are matched on the path so a test can assert
 * that a tap really went through `/actions` rather than some other endpoint.
 */
export const wdaMock =
  (
    overrides: Record<string, () => Response> = {},
    log: { method: string; path: string; body: unknown }[] = [],
  ): FetchLike =>
  async (url: unknown, init?: unknown): Promise<Response> => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    const request = (init ?? {}) as RequestInit;
    log.push({
      method: request.method ?? "GET",
      path,
      body: typeof request.body === "string" ? JSON.parse(request.body) : undefined,
    });

    for (const [pattern, respond] of Object.entries(overrides)) {
      if (path.includes(pattern)) return respond();
    }
    if (path === "/status")
      return json({ ready: true, state: "success", build: { version: "9.0.0" } });
    if (path === "/session") return json({ sessionId: "S1", capabilities: {} });
    if (path === "/screenshot") return json(TINY_PNG);
    if (path.startsWith("/source")) return json(sampleSource);
    if (path.endsWith("/window/size")) return json({ width: 440, height: 956 });
    if (path.endsWith("/elements")) return json([{ "element-6066-11e4-a52e-4f735466cecf": "E1" }]);
    if (path.endsWith("/rect")) return json({ x: 20, y: 900, width: 100, height: 40 });
    if (path.endsWith("/alert/text")) {
      return new Response(JSON.stringify({ value: { error: "no such alert" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return json(null);
  };

// ------------------------------------------------------------------ harness --

export type Harness = Awaited<ReturnType<typeof connect>>;

/** Records what would have been spawned, and starts nothing. */
export const spawnMock =
  (log: { command: string; args: string[]; env: Record<string, string> }[] = []): SpawnRunner =>
  async (command, args, { env }) => {
    log.push({ command, args, env });
    return 4242;
  };

export const connect = async (
  env: Record<string, string> = {},
  opts: { exec?: ExecImpl; fetch?: FetchLike; spawnRunner?: SpawnRunner } = {},
) => {
  const config: Config = loadConfig(env, ABSENT_CONFIG);
  const { server } = createServer({
    config,
    exec: opts.exec ?? execMock(),
    fetch: (opts.fetch ?? wdaMock()) as unknown as typeof fetch,
    // Defaulted, never optional: a test that reached the real one would leave an
    // xcodebuild running on whoever ran the suite.
    spawnRunner: opts.spawnRunner ?? spawnMock(),
  });

  // Both halves of a linked pair must come from the *same* package: v2 exports
  // InMemoryTransport from both /client and /server, and the two copies keep
  // private state that does not cross. Mixing them makes the pair hang rather
  // than fail, which is a miserable thing to debug.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    toolNames: async (): Promise<string[]> =>
      (await client.listTools()).tools.map((t) => t.name).toSorted(),
    tools: async () => (await client.listTools()).tools,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      let res;
      try {
        res = await client.callTool({ name, arguments: args });
      } catch (err) {
        // A schema violation is rejected by the SDK at the protocol layer and
        // never reaches the tool body — which is the behaviour we want, so the
        // harness reports it rather than failing to parse it.
        return { isToolError: true, rejected: true, error: String(err) } as Record<string, unknown>;
      }
      const content = res.content as ({ type: string; text?: string } | { type: string })[];
      const text =
        content.find((part): part is { type: string; text: string } => part.type === "text")
          ?.text ?? "{}";
      const image = content.find((part) => part.type === "image");
      try {
        return {
          ...JSON.parse(text),
          isToolError: res.isError === true,
          hasImage: image !== undefined,
        };
      } catch {
        return { isToolError: res.isError === true, error: text, hasImage: image !== undefined };
      }
    },
  };
};
