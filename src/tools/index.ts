import type { McpServer } from "@modelcontextprotocol/server";

import type { DeviceClient } from "#/client/device";
import type { Config } from "#/config";
import { registerAppTools } from "#/tools/app";
import { registerDiagnosticsTools } from "#/tools/diagnostics";
import { registerInputTools } from "#/tools/input";
import { registerInspectTools } from "#/tools/inspect";
import { registerRunnerTools, type SpawnRunner } from "#/tools/runner";

export type ToolContext = {
  config: Config;
  /** Register the tools that drive the device too. Off by default — see IOS_DEVICE_ALLOW_WRITES. */
  allowWrites: boolean;
};

/**
 * All capability decisions in one place, so "why can't I call that" is answered
 * by one file.
 *
 * The split is observe versus drive. Observing — what is connected, what is
 * installed, what the screen looks like, what is on it — is always registered,
 * including when there is no device at all: a server that answers "no device is
 * connected, here is how to fix it" is worth far more than one that closes the
 * connection. Driving is registered only when writes are enabled, and then it is
 * not merely refused but **absent** from tools/list, because a refusal still
 * lets a model try, retry and reason about a way around it.
 *
 * There is no credential gate here because there are no credentials. What gates
 * the screen lane instead is whether WebDriverAgent answers, and that is a
 * runtime fact reported by ios_device_diagnostics rather than a registration
 * decision — the runner can start and stop while this server is connected, and a
 * tool that vanished at startup would never come back.
 */
export const registerTools = (
  server: McpServer,
  client: DeviceClient,
  ctx: ToolContext,
  spawnRunner?: SpawnRunner,
): void => {
  registerDiagnosticsTools(server, client, ctx);
  registerInspectTools(server, client, ctx);

  if (!ctx.allowWrites) return;

  registerInputTools(server, client, ctx);
  registerAppTools(server, client, ctx);
  // Write-gated with the rest: it kills a process the user may be watching
  // and starts one that outlives this server.
  registerRunnerTools(server, client, ctx, spawnRunner);
};
