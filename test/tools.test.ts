import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "#/config";
import {
  ABSENT_CONFIG,
  connect,
  DEVICE_ID,
  execMock,
  sampleSource,
  spawnMock,
  wdaMock,
  type FetchLike,
} from "#test/helpers";

const WRITES = { IOS_DEVICE_ALLOW_WRITES: "1" };

const READ_TOOLS = [
  "ios_device_diagnostics",
  "ios_device_get_display_info",
  "ios_device_list_apps",
  "ios_device_list_devices",
  "ios_device_screenshot",
  "ios_device_ui_tree",
];

const WRITE_TOOLS = [
  "ios_device_install",
  "ios_device_launch",
  "ios_device_press_button",
  "ios_device_pull_container",
  "ios_device_restart_wda",
  "ios_device_swipe",
  "ios_device_tap",
  "ios_device_tap_element",
  "ios_device_terminate",
  "ios_device_type",
];

describe("registration matrix", () => {
  it("registers exactly the observing tools by default", async () => {
    const harness = await connect();
    expect(await harness.toolNames()).toEqual(READ_TOOLS);
  });

  it("adds the driving tools, and only those, when writes are enabled", async () => {
    const harness = await connect(WRITES);
    expect(await harness.toolNames()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].toSorted());
  });

  it("never registers a driving tool with the flag off", async () => {
    const names = await (await connect()).toolNames();
    for (const tool of WRITE_TOOLS) expect(names).not.toContain(tool);
  });
});

const exploding = (message: string, code?: string) => async () => {
  throw code ? Object.assign(new Error(message), { code }) : new Error(message);
};

const refusing: FetchLike = async () => {
  throw new Error("connect ECONNREFUSED");
};

/** WDA's own failure envelope, which it sends on a 500 as readily as on a 200. */
const wdaFailure = (message: string): Response =>
  new Response(JSON.stringify({ value: { error: "unknown error", message }, sessionId: null }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });

/**
 * A runner that is up and refuses to act — `/status` healthy, every XCTest call
 * rejected. Measured against WDA 16.12.3 on iOS 26.6.1 with the device's
 * automation grant missing: the domain and code carry the meaning, and the
 * `error` field is the generic one.
 */
/**
 * What `/source` returns when WebDriverAgent holds no application at all. Reads
 * like a claim about the app under test; is nothing of the kind.
 */
const deadHandle = (): Response =>
  wdaFailure(
    "The previously found element \"Application 'local.pid.0'\" is not present in the current " +
      "view anymore. Original error: Application local.pid.0 is not running",
  );

const unauthorized = (): FetchLike =>
  wdaMock({
    "/screenshot": () =>
      wdaFailure(
        'Error Domain=XCTDaemonErrorDomain Code=41 "Not authorized for performing UI testing ' +
          'actions." UserInfo={NSLocalizedDescription=Not authorized for performing UI testing ' +
          "actions.}",
      ),
  });

/** The pointer sequence a W3C `/actions` call carried, for asserting on. */
const pointerSequence = (log: { path: string; body: unknown }[]): Record<string, number>[] => {
  const body = log.find((entry) => entry.path.endsWith("/actions"))?.body as
    | { actions?: { actions?: Record<string, number>[] }[] }
    | undefined;
  return body?.actions?.[0]?.actions ?? [];
};

