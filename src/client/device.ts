import { Devicectl, type DisplayInfo, type RawApp } from "#/client/devicectl";
import { DeviceNotFoundError, IosDeviceError } from "#/client/errors";
import { defaultExec, type ExecImpl, type Logger } from "#/client/exec";
import { summarizeDevice, type DeviceSummary } from "#/client/shape";
import { WdaClient } from "#/client/wda";

/**
 * The facade the tools talk to. It holds the one piece of knowledge neither lane
 * has on its own: which device we are talking about, and how to reach its screen.
 */
export type DeviceClientOptions = {
  xcrunPath: string;
  sipsPath: string;
  execTimeoutMs: number;
  wdaTimeoutMs: number;
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
    const devices = (await this.devicectl.listDevices()).map(summarizeDevice);
    this.deviceCache = { at: Date.now(), devices };
    return devices;
  }

  /**
   * Resolve a device from a hint, the configured default, or the fact that only
   * one is plugged in. Two connected devices and no hint is an error that lists
   * them: picking one would work most of the time and drive the wrong phone the
   * rest, which is the worse failure.
   */
  async resolveDevice(hint?: string): Promise<DeviceSummary> {
    const wanted = hint ?? this.opts.defaultDeviceId;
    const devices = await this.listDevices();

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
      return match;
    }

    const connected = devices.filter((d) => d.state === "connected");
    if (connected.length === 1) return connected[0] as DeviceSummary;
    if (connected.length === 0) {
      throw new DeviceNotFoundError(
        "No connected device.",
        devices.length === 0
          ? "Connect an iPhone or iPad by USB, unlock it, and trust this Mac."
          : `Devices are known but none has a live connection: ${devices
              .map((d) => `${d.name ?? "?"} (${d.state})`)
              .join(", ")}. Unlock the device and reconnect it.`,
      );
    }
    throw new DeviceNotFoundError(
      `${connected.length} devices are connected, so there is no obvious default.`,
      `Pass \`device\` (or set IOS_DEVICE_ID) to one of: ${connected
        .map((d) => `${d.name ?? "?"} = ${d.id}`)
        .join(", ")}.`,
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
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(this.opts.logger ? { logger: this.opts.logger } : {}),
    });
    this.wdaClients.set(url, client);
    return client;
  }
}
