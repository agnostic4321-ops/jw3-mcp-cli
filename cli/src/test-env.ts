/**
 * Test-run preload (`npm test` → `node --import ./dist/test-env.js --test …`).
 * `node --test` hands `--import` on to every test-file process, so both rules
 * below hold in each of them.
 *
 * 1. CONFIG HOME. Every test process gets a throwaway config home unless the
 *    caller already chose one, so no test reads or writes the operator's
 *    ~/.config/jw3 — credentials, state files, and the watchdog breaker that
 *    the live order gate reads on every opening order (OQ-12). A tripped
 *    breaker on the operator's machine must not turn the suite red, and a
 *    test must never write next to a real one.
 *
 * 2. NETWORK GUARD. A test must never reach production. The CLI talks to
 *    jw3.ai, the *.supabase.co mcp-server and the venues' public APIs
 *    (KuCoin, Polymarket, …), and the order path behind them moves real
 *    money. `fetch` and `WebSocket` therefore refuse every host that is not
 *    loopback — a list of production hosts would go stale the day a venue is
 *    added — and they refuse BEFORE anything is sent, so a stray request fails
 *    fast and identically with or without a network. A refusal throws
 *    `NetworkGuardError` and also prints one line to stderr, so a refusal the
 *    code under test swallows still shows in the log. Loopback stays open for
 *    tests that run a local server. A test that truly needs a real host opts
 *    in with `allowTestNetwork(reason, hosts)`; an opted-in request that
 *    carries an Authorization header is still refused, so an opt-in never
 *    carries a PAT.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

if (!process.env.JW3_CONFIG_HOME?.trim()) {
  process.env.JW3_CONFIG_HOME = mkdtempSync(join(tmpdir(), "jw3-test-config-"));
}

/** Thrown for every request the guard refuses. Nothing was sent. */
export class NetworkGuardError extends Error {
  readonly code = "JW3_TEST_NETWORK_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "NetworkGuardError";
  }
}

/** Opt-ins by exact hostname → the reason. One map per process. */
type GuardState = { optIns: Map<string, string> };

const STATE = Symbol.for("jw3.test-env.network-guard");
const holder = globalThis as unknown as Record<symbol, GuardState | undefined>;

/** Loopback only: localhost, *.localhost, 127.0.0.0/8, ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

function carriesAuthorization(headers: unknown): boolean {
  try {
    return new Headers(headers as ConstructorParameters<typeof Headers>[0]).has("authorization");
  } catch {
    return false; // malformed headers: the transport itself rejects them
  }
}

function note(line: string): void {
  process.stderr.write(`[jw3 test network guard] ${line}\n`);
}

/** The refusal message, or null when the request may go to the transport. */
function refusal(state: GuardState, kind: "fetch" | "WebSocket", rawUrl: string, hasAuth: boolean): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null; // not an absolute URL: the transport rejects it, nothing leaves
  }
  if (!/^(https?|wss?):$/.test(url.protocol)) return null; // data:, blob: never touch the network
  if (isLoopbackHost(url.hostname)) return null;
  const host = url.hostname.toLowerCase();
  // origin + path only (a query string is where keys travel), PATs redacted
  const where = `${url.protocol}//${url.host}${url.pathname}`.slice(0, 120).replace(/jw3_mcp_[A-Za-z0-9_-]+/g, "jw3_mcp_[REDACTED]");
  const from = relative(process.cwd(), process.argv[1] ?? "") || "the test process";
  const reason = state.optIns.get(host);
  if (reason !== undefined && !hasAuth) {
    note(`allowed ${kind} ${where} from ${from} (opt-in: ${reason})`);
    return null;
  }
  const why =
    reason !== undefined
      ? "the request carries an Authorization header, and an opt-in never carries a PAT"
      : "tests must not reach production (jw3.ai, *.supabase.co, venue public APIs) or any other non-loopback host";
  return (
    `refused ${kind} ${where} from ${from}: ${why}. Nothing was sent. ` +
    `Stub the transport, or opt in with allowTestNetwork(reason, ["${host}"]) from test-env.js, without a PAT.`
  );
}

function install(): GuardState {
  const state: GuardState = { optIns: new Map() };
  const realFetch = globalThis.fetch;
  const guardedFetch = ((input: unknown, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const rawUrl = req ? req.url : input instanceof URL ? input.href : String(input);
    const hasAuth = carriesAuthorization(init?.headers) || (req !== null && req.headers.has("authorization"));
    const refused = refusal(state, "fetch", rawUrl, hasAuth);
    if (refused) {
      note(refused);
      return Promise.reject(new NetworkGuardError(refused));
    }
    return Reflect.apply(realFetch, globalThis, [input, init]) as Promise<Response>;
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { ...Object.getOwnPropertyDescriptor(globalThis, "fetch"), value: guardedFetch });

  const ws = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  if (typeof ws?.value === "function") {
    const guardedWebSocket = new Proxy(ws.value as new (...args: unknown[]) => object, {
      construct(target, args, newTarget) {
        const opts = args[1] as { headers?: unknown } | undefined;
        const hasAuth = typeof opts === "object" && opts !== null && carriesAuthorization(opts.headers);
        const refused = refusal(state, "WebSocket", String(args[0]), hasAuth);
        if (refused) {
          note(refused);
          throw new NetworkGuardError(refused);
        }
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
    Object.defineProperty(globalThis, "WebSocket", { ...ws, value: guardedWebSocket });
  }
  return state;
}

// Installed once per process, even if this module is loaded under two URLs.
const guard: GuardState = (holder[STATE] ??= install());

/**
 * Explicit opt-in for a test that must reach a real host: `reason` is
 * required and printed with every request it lets through; `hosts` are exact
 * hostnames. A request carrying an Authorization header stays refused.
 * Returns the revoke function (call it in `after` / `finally`).
 */
export function allowTestNetwork(reason: string, hosts: readonly string[]): () => void {
  const why = reason.trim();
  if (!why) throw new Error("allowTestNetwork: a reason is required");
  const names = hosts.map((h) => h.trim().toLowerCase());
  if (names.length === 0 || names.some((h) => !h)) throw new Error("allowTestNetwork: name every host exactly");
  for (const h of names) guard.optIns.set(h, why);
  return () => {
    for (const h of names) guard.optIns.delete(h);
  };
}