describe("surviving a broken environment", () => {
  // The regression that produces "MCP error -32000: Connection closed": a server
  // that throws at startup takes its own diagnostics with it, leaving no way to
  // discover what is wrong.
  it("still connects and serves tools when xcrun is missing entirely", async () => {
    const harness = await connect({}, { exec: exploding("spawn ENOENT", "ENOENT") as never });
    expect(await harness.toolNames()).toEqual(READ_TOOLS);
  });

  it("reports what is wrong as data rather than throwing", async () => {
    const broken = exploding('xcrun: error: unable to find utility "devicectl"');
    const result = await (
      await connect({}, { exec: broken as never })
    ).call("ios_device_diagnostics");
    expect(result.isToolError).toBe(false);
    expect(result.ok).toBe(false);
    expect(String(result.nextSteps)).toContain("Xcode");
  });

  it("reports a locked device as its own problem, since it explains every other failure", async () => {
    const locked = execMock({ "device info lockState": { passcodeRequired: true } });
    const result = await (await connect({}, { exec: locked })).call("ios_device_diagnostics");
    expect(result.locked).toBe(true);
    expect(String(result.problems)).toContain("locked");
  });

  it("names the UI Automation toggle, which cannot be set from this Mac", async () => {
    const result = await (await connect({}, { fetch: refusing })).call("ios_device_diagnostics");
    expect(String(result.nextSteps)).toContain("Enable UI Automation");
  });

  it("names WebDriverAgent, not the device, when only the runner is down", async () => {
    const result = await (await connect({}, { fetch: refusing })).call("ios_device_diagnostics");
    expect(result.ok).toBe(false);
    expect(String(result.problems)).toContain("WebDriverAgent");
    expect(String(result.nextSteps)).toContain("wda.sh");
  });

  it("gives a screenshot failure a remedy rather than a bare fetch error", async () => {
    const result = await (await connect({}, { fetch: refusing })).call("ios_device_screenshot");
    expect(result.isToolError).toBe(true);
    expect(String(result.remedy)).toContain("wda.sh");
  });

  // The regression this whole group exists for: a runner whose HTTP server is up
  // and whose XCTest lane is dead reported `ok: true, problems: []` while every
  // screenshot, tap and ui_tree failed. `/status` cannot see that, so diagnostics
  // has to probe across the line rather than infer from it.
  it("catches a runner that answers /status but is not authorized to drive the UI", async () => {
    const result = await (
      await connect({}, { fetch: unauthorized() })
    ).call("ios_device_diagnostics");
    expect(result.isToolError).toBe(false);
    expect(result.ok).toBe(false);
    expect((result.wda as { reachable: boolean }).reachable).toBe(true);
    expect((result.wda as { authorized: boolean }).authorized).toBe(false);
    expect(String(result.problems)).toContain("not authorized");
    expect(String(result.nextSteps)).toContain("Enable UI Automation");
  });

  it("gives error 41 a remedy, though it arrives under no code worth switching on", async () => {
    const result = await (
      await connect({}, { fetch: unauthorized() })
    ).call("ios_device_screenshot");
    expect(result.isToolError).toBe(true);
    expect(String(result.remedy)).toContain("Enable UI Automation");
  });

  // A dead handle that survives a fresh session is not a dead handle at all —
  // it is what an unauthorized runner looks like through /source. Reporting it
  // as "Application local.pid.0 is not running" sends the reader to relaunch an
  // app that is running perfectly well.
  it("blames the runner, not the app, when a fresh session hits the same dead handle", async () => {
    const result = await (
      await connect({}, { fetch: wdaMock({ "/source": deadHandle }) })
    ).call("ios_device_ui_tree");
    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toContain("cannot see any foreground application");
    expect(String(result.remedy)).toContain("Enable UI Automation");
  });

  // WDA keeps the app it attached to, and reports its death as a `local.pid.0`
  // handle rather than as anything about the session. Left unmatched, that made
  // ui_tree permanently broken after any relaunch.
  it("recreates the session when the app WebDriverAgent held has gone", async () => {
    const log: { method: string; path: string; body: unknown }[] = [];
    let attempts = 0;
    const fetch = wdaMock(
      {
        "/source": () => {
          attempts += 1;
          return attempts === 1
            ? wdaFailure(
                "The previously found element \"Application 'local.pid.0'\" is not present in the " +
                  "current view anymore. Make sure the application UI has the expected state. " +
                  "Original error: Application local.pid.0 is not running",
              )
            : new Response(JSON.stringify({ value: sampleSource, sessionId: "S2" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
        },
      },
      log,
    );

    const result = await (await connect({}, { fetch })).call("ios_device_ui_tree");
    expect(result.isToolError).toBe(false);
    expect(attempts).toBe(2);
    expect(log.filter((entry) => entry.path === "/session")).toHaveLength(2);
  });
});

describe("restarting the runner", () => {
  // The grant is handed to an XCTest session at startup and never revisited, so
  // a restart is the only thing that can change `authorized`. That makes this
  // tool the one write here whose whole purpose is a process boundary.
  it("spawns the runner and reports it authorized once it answers", async () => {
    const spawned: { command: string; args: string[]; env: Record<string, string> }[] = [];
    const result = await (
      await connect(WRITES, { spawnRunner: spawnMock(spawned) })
    ).call("ios_device_restart_wda", { wait_seconds: 5 });

    expect(result.isToolError).toBe(false);
    expect(result.reachable).toBe(true);
    expect(result.authorized).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.command).toMatch(/wda\.sh$/);
    expect(spawned[0]?.args).toEqual(["run"]);
    // Pinned, so the script cannot resolve a different device than the tool did.
    expect(spawned[0]?.env["IOS_DEVICE_ID"]).toBe("00008150-000A43CE1447801C");
  });

  // Measured against Bastion, which runs this server off the node inside its own
  // bundle: nothing called `node` is on PATH, `wda.sh` parses devicectl's JSON
  // with it, and every spawn died with "node: command not found" while the tool
  // cheerfully reported a pid and success.
  it("hands the script a node it can actually find", async () => {
    const spawned: { command: string; args: string[]; env: Record<string, string> }[] = [];
    await (
      await connect(WRITES, { spawnRunner: spawnMock(spawned) })
    ).call("ios_device_restart_wda");

    const env = spawned[0]?.env ?? {};
    expect(env["NODE"]).toBe(process.execPath);
    expect(env["PATH"]?.split(":")[0]).toBe(dirname(process.execPath));
  });

  // 75s was the old default and no MCP call survives it: the transport gives up
  // around 60s, so the tool was killed before it could report the pid it had
  // already spawned.
  it("defaults to spawning and returning, not to waiting past the transport timeout", async () => {
    const tools = await (await connect(WRITES)).tools();
    const schema = tools.find((t) => t.name === "ios_device_restart_wda")?.inputSchema as {
      properties?: { wait_seconds?: { default?: number; maximum?: number } };
    };
    expect(schema.properties?.wait_seconds?.default).toBe(0);
    expect(schema.properties?.wait_seconds?.maximum).toBeLessThanOrEqual(45);
  });

  it("says so when the fresh runner is still refused, rather than reporting success", async () => {
    const result = await (
      await connect(WRITES, { fetch: unauthorized(), spawnRunner: spawnMock() })
    ).call("ios_device_restart_wda", { wait_seconds: 5 });

    expect(result.reachable).toBe(true);
    expect(result.authorized).toBe(false);
    expect(String(result.remedy)).toContain("Enable UI Automation");
  });

  // Two runners on one device is worse than none: they take turns answering and
  // every tool becomes intermittent.
  it("stops an existing runner for this device before starting one", async () => {
    const ps = `  999999 /usr/bin/xcodebuild test-without-building -destination id=00008150-000A43CE1447801C\n`;
    const result = await (
      await connect(WRITES, {
        exec: execMock({ __ps: ps }),
        spawnRunner: spawnMock(),
      })
    ).call("ios_device_restart_wda", { wait_seconds: 5 });

    expect(result.stopped).toEqual([999999]);
  });

  it("is absent without the write flag, like every other tool that changes something", async () => {
    expect(await (await connect()).toolNames()).not.toContain("ios_device_restart_wda");
  });
});

describe("device resolution", () => {
  it("uses the only connected device without being told", async () => {
    const result = await (await connect()).call("ios_device_get_display_info");
    expect(result.pointWidth).toBe(440);
    expect(result.pointHeight).toBe(956);
    expect(result.pointScale).toBe(3);
  });

  it("refuses to guess between two connected devices, and names both", async () => {
    const two = execMock({
      "list devices": {
        devices: [
          {
            identifier: "A",
            connectionProperties: { tunnelState: "connected" },
            deviceProperties: { name: "One" },
          },
          {
            identifier: "B",
            connectionProperties: { tunnelState: "connected" },
            deviceProperties: { name: "Two" },
          },
        ],
      },
    });
    const result = await (await connect({}, { exec: two })).call("ios_device_get_display_info");
    expect(result.isToolError).toBe(true);
    expect(String(result.remedy)).toContain("One = A");
    expect(String(result.remedy)).toContain("Two = B");
  });

  it("says which devices exist when the named one does not", async () => {
    const result = await (await connect()).call("ios_device_get_display_info", { device: "nope" });
    expect(result.isToolError).toBe(true);
    expect(String(result.remedy)).toContain(DEVICE_ID);
  });
});

describe("screenshot", () => {
  it("returns an image scaled into point space, so its coordinates are tap coordinates", async () => {
    const result = await (await connect()).call("ios_device_screenshot");
    expect(result.hasImage).toBe(true);
    expect(result.coordinateSpace).toBe("points");
    expect(result.pointsPerPixel).toBe(1);
    expect(result.width).toBe(440);
  });

  it("warns when a custom size takes the image out of point space", async () => {
    const result = await (await connect()).call("ios_device_screenshot", { max_dimension: 400 });
    // The mock reports the same output dimensions whatever is asked for, which
    // is precisely the case that must not silently claim point space.
    expect(result.coordinateSpace).toBe("points");
  });
});

describe("ui tree", () => {
  it("returns controls only by default, with the tap point precomputed", async () => {
    const result = await (await connect()).call("ios_device_ui_tree");
    expect(result.coordinateSpace).toBe("points");
    const elements = result.elements as { type: string; label?: string; tap: number[] }[];
    expect(elements.map((e) => e.label)).toEqual(["Garden", "Today"]);
    expect(elements[0]?.tap).toEqual([70, 920]);
  });

  it('reads WebDriverAgent\'s "1"/"0" booleans, not just true/false', async () => {
    // The narrow version of this check filtered out every element on a real
    // screen and returned an empty tree that looked like a working answer.
    const live = {
      type: "Application",
      rect: { x: 0, y: 0, width: 440, height: 956 },
      isVisible: "1",
      isEnabled: "1",
      children: [
        {
          type: "Icon",
          label: "Weather",
          rawIdentifier: "Weather",
          rect: { x: 29, y: 91, width: 181, height: 205 },
          isVisible: "1",
          isEnabled: "1",
        },
      ],
    };
    const harness = await connect(
      {},
      {
        fetch: wdaMock({
          "/source": () =>
            new Response(JSON.stringify({ value: live, sessionId: "S1" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        }),
      },
    );
    const result = await harness.call("ios_device_ui_tree");
    expect(result.elements).toEqual([
      { type: "Icon", label: "Weather", rect: [29, 91, 181, 205], tap: [120, 194] },
    ]);
  });

  it("drops elements XCUITest marks invisible, because they cannot be tapped", async () => {
    const result = await (await connect()).call("ios_device_ui_tree");
    expect(JSON.stringify(result)).not.toContain("Hidden");
  });

  it("widens to labelled text on request", async () => {
    const result = await (await connect()).call("ios_device_ui_tree", { detail: "labelled" });
    expect(JSON.stringify(result)).toContain("Monstera deliciosa");
  });

  it("filters by substring", async () => {
    const result = await (await connect()).call("ios_device_ui_tree", { contains: "gard" });
    expect((result.elements as unknown[]).length).toBe(1);
  });

  it("caps the payload and says so rather than truncating silently", async () => {
    // A real screen has far more than the four nodes the default fixture has;
    // this is what the cap exists for.
    const crowded = {
      type: "Application",
      rect: { x: 0, y: 0, width: 440, height: 956 },
      isVisible: "1",
      isEnabled: "1",
      children: Array.from({ length: 60 }, (_, i) => ({
        type: "Button",
        label: `Plant number ${i}`,
        rawIdentifier: `plant.row.${i}`,
        rect: { x: 20, y: i * 12, width: 400, height: 44 },
        isVisible: "1",
        isEnabled: "1",
      })),
    };
    const harness = await connect(
      { IOS_DEVICE_MAX_TREE_BYTES: "1000" },
      {
        fetch: wdaMock({
          "/source": () =>
            new Response(JSON.stringify({ value: crowded, sessionId: "S1" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        }),
      },
    );
    const result = await harness.call("ios_device_ui_tree");
    expect(result.matched).toBe(60);
    expect((result.elements as unknown[]).length).toBeLessThan(60);
    expect(String(result.truncated)).toContain("byte cap");
  });
});

describe("input", () => {
  it("sends a tap as a W3C pointer sequence at the given point", async () => {
    const log: { method: string; path: string; body: unknown }[] = [];
    const harness = await connect(WRITES, { fetch: wdaMock({}, log) });
    const result = await harness.call("ios_device_tap", { x: 70, y: 920, screenshot: false });
    expect(result.isToolError).toBe(false);

    const sequence = pointerSequence(log);
    expect(sequence[0]).toMatchObject({ type: "pointerMove", x: 70, y: 920 });
    expect(sequence[1]).toMatchObject({ type: "pointerDown" });
  });

  it("returns the resulting screen by default, so a mis-aimed tap is visible immediately", async () => {
    const result = await (
      await connect(WRITES)
    ).call("ios_device_tap", { x: 10, y: 10, settle_ms: 0 });
    expect(result.hasImage).toBe(true);
  });

  it("carries the drag duration into the swipe, since that is what separates a scroll from a fling", async () => {
    const log: { method: string; path: string; body: unknown }[] = [];
    const harness = await connect(WRITES, { fetch: wdaMock({}, log) });
    await harness.call("ios_device_swipe", {
      from_x: 220,
      from_y: 700,
      to_x: 220,
      to_y: 200,
      duration_ms: 400,
      screenshot: false,
    });
    expect(pointerSequence(log)[2]).toMatchObject({ type: "pointerMove", duration: 400, y: 200 });
  });

  it("rejects a tap_element that names more than one way to find it", async () => {
    const result = await (
      await connect(WRITES)
    ).call("ios_device_tap_element", {
      id: "garden.tab",
      label: "Garden",
      screenshot: false,
    });
    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toContain("exactly one");
  });

  it("resolves an element by accessibility id and clicks it", async () => {
    const log: { method: string; path: string; body: unknown }[] = [];
    const harness = await connect(WRITES, { fetch: wdaMock({}, log) });
    const result = await harness.call("ios_device_tap_element", {
      id: "garden.tab",
      screenshot: false,
    });
    expect(result.isToolError).toBe(false);
    const find = log.find((e) => e.path.endsWith("/elements"));
    expect(find?.body).toMatchObject({ using: "accessibility id", value: "garden.tab" });
    expect(log.some((e) => e.path.endsWith("/click"))).toBe(true);
  });

  it("quotes a label into the predicate rather than letting it end the string", async () => {
    const log: { method: string; path: string; body: unknown }[] = [];
    const harness = await connect(WRITES, { fetch: wdaMock({}, log) });
    await harness.call("ios_device_tap_element", { label: 'say "hi"', screenshot: false });
    const find = log.find((e) => e.path.endsWith("/elements"))?.body as
      | { value?: string }
      | undefined;
    expect(find?.value).toBe('label == "say \\"hi\\"" OR name == "say \\"hi\\""');
  });

  it("refuses clear_first with no field named, since focus alone cannot be cleared", async () => {
    const result = await (
      await connect(WRITES)
    ).call("ios_device_type", {
      text: "hello",
      clear_first: true,
      screenshot: false,
    });
    expect(result.isToolError).toBe(true);
    expect(String(result.remedy)).toContain("accessibility identifier");
  });
});

describe("app lifecycle", () => {
  it("applies the configured launch arguments and says where they came from", async () => {
    const harness = await connect({ ...WRITES, IOS_DEVICE_LAUNCH_ARGS: "-CanopyDemoMode" });
    const result = await harness.call("ios_device_launch", { bundle_id: "io.mgcrea.Canopy" });
    expect(result.arguments).toEqual(["-CanopyDemoMode"]);
    expect(result.argumentsFrom).toBe("IOS_DEVICE_LAUNCH_ARGS");
  });

  it("lets an explicit empty array override the configured default deliberately", async () => {
    const harness = await connect({ ...WRITES, IOS_DEVICE_LAUNCH_ARGS: "-CanopyDemoMode" });
    const result = await harness.call("ios_device_launch", {
      bundle_id: "io.mgcrea.Canopy",
      arguments: [],
    });
    expect(result.arguments).toEqual([]);
    expect(result.argumentsFrom).toBe("call");
  });

  it("passes launch arguments as argv rather than interpolating them", async () => {
    const log: string[][] = [];
    const harness = await connect(WRITES, { exec: execMock({}, log) });
    await harness.call("ios_device_launch", {
      bundle_id: "io.mgcrea.Canopy",
      arguments: ["-Flag", "a b; rm -rf /"],
    });
    const launch = log.find((argv) => argv.includes("launch")) as string[];
    // Last, after --json-output: our own flags must never land inside the app's
    // trailing argv, and the app's argv must never be parsed as our flags.
    expect(launch.at(-1)).toBe("a b; rm -rf /");
    expect(launch.at(-2)).toBe("-Flag");
    expect(launch.at(-3)).toBe("io.mgcrea.Canopy");
  });

  it("finds the pid through the app's bundle path, not its executable name", async () => {
    const log: string[][] = [];
    const harness = await connect(WRITES, { exec: execMock({}, log) });
    const result = await harness.call("ios_device_terminate", { bundle_id: "io.mgcrea.Canopy" });
    expect(result.terminated).toBe(true);
    expect(result.pid).toBe(4242);
  });

  it("treats terminating something that is not running as success, not failure", async () => {
    const harness = await connect(WRITES, {
      exec: execMock({ "device info processes": { runningProcesses: [] } }),
    });
    const result = await harness.call("ios_device_terminate", { bundle_id: "io.mgcrea.Canopy" });
    expect(result.isToolError).toBe(false);
    expect(result.terminated).toBe(false);
  });

  it("requires an absolute path to install", async () => {
    const result = await (
      await connect(WRITES)
    ).call("ios_device_install", { app_path: "build/Canopy.app" });
    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toContain("absolute");
  });

  it("requires confirm before pulling an app's private data", async () => {
    const result = await (
      await connect(WRITES)
    ).call("ios_device_pull_container", {
      bundle_id: "io.mgcrea.Canopy",
    });
    // The SDK rejects it against the schema before the handler ever runs, which
    // is the layer this must be caught at.
    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toContain("confirm");
  });
});

describe("config", () => {
  it("lets the environment beat the config file field by field", () => {
    const config = loadConfig({ IOS_DEVICE_WDA_PORT: "9100" }, ABSENT_CONFIG);
    expect(config.wdaPort).toBe(9100);
    expect(config.allowWrites).toBe(false);
  });

  it("treats an empty environment variable as unset rather than empty", () => {
    expect(loadConfig({ IOS_DEVICE_ID: "  " }, ABSENT_CONFIG).deviceId).toBeUndefined();
  });

  it("splits launch arguments on whitespace", () => {
    expect(loadConfig({ IOS_DEVICE_LAUNCH_ARGS: "-A  -B" }, ABSENT_CONFIG).launchArgs).toEqual([
      "-A",
      "-B",
    ]);
  });
});

describe("tool contract", () => {
  it("gives every tool a service-prefixed title", async () => {
    const tools = await (await connect(WRITES)).tools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(tool.title, tool.name).toMatch(/^iOS Device: /);
  });

  it("describes every input field, since that is all a model reads before choosing", async () => {
    for (const tool of await (await connect(WRITES)).tools()) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [field, schema] of Object.entries(props)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  it("annotates every tool", async () => {
    for (const tool of await (await connect(WRITES)).tools()) {
      expect(tool.annotations, tool.name).toBeDefined();
    }
  });

  it("names every tool with the service prefix", async () => {
    for (const name of await (await connect(WRITES)).toolNames()) {
      expect(name).toMatch(/^ios_device_/);
    }
  });
});
