#!/usr/bin/env node
/**
 * jw3 — JW3.ai command line. Thin wrapper over the mcp-server JSON-RPC
 * surface. Read-only by default; proposals go to the Diary for in-app
 * approve-and-sign. Never executes, never touches keys.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdAuth } from "./commands/auth.js";
import { cmdMarketsEnding } from "./commands/markets.js";
import { cmdAnalyze, cmdAnalyzeTrend } from "./commands/analyze.js";
import { cmdGrid, cmdGridBacktest } from "./commands/grid.js";
import { cmdBacktestScalp } from "./commands/backtest-scalp.js";
import { cmdLive, liveModelDeps } from "./commands/live-cmd.js";
import { cmdWatchdogCheck, cmdWatchdogResume, cmdWatchdogRun } from "./commands/watchdog.js";
import { cmdMonitor, DEFAULT_MONITOR_THRESHOLDS } from "./commands/monitor.js";
import { cmdAlert } from "./commands/alert.js";
import { cmdLearningRecord, cmdLearningStats } from "./commands/learning.js";
import { cmdBacktestLive } from "./commands/backtest-live.js";
import { cmdDaemon, loadDaemonManifest } from "./commands/daemon.js";
import { resolvePat } from "./config.js";
import { cmdFarmLeaderboard, cmdFarmRun } from "./commands/farm.js";
import {
  PAPER_USAGE,
  cmdPaperCreate,
  cmdPaperExecute,
  cmdPaperFills,
  cmdPaperFund,
  cmdPaperList,
  cmdPaperPnl,
  cmdPaperPositions,
  cmdPaperPromote,
  cmdPaperReset,
  cmdPaperTick,
} from "./commands/paper.js";
import { cmdPolyScan } from "./commands/poly.js";
import { cmdScalpKill, cmdScalpStart, cmdScalpWatch } from "./commands/scalp.js";
import { cmdScanFade, cmdScalpPlan } from "./commands/scan.js";
import { cmdForecast } from "./commands/forecast.js";
import { cmdIntel } from "./commands/intel.js";
import { cmdDecide } from "./commands/decide.js";
import { cmdDegen, cmdDegenRecord, cmdPaperStats } from "./commands/degen.js";
import { cmdTtm } from "./commands/ttm.js";
import { cmdSpikes } from "./commands/spikes.js";
import { cmdConnections, cmdDailyPrep, cmdDiary, cmdDiaryNote, cmdNews, cmdPropose, cmdRisk } from "./commands/extra.js";
import { cmdProposeBracket, cmdProposeCloseAll, cmdProposeIdea, cmdProposePredict } from "./commands/propose-cards.js";
import { cmdFills, cmdPnl } from "./commands/fills.js";
import { cmdPnlReconcile } from "./commands/pnl-reconcile.js";
import { cmdInsights } from "./commands/insights.js";
import {
  cmdBalances,
  cmdMarket,
  cmdOnchain,
  cmdOrderStatus,
  cmdOrders,
  cmdPositions,
  cmdScreener,
  validatePolls,
  validateWatchSec,
} from "./commands/market.js";
import { cmdCancel, cmdCancelAll, cmdClose, cmdExecute, cmdExits, parseTpLegsFlag } from "./commands/trade.js";
import { cmdExecuteChase, parseChaseFlags } from "./chase.js";
import { cmdTrail } from "./commands/trail.js";
import { cmdTick } from "./commands/tick.js";
import { BOUNCE_DEFAULT_LOOKBACK_MIN, BOUNCE_DEFAULT_PCT, cmdBounce } from "./bounce.js";
import { KLINES_DEFAULT_LIMIT, KLINES_DEFAULT_TF, cmdKlines } from "./commands/klines.js";
import { cmdLoop } from "./commands/loop.js";
import { cmdReserveSweep } from "./commands/reserve.js";
import { cmdReconcile } from "./commands/reconcile.js";
import { cmdHeat } from "./commands/heat.js";
import {
  DEFI_USAGE,
  cmdDefiBuild,
  cmdDefiMarkets,
  cmdDefiPositions,
  cmdDefiProtocols,
} from "./commands/defi.js";
import { clampInt, flagAny, flagOf, needNum, needNumAny, numAny, numOf, posAny, posOf, refusePaperFlag } from "./args.js";
import { helpFor, renderHelp } from "./help.js";

/**
 * CLI version, single-sourced from cli/package.json (never hardcoded, so
 * HELP cannot drift). The built CLI reads the file beside its own dist
 * dir; anything unreadable falls back to the last released version.
 */
