import { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "#/build-info";
import { DeviceClient } from "#/client/device";
import type { ExecImpl, Logger } from "#/client/exec";
import type { Config } from "#/config";
import { registerTools } from "#/tools/index";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;

export type CreateServerOptions = {
  config: Config;
  /** Override the process boundary (tests): `xcrun` and `sips` never actually run. */
  exec?: ExecImpl;
  /** Override HTTP to WebDriverAgent (tests). */
  fetch?: typeof fetch;
  logger?: Logger;
};

export type CreatedServer = {
  server: McpServer;
  client: DeviceClient;
};

/**
 * A pure factory. The two injectable seams — `exec` and `fetch` — are the whole
 * reason the test suite can drive real tools through the real SDK with no
 * device, no Xcode and no WebDriverAgent. Nothing below `config.ts` reads
 * `process.env`.
 */
export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const client = new DeviceClient({
    xcrunPath: config.xcrunPath,
    sipsPath: config.sipsPath,
    execTimeoutMs: config.execTimeoutMs,
    wdaTimeoutMs: config.wdaTimeoutMs,
    wdaPort: config.wdaPort,
    ...(config.wdaUrl ? { wdaUrl: config.wdaUrl } : {}),
    ...(config.deviceId ? { defaultDeviceId: config.deviceId } : {}),
    ...(opts.exec ? { exec: opts.exec } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  registerTools(server, client, { config, allowWrites: config.allowWrites });

  return { server, client };
};
