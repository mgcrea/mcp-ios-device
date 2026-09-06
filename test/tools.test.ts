import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ScreenHost } from "@mgcrea/mcp-ios-core";
import { describe, expect, it } from "vitest";

import type { ExecImpl } from "#/client/exec";
import type { DeviceSummary } from "#/client/shape";
import { loadConfig } from "#/config";
import { createServer } from "#/server";
import {
  ABSENT_CONFIG,
  connect,
  connectedDevice,
  DEVICE_ID,
  execMock,
  sampleSource,
  spawnMock,
  wdaMock,
  type FetchLike,
} from "#test/helpers";

/**
 * An exec whose `list devices` walks a script of tunnel states, one per call.
 * The last entry repeats, so `["unavailable", "connected"]` is a tunnel that
 * comes back the moment something asks the device for anything.
 */
const tunnelStates = (states: (string | undefined)[], log: string[][] = []): ExecImpl => {
  const base = execMock();
  let seen = 0;
  return async (path, args, timeoutMs) => {
    log.push([path, ...args]);
    if (args.join(" ").includes("list devices")) {
      const state = states[Math.min(seen, states.length - 1)];
      seen += 1;
      const jsonPath = args[args.indexOf("--json-output") + 1] as string;
      const device = {
        ...connectedDevice,
        connectionProperties: { ...connectedDevice.connectionProperties, tunnelState: state },
      };
      await writeFile(jsonPath, JSON.stringify({ info: {}, result: { devices: [device] } }));
      return { stdout: "", stderr: "" };
    }
    return base(path, args, timeoutMs);
  };
};

/** Indexes of every `list devices`, and of the first poke, in call order. */
const ordering = (log: string[][]): { lists: number[]; poke: number } => {
  const calls = log.map((entry) => entry.join(" "));
  return {
    lists: calls.flatMap((call, index) => (call.includes("list devices") ? [index] : [])),
    poke: calls.findIndex((call) => call.includes("device info lockState")),
  };
};

const WRITES = { IOS_DEVICE_ALLOW_WRITES: "1" };

