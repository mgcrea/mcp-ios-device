// Crash reports as the device lists them. Reading and shaping one report is
// transport-free and lives in `@mgcrea/mcp-ios-core` (`summarizeCrashReport`);
// what is left here is the half only `devicectl device info files` produces.

import { crashKind, crashProcessName } from "@mgcrea/mcp-ios-core";

import type { RawFile } from "#/client/devicectl";

export { DEFAULT_CRASH_KINDS, summarizeCrashReport } from "@mgcrea/mcp-ios-core";

export type CrashFileSummary = {
  /** The path every other crash tool takes. */
  name: string;
  process: string;
  kind: string;
  date: string | undefined;
  size: number | undefined;
};

export const summarizeCrashFiles = (files: RawFile[]): CrashFileSummary[] =>
  files
    .filter((file) => !file.resources?.isDirectory && file.relativePath?.includes(".ips"))
    .map((file) => {
      const path = file.relativePath as string;
      const bugType = file.metadata?.extendedAttributes?.bug_type;
      return {
        name: path,
        process: crashProcessName(path),
        kind: crashKind(bugType),
        date: file.metadata?.lastModDate,
        size: file.metadata?.size,
      };
    })
    .toSorted((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
