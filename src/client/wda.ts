import { WdaError, WdaUnavailableError } from "#/client/errors";
import type { Logger } from "#/client/exec";

/**
 * WebDriverAgent, over plain HTTP.
 *
 * WDA is an XCTest runner that Apple's own frameworks drive, so it is the only
 * lane that can both *see* the screen (`/screenshot`, `/source`) and *touch* it,
 * with real synthesised events rather than blind pixel pokes. It is an ordinary
 * HTTP server on port 8100 of the device, which is what lets this entire server
 * stay TypeScript: the client is `fetch` and nothing else.
 *
 * Reaching it needs no port forwarding. A device CoreDevice has connected to is
 * already routable at its `tunnelIPAddress` over a `utun` interface, so
 * `http://[fd1f:…::1]:8100` resolves straight from this process. `baseUrl` is a
 * thunk rather than a string because that address is discovered per call and
 * changes when the tunnel is re-established.
 */
export type WdaOptions = {
  baseUrl: () => Promise<string>;
  timeoutMs: number;
  fetch?: typeof fetch;
  logger?: Logger | undefined;
};

export type WdaRect = { x: number; y: number; width: number; height: number };

/** WDA's own node shape from `GET /source?format=json`. */
export type WdaNode = {
  type?: string;
  name?: string | null;
  label?: string | null;
  value?: string | number | boolean | null;
  rawIdentifier?: string | null;
  rect?: WdaRect;
  isEnabled?: string | boolean;
  isVisible?: string | boolean;
  isAccessible?: string | boolean;
  children?: WdaNode[];
};

/** The W3C element handle key. WDA returns both this and the legacy `ELEMENT`. */
const W3C_ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

type WdaEnvelope<T> = { value?: T; sessionId?: string | null };

type WdaValueError = { error?: string; message?: string; traceback?: string };

export type Locator =
  | "accessibility id"
  | "class name"
  | "predicate string"
  | "link text"
  | "xpath";

export class WdaClient {
  private readonly baseUrl: () => Promise<string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  /**
   * One session, created lazily and reused. Creating one per call is what makes
   * a WDA-backed driver feel slow — session setup is the expensive part, and a
   * stale one is cheap to detect and recreate.
   */
  private sessionId: string | undefined;