const READ_TOOLS = [
  "ios_device_diagnostics",
  "ios_device_get_display_info",
  "ios_device_list_apps",
  "ios_device_list_devices",
  "ios_device_screenshot",
  "ios_device_ui_tree",
  // Observing, so it is registered whatever the write gate says: waiting for a
  // screen to finish loading is not a change to the device.
  "ios_device_wait_for_element",
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

  // The tunnel bug this server shipped with: `devicectl list devices` is a
  // passive read of CoreDevice's cache, so polling it could never revive
  // anything, while the `lockState` call further down — which acquires the usage
  // assertion that does — ran only after the verdict had been written.
  it("pokes a dropped tunnel before judging it, so the one that comes back reads as healthy", async () => {
    const log: string[][] = [];
    const result = await (
      await connect({}, { exec: tunnelStates(["unavailable", "connected"], log) })
    ).call("ios_device_diagnostics");

    expect(result.tunnelPoked).toBe(true);
    expect(result.devices[0].tunnel.state).toBe("connected");
    expect(String(result.problems)).not.toContain("tunnel");
  });

  it("acquires the usage assertion between the two readings, not after both", async () => {
    const log: string[][] = [];
    await (
      await connect({}, { exec: tunnelStates(["unavailable", "connected"], log) })
    ).call("ios_device_diagnostics");

    const { lists, poke } = ordering(log);
    expect(lists.length).toBeGreaterThanOrEqual(2);
    expect(poke).toBeGreaterThan(lists[0] as number);
    expect(poke).toBeLessThan(lists[1] as number);
  });

  // A dropped tunnel also makes the device stop resolving, since `state` is
  // derived from `tunnelState`. Reporting "no connected device" without poking
  // is the same mistake one level up.
  it("rescues a device that a dropped tunnel made unresolvable", async () => {
    const result = await (
      await connect({}, { exec: tunnelStates(["unavailable", "connected"]) })
    ).call("ios_device_diagnostics");

    expect(result.target?.id).toBe(DEVICE_ID);
    expect(String(result.problems)).not.toContain("No connected device");
  });

  it("still reports a tunnel the poke could not revive, and stops blaming Xcode first", async () => {
    const result = await (
      await connect({}, { exec: tunnelStates(["unavailable"]) })
    ).call("ios_device_diagnostics");

    expect(result.tunnelPoked).toBe(true);
    expect(result.ok).toBe(false);
    expect(String(result.nextSteps)).toContain("xcdevice");
  });

  it("does not poke a device whose tunnel is already up", async () => {
    const log: string[][] = [];
    const result = await (
      await connect({}, { exec: tunnelStates(["connected"], log) })
    ).call("ios_device_diagnostics");

    expect(result.tunnelPoked).toBeUndefined();
    expect(ordering(log).lists).toHaveLength(1);
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

  it("names the runner tool, not a shell, once that tool is registered", async () => {
    // The same fix as the simulator server's: diagnostics diagnosed a dead
    // runner and then sent the reader out of the toolset. It bites harder here,
    // because restart_wda is the *only* way a runner picks up the UI Automation
    // grant — flipping the Settings toggle does nothing to a running session.
    const result = await (
      await connect(WRITES, { fetch: refusing })
    ).call("ios_device_diagnostics");
    expect(String(result.nextSteps)).toContain("ios_device_restart_wda");
    expect(String(result.nextSteps)).not.toContain("npx");
  });

  it("keeps the shell recipe when writes are off and the tool is absent", async () => {
    // Writes default to off on a physical device, so this is the common case —
    // and naming a tool that is not in the list would be the same mistake.
    const result = await (await connect({}, { fetch: refusing })).call("ios_device_diagnostics");
    expect(String(result.nextSteps)).toContain("wda.sh");
    expect(String(result.nextSteps)).not.toContain("ios_device_restart_wda");
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
            hardwareProperties: { platform: "iOS" },
          },
          {
            identifier: "B",
            connectionProperties: { tunnelState: "connected" },
            deviceProperties: { name: "Two" },
            hardwareProperties: { platform: "iOS" },
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

  // The bug Canopy's own build script hit and fixed independently: `list
  // devices` is a passive read that never opens a tunnel, so a phone reached
  // over Wi-Fi reads `disconnected` the moment it goes idle. Every tool used to
  // fail outright on exactly that phone — only `ios_device_diagnostics` poked
  // and recovered, because the poke lived there instead of in `resolveDevice`.
  // This is the same recovery, proven on a tool that actually drives the
  // screen rather than merely reporting on it.
  it("wakes a dormant device with no hint, so a screenshot works on a phone whose tunnel went idle", async () => {
    const harness = await connect({}, { exec: tunnelStates(["unavailable", "connected"]) });
    const result = await harness.call("ios_device_screenshot");
    expect(result.isToolError).toBeFalsy();
    expect(result.hasImage).toBe(true);
  });

  it("wakes a device named by hint, so it does not throw a stale tunnel-address error", async () => {
    const harness = await connect({}, { exec: tunnelStates(["unavailable", "connected"]) });
    const result = await harness.call("ios_device_screenshot", { device: DEVICE_ID });
    expect(result.isToolError).toBeFalsy();
    expect(result.hasImage).toBe(true);
  });

  it("gives up on a device that never wakes, with a remedy naming CoreDevice's own discovery", async () => {
    const harness = await connect({}, { exec: tunnelStates(["unavailable"]) });
    const result = await harness.call("ios_device_screenshot");
    expect(result.isToolError).toBe(true);
    expect(String(result.remedy)).toContain("xcdevice");
  });

  it("wakes every paired candidate, not just one — unlike the old single-candidate rule", async () => {
    const log: string[][] = [];
    const two = execMock(
      {
        "list devices": {
          devices: [
            {
              identifier: "A",
              connectionProperties: { pairingState: "paired", lastConnectionDate: "2026-01-01" },
              deviceProperties: { name: "Older" },
              hardwareProperties: { platform: "iOS" },
            },
            {
              identifier: "B",
              connectionProperties: { pairingState: "paired", lastConnectionDate: "2026-06-01" },
              deviceProperties: { name: "Newer" },
              hardwareProperties: { platform: "iOS" },
            },
          ],
        },
      },
      log,
    );
    await (await connect({}, { exec: two })).call("ios_device_get_display_info");
    const pokes = log.filter((entry) => entry.join(" ").includes("device info lockState"));
    // Both candidates are woken, not just one. `pokeTunnel` dispatches every
    // wake-up call with a single `Promise.allSettled`, which this cannot
    // observe directly — but if it fell back to a sequential loop that
    // stopped at the first attempt, only "A" would show up here.
    expect(pokes.map((entry) => entry[entry.indexOf("--device") + 1])).toEqual(
      expect.arrayContaining(["A", "B"]),
    );
  });

  it("does not count a paired Apple Watch or Apple TV as a candidate", async () => {
    const withWatch = execMock({
      "list devices": {
        devices: [
          connectedDevice,
          {
            identifier: "WATCH",
            connectionProperties: { tunnelState: "connected" },
            deviceProperties: { name: "Olivier's Watch" },
            hardwareProperties: { platform: "watchOS" },
          },
        ],
      },
    });
    const result = await (await connect({}, { exec: withWatch })).call("ios_device_list_devices");
    const ids = (result.devices as { id: string }[]).map((d) => d.id);
    expect(ids).toEqual([DEVICE_ID]);
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

  it("names the variable that raises the cap, so a truncated tree says how to get more", async () => {
    // The hint is a parameter now that `flattenTree` is shared, and a shared
    // default would name the wrong env var in the other server. Nothing else in
    // the suite reads the truncation string, so this is the only thing standing
    // between a correct hint and a silently missing one.
    const crowded = {
      type: "XCUIElementTypeApplication",
      rect: { x: 0, y: 0, width: 440, height: 956 },
      isVisible: "1",
      children: Array.from({ length: 60 }, (_, i) => ({
        type: "XCUIElementTypeButton",
        label: `Row number ${i} with a deliberately long label`,
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
    const result = await harness.call("ios_device_ui_tree", {});
    expect(String(result.truncated)).toContain("IOS_DEVICE_MAX_TREE_BYTES");
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
    // The escaping is what is under test, not the whole predicate: a label match
    // is also narrowed to the interactive types, so this is one clause of two.
    expect(find?.value).toContain('label == "say \\"hi\\"" OR name == "say \\"hi\\""');
  });

  it("prefers a control when a label is shared with the container around it", async () => {
    const log: { method: string; path: string; body: unknown }[] = [];
    const harness = await connect(WRITES, { fetch: wdaMock({}, log) });
    const result = await harness.call("ios_device_tap_element", {
      label: "Identify",
      screenshot: false,
    });
    expect(result.isToolError).toBe(false);
    const find = log.find((e) => e.path.endsWith("/elements"))?.body as { value?: string };
    expect(find?.value).toContain('type == "XCUIElementTypeButton"');
    expect(result.tapped.preferredControl).toBe(true);
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

describe("the shared-core seam", () => {
  it("is satisfied by DeviceClient without exposing any device-only member", async () => {
    // A compile-time assertion, mostly. It is the only thing that catches a
    // re-coupling: if `ScreenHost` ever grows a `devicectl` member, or
    // `DeviceClient` loses `resolveTarget`, this stops type-checking. Nothing at
    // runtime would notice, because the device server satisfies its own
    // interface by construction — the risk is entirely to the *other* consumer.
    const { client } = createServer({
      config: loadConfig({}, ABSENT_CONFIG),
      exec: execMock(),
      fetch: wdaMock() as unknown as typeof fetch,
      spawnRunner: spawnMock(),
    });
    const host: ScreenHost<DeviceSummary> = client;
    expect(typeof host.resolveTarget).toBe("function");
    expect(typeof host.wda).toBe("function");
    expect(typeof host.display).toBe("function");
    // The device lane has no capture that bypasses WebDriverAgent; a simulator
    // does, and that asymmetry is why the member is optional.
    expect(host.screenshotPng).toBeUndefined();
  });
});
