import { Devicectl, type DisplayInfo, type RawApp } from "#/client/devicectl";
import { DeviceNotFoundError, IosDeviceError } from "#/client/errors";
import { defaultExec, type ExecImpl, type Logger } from "#/client/exec";
import { summarizeDevice, type DeviceSummary } from "#/client/shape";
import { DEVICE_WDA_REMEDIES, WdaClient } from "#/client/wda";

/**
 * The facade the tools talk to. It holds the one piece of knowledge neither lane
 * has on its own: which device we are talking about, and how to reach its screen.
 */
export type DeviceClientOptions = {
  xcrunPath: string;
  sipsPath: string;
  execTimeoutMs: number;
  wdaTimeoutMs: number;
  /** Budget for a single wake-up poke — short, since it runs against every dormant device at once. */
  warmTimeoutMs: number;
  wdaPort: number;
  /** Explicit override; unset means "derive from the CoreDevice tunnel". */
  wdaUrl?: string | undefined;
  defaultDeviceId?: string | undefined;
  exec?: ExecImpl | undefined;
  fetch?: typeof fetch | undefined;
  logger?: Logger | undefined;
};

export class DeviceClient {
  readonly devicectl: Devicectl;
  readonly exec: ExecImpl;
  readonly sipsPath: string;
  readonly execTimeoutMs: number;
  private readonly warmTimeoutMs: number;
  private readonly opts: DeviceClientOptions;
  private readonly wdaClients = new Map<string, WdaClient>();
  /**
   * `xcrun devicectl list devices` costs the better part of a second and nearly
   * every tool needs it twice — once to resolve the device, once for its
   * geometry. A 2s window collapses that without letting a device that was
   * unplugged mid-conversation look connected for long.
   */
  private deviceCache: { at: number; devices: DeviceSummary[] } | undefined;