function cliVersion(): string {
  try {
    const doc = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof doc.version === "string" && doc.version ? doc.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

/** Current CLI version (exported for the dispatch pins). */
export const CLI_VERSION = cliVersion();

const HELP = renderHelp(CLI_VERSION);

type Global = { url?: string; pat?: string; json: boolean; rest: string[] };

function globals(argv: string[]): Global {
  const out: Global = { json: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--url") out.url = argv[++i];
    else if (a === "--pat") {
      // Debug-only: the value leaks via shell history and the process list.
      // Warn here (real argv only) so library callers and --json output stay clean.
      console.error("Note: --pat is debug-only (visible in shell history and ps); prefer pipe, JW3_MCP_PAT env, or browser login.");
      out.pat = argv[++i];
    }
    else if (a === "--json") out.json = true;
    else if (a.startsWith("--url=")) out.url = a.slice(6);
    else if (a.startsWith("--pat=")) {
      console.error("Note: --pat is debug-only (visible in shell history and ps); prefer pipe, JW3_MCP_PAT env, or browser login.");
      out.pat = a.slice(6);
    }
    else out.rest.push(a);
  }
  return out;
}

// Flag/number parsing lives in ./args.js (single copy, unit-tested).

/** One dispatch row: match on (cmd, sub), then run with the raw tail. */
type CliRoute = {
  match: (cmd: string, sub: string | undefined) => boolean;
  run: (cmd: string, sub: string | undefined, tail: string[]) => Promise<void>;
};

// Table-driven dispatch. Order matters exactly as before: guarded
// bare commands (diary, propose, cancel, pnl) sit above their space
// forms (diary note, propose idea, cancel all, pnl reconcile).
export const ROUTES: CliRoute[] = [
  {
    match: (cmd, sub) => cmd === "auth",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdAuth(sub ?? "", {
        pat: g.pat,
        url: g.url,
        browser: g.rest.includes("--browser"),
        scope: flagOf(g.rest, "--scope"),
        timeoutSec: flagOf(g.rest, "--timeout") ? Number(flagOf(g.rest, "--timeout")) : undefined,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "markets" && (sub === "ending" || sub === undefined),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const days = posOf(g.rest, "--days", 14);
      const minLiq = posOf(g.rest, "--min-liq", 10000);
      const limit = posOf(g.rest, "--limit", 25);
      if (
        !needNum(days, "--days", g.rest) ||
        !needNum(minLiq, "--min-liq", g.rest) ||
        !needNum(limit, "--limit", g.rest)
      ) {
        return;
      }
      await cmdMarketsEnding({ days, minLiq, limit: Math.min(limit, 100), json: g.json });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "analyze" && sub === "prediction",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const id = g.rest[0];
      if (!id) {
        console.error("Usage: jw3 analyze prediction <slug|conditionId|id> [--json]");
        process.exitCode = 2;
        return;
      }
      await cmdAnalyze({ id, json: g.json, url: g.url, pat: g.pat });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "analyze" && sub === "trend",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdAnalyzeTrend({
        exchange: flagOf(g.rest, "--exchange") ?? "",
        pair: flagOf(g.rest, "--pair") ?? "",
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "scalp" && (sub === "plan" || sub === "start" || sub === "watch" || sub === "kill" || sub === undefined),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const rest = g.rest.join(" ");
      const size = posOf(g.rest, "--size", 15);
      const steps = clampInt(numOf(g.rest, "--steps", 3), 1, 3);
      if (!needNum(size, "--size", g.rest) || !needNum(steps, "--steps", g.rest)) return;
      const pair = flagOf(g.rest, "--pair") ?? "";
      const direction = rest.includes("--short") ? "short" : "long";
      if (sub === "start") {
        if (refusePaperFlag(g.rest, "jw3 scalp start")) return;
        const lev = posAny(g.rest, 2, "--lev", "--leverage");
        if (!needNumAny(lev, g.rest, "--lev", "--leverage")) return;
        await cmdScalpStart(
          {
            exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
            pair,
            direction,
            sizeUsd: size,
            steps,
            leverage: lev,
          },
          { yes: tail.includes("--yes"), json: g.json, url: g.url, pat: g.pat },
        );
        return;
      }
      if (sub === "watch") {
        const polls = clampInt(numOf(g.rest, "--polls", 30), 1, 360);
        const interval = posOf(g.rest, "--interval", 10);
        if (!needNum(polls, "--polls", g.rest) || !needNum(interval, "--interval", g.rest)) return;
        await cmdScalpWatch({ pair, polls, intervalSec: interval, json: g.json });
        return;
      }
      if (sub === "kill") {
        if (refusePaperFlag(g.rest, "jw3 scalp kill")) return;
        await cmdScalpKill({
          pair,
          exchange: flagOf(g.rest, "--exchange"),
          yes: tail.includes("--yes"),
          json: g.json,
          url: g.url,
          pat: g.pat,
        });
        return;
      }
      await cmdScalpPlan({
        pair,
        direction,
        size,
        steps,
        json: g.json,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "trail",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      if (refusePaperFlag(g.rest, "jw3 trail")) return;
      const rest = g.rest.join(" ");
      const pair = flagOf(g.rest, "--pair") ?? "";
      const sideRaw = (flagOf(g.rest, "--side") ?? (rest.includes("--short") ? "short" : rest.includes("--long") ? "long" : "")).toLowerCase();
      const sizeRaw = flagOf(g.rest, "--size");
      const size = sizeRaw === undefined ? NaN : Number(sizeRaw);
      const activationPct = numOf(g.rest, "--activation-pct", 0.25);
      // --backoff-pct is an alias of --bounceback-pct (same trailing engine).
      const backoffRaw = flagOf(g.rest, "--backoff-pct");
      const bounceRaw = flagOf(g.rest, "--bounceback-pct");
      const bouncebackPct =
        bounceRaw !== undefined
          ? Number(bounceRaw)
          : backoffRaw !== undefined
            ? Number(backoffRaw)
            : 0.08;
      const pollsRaw = flagOf(g.rest, "--polls");
      const polls = pollsRaw === undefined ? 600 : Number(pollsRaw);
      if (!pair || !pair.includes("/")) {
        console.error("Usage: jw3 trail --pair SOL/USDT --side long|short --size LOT [--activation-pct 0.25] [--bounceback-pct 0.08] [--polls 600] [--live] [--yes] [--json]");
        process.exitCode = 2;
        return;
      }
      if (sizeRaw === undefined) {
        console.error("Bad --size: LOT is required (e.g. --size 1) — nothing was called.");
        process.exitCode = 2;
        return;
      }
      if (!needNum(size, "--size", g.rest)) return;
      if (!needNum(activationPct, "--activation-pct", g.rest)) return;
      if (!needNum(bouncebackPct, bounceRaw !== undefined ? "--bounceback-pct" : "--backoff-pct", g.rest)) return;
      if (
        pollsRaw !== undefined &&
        (!Number.isInteger(polls) || !(polls >= 1) || !(polls <= 3600))
      ) {
        console.error(`Bad --polls: ${JSON.stringify(pollsRaw)} is not a usable number — nothing was called.`);
        process.exitCode = 2;
        return;
      }
      await cmdTrail(
        {
          exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
          pair,
          side: sideRaw as "long" | "short",
          size,
          activationPct,
          bouncebackPct,
          polls,
          live: tail.includes("--live"),
        },
        { yes: tail.includes("--yes"), json: g.json, url: g.url, pat: g.pat },
      );
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "bounce",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      if (refusePaperFlag(g.rest, "jw3 bounce")) return;
      const rest = g.rest.join(" ");
      const pair = flagOf(g.rest, "--pair") ?? "";
      const sideRaw = (
        flagOf(g.rest, "--side") ??
        (rest.includes("--short") ? "short" : rest.includes("--long") ? "long" : "short")
      ).toLowerCase();
      const bouncePct = numOf(g.rest, "--bounce-pct", BOUNCE_DEFAULT_PCT);
      const lookbackMin = numOf(g.rest, "--lookback-min", BOUNCE_DEFAULT_LOOKBACK_MIN);
      const sizeRaw = flagOf(g.rest, "--size");
      const size = sizeRaw === undefined ? undefined : Number(sizeRaw);
      if (!pair || !pair.includes("/")) {
        console.error("Usage: jw3 bounce --pair SOL/USDT --side short [--bounce-pct 0.4] [--lookback-min 60] [--size …] [--yes] [--json]");
        process.exitCode = 2;
        return;
      }
      if (sideRaw !== "long" && sideRaw !== "short") {
        console.error(`Bad --side: ${JSON.stringify(sideRaw)} is not a usable value (long|short) — nothing was called.`);
        process.exitCode = 2;
        return;
      }
      if (!needNum(bouncePct, "--bounce-pct", g.rest)) return;
      if (!needNum(lookbackMin, "--lookback-min", g.rest)) return;
      if (sizeRaw !== undefined && !needNum(size as number, "--size", g.rest)) return;
      await cmdBounce(
        {
          exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
          pair,
          side: sideRaw as "long" | "short",
          bouncePct,
          lookbackMin,
          ...(size === undefined ? {} : { size }),
        },
        { yes: tail.includes("--yes"), json: g.json, url: g.url, pat: g.pat },
      );
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "tick",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const pair = flagOf(g.rest, "--pair") ?? "";
      const secondsRaw = flagOf(g.rest, "--seconds");
      const seconds = secondsRaw === undefined ? 15 : Number(secondsRaw);
      if (!pair || !pair.includes("/")) {
        console.error("Usage: jw3 tick --pair SOL/USDT [--seconds 15] [--json]");
        process.exitCode = 2;
        return;
      }
      if (secondsRaw !== undefined && (!Number.isFinite(seconds) || !(seconds >= 1) || !(seconds <= 300))) {
        console.error(`Bad --seconds: ${JSON.stringify(secondsRaw)} is not a usable number — nothing was called.`);
        process.exitCode = 2;
        return;
      }
      await cmdTick({ pair, seconds, json: g.json });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "klines",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const pair = flagOf(g.rest, "--pair") ?? "";
      const tf = (flagOf(g.rest, "--tf") ?? flagOf(g.rest, "--timeframe") ?? KLINES_DEFAULT_TF).toLowerCase();
      const limitRaw = flagOf(g.rest, "--limit");
      const limit = limitRaw === undefined ? KLINES_DEFAULT_LIMIT : Number(limitRaw);
      if (!pair || !pair.includes("/")) {
        console.error("Usage: jw3 klines --pair SOL/USDT [--tf 5m|15m|1h|1d] [--limit 50] [--rsi] [--vwap] [--json]");
        process.exitCode = 2;
        return;
      }
      if (limitRaw !== undefined && (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1)) {
        console.error(`Bad --limit: ${JSON.stringify(limitRaw)} is not a usable number — nothing was called.`);
        process.exitCode = 2;
        return;
      }
      await cmdKlines({
        pair,
        tf,
        limit,
        rsi: g.rest.includes("--rsi"),
        vwap: g.rest.includes("--vwap"),
        json: g.json,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "loop",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const rest = g.rest.join(" ");
      const size = posOf(g.rest, "--size", 15);
      if (!needNum(size, "--size", g.rest)) return;
      await cmdLoop({
        exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
        pair: flagOf(g.rest, "--pair") ?? "",
        direction: rest.includes("--short") ? "short" : "long",
        sizeUsd: size,
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "grid" && (sub === "plan" || sub === "start" || sub === "backtest" || sub === undefined),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const biasRaw = (flagOf(g.rest, "--bias") ?? "neutral").toLowerCase();
      const stepPct = numOf(g.rest, "--step-pct", 0.25);
      const levels = clampInt(numOf(g.rest, "--levels", 25), 1, 100);
      const lev = posAny(g.rest, 2, "--lev", "--leverage");
      if (sub === "backtest") {
        const contracts = numOf(g.rest, "--contracts", 0);
        const days = clampInt(numOf(g.rest, "--days", 30), 1, 90);
        if (
          !needNum(stepPct, "--step-pct", g.rest) ||
          !needNum(levels, "--levels", g.rest) ||
          !needNum(contracts, "--contracts", g.rest) ||
          !needNumAny(lev, g.rest, "--lev", "--leverage") ||
          !needNum(days, "--days", g.rest)
        ) {
          return;
        }
        await cmdGridBacktest({
          pair: flagOf(g.rest, "--pair") ?? "",
          stepPct,
          levelsPerSide: levels,
          contracts,
          leverage: lev,
          days,
          json: g.json,
        });
        return;
      }
      const size = posOf(g.rest, "--size", 15);
      if (
        !needNum(stepPct, "--step-pct", g.rest) ||
        !needNum(levels, "--levels", g.rest) ||
        !needNum(size, "--size", g.rest) ||
        !needNumAny(lev, g.rest, "--lev", "--leverage")
      ) {
        return;
      }
      if (sub === "start" && refusePaperFlag(g.rest, "jw3 grid start")) return;
      await cmdGrid(
        sub === "start" ? "start" : "plan",
        {
          exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
          pair: flagOf(g.rest, "--pair") ?? "",
          bias: biasRaw === "long" ? "long" : biasRaw === "short" ? "short" : "neutral",
          stepPct,
          levelsPerSide: levels,
          stepUsd: size,
          leverage: lev,
        },
        { yes: tail.includes("--yes"), json: g.json, url: g.url, pat: g.pat },
      );
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "daemon" && sub === undefined,
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      if (refusePaperFlag(g.rest, "jw3 daemon")) return;
      const configPath = flagOf(g.rest, "--config");
      if (!configPath) {
        console.error("Usage: jw3 daemon --config <manifest.json> [--once] [--allow-live] [--flatten-on-shutdown] [--json]");
        process.exitCode = 2;
        return;
      }
      let manifest;
      try {
        manifest = loadDaemonManifest(configPath);
      } catch (e) {
        console.error(`Unreadable daemon manifest ${configPath}: ${e instanceof Error ? e.message : String(e)}. Nothing was started.`);
        process.exitCode = 2;
        return;
      }
      await cmdDaemon({
        manifest,
        json: g.json,
        // Real money is opt-in per invocation. Without it every child is
        // dry-run — the daemon still supervises, it just does not trade.
        allowLive: g.rest.includes("--allow-live"),
        // Flattening on shutdown is a separate, explicit opt-in. A
        // shutdown must never silently close a position.
        flattenOnShutdown: g.rest.includes("--flatten-on-shutdown"),
        once: g.rest.includes("--once"),
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "watchdog" && (sub === "check" || sub === "run" || sub === "resume" || sub === undefined),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const mode = sub ?? "check";
      const opts = {
        sub: mode,
        exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
        pollSec: numOf(g.rest, "--poll-sec", 15),
        // Flattening is opt-in per invocation, never the default.
        flatten: g.rest.includes("--flatten"),
        // A resume must name a human actor.
        actor: flagOf(g.rest, "--actor"),
        json: g.json,
        url: g.url,
        pat: g.pat,
        once: g.rest.includes("--once"),
      };
      if ((mode === "run" || mode === "resume") && refusePaperFlag(g.rest, `jw3 watchdog ${mode}`)) return;
      if (mode === "resume" && !opts.actor) {
        console.error("watchdog resume needs --actor <who> — a resume is human-only and must be attributable. Nothing was called.");
        process.exitCode = 2;
        return;
      }
      if (mode === "check") await cmdWatchdogCheck(opts);
      else if (mode === "run") await cmdWatchdogRun(opts);
      else await cmdWatchdogResume(opts);
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "monitor" && sub === undefined,
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdMonitor({
        exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
        thresholds: DEFAULT_MONITOR_THRESHOLDS,
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "alert" && sub === undefined,
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const snapshot = flagOf(g.rest, "--snapshot");
      if (!snapshot) {
        console.error("alert needs --snapshot <path to the machine snapshot JSON>. Nothing was called.");
        process.exitCode = 2;
        return;
      }
      await cmdAlert({
        snapshot,
        prevSnapshot: flagOf(g.rest, "--prev-snapshot"),
        statePath: flagOf(g.rest, "--state"),
        policyPath: flagOf(g.rest, "--policy"),
        transport: (flagOf(g.rest, "--transport") as "console" | "file" | undefined) ?? "console",
        out: flagOf(g.rest, "--out"),
        json: g.json,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "learning" && (sub === "record" || sub === "stats" || sub === undefined),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      if (sub === "stats" || sub === undefined) {
        await cmdLearningStats({ json: g.json, logPath: flagOf(g.rest, "--log") });
        return;
      }
      // A record describes a CLOSED trade: it needs the full trade, not a
      // pair. A partial record would poison the learning log with trades
      // whose outcome is unknown.
      const pair = flagOf(g.rest, "--pair") ?? "";
      const side = flagOf(g.rest, "--side") ?? "";
      const entry = numOf(g.rest, "--entry", NaN);
      const exitPx = numOf(g.rest, "--exit", NaN);
      if (!pair || !side || !Number.isFinite(entry) || !Number.isFinite(exitPx)) {
        console.error("learning record needs --pair BASE/USDT --side long|short --entry <px> --exit <px> --reason <text> --pnl <usd> [--fees <usd>]");
        process.exitCode = 2;
        return;
      }
      await cmdLearningRecord({
        pair,
        side,
        entry,
        exit: exitPx,
        exitReason: flagOf(g.rest, "--reason") ?? "unknown",
        pnlUsd: numOf(g.rest, "--pnl", 0),
        feesUsd: numOf(g.rest, "--fees", 0),
        exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
        json: g.json,
        logPath: flagOf(g.rest, "--log"),
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "backtest" && sub === "live",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const pair = flagOf(g.rest, "--pair") ?? "";
      if (!pair) {
        console.error("Usage: jw3 backtest live --pair BASE/USDT [--days 30] [--tf 15m] [--size 15] [--leverage 20] [--mode maker|chase|taker|all] [--json]");
        process.exitCode = 2;
        return;
      }
      await cmdBacktestLive({
        pair,
        days: numOf(g.rest, "--days", 30),
        tf: flagAny(g.rest, "--tf", "--timeframe") ?? "15m",
        sizeUsd: numOf(g.rest, "--size", 15),
        leverage: numAny(g.rest, 20, "--leverage", "--lev"),
        mode: (flagOf(g.rest, "--mode") as "maker" | "chase" | "taker" | "all" | undefined) ?? "all",
        json: g.json,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "live" && sub === undefined,
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      if (refusePaperFlag(g.rest, "jw3 live")) return;
      const pair = flagOf(g.rest, "--pair") ?? "";
      if (!pair) {
        console.error("Usage: jw3 live --pair BASE/USDT [--exchange kucoin] [--side long|short|auto] [--risk 3] [--size 15] [--session live] [--turn t1] [--yes] [--json]");
        process.exitCode = 2;
        return;
      }
      const exchange = flagOf(g.rest, "--exchange") ?? "kucoin";
      const sideRaw = (flagOf(g.rest, "--side") ?? "auto").toLowerCase();
      if (sideRaw !== "long" && sideRaw !== "short" && sideRaw !== "auto") {
        console.error(`Bad --side: ${JSON.stringify(sideRaw)} — want long|short|auto. Nothing was called.`);
        process.exitCode = 2;
        return;
      }
      const risk = posOf(g.rest, "--risk", 3);
      const size = posOf(g.rest, "--size", 15);
      if (!needNum(risk, "--risk", g.rest) || !needNum(size, "--size", g.rest)) return;
      const pat = resolvePat(g.pat);
      if (!pat) {
        console.error("Not authenticated — run `jw3 auth login --browser` first; nothing was called.");
        process.exitCode = 2;
        return;
      }
      await cmdLive(
        {
          pair,
          exchange,
          side: sideRaw,
          riskPct: risk,
          sizeUsd: size,
          json: g.json,
          yes: g.rest.includes("--yes"),
          session: flagOf(g.rest, "--session") ?? "live",
          turn: flagOf(g.rest, "--turn") ?? "t1",
        },
        liveModelDeps(exchange, pat, g.url),
      );
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "backtest" && sub === "scalp",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const days = clampInt(numOf(g.rest, "--days", 30), 1, 90);
      const tpRaw = flagOf(g.rest, "--tp");
      const tp = tpRaw === undefined ? undefined : Number(tpRaw);
      const size = posOf(g.rest, "--size", 60);
      const feeRaw = (flagOf(g.rest, "--fee") ?? (g.rest.includes("--maker") ? "maker" : g.rest.includes("--taker") ? "taker" : "taker")).toLowerCase();
      if (!needNum(days, "--days", g.rest) || !needNum(size, "--size", g.rest)) {
        return;
      }
      if (tp !== undefined && !(tp > 0 && tp <= 2)) {
        console.error(`Bad --tp: ${JSON.stringify(tpRaw)} is not a usable number — nothing was called.`);
        process.exitCode = 2;
        return;
      }
      if (feeRaw !== "maker" && feeRaw !== "taker") {
        console.error(`Bad --fee: ${JSON.stringify(flagOf(g.rest, "--fee"))} — want maker|taker. Nothing was called.`);
        process.exitCode = 2;
        return;
      }
      await cmdBacktestScalp({
        pair: flagOf(g.rest, "--pair") ?? "",
        days,
        tpPct: tp,
        fee: feeRaw,
        sizeUsd: size,
        json: g.json,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "farm" && (sub === "run" || sub === "leaderboard" || sub === undefined),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      if (g.rest.includes("--live") || g.rest.includes("--yes")) {
        console.error("farm is paper-only: --live/--yes are refused. Nothing was called.");
        process.exitCode = 2;
        return;
      }
      if (sub === "leaderboard") {
        await cmdFarmLeaderboard({ json: g.json });
        return;
      }
      const days = clampInt(numOf(g.rest, "--days", 30), 1, 90);
      const size = posOf(g.rest, "--size", 60);
      const feeRaw = (flagOf(g.rest, "--fee") ?? "taker").toLowerCase();
      if (!needNum(days, "--days", g.rest) || !needNum(size, "--size", g.rest)) {
        return;
      }
      if (feeRaw !== "maker" && feeRaw !== "taker") {
        console.error(`Bad --fee: ${JSON.stringify(flagOf(g.rest, "--fee"))} — want maker|taker. Nothing was called.`);
        process.exitCode = 2;
        return;
      }
      await cmdFarmRun({
        pairsRaw: flagOf(g.rest, "--pairs"),
        days,
        fee: feeRaw,
        sizeUsd: size,
        json: g.json,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "paper",
    run: async (cmd, sub, tail) => {
      // Local paper-trading accounts — zero venue contact. Validation lives
      // in the paper commands (exit 2, nothing written on bad input); the
      // router only parses flags through.
      const g = globals(tail);
      const numFlag = (f: string): number | undefined => {
        const v = flagOf(g.rest, f);
        return v === undefined ? undefined : Number(v);
      };
      const paperSubs = new Set([
        "create", "fund", "reset", "list", "execute",
        "positions", "fills", "pnl", "tick", "promote",
      ]);
      if (sub === undefined || !paperSubs.has(sub)) {
        console.error(PAPER_USAGE);
        process.exitCode = 2;
        return;
      }
      const account = flagOf(g.rest, "--account") ?? "";
      if (sub === "create") {
        await cmdPaperCreate({ name: account, equityUsd: numFlag("--equity") ?? 10000, json: g.json });
        return;
      }
      if (sub === "fund") {
        await cmdPaperFund({ name: account, amountUsd: numFlag("--amount") ?? NaN, json: g.json });
        return;
      }
      if (sub === "reset") {
        await cmdPaperReset({ name: account, json: g.json });
        return;
      }
      if (sub === "list") {
        await cmdPaperList({ json: g.json });
        return;
      }
      if (sub === "execute") {
        await cmdPaperExecute({
          account,
          pair: flagOf(g.rest, "--pair") ?? "",
          side: flagOf(g.rest, "--side") ?? "",
          qty: numFlag("--qty"),
          sizeUsd: numFlag("--size-usd"),
          price: numFlag("--price") ?? NaN,
          leverage: numFlag("--lev") ?? numFlag("--leverage") ?? 1,
          tp: numFlag("--tp"),
          sl: numFlag("--sl"),
          fee: flagOf(g.rest, "--fee"),
          strategy: flagOf(g.rest, "--strategy"),
          json: g.json,
        });
        return;
      }
      if (sub === "positions") {
        await cmdPaperPositions({
          account: account || undefined,
          pair: flagOf(g.rest, "--pair"),
          strategy: flagOf(g.rest, "--strategy"),
          mark: numFlag("--mark"),
          json: g.json,
        });
        return;
      }
      if (sub === "fills") {
        await cmdPaperFills({
          account: account || undefined,
          pair: flagOf(g.rest, "--pair"),
          strategy: flagOf(g.rest, "--strategy"),
          limit: numFlag("--limit"),
          json: g.json,
        });
        return;
      }
      if (sub === "pnl") {
        await cmdPaperPnl({ account: account || undefined, json: g.json });
        return;
      }
      if (sub === "tick") {
        await cmdPaperTick({
          account: account || undefined,
          pair: flagOf(g.rest, "--pair") ?? "",
          price: numFlag("--price") ?? NaN,
          fee: flagOf(g.rest, "--fee"),
          json: g.json,
        });
        return;
      }
      await cmdPaperPromote({
        account,
        positionId: flagOf(g.rest, "--position-id"),
        pair: flagOf(g.rest, "--pair"),
        exchange: flagOf(g.rest, "--exchange"),
        json: g.json,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "poly" && (sub === "scan" || sub === undefined),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdPolyScan({ json: g.json });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "scan" && (sub === "fade" || sub === undefined),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const minChg = numOf(g.rest, "--min-chg", 3);
      const limit = clampInt(numOf(g.rest, "--limit", 12), 1, 25);
      if (!needNum(minChg, "--min-chg", g.rest) || !needNum(limit, "--limit", g.rest)) return;
      await cmdScanFade({
        exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
        minChg,
        limit,
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "forecast",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const horizon = clampInt(numOf(g.rest, "--horizon", 12), 1, 120);
      if (!needNum(horizon, "--horizon", g.rest)) return;
      await cmdForecast({ pair: flagOf(g.rest, "--pair") ?? "", horizon, json: g.json });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "intel",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const limit = clampInt(numOf(g.rest, "--limit", 10), 1, 25);
      if (!needNum(limit, "--limit", g.rest)) return;
      // Multi-word topic: every non-flag token in the sub + tail slots.
      // --limit/--url/--pat consume the token after them.
      const consumesValue = new Set(["--limit", "--url", "--pat"]);
      const words: string[] = [];
      const raw: (string | undefined)[] = [sub, ...tail];
      for (let i = 0; i < raw.length; i++) {
        const w = raw[i];
        if (w === undefined || w === "--json" || w === "--no-cache") continue;
        if (consumesValue.has(w)) {
          i++;
          continue;
        }
        if (w.startsWith("--")) continue;
        words.push(w);
      }
      await cmdIntel({
        topic: words.join(" "),
        limit,
        noCache: tail.includes("--no-cache"),
        json: g.json,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "decide",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdDecide({
        pair: flagOf(g.rest, "--pair") ?? "",
        exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "degen" && (sub === undefined || sub === "record" || sub === "paper-stats"),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      if (sub === "paper-stats") {
        await cmdPaperStats({ json: g.json });
        return;
      }
      if (sub === "record") {
        const pnlRaw = flagOf(g.rest, "--pnl");
        await cmdDegenRecord({
          pair: flagOf(g.rest, "--pair") ?? "",
          outcome: flagOf(g.rest, "--outcome") ?? "",
          pnl: pnlRaw === undefined ? undefined : Number(pnlRaw),
          paper: tail.includes("--paper"),
          json: g.json,
        });
        return;
      }
      const size = posOf(g.rest, "--size", 15);
      const lev = posAny(g.rest, 2, "--lev", "--leverage");
      const maxHeat = posOf(g.rest, "--max-heat", 6);
      const maxConcurrent = clampInt(numOf(g.rest, "--max-concurrent", 2), 1, 8);
      const activationPct = numOf(g.rest, "--activation-pct", 0.25);
      const bouncebackPct = numAny(g.rest, 0.08, "--bounceback-pct", "--backoff-pct");
      const pollsRaw = flagOf(g.rest, "--polls");
      const polls = pollsRaw === undefined ? 600 : Number(pollsRaw);
      const horizon = clampInt(numOf(g.rest, "--horizon", 12), 1, 120);
      if (
        !needNum(size, "--size", g.rest) ||
        !needNumAny(lev, g.rest, "--lev", "--leverage") ||
        !needNum(maxHeat, "--max-heat", g.rest) ||
        !needNum(maxConcurrent, "--max-concurrent", g.rest) ||
        !needNum(activationPct, "--activation-pct", g.rest) ||
        !needNumAny(bouncebackPct, g.rest, "--bounceback-pct", "--backoff-pct") ||
        !needNum(horizon, "--horizon", g.rest)
      ) {
        return;
      }
      if (
        pollsRaw !== undefined &&
        (!Number.isInteger(polls) || !(polls >= 1) || !(polls <= 3600))
      ) {
        console.error(`Bad --polls: ${JSON.stringify(pollsRaw)} is not a usable number — nothing was called.`);
        process.exitCode = 2;
        return;
      }
      await cmdDegen(
        {
          pair: flagOf(g.rest, "--pair"),
          exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
          sizeUsd: size,
          leverage: lev,
          maxHeatUsd: maxHeat,
          maxConcurrent,
          activationPct,
          bouncebackPct,
          polls,
          horizon,
          trail: tail.includes("--trail"),
          live: tail.includes("--live"),
          paper: tail.includes("--paper"),
        },
        { yes: tail.includes("--yes"), json: g.json, url: g.url, pat: g.pat },
      );
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "ttm" && (sub === undefined || sub === "plan"),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const rest = g.rest.join(" ");
      const sideRaw = (
        flagOf(g.rest, "--side") ??
        (rest.includes("--short") ? "short" : rest.includes("--long") ? "long" : "")
      ).toLowerCase();
      const equity = numOf(g.rest, "--equity", 10);
      const base = posOf(g.rest, "--base", NaN);
      const lev = posAny(g.rest, 25, "--lev", "--leverage");
      const entryRaw = flagOf(g.rest, "--entry");
      const entry = entryRaw === undefined ? NaN : Number(entryRaw);
      const atrPct = numOf(g.rest, "--atr-pct", NaN);
      const activationPct = numOf(g.rest, "--activation-pct", 0.25);
      const bouncebackPct = numAny(g.rest, 0.08, "--bounceback-pct", "--backoff-pct");
      const sleeveRaw = (flagOf(g.rest, "--sleeve") ?? "momentum").toLowerCase();
      if (!needNum(equity, "--equity", g.rest) || !needNum(base, "--base", g.rest)) return;
      if (!needNumAny(lev, g.rest, "--lev", "--leverage")) return;
      if (!needNum(entry, "--entry", g.rest) || !needNum(atrPct, "--atr-pct", g.rest)) return;
      if (!needNum(activationPct, "--activation-pct", g.rest)) return;
      if (!needNumAny(bouncebackPct, g.rest, "--bounceback-pct", "--backoff-pct")) return;
      await cmdTtm(
        {
          pair: flagOf(g.rest, "--pair") ?? "",
          side: sideRaw as "long" | "short",
          equityUsd: equity,
          baseNotionalUsd: base,
          leverage: lev,
          entryPrice: entry,
          atrPct,
          sleeve: sleeveRaw as "momentum" | "fade" | "funding" | "breakout",
          activationPct,
          bouncebackPct,
          json: g.json,
        },
        { live: tail.includes("--live"), yes: tail.includes("--yes") },
      );
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "spikes",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const cycles = clampInt(numOf(g.rest, "--cycles", 1), 1, 30);
      if (!needNum(cycles, "--cycles", g.rest)) return;
      await cmdSpikes({
        exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
        pairs: flagOf(g.rest, "--pairs"),
        cycles,
        json: g.json,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "connections",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdConnections({ json: g.json, url: g.url, pat: g.pat });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "diary" && sub !== "note",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdDiary({ day: flagOf(g.rest, "--day"), startDay: flagOf(g.rest, "--start-day") ?? flagOf(g.rest, "--start"), endDay: flagOf(g.rest, "--end-day") ?? flagOf(g.rest, "--end"), json: g.json, url: g.url, pat: g.pat });
      return;
    },
  },
  // Space form: `diary note` (same handler; mirrors `cancel all`). Must sit
  // below the guarded bare `diary` above.
  {
    match: (cmd, sub) => cmd === "diary-note" || (cmd === "diary" && sub === "note"),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdDiaryNote(
        {
          day: flagOf(g.rest, "--day"),
          body: flagOf(g.rest, "--body") ?? "",
          mode: flagOf(g.rest, "--mode"),
        },
        { json: g.json, url: g.url, pat: g.pat },
      );
      return;
    },
  },
  // Space form: `daily prep`.
  {
    match: (cmd, sub) => cmd === "daily-prep" || (cmd === "daily" && sub === "prep"),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdDailyPrep({ dry: tail.includes("--dry"), day: flagOf(g.rest, "--day"), json: g.json, url: g.url, pat: g.pat });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "risk",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdRisk({ json: g.json, state: g.rest.includes("--state"), url: g.url, pat: g.pat });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "insights",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      // numOf keeps the documented default when a flag is absent and yields NaN
      // for a present-but-unparsable value, so cmdInsights rejects it (exit 2,
      // nothing called) instead of silently running on a default.
      await cmdInsights({
        days: numOf(g.rest, "--days", 30),
        notionalUsd: numOf(g.rest, "--notional-usd", 10000),
        feeBps: numOf(g.rest, "--fee-bps", 5),
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "news",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const limitRaw = flagOf(g.rest, "--limit");
      const windowRaw = flagOf(g.rest, "--window-hrs") ?? flagOf(g.rest, "--window");
      await cmdNews({
        pair: flagOf(g.rest, "--pair"),
        source: flagOf(g.rest, "--source"),
        limit: limitRaw === undefined ? undefined : Number(limitRaw),
        windowHrs: windowRaw === undefined ? undefined : Number(windowRaw),
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  // Space forms (`propose idea|bracket|predict|close-all`, plus
  // `propose close all`) are handled by the card branches below — the
  // guard keeps them from falling into the bare propose ticket.
  {
    match: (cmd, sub) => cmd === "propose" && sub !== "idea" && sub !== "bracket" && sub !== "predict" && sub !== "close-all" && sub !== "close",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const entry = Number(flagOf(g.rest, "--entry"));
      const stop = Number(flagOf(g.rest, "--stop"));
      const sizeRaw = flagOf(g.rest, "--size-usd");
      await cmdPropose(
        {
          pair: flagOf(g.rest, "--pair") ?? "",
          side: flagOf(g.rest, "--side") ?? "",
          entry,
          stop,
          asset: flagOf(g.rest, "--asset"),
          venue: flagOf(g.rest, "--venue"),
          sizeUsd: sizeRaw === undefined ? undefined : Number(sizeRaw),
          thesis: flagOf(g.rest, "--thesis"),
          timeframe: flagOf(g.rest, "--timeframe"),
        },
        { json: g.json, url: g.url, pat: g.pat },
      );
      return;
    },
  },
  // Space form: `propose idea`.
  {
    match: (cmd, sub) => cmd === "propose-idea" || (cmd === "propose" && sub === "idea"),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const entry = Number(flagOf(g.rest, "--entry"));
      const stop = Number(flagOf(g.rest, "--stop"));
      const sizeRaw = flagOf(g.rest, "--size-usd");
      await cmdProposeIdea(
        {
          pair: flagOf(g.rest, "--pair") ?? "",
          side: flagOf(g.rest, "--side") ?? "",
          entry,
          stop,
          thesis: flagOf(g.rest, "--thesis") ?? "",
          targetRaw: flagOf(g.rest, "--target") ?? flagOf(g.rest, "--targets"),
          asset: flagOf(g.rest, "--asset"),
          venue: flagOf(g.rest, "--venue"),
          exchange: flagOf(g.rest, "--exchange"),
          timeframe: flagAny(g.rest, "--timeframe", "--tf"),
          sizeUsd: sizeRaw === undefined ? undefined : Number(sizeRaw),
          jevVerdict: flagOf(g.rest, "--jev-verdict"),
          rationale: flagOf(g.rest, "--rationale"),
        },
        { json: g.json, url: g.url, pat: g.pat },
      );
      return;
    },
  },
  // Space form: `propose bracket`.
  {
    match: (cmd, sub) => cmd === "propose-bracket" || (cmd === "propose" && sub === "bracket"),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const entryRaw = flagOf(g.rest, "--entry-price");
      const feeRaw = flagOf(g.rest, "--fee-usd");
      await cmdProposeBracket(
        {
          exchange: flagOf(g.rest, "--exchange") ?? "",
          pair: flagOf(g.rest, "--pair") ?? "",
          side: flagOf(g.rest, "--side") ?? "",
          entryType: flagOf(g.rest, "--entry-type") ?? "",
          entryPrice: entryRaw === undefined ? undefined : Number(entryRaw),
          amount: flagOf(g.rest, "--amount") ?? "",
          stop: Number(flagOf(g.rest, "--stop")),
          tpRaw: flagOf(g.rest, "--tp") ?? flagOf(g.rest, "--tp-legs"),
          feeUsd: feeRaw === undefined ? undefined : Number(feeRaw),
          rationale: flagOf(g.rest, "--rationale") ?? flagOf(g.rest, "--reason") ?? "",
        },
        { json: g.json, url: g.url, pat: g.pat },
      );
      return;
    },
  },
  // Space form: `propose predict`.
  {
    match: (cmd, sub) => cmd === "propose-predict" || (cmd === "propose" && sub === "predict"),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const amountRaw = flagOf(g.rest, "--amount");
      const confRaw = flagOf(g.rest, "--confidence");
      await cmdProposePredict(
        {
          marketId: flagOf(g.rest, "--market-id") ?? "",
          side: flagOf(g.rest, "--side") ?? "",
          jevVerdict: flagOf(g.rest, "--jev-verdict") ?? "",
          rationale: flagOf(g.rest, "--rationale") ?? flagOf(g.rest, "--reason") ?? "",
          question: flagOf(g.rest, "--question"),
          amount: amountRaw === undefined ? undefined : Number(amountRaw),
          venue: flagOf(g.rest, "--venue"),
          confidence: confRaw === undefined ? undefined : Number(confRaw),
        },
        { json: g.json, url: g.url, pat: g.pat },
      );
      return;
    },
  },
  // Space forms: `propose close-all` and `propose close all`.
  {
    match: (cmd, sub) => cmd === "propose-close-all" || (cmd === "propose" && (sub === "close-all" || sub === "close")),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      // Drop the `all` in `propose close all` — it is the sub alias, not a flag value.
      if (sub === "close" && g.rest[0] === "all") g.rest.shift();
      await cmdProposeCloseAll(
        {
          rationale: flagOf(g.rest, "--rationale") ?? flagOf(g.rest, "--reason") ?? "",
          exchange: flagOf(g.rest, "--exchange"),
          pair: flagOf(g.rest, "--pair"),
          orderType: flagOf(g.rest, "--order-type"),
          limitPrice: flagOf(g.rest, "--limit-price"),
        },
        { json: g.json, url: g.url, pat: g.pat },
      );
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "market",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdMarket({
        exchange: flagOf(g.rest, "--exchange") ?? "",
        pair: flagOf(g.rest, "--pair") ?? "",
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "screener",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdScreener({
        exchange: flagOf(g.rest, "--exchange") ?? "binance",
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "positions",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const pair = flagOf(g.rest, "--pair");
      const watchRaw = flagOf(g.rest, "--watch");
      const pollsRaw = flagOf(g.rest, "--polls");
      const jsonLines = g.rest.includes("--json-lines") || g.rest.includes("--json_lines");
      let watchSec: number | undefined;
      if (watchRaw !== undefined) {
        watchSec = Number(watchRaw);
        const bad = validateWatchSec(watchSec);
        if (bad) {
          console.error(`Bad --watch: ${bad} — nothing was called.`);
          process.exitCode = 2;
          return;
        }
      } else if (g.rest.includes("--watch")) {
        console.error(
          "Usage: jw3 positions [--exchange kucoin] [--pair BTC/USDT] [--watch SEC] [--polls N] [--json] [--json-lines]",
        );
        process.exitCode = 2;
        return;
      }
      let polls: number | undefined;
      if (pollsRaw !== undefined) {
        polls = Number(pollsRaw);
        const bad = validatePolls(polls);
        if (bad) {
          console.error(`Bad --polls: ${bad} — nothing was called.`);
          process.exitCode = 2;
          return;
        }
      }
      await cmdPositions({
        exchange: flagOf(g.rest, "--exchange"),
        pair,
        watchSec,
        polls,
        json: g.json,
        jsonLines,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "balances",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdBalances({
        exchange: flagOf(g.rest, "--exchange"),
        venue: flagOf(g.rest, "--venue") ?? (g.rest.includes("--venue") ? "all" : undefined),
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "orders",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdOrders({
        exchange: flagOf(g.rest, "--exchange"),
        pair: flagOf(g.rest, "--pair"),
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "order",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdOrderStatus({
        exchange: flagOf(g.rest, "--exchange") ?? "",
        orderId: flagOf(g.rest, "--order-id") ?? "",
        pair: flagOf(g.rest, "--pair"),
        market: flagOf(g.rest, "--market"),
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "fills",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const daysRaw = flagOf(g.rest, "--days");
      const limitRaw = flagOf(g.rest, "--limit");
      await cmdFills({
        exchange: flagOf(g.rest, "--exchange") ?? "",
        pair: flagOf(g.rest, "--pair"),
        market: flagOf(g.rest, "--market"),
        days: daysRaw === undefined ? undefined : Number(daysRaw),
        limit: limitRaw === undefined ? undefined : Number(limitRaw),
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  // `pnl reconcile` (space form) is handled by the pnl-reconcile branch
  // below — the guard keeps it from falling into the bare pnl reader.
  {
    match: (cmd, sub) => cmd === "pnl" && sub !== "reconcile",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const daysRaw = flagOf(g.rest, "--days");
      const limitRaw = flagOf(g.rest, "--limit");
      await cmdPnl({
        exchange: flagOf(g.rest, "--exchange") ?? "",
        pair: flagOf(g.rest, "--pair"),
        days: daysRaw === undefined ? undefined : Number(daysRaw),
        limit: limitRaw === undefined ? undefined : Number(limitRaw),
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  // Space form: `pnl reconcile` (same handler; mirrors `cancel all`).
  // Sits below the guarded bare `pnl` above.
  {
    match: (cmd, sub) => cmd === "pnl-reconcile" || (cmd === "pnl" && sub === "reconcile"),
    run: async (cmd, sub, tail) => {
      // Count the venue's realized LOSSES against the daily risk counters.
      // A trade closed by the VENUE's own stop never goes through the
      // close path, so without this the daily loss cap can never fire on
      // it. Idempotent: each venue trade is counted exactly once.
      const g = globals(tail);
      const daysRaw = flagOf(g.rest, "--days");
      await cmdPnlReconcile({
        exchange: flagOf(g.rest, "--exchange") ?? "",
        days: daysRaw === undefined ? undefined : Number(daysRaw),
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "onchain",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdOnchain({ chains: flagOf(g.rest, "--chains"), json: g.json, url: g.url, pat: g.pat });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "execute",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      if (refusePaperFlag(g.rest, "jw3 execute")) return;
      const numFlag = (f: string): number | undefined => {
        const v = flagOf(g.rest, f);
        return v === undefined ? undefined : Number(v);
      };
      const tpLegsParsed = parseTpLegsFlag(flagOf(g.rest, "--tp-legs"));
      if (tpLegsParsed.error) {
        console.error(`Bad ticket: ${tpLegsParsed.error} — nothing was called.`);
        process.exitCode = 2;
        return;
      }
      const chase = parseChaseFlags(g.rest);
      if ("error" in chase) {
        console.error(`Bad ticket: ${chase.error} — nothing was called.`);
        process.exitCode = 2;
        return;
      }
      if (chase.cfg.enabled) {
        if (numFlag("--price") !== undefined) {
          console.error("Bad ticket: --chase sets its own limit at the touch — drop --price — nothing was called.");
          process.exitCode = 2;
          return;
        }
        await cmdExecuteChase(
          {
            exchange: flagOf(g.rest, "--exchange") ?? "",
            pair: flagOf(g.rest, "--pair") ?? "",
            side: flagOf(g.rest, "--side") ?? "",
            amount: numFlag("--amount"),
            price: undefined,
            market: flagOf(g.rest, "--market"),
            leverage: numFlag("--leverage"),
            marginMode: flagOf(g.rest, "--margin-mode"),
            stop: numFlag("--stop"),
            tp: numFlag("--tp"),
            tpLegs: tpLegsParsed.legs,
            riskUsd: numFlag("--risk-usd"),
            idempotencyKey: flagOf(g.rest, "--idempotency-key"),
            actor: flagOf(g.rest, "--actor"),
          },
          chase.cfg,
          { yes: g.rest.includes("--yes"), json: g.json, url: g.url, pat: g.pat },
        );
        return;
      }
      await cmdExecute(
        {
          exchange: flagOf(g.rest, "--exchange") ?? "",
          pair: flagOf(g.rest, "--pair") ?? "",
          side: flagOf(g.rest, "--side") ?? "",
          amount: numFlag("--amount"),
          price: numFlag("--price"),
          market: flagOf(g.rest, "--market"),
          leverage: numFlag("--leverage") ?? numFlag("--lev"),
          marginMode: flagOf(g.rest, "--margin-mode"),
          stop: numFlag("--stop"),
          tp: numFlag("--tp"),
          tpLegs: tpLegsParsed.legs,
          riskUsd: numFlag("--risk-usd"),
          idempotencyKey: flagOf(g.rest, "--idempotency-key"),
          actor: flagOf(g.rest, "--actor"),
        },
        { yes: g.rest.includes("--yes"), json: g.json, url: g.url, pat: g.pat },
      );
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "close",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      if (refusePaperFlag(g.rest, "jw3 close")) return;
      const sizeRaw = flagOf(g.rest, "--size");
      await cmdClose({
        exchange: flagOf(g.rest, "--exchange") ?? "",
        pair: flagOf(g.rest, "--pair") ?? "",
        side: flagOf(g.rest, "--side") ?? "",
        size: sizeRaw === undefined ? undefined : Number(sizeRaw),
        yes: g.rest.includes("--yes"),
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "exits",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      if (refusePaperFlag(g.rest, "jw3 exits")) return;
      await cmdExits({
        exchange: flagOf(g.rest, "--exchange") ?? "",
        pair: flagOf(g.rest, "--pair") ?? "",
        sl: flagOf(g.rest, "--sl") === undefined ? undefined : Number(flagOf(g.rest, "--sl")),
        tp: flagOf(g.rest, "--tp") === undefined ? undefined : Number(flagOf(g.rest, "--tp")),
        market: flagOf(g.rest, "--market"),
        quantity: flagOf(g.rest, "--quantity") === undefined ? undefined : Number(flagOf(g.rest, "--quantity")),
        yes: g.rest.includes("--yes"),
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "cancel-all" || (cmd === "cancel" && sub === "all"),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      if (refusePaperFlag(g.rest, "jw3 cancel-all")) return;
      await cmdCancelAll({
        exchange: flagOf(g.rest, "--exchange") ?? "",
        pair: flagOf(g.rest, "--pair") ?? "",
        market: flagOf(g.rest, "--market"),
        yes: g.rest.includes("--yes"),
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "cancel",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      if (refusePaperFlag(g.rest, "jw3 cancel")) return;
      await cmdCancel({
        exchange: flagOf(g.rest, "--exchange") ?? "",
        orderId: flagOf(g.rest, "--order-id") ?? "",
        pair: flagOf(g.rest, "--pair"),
        market: flagOf(g.rest, "--market"),
        yes: g.rest.includes("--yes"),
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "reconcile",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      await cmdReconcile({
        exchange: flagOf(g.rest, "--exchange") ?? "",
        pair: flagOf(g.rest, "--pair") ?? "",
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "heat",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const minFreeRaw = flagOf(g.rest, "--min-free");
      const minFree = minFreeRaw === undefined ? 0 : Number(minFreeRaw);
      if (!needNum(minFree, "--min-free", g.rest) || minFree < 0) {
        if (Number.isFinite(minFree)) {
          console.error("Bad --min-free: must be >= 0 — nothing was called.");
          process.exitCode = 2;
        }
        return;
      }
      await cmdHeat({
        exchange: flagOf(g.rest, "--exchange"),
        minFree,
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "reserve" && (sub === "sweep" || sub === undefined),
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      if (refusePaperFlag(g.rest, "jw3 reserve sweep")) return;
      const keepRaw = flagOf(g.rest, "--keep");
      const keep = keepRaw === undefined ? 10 : Number(keepRaw);
      await cmdReserveSweep(
        {
          exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
          keep,
          currency: flagOf(g.rest, "--currency") ?? "USDT",
        },
        { yes: g.rest.includes("--yes"), json: g.json, url: g.url, pat: g.pat },
      );
      return;
    },
  },
  {
    match: (cmd, sub) => cmd === "defi",
    run: async (cmd, sub, tail) => {
      const g = globals(tail);
      const limitRaw = flagOf(g.rest, "--limit");
      const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
      if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
        console.error(`Bad --limit: ${JSON.stringify(limitRaw)} is not a usable number — nothing was called.`);
        process.exitCode = 2;
        return;
      }
      if (sub === "protocols") {
        await cmdDefiProtocols({
          chain: flagOf(g.rest, "--chain"),
          category: flagOf(g.rest, "--category"),
          limit,
          json: g.json,
          url: g.url,
          pat: g.pat,
        });
        return;
      }
      if (sub === "markets" || sub === "investments") {
        const minApyRaw = flagOf(g.rest, "--min-apy");
        const minApy = minApyRaw !== undefined ? Number(minApyRaw) : undefined;
        if (minApy !== undefined && (!Number.isFinite(minApy) || minApy < 0)) {
          console.error(`Bad --min-apy: ${JSON.stringify(minApyRaw)} is not a usable number — nothing was called.`);
          process.exitCode = 2;
          return;
        }
        await cmdDefiMarkets({
          chain: flagOf(g.rest, "--chain"),
          protocol: flagOf(g.rest, "--protocol"),
          token: flagOf(g.rest, "--token"),
          category: flagOf(g.rest, "--category"),
          minApy,
          limit,
          json: g.json,
          url: g.url,
          pat: g.pat,
        });
        return;
      }
      if (sub === "positions") {
        await cmdDefiPositions({
          wallet: flagOf(g.rest, "--wallet"),
          chain: flagOf(g.rest, "--chain"),
          protocol: flagOf(g.rest, "--protocol"),
          json: g.json,
          url: g.url,
          pat: g.pat,
        });
        return;
      }
      if (sub === "quote-lp" || sub === "build") {
        const slipRaw = flagOf(g.rest, "--slippage-bps");
        const slippageBps = slipRaw !== undefined ? Number(slipRaw) : undefined;
        await cmdDefiBuild({
          action: sub === "quote-lp" ? "quote_lp" : (flagOf(g.rest, "--action") ?? ""),
          investmentId: flagOf(g.rest, "--investment-id") ?? "",
          walletAddress: flagOf(g.rest, "--wallet"),
          amount: flagOf(g.rest, "--amount"),
          tokenAddress: flagOf(g.rest, "--token-address"),
          chain: flagOf(g.rest, "--chain"),
          slippageBps,
          simulate: !g.rest.includes("--no-simulate"),
          json: g.json,
          url: g.url,
          pat: g.pat,
        });
        return;
      }
      console.error(DEFI_USAGE);
      process.exitCode = 2;
      return;
    },
  },
];

async function main(): Promise<void> {
  const [, , cmd, subRaw, ...tailRaw] = process.argv;
  // Flags in the sub slot (e.g. `execute --exchange …`) belong to the
  // arg list — only a non-flag token is a real subcommand.
  const sub = subRaw && !subRaw.startsWith("--") ? subRaw : undefined;
  const tail = subRaw && subRaw.startsWith("--") ? [subRaw, ...tailRaw] : tailRaw;
  // Help is intercepted HERE, before any route runs: `jw3`, `jw3 --help`,
  // `jw3 help`, `jw3 <cmd> --help|-h`, `jw3 <cmd> <sub> --help`. A help
  // request must never reach command code — no MCP call, no venue call, no
  // file or state write, no migration. See help.ts for the registry and
  // help.test.ts for the registry-wide zero-side-effect matrix.
  const wantsHelp = process.argv.slice(2).some((a) => a === "--help" || a === "-h");
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    return;
  }
  if (wantsHelp) {
    const usage = helpFor([cmd, sub, ...tail]);
    if (usage) {
      console.log(usage);
      return;
    }
    // Unknown command with --help: fall through to the unknown-command answer
    // (exit 2) instead of advertising a command the dispatcher does not route.
  }
  try {
    for (const route of ROUTES) {
      if (route.match(cmd, sub)) {
        await route.run(cmd, sub, tail);
        return;
      }
    }
    console.error(`Unknown command: ${[cmd, sub].filter(Boolean).join(" ")}\n\n${HELP}`);
    process.exitCode = 2;
  } catch (e) {
    console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

// Run only when this module IS the entry point. Tests import ROUTES from
// here to pin the command registry against the dispatch table; importing
// must never execute a command.
const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) void main();
