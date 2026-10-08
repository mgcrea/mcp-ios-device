// Crash reports, shaped.
//
// A `.ips` file is two JSON documents: a one-line header, then the report. The
// report for one crash of one system daemon was measured at 116 KB — `threads`
// for every thread with register state, `usedImages` for every loaded library,
// a VM summary, a code-signing block. What anyone reading a crash acts on is a
// small fraction of that: what was thrown, why the process was killed, and the
// faulting thread's frames with each image index already resolved to a name.
// That join (`frames[].imageIndex` → `usedImages[].name`) is exactly the kind a
// model can silently get wrong, so it is done here.

import type { RawFile } from "#/client/devicectl";

/**
 * `bug_type`, as the report types that come back from a real device. Only the
 * ones confirmed against file names on iOS 27.0 are named; the rest are kept
 * as their number rather than guessed at.
 */
const KINDS: Record<string, string> = {
  "109": "crash",
  "309": "crash",
  "298": "jetsam",
  "308": "user_fault",
  "202": "cpu_resource",
  "145": "disk_writes_resource",
  "211": "analytics",
};

/** What a person debugging an app means by "crash logs". */
export const DEFAULT_CRASH_KINDS = ["crash", "jetsam", "user_fault"];

export type CrashFileSummary = {
  /** The path every other crash tool takes. */
  name: string;
  process: string;
  kind: string;
  date: string | undefined;
  size: number | undefined;
};

/** `Retired/MyApp-2026-10-02-213409.ips` → `MyApp`. */
const processOf = (path: string): string => {
  const base = path.split("/").pop() ?? path;
  return base.replace(/-\d{4}-\d{2}-\d{2}-\d{6}.*$/, "").replace(/^ExcUserFault_/, "");
};

export const summarizeCrashFiles = (files: RawFile[]): CrashFileSummary[] =>
  files
    .filter((file) => !file.resources?.isDirectory && file.relativePath?.includes(".ips"))
    .map((file) => {
      const path = file.relativePath as string;
      const bugType = file.metadata?.extendedAttributes?.bug_type;
      return {
        name: path,
        process: processOf(path),
        kind: (bugType && KINDS[bugType]) ?? `bug_type_${bugType ?? "unknown"}`,
        date: file.metadata?.lastModDate,
        size: file.metadata?.size,
      };
    })
    .toSorted((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

type IpsFrame = {
  imageIndex?: number;
  imageOffset?: number;
  symbol?: string;
  symbolLocation?: number;
  sourceFile?: string;
  sourceLine?: number;
};

type IpsReport = {
  procName?: string;
  pid?: number;
  captureTime?: string;
  exception?: { type?: string; signal?: string; codes?: string; subtype?: string };
  termination?: { namespace?: string; code?: number; indicator?: string; reasons?: string[] };
  asi?: Record<string, string[]>;
  faultingThread?: number;
  threads?: { name?: string; queue?: string; frames?: IpsFrame[] }[];
  lastExceptionBacktrace?: IpsFrame[];
  usedImages?: { name?: string }[];
};

/** Frames kept per backtrace. The top is where the answer nearly always is. */
const MAX_FRAMES = 30;

const renderFrames = (frames: IpsFrame[], images: { name?: string }[]): string[] =>
  frames.slice(0, MAX_FRAMES).map((frame, index) => {
    const image = images[frame.imageIndex ?? -1]?.name ?? "???";
    const where = frame.symbol
      ? `${frame.symbol} + ${frame.symbolLocation ?? 0}`
      : `0x${(frame.imageOffset ?? 0).toString(16)}`;
    const source = frame.sourceFile ? ` (${frame.sourceFile}:${frame.sourceLine ?? "?"})` : "";
    return `${index} ${image} ${where}${source}`;
  });

/**
 * The parts of a report worth reading. Only a modern JSON `.ips` crash has a
 * `crash` section: a jetsam or resource report has no faulting thread, so it
 * comes back as its header alone and the caller points at the file.
 */
export const summarizeCrashReport = (
  text: string,
): { header: Record<string, unknown>; crash?: Record<string, unknown> } => {
  const newline = text.indexOf("\n");
  const header = JSON.parse(newline === -1 ? text : text.slice(0, newline)) as Record<
    string,
    unknown
  >;
  if (newline === -1) return { header };

  let report: IpsReport;
  try {
    report = JSON.parse(text.slice(newline + 1)) as IpsReport;
  } catch {
    return { header };
  }
  if (!report.threads) return { header };

  const images = report.usedImages ?? [];
  const faulting =
    report.faultingThread !== undefined ? report.threads[report.faultingThread] : undefined;
  return {
    header: {
      app: header["app_name"],
      bundleId: header["bundleID"],
      version: header["app_version"],
      build: header["build_version"],
      os: header["os_version"],
      timestamp: header["timestamp"],
      incident: header["incident_id"],
    },
    crash: {
      process: report.procName,
      pid: report.pid,
      exception: report.exception,
      termination: report.termination,
      // "Application Specific Information": where a Swift fatalError message,
      // a precondition failure or an assertion's text actually ends up.
      ...(report.asi ? { applicationSpecificInfo: report.asi } : {}),
      ...(report.lastExceptionBacktrace
        ? { lastExceptionBacktrace: renderFrames(report.lastExceptionBacktrace, images) }
        : {}),
      faultingThread: faulting
        ? {
            index: report.faultingThread,
            ...(faulting.name ? { name: faulting.name } : {}),
            ...(faulting.queue ? { queue: faulting.queue } : {}),
            frames: renderFrames(faulting.frames ?? [], images),
          }
        : undefined,
    },
  };
};
