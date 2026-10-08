import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { DEFAULT_CRASH_KINDS, summarizeCrashFiles, summarizeCrashReport } from "#/client/crash";
import type { DeviceClient } from "#/client/device";
import { IosDeviceError } from "#/client/errors";
import type { ToolContext } from "#/tools/index";
import { deviceArg, wrap } from "#/tools/util";

/**
 * Crash reports: the half of "logs" that needs nothing launched. Observing, so
 * registered whatever the write gate says — reading a report changes nothing
 * on the device, the same way a screenshot does not.
 */
export const registerCrashLogTools = (
  server: McpServer,
  client: DeviceClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "ios_device_list_crash_logs",
    {
      title: "iOS Device: List Crash Logs",
      description:
        "List the crash reports on the device, newest first — the same reports Xcode's Devices " +
        "window shows, read without root. Defaults to crashes, jetsam (memory-pressure kills) " +
        "and user faults; the device also keeps hundreds of analytics and resource reports, " +
        "which `kinds` can include. Pass `process` to find one app's crashes, then read one with " +
        "ios_device_get_crash_log. For an app's live log output, use ios_device_read_logs.",
      inputSchema: z.object({
        device: deviceArg,
        process: z
          .string()
          .optional()
          .describe(
            'Case-insensitive substring of the process name, e.g. "Canopy". This is the app\'s ' +
              "executable name, which is usually but not always its display name.",
          ),
        kinds: z
          .array(z.string())
          .optional()
          .describe(
            'Report kinds to include, e.g. ["crash"]. Defaults to ["crash", "jetsam", ' +
              '"user_fault"]. Others seen on devices: "cpu_resource", "disk_writes_resource", ' +
              '"analytics", and "bug_type_<n>" for types without a name. Pass ["all"] for everything.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(20)
          .describe("Maximum reports to return, newest first (1-200). Defaults to 20."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ device, process, kinds, limit }) =>
      wrap(async () => {
        const target = await client.resolveDevice(device);
        const wanted = kinds ?? DEFAULT_CRASH_KINDS;
        const needle = process?.toLowerCase();
        const all = summarizeCrashFiles(await client.devicectl.listCrashFiles(target.id));
        const matching = all.filter(
          (report) =>
            (wanted.includes("all") || wanted.includes(report.kind)) &&
            (!needle || report.process.toLowerCase().includes(needle)),
        );
        return {
          device: target.name ?? target.id,
          reports: matching.slice(0, limit),
          total: matching.length,
        };
      }),
  );

  server.registerTool(
    "ios_device_get_crash_log",
    {
      title: "iOS Device: Get Crash Log",
      description:
        "Copy one crash report off the device and return what matters in it: the exception, " +
        "why the process was terminated, any application-specific message (where a Swift " +
        "fatalError or precondition text ends up), and the faulting thread's top frames with " +
        "library names resolved. The full report is saved locally and its path returned; it " +
        "is often over 100 KB, so read it only when the summary is not enough. Symbols for " +
        "your own code appear only if the build kept them — a stripped release build shows " +
        "addresses that need its dSYM.",
      inputSchema: z.object({
        device: deviceArg,
        name: z
          .string()
          .regex(
            /^[^/][^\0]*\.ips[^/]*$/,
            "Pass a `name` exactly as ios_device_list_crash_logs returned it.",
          )
          .refine((value) => !value.split("/").includes(".."), "`name` cannot contain `..`.")
          .describe(
            'The report\'s `name` from ios_device_list_crash_logs, e.g. "Canopy-2026-10-08-101500.ips" ' +
              'or "Retired/Canopy-2026-10-02-213409.ips". Older reports move under Retired/.',
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ device, name }) =>
      wrap(async () => {
        const target = await client.resolveDevice(device);
        const dir = join(ctx.config.outputDir, "crash-logs");
        await mkdir(dir, { recursive: true });
        const destination = join(dir, basename(name));
        await client.devicectl.copyCrashFile(target.id, { source: name, destination });
        let text: string;
        try {
          text = await readFile(destination, "utf8");
        } catch {
          throw new IosDeviceError(`devicectl reported no error, but ${name} did not arrive.`, {
            remedy: "Run ios_device_list_crash_logs again; reports move to Retired/ once synced.",
          });
        }
        const summary = summarizeCrashReport(text);
        return {
          name,
          path: destination,
          ...summary,
          ...(summary.crash
            ? {}
            : { note: "Not a crash report with a faulting thread; read the file at `path`." }),
        };
      }),
  );
};

/**
 * Reading an app's captured console. Registered with the launch tool it depends
 * on, behind the write gate: without `ios_device_launch` there is never anything
 * to read.
 */
export const registerConsoleLogTools = (server: McpServer, client: DeviceClient): void => {
  server.registerTool(
    "ios_device_read_logs",
    {
      title: "iOS Device: Read Logs",
      description:
        "Read an app's live log output: stdout, stderr, and every Logger/os_log message the " +
        "process emits, its frameworks' included. Only available for an app started with " +
        "ios_device_launch `capture_logs: true` — iOS gives no other way to a device's logs " +
        "without root. Returns the newest `limit` lines plus a `next` cursor; pass it back to " +
        "get only what arrived since, which is how to see what one tap logged. The capture ends " +
        "when the app exits, and what it gathered stays readable. For crashes, see " +
        "ios_device_list_crash_logs — a crash ends the capture but its backtrace is not in it.",
      inputSchema: z.object({
        device: deviceArg,
        bundle_id: z
          .string()
          .optional()
          .describe(
            'Which app\'s capture, e.g. "io.mgcrea.Canopy". Defaults to the most recent capture.',
          ),
        cursor: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "The `next` value from the previous read, to get only newer lines. Omit to read " +
              "from the start of the capture.",
          ),
        filter: z
          .string()
          .optional()
          .describe(
            'Case-insensitive regular expression a line must match, e.g. "error|fail" or ' +
              '"\\[Sync\\]". Applied before `limit`, so it finds matches across the whole range.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .default(200)
          .describe(
            "Most lines to return; the newest are kept and the rest counted in `omitted`. " +
              "Defaults to 200 — a chatty app logs that many in a second, so filter rather than " +
              "raising this.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ device, bundle_id, cursor, filter, limit }) =>
      wrap(async () => {
        // Resolved only when named: a capture outlives its device's tunnel, and
        // reading a file on this Mac should not fail because the phone slept.
        const target = device ? await client.resolveDevice(device) : undefined;
        const capture = client.consoles.find(target?.id, bundle_id);
        if (!capture) {
          throw new IosDeviceError(
            bundle_id ? `No log capture for ${bundle_id}.` : "No log capture is running.",
            {
              remedy:
                "Start one with ios_device_launch and `capture_logs: true`. A capture belongs to " +
                "this server process, so one started before it restarted is gone.",
            },
          );
        }
        const result = await client.consoles.read(capture, { cursor, filter, limit });
        const running = client.consoles.running(capture);
        return {
          bundleId: capture.bundleId,
          device: capture.deviceName ?? capture.device,
          capturing: running,
          ...(running ? {} : { exitCode: capture.exitCode }),
          ...result,
          path: capture.path,
          ...(result.skippedBytes > 0
            ? {
                note:
                  `${result.skippedBytes} bytes before this window were not read. Pass the ` +
                  "returned `next` sooner, or read the file at `path`.",
              }
            : {}),
        };
      }),
  );
};