  constructor(opts: DeviceClientOptions) {
    this.opts = opts;
    this.exec = opts.exec ?? defaultExec;
    this.sipsPath = opts.sipsPath;
    this.execTimeoutMs = opts.execTimeoutMs;
    this.warmTimeoutMs = opts.warmTimeoutMs;
    this.devicectl = new Devicectl({
      xcrunPath: opts.xcrunPath,
      timeoutMs: opts.execTimeoutMs,
      ...(opts.exec ? { exec: opts.exec } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
  }

  async listDevices(opts: { fresh?: boolean } = {}): Promise<DeviceSummary[]> {
    const cached = this.deviceCache;
    if (!opts.fresh && cached && Date.now() - cached.at < 2000) return cached.devices;
    const raw = await this.devicectl.listDevices();
    // devicectl reports every paired Apple device, not just iPhones and iPads —
    // a paired Apple Watch or Apple TV comes back in the same list, with the
    // same `connected`/`paired` states this server otherwise reads as "a
    // candidate". Filtered here, once, rather than at every call site, so
    // nothing downstream — resolution, the wake-up below, ios_device_list_devices
    // — has to know this server only drives one platform.
    const devices = raw
      .filter((device) => device.hardwareProperties?.platform === "iOS")
      .map(summarizeDevice);
    this.deviceCache = { at: Date.now(), devices };
    return devices;
  }

  /**
   * Make CoreDevice service one or more devices, then report what the fleet
   * looks like afterwards.
   *
   * `devicectl list devices` only reads CoreDevice's cached record. It never
   * contacts a device, so a tunnel that is down stays down however often it is
   * polled — a phone reached over Wi-Fi drops its tunnel when idle and reads
   * `disconnected` between calls, which is how this server came to report "no
   * connected device" about a phone sitting unlocked on the desk. Every
   * `devicectl device info …` call is the opposite: it acquires a usage
   * assertion, and that assertion is what makes CoreDevice build the tunnel
   * back up. It is the same signal Xcode's Devices window holds for as long as
   * it stays open, so "open Xcode once" was never really about Xcode.
   *
   * `lockState` is the cheapest of those calls — measured at ~0.2s against a
   * healthy device — and its answer is discarded here; only the assertion
   * matters. It is run against every candidate **in parallel** rather than one
   * at a time: `warmTimeoutMs` is short precisely so a device that is genuinely
   * gone fails fast, and paying that cost sequentially per candidate would make
   * resolving against three paired-but-dormant devices three times slower than
   * against one. Failures are swallowed — a device CoreDevice cannot even
   * locate answers this with `unable to locate a device`, which is not
   * something a poke can rescue — and the fresh read afterward is the honest
   * answer either way.
   *
   * The assertion dies with the process holding it, so this brings a tunnel up
   * and does not keep it up: a device that drops repeatedly needs something
   * long-running to hold one open, not a second poke.
   */
  async pokeTunnel(devices: DeviceSummary | readonly DeviceSummary[]): Promise<DeviceSummary[]> {
    const targets = Array.isArray(devices) ? devices : [devices];
    await Promise.allSettled(
      targets.map((device) =>
        this.devicectl.lockState(device.id, { timeoutMs: this.warmTimeoutMs }),
      ),
    );
    return this.listDevices({ fresh: true });
  }

  /**
   * `ScreenHost.resolveTarget`, which is `resolveDevice` under the name the
   * shared tools know it by.
   *
   * An alias rather than a rename: `resolveDevice` says what it does in this
   * server and is used throughout it, while the shared screen and input tools
   * cannot know that a target is a device at all. This one line is the entire
   * cost of `DeviceClient` satisfying `ScreenHost<DeviceSummary>`.
   */
  async resolveTarget(hint?: string): Promise<DeviceSummary> {
    return this.resolveDevice(hint);
  }

  /**
   * Resolve a device from a hint, the configured default, or the fact that only
   * one is plugged in.
   *
   * "Connected" is not read as a fixed fact about the world: a paired device
   * whose tunnel is merely idle gets one wake-up attempt before this gives up
   * on it, because `listDevices` is a passive read that can never notice a
   * phone sitting unlocked on the desk (see `pokeTunnel`). What still refuses
   * to guess is which device to drive when more than one answers — two devices
   * connected, or two devices waking up, is an error that lists them: picking
   * one would work most of the time and drive the wrong phone the rest, which
   * is the worse failure.
   */
  async resolveDevice(hint?: string): Promise<DeviceSummary> {
    const wanted = hint ?? this.opts.defaultDeviceId;
    let devices = await this.listDevices();

    if (wanted) {
      const match = devices.find((d) => d.id === wanted || d.udid === wanted || d.name === wanted);
      if (!match) {
        throw new DeviceNotFoundError(
          `No device matches "${wanted}".`,
          devices.length === 0
            ? "No devices are known to CoreDevice at all. Connect the device by USB and trust this Mac."
            : `Known devices: ${devices.map((d) => `${d.name ?? "?"} (${d.id})`).join(", ")}.`,
        );
      }
      // Named devices are returned even when dormant — plenty of tools
      // (list_apps, install) need no tunnel at all — but a wake-up attempt
      // first means one that does need it, like a screenshot, is more likely
      // to just work rather than fail downstream blaming a tunnel that a
      // one-line poke would have brought up.
      if (match.tunnel.state !== "connected") {
        const refreshed = await this.pokeTunnel(match);
        return refreshed.find((d) => d.id === match.id) ?? match;
      }
      return match;
    }

    const connected = devices.filter((d) => d.state === "connected");
    if (connected.length === 1) return connected[0] as DeviceSummary;
    if (connected.length > 1) {
      throw new DeviceNotFoundError(
        `${connected.length} devices are connected, so there is no obvious default.`,
        `Pass \`device\` (or set IOS_DEVICE_ID) to one of: ${connected
          .map((d) => `${d.name ?? "?"} = ${d.id}`)
          .join(", ")}.`,
      );
    }

    // Nothing already has a live tunnel. Rather than reporting that as "no
    // device" — the bug this method used to have — every paired-but-dormant
    // device gets one wake-up attempt, most-recently-seen first, before this
    // gives up. `pokeTunnel` runs them in parallel, so this costs one slow
    // call rather than one per candidate.
    const dormant = devices
      .filter((d) => d.state === "paired")
      .toSorted((a, b) => (b.lastConnectionDate ?? "").localeCompare(a.lastConnectionDate ?? ""));

    if (dormant.length === 0) {
      throw new DeviceNotFoundError(
        "No connected device.",
        devices.length === 0
          ? "Connect an iPhone or iPad by USB, unlock it, and trust this Mac."
          : `Devices are known but none is paired or connected: ${devices
              .map((d) => `${d.name ?? "?"} (${d.state})`)
              .join(", ")}. Unlock the device and reconnect it.`,
      );
    }

    devices = await this.pokeTunnel(dormant);
    const reachable = devices.filter((d) => d.state === "connected");
    if (reachable.length === 1) return reachable[0] as DeviceSummary;
    if (reachable.length > 1) {
      throw new DeviceNotFoundError(
        `${reachable.length} devices answered, so there is no obvious default.`,
        `Pass \`device\` (or set IOS_DEVICE_ID) to one of: ${reachable
          .map((d) => `${d.name ?? "?"} = ${d.id}`)
          .join(", ")}.`,
      );
    }
    throw new DeviceNotFoundError(
      "No reachable device.",
      `${dormant.length === 1 ? "The paired device" : "Every paired device"} failed to wake up: ${dormant
        .map((d) => `${d.name ?? "?"}`)
        .join(", ")}. A usage assertion was already acquired against ` +
        `${dormant.length === 1 ? "it" : "each of them"} and did not bring a tunnel up, so this is ` +
        "not one that merely needed waking. Unlock it, and check it is on this Mac's network or " +
        "plugged in by USB — or run `xcrun xcdevice list --timeout 5` to drive the same discovery " +
        "Xcode's Devices window does. Opening Xcode once is the last resort.",
    );
  }

  async display(device: DeviceSummary): Promise<DisplayInfo> {
    return this.devicectl.displays(device.id);
  }

  async apps(device: DeviceSummary, opts: { includeAll?: boolean } = {}): Promise<RawApp[]> {
    return this.devicectl.listApps(device.id, opts);
  }

  /**
   * The pid of a running app, by bundle id.
   *
   * `devicectl device process terminate` takes a pid and nothing else, and the
   * process list carries only an executable URL — so the join goes through the
   * app's own bundle path, which `device info apps` reports exactly. Matching on
   * the executable name instead would be one ambiguity away from killing a
   * system process that happens to share it.
   */
  async pidFor(device: DeviceSummary, bundleId: string): Promise<number | undefined> {
    const app = (await this.devicectl.listApps(device.id, { includeAll: true })).find(
      (candidate) => candidate.bundleIdentifier === bundleId,
    );
    if (!app?.url) return undefined;
    const prefix = app.url.endsWith("/") ? app.url : `${app.url}/`;
    const process = (await this.devicectl.listProcesses(device.id)).find((candidate) =>
      candidate.executable?.startsWith(prefix),
    );
    return process?.processIdentifier;
  }

  /**
   * Where WebDriverAgent is. An explicit `IOS_DEVICE_WDA_URL` wins, because
   * someone forwarding the port themselves has a reason to; otherwise it is the
   * device's own tunnel address, which needs no setup and no extra process.
   */
  wdaUrlFor(device: DeviceSummary): string {
    if (this.opts.wdaUrl) return this.opts.wdaUrl;
    const address = device.tunnel.address;
    if (!address) {
      throw new IosDeviceError(
        `${device.name ?? device.id} has no CoreDevice tunnel address, so WebDriverAgent cannot be reached.`,
        {
          remedy:
            "Open Xcode once with the device connected to bring the tunnel up (tunnelState must be " +
            "`connected`), or forward port 8100 yourself and set IOS_DEVICE_WDA_URL.",
        },
      );
    }
    // An IPv6 literal has to be bracketed in a URL, and the tunnel address
    // always is one.
    const host = address.includes(":") ? `[${address}]` : address;
    return `http://${host}:${this.opts.wdaPort}`;
  }

  /**
   * One WDA client per device, cached so its session is reused. A fresh client
   * per call would create a fresh XCTest session per call, which is the single
   * slowest thing this server can do.
   */
  wda(device: DeviceSummary): WdaClient {
    const url = this.wdaUrlFor(device);
    const existing = this.wdaClients.get(url);
    if (existing) return existing;
    const client = new WdaClient({
      baseUrl: async () => url,
      timeoutMs: this.opts.wdaTimeoutMs,
      remedies: DEVICE_WDA_REMEDIES,
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(this.opts.logger ? { logger: this.opts.logger } : {}),
    });
    this.wdaClients.set(url, client);
    return client;
  }
}