  constructor(opts: WdaOptions) {
    this.baseUrl = opts.baseUrl;
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const base = await this.baseUrl();
    const url = `${base.replace(/\/$/, "")}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.logger?.debug?.("wda", method, path);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        signal: controller.signal,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
    } catch (err) {
      // A refused connection and an aborted one mean the same thing to the
      // caller — the runner is not up — and neither is worth a retry, so they
      // are named rather than surfaced as a bare TypeError from undici.
      const cause =
        err instanceof Error
          ? err.name === "AbortError"
            ? `no answer in ${this.timeoutMs}ms`
            : err.message
          : String(err);
      throw new WdaUnavailableError(base, cause);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let envelope: WdaEnvelope<T>;
    try {
      envelope = JSON.parse(text) as WdaEnvelope<T>;
    } catch {
      throw new WdaError(
        `WebDriverAgent returned non-JSON on ${method} ${path}: ${text.slice(0, 300)}`,
        {
          status: res.status,
        },
      );
    }

    // WDA reports application-level failures inside `value` on a 200 as often as
    // it does with a non-2xx status, so both have to be checked or half the
    // errors come back looking like successes.
    const failure = asValueError(envelope.value);
    if (!res.ok || failure) {
      throw new WdaError(
        `WebDriverAgent ${method} ${path} failed: ${failure?.message ?? failure?.error ?? res.statusText}`,
        {
          status: res.status,
          ...(failure?.error ? { wdaCode: failure.error } : {}),
          ...(remedyForWdaError(failure?.error)
            ? { remedy: remedyForWdaError(failure?.error)! }
            : {}),
        },
      );
    }
    if (envelope.sessionId) this.sessionId = envelope.sessionId;
    return envelope.value as T;
  }

  /** `GET /status` — session-less, and the one call that says whether WDA is alive. */
  async status(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/status");
  }

  /**
   * Attach a session to whatever is in the foreground, reusing the cached one.
   * An empty `alwaysMatch` deliberately does not name a bundle id: that would
   * relaunch the app under test and throw away the state we were sent here to
   * look at.
   */
  private async session(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const value = await this.request<{ sessionId?: string }>("POST", "/session", {
      capabilities: { alwaysMatch: {} },
    });
    const id = value?.sessionId ?? this.sessionId;
    if (!id) {
      throw new WdaError("WebDriverAgent created a session but returned no session id.", {
        status: 200,
        remedy: "Restart the WebDriverAgent runner on the device.",
      });
    }
    this.sessionId = id;
    return id;
  }

  /**
   * Run a session-scoped call, recreating the session once if WDA has forgotten
   * it. Sessions die when the runner restarts or the device locks, and without
   * this every such event turns into a manual reconnect.
   */
  private async withSession<T>(fn: (sessionId: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.session());
    } catch (err) {
      if (!(err instanceof WdaError) || !isStaleSession(err)) throw err;
      this.logger?.warn?.("wda session expired, recreating");
      this.sessionId = undefined;
      return fn(await this.session());
    }
  }

  /** Base64 PNG of the whole screen, in device *pixels*. Works without a session. */
  async screenshot(): Promise<string> {
    return this.request<string>("GET", "/screenshot");
  }

  /** The full accessibility hierarchy. Rects are in *points*, not pixels. */
  async source(): Promise<WdaNode> {
    return this.request<WdaNode>("GET", "/source?format=json");
  }

  /** Logical screen size in points — the space every coordinate below is in. */
  async windowSize(): Promise<{ width: number; height: number }> {
    return this.withSession((id) =>
      this.request<{ width: number; height: number }>("GET", `/session/${id}/window/size`),
    );
  }

  /**
   * A single touch, expressed as a W3C pointer action rather than WDA's older
   * `/wda/tap` shortcut. The W3C path is the one that survived every WDA
   * rewrite, and it expresses tap, long-press and swipe as the same primitive
   * with different pauses.
   */
  async pointer(actions: PointerAction[]): Promise<void> {
    await this.withSession((id) =>
      this.request<unknown>("POST", `/session/${id}/actions`, {
        actions: [
          {
            type: "pointer",
            id: "finger1",
            parameters: { pointerType: "touch" },
            actions,
          },
        ],
      }),
    );
  }

  /** Type into whatever currently has keyboard focus. */
  async keys(text: string): Promise<void> {
    await this.withSession((id) =>
      this.request<unknown>("POST", `/session/${id}/wda/keys`, { value: [...text] }),
    );
  }

  async pressButton(name: string): Promise<void> {
    await this.withSession((id) =>
      this.request<unknown>("POST", `/session/${id}/wda/pressButton`, { name }),
    );
  }

  /** Find elements. Returns opaque WDA element uuids, valid until the tree changes. */
  async findElements(using: Locator, value: string): Promise<string[]> {
    const found = await this.withSession((id) =>
      this.request<Record<string, string>[]>("POST", `/session/${id}/elements`, { using, value }),
    );
    return (found ?? [])
      .map((entry) => entry[W3C_ELEMENT_KEY] ?? entry["ELEMENT"])
      .filter((uuid): uuid is string => typeof uuid === "string");
  }

  async elementRect(uuid: string): Promise<WdaRect> {
    return this.withSession((id) =>
      this.request<WdaRect>("GET", `/session/${id}/element/${encodeURIComponent(uuid)}/rect`),
    );
  }

  async click(uuid: string): Promise<void> {
    await this.withSession((id) =>
      this.request<unknown>("POST", `/session/${id}/element/${encodeURIComponent(uuid)}/click`, {}),
    );
  }

  async setValue(uuid: string, text: string): Promise<void> {
    await this.withSession((id) =>
      this.request<unknown>("POST", `/session/${id}/element/${encodeURIComponent(uuid)}/value`, {
        value: [...text],
      }),
    );
  }

  /** Whatever alert is on screen, or undefined. Alerts silently eat taps. */
  async alertText(): Promise<string | undefined> {
    try {
      return await this.withSession((id) =>
        this.request<string>("GET", `/session/${id}/alert/text`),
      );
    } catch (err) {
      if (err instanceof WdaError) return undefined;
      throw err;
    }
  }
}

export type PointerAction =
  | { type: "pointerMove"; duration: number; x: number; y: number; origin?: string }
  | { type: "pointerDown"; button: number }
  | { type: "pointerUp"; button: number }
  | { type: "pause"; duration: number };

const asValueError = (value: unknown): WdaValueError | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as WdaValueError;
  return typeof record.error === "string" ? record : undefined;
};

const isStaleSession = (err: WdaError): boolean =>
  err.wdaCode === "invalid session id" ||
  err.wdaCode === "no such session" ||
  err.message.includes("Session does not exist");

const remedyForWdaError = (code: string | undefined): string | undefined => {
  switch (code) {
    case "no such element":
      return "Call ios_device_ui_tree to see what is actually on screen — the element may not have appeared yet.";
    case "unexpected alert open":
      return "A system alert is on screen and is swallowing input. Dismiss it before retrying.";
    case "invalid element state":
      return "The element exists but cannot accept this action right now (disabled, or off screen).";
    default:
      return undefined;
  }
};
