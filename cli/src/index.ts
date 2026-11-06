#!/usr/bin/env node
/**
 * jw3 — JW3.ai command line. Thin wrapper over the mcp-server JSON-RPC
 * surface. Read-only by default; proposals go to the Diary for in-app
 * approve-and-sign. Never executes, never touches keys.
 */
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
import { cmdHarness } from "./commands/harness.js";
import { cmdBacktestLive } from "./commands/backtest-live.js";
import { cmdScoreRecord, cmdScoreReport, cmdScoreStats } from "./commands/score.js";
import { cmdCommittee } from "./commands/committee.js";
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
import { cmdOracle } from "./commands/oracle.js";
import { cmdDegen, cmdDegenRecord, cmdPaperStats } from "./commands/degen.js";
import { cmdTtm } from "./commands/ttm.js";
import { cmdSpikes } from "./commands/spikes.js";
import { cmdConnections, cmdDailyPrep, cmdDiary, cmdDiaryNote, cmdNews, cmdPropose, cmdRisk } from "./commands/extra.js";
import { cmdProposeBracket, cmdProposeCloseAll, cmdProposeIdea, cmdProposePredict } from "./commands/propose-cards.js";
import { cmdFills, cmdPnl } from "./commands/fills.js";
import { cmdPnlReconcile } from "./commands/pnl-reconcile.js";
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
import { cmdVote, cmdVoteRecord, cmdVoteStats } from "./commands/vote.js";
import { cmdLoop } from "./commands/loop.js";
import { cmdReserveSweep } from "./commands/reserve.js";
import { cmdReconcile } from "./commands/reconcile.js";
import { cmdHeat } from "./commands/heat.js";
import {
  SUPERVISE_DEFAULT_HEARTBEAT_SEC,
  SUPERVISE_DEFAULT_MAX_LOG_BYTES,
  SUPERVISE_DEFAULT_MAX_LOG_FILES,
  SUPERVISE_DEFAULT_MAX_RESTARTS,
  cmdSupervise,
  loadManifest,
  parseLoopSpec,
  parseTrailSpec,
} from "./commands/supervise.js";
import {
  DEFI_USAGE,
  cmdDefiBuild,
  cmdDefiMarkets,
  cmdDefiPositions,
  cmdDefiProtocols,
} from "./commands/defi.js";
import { clampInt, flagAny, flagOf, needNum, needNumAny, numAny, numOf, posAny, posOf, refusePaperFlag } from "./args.js";

const HELP = `jw3 — JW3.ai command line (v0.1.0)

Usage:
  jw3 auth login|logout|status [--pat …] [--url …] [--browser] [--scope "mcp:read trade:propose"] [--timeout 300]
  jw3 markets ending [--days 14] [--min-liq 10000] [--limit 25] [--json]
  jw3 analyze prediction <slug|conditionId|id> [--json]
  jw3 analyze trend --exchange kucoin --pair BTC/USDT [--json]
  jw3 scan fade [--exchange kucoin] [--min-chg 3] [--limit 12] [--json]
  jw3 forecast --pair ETH/USDT [--horizon 12] [--json]
  jw3 intel <topic> [--limit 10] [--no-cache] [--json]
  jw3 decide --pair SOL/USDT [--exchange kucoin] [--json]
  jw3 oracle --pair SOL/USDT [--exchange kucoin] [--horizon 12] [--chart chart.png] [--json]
  jw3 degen [--pair SOL/USDT] [--exchange kucoin] [--size 15] [--lev 2] [--max-heat 6] [--max-concurrent 2] [--activation-pct 0.25] [--bounceback-pct 0.08] [--polls 600] [--horizon 12] [--trail] [--live] [--yes] [--paper] [--json]
  jw3 degen record --pair SOL/USDT --outcome win|loss|stop|scratch [--pnl …] [--paper] [--json]
  jw3 degen paper-stats [--json]
  jw3 ttm --pair SOL/USDT --side long|short --equity 10 --base 5 --entry … --atr-pct 0.8 [--lev 25] [--sleeve momentum] [--activation-pct 0.25] [--bounceback-pct 0.08] [--json]
  jw3 spikes --exchange kucoin [--pairs GRAM,SOL,ETH,XBT,SUI,DOT,DOGE,PEPE,UNI] [--cycles 1] [--json]
  jw3 scalp plan --pair SOL/USDT --long|--short [--size 15] [--steps 3] [--json]
  jw3 scalp start|watch|kill --pair SOL/USDT --long|--short [--exchange kucoin] [--size 15] [--steps 3] [--lev 2] [--yes]
  jw3 trail --pair SOL/USDT --side long|short --size 1 [--exchange kucoin] [--activation-pct 0.25] [--bounceback-pct|--backoff-pct 0.08] [--polls 600] [--live] [--yes] [--json]
  jw3 bounce --pair SOL/USDT --side short [--exchange kucoin] [--bounce-pct 0.4] [--lookback-min 60] [--size …] [--yes] [--json]
  jw3 tick --pair SOL/USDT [--seconds 15] [--json]
  jw3 klines --pair SOL/USDT [--tf 5m|15m|1h|1d] [--limit 50] [--rsi] [--vwap] [--json]
  jw3 vote --pair SOL/USDT [--exchange kucoin] [--horizon 12] [--json]
  jw3 vote stats [--json]
  jw3 vote record --pair SOL/USDT --outcome long|short|flat [--json]
  jw3 loop --exchange kucoin --pair SOL/USDT [--long|--short] [--size 15] [--json]
  jw3 grid plan|start --pair SEI/USDT [--bias long|short|neutral] [--step-pct 0.25] [--levels 25] [--size 15] [--lev 2] [--yes]
  jw3 grid backtest --pair SEI/USDT [--step-pct 0.25] [--levels 25] [--contracts 19] [--lev 2] [--days 30] [--json]
  jw3 backtest live --pair SOL/USDT [--days 30] [--tf 15m] [--size 15] [--leverage 20] [--mode maker|chase|taker|all] [--json]
  jw3 backtest scalp --pair SOL/USDT [--days 30] [--tp 0.3] [--fee maker|taker] [--size 60] [--json]
  jw3 farm run [--pairs SOL/USDT,BTC/USDT,ETH/USDT] [--days 30] [--fee maker|taker] [--size 60] [--json]
  jw3 farm leaderboard [--json]
  jw3 live --pair BASE/USDT [--exchange kucoin] [--side long|short|auto] [--risk 3] [--size 15] [--session live] [--turn t1] [--yes] [--json]
  jw3 committee --pair BASE/USDT [--exchange kucoin] [--json]
  jw3 paper create --account NAME [--equity 10000] [--json]
  jw3 paper fund --account NAME --amount 500 [--json]
  jw3 paper reset --account NAME [--json]
  jw3 paper list [--json]
  jw3 paper execute --account NAME --pair SOL/USDT --side buy|sell (--qty … | --size-usd …) --price … [--lev 1] [--tp …] [--sl …] [--fee maker|taker] [--strategy TAG] [--json]
  jw3 paper positions [--account NAME] [--pair …] [--strategy TAG] [--mark …] [--json]
  jw3 paper fills [--account NAME] [--pair …] [--strategy TAG] [--limit 50] [--json]
  jw3 paper pnl [--account NAME] [--json]
  jw3 paper tick --pair SOL/USDT --price … [--account NAME] [--fee maker|taker] [--json]
  jw3 paper promote --account NAME [--position-id …] [--pair …] [--exchange kucoin] [--json]
  jw3 poly scan [--json]
  jw3 connections [--json]
  jw3 diary [--day YYYY-MM-DD | --start-day YYYY-MM-DD --end-day YYYY-MM-DD] [--json]
  jw3 diary-note --body "..." [--day YYYY-MM-DD] [--mode append|replace] [--json]
  jw3 daily-prep [--dry] [--day YYYY-MM-DD] [--json]
  jw3 risk [--state] [--json]
  jw3 news [--pair BTC] [--source CoinDesk] [--limit 6] [--window-hrs 48] [--json]
  jw3 propose --pair BTC/USDT --side long --entry … --stop … [--asset BTC] [--venue kucoin] [--size-usd …] [--thesis …] [--timeframe 4h] [--json]
  jw3 propose-idea --pair BTC/USDT --side buy --entry … --stop … --target 70000[:0.5],75000 --thesis "…" [--rationale "…"] [--json]
  jw3 propose-bracket --exchange kucoin --pair BTC/USDT --side buy --entry-type market --amount … --stop … --tp 70000:50,75000:50 --rationale "…" [--json]
  jw3 propose-predict --market-id <id> --side yes --jev-verdict "…" --rationale "…" [--json]
  jw3 propose-close-all --rationale "…" [--exchange kucoin] [--pair BTC/USDT] [--json]
  jw3 market --exchange binance --pair BTC/USDT [--json]
  jw3 screener [--exchange binance] [--json]
  jw3 positions [--exchange kucoin] [--pair BTC/USDT] [--watch SEC] [--polls N] [--json] [--json-lines]
  jw3 balances [--exchange kucoin] [--json]
  jw3 orders --exchange kucoin [--pair BTC/USDT] [--json]
  jw3 order --exchange kucoin --order-id … [--pair …] [--market spot|futures] [--json]
  jw3 fills --exchange kucoin [--pair BTC/USDT] [--market spot|futures|all] [--days 30] [--limit 50] [--json]
  jw3 pnl --exchange kucoin [--pair BTC/USDT] [--days 30] [--limit 100] [--json]
  jw3 pnl-reconcile --exchange kucoin [--days 2] [--json]
  jw3 onchain [--chains ethereum,solana] [--json]
  jw3 execute --exchange kucoin --pair BTC/USDT --side buy (--amount … | --risk-usd …) [--price …] [--market futures] [--leverage …] [--margin-mode cross|isolated] [--stop …] [--tp … | --tp-legs P1:S1,P2:S2] [--chase SECS [--chase-poll S] [--chase-max N] [--chase-take]] [--idempotency-key …] [--actor …] --yes [--json]
  jw3 close --exchange kucoin --pair BTC/USDT --side long|short [--size …] --yes [--json]
  jw3 exits --exchange kucoin --pair BTC/USDT [--sl …] [--tp …] [--market spot|futures] [--quantity …] --yes [--json]
  jw3 cancel --exchange kucoin --order-id … [--pair …] [--market spot|futures] --yes [--json]
  jw3 cancel-all --exchange kucoin --pair BTC/USDT [--market spot|futures] --yes [--json]
  jw3 reconcile --exchange kucoin --pair BTC/USDT [--json]
  jw3 heat [--exchange kucoin] [--min-free 50] [--json]
  jw3 reserve sweep [--exchange kucoin] [--keep 10] [--currency USDT] [--yes] [--json]
  jw3 defi protocols|markets|investments|positions|quote-lp|build [--chain …] [--protocol …] [--token …] [--investment-id …] [--wallet …] [--amount …] [--json]
  jw3 watchdog check|run|resume [--exchange kucoin] [--poll-sec 15] [--flatten] [--actor NAME] [--once] [--json]
  jw3 monitor [--exchange kucoin] [--json]
  jw3 alert --snapshot <path> [--prev-snapshot <path>] [--state <path>] [--policy <path>] [--transport console|file] [--out <path>] [--json]
  jw3 learning record --pair BASE/USDT --side long|short --entry <px> --exit <px> [--reason <text>] [--pnl <usd>] [--fees <usd>] [--json]
  jw3 learning stats [--log <path>] [--json]
  jw3 harness [--json]
  jw3 score stats [--store <path>] [--json]
  jw3 score report [--store <path>] [--holdout 64] [--json]
  jw3 score record --pair SOL/USDT [--side long] [--pnl …] [--store <path>] [--json]
  jw3 daemon --config <manifest.json> [--once] [--allow-live] [--flatten-on-shutdown] [--json]
  jw3 supervise --trail SOL/USDT:long:1 [--trail …] [--loop kucoin:SOL/USDT] [--config manifest.json] [--once] [--heartbeat-sec 15] [--max-restarts 10] [--allow-live] [--json]
  jw3d supervise …                   same supervisor via the jw3d alias (24/7 entrypoint)

Aliases: diary note, daily prep, pnl reconcile, propose <idea|bracket|predict|close-all|close all>, cancel all — spaced forms of the hyphenated commands.
Flag aliases (same meaning everywhere the option exists): --lev|--leverage, --tf|--timeframe, --bounceback-pct|--backoff-pct.

Global:
  --url <supabase-url>   override JW3_SUPABASE_URL
  --pat <pat>            one-shot PAT (prefers JW3_MCP_PAT env)
  --json                 machine output where supported

Auth: PAT jw3_mcp_… (Settings → Harness Access) or SIWX JWT as bearer.
Stored 0600 in ~/.config/jw3/credentials.json (JW3_CONFIG_HOME override).
Secrets never print, never enter the repo.`;

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
async function main(): Promise<void> {
  const [, , cmd, subRaw, ...tailRaw] = process.argv;
  // Flags in the sub slot (e.g. `execute --exchange …`) belong to the
  // arg list — only a non-flag token is a real subcommand.
  const sub = subRaw && !subRaw.startsWith("--") ? subRaw : undefined;
  const tail = subRaw && subRaw.startsWith("--") ? [subRaw, ...tailRaw] : tailRaw;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(HELP);
    return;
  }
  try {
    if (cmd === "auth") {
      const g = globals(tail);
      await cmdAuth(sub ?? "", {
        pat: g.pat,
        url: g.url,
        browser: g.rest.includes("--browser"),
        scope: flagOf(g.rest, "--scope"),
        timeoutSec: flagOf(g.rest, "--timeout") ? Number(flagOf(g.rest, "--timeout")) : undefined,
      });
      return;
    }
    if (cmd === "markets" && (sub === "ending" || sub === undefined)) {
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
    }
    if (cmd === "analyze" && sub === "prediction") {
      const g = globals(tail);
      const id = g.rest[0];
      if (!id) {
        console.error("Usage: jw3 analyze prediction <slug|conditionId|id> [--json]");
        process.exitCode = 2;
        return;
      }
      await cmdAnalyze({ id, json: g.json, url: g.url, pat: g.pat });
      return;
    }
    if (cmd === "analyze" && sub === "trend") {
      const g = globals(tail);
      await cmdAnalyzeTrend({
        exchange: flagOf(g.rest, "--exchange") ?? "",
        pair: flagOf(g.rest, "--pair") ?? "",
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    }
    if (cmd === "scalp" && (sub === "plan" || sub === "start" || sub === "watch" || sub === "kill" || sub === undefined)) {
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
    }
    if (cmd === "trail") {
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
    }
    if (cmd === "bounce") {
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
    }
    if (cmd === "tick") {
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
    }
    if (cmd === "klines") {
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
    }
    if (cmd === "vote" && (sub === undefined || sub === "stats" || sub === "record")) {
      const g = globals(tail);
      if (sub === "stats") {
        await cmdVoteStats({ json: g.json });
        return;
      }
      if (sub === "record") {
        await cmdVoteRecord({
          pair: flagOf(g.rest, "--pair") ?? "",
          outcome: flagOf(g.rest, "--outcome") ?? "",
          json: g.json,
        });
        return;
      }
      const horizon = clampInt(numOf(g.rest, "--horizon", 12), 1, 120);
      if (!needNum(horizon, "--horizon", g.rest)) return;
      await cmdVote({
        pair: flagOf(g.rest, "--pair") ?? "",
        exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
        horizon,
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    }
    if (cmd === "loop") {
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
    }
    if (cmd === "grid" && (sub === "plan" || sub === "start" || sub === "backtest" || sub === undefined)) {
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
    }
    if (cmd === "daemon" && sub === undefined) {
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
    }
    if (cmd === "watchdog" && (sub === "check" || sub === "run" || sub === "resume" || sub === undefined)) {
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
    }
    if (cmd === "monitor" && sub === undefined) {
      const g = globals(tail);
      await cmdMonitor({
        exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
        thresholds: DEFAULT_MONITOR_THRESHOLDS,
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    }
    if (cmd === "alert" && sub === undefined) {
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
    }
    if (cmd === "learning" && (sub === "record" || sub === "stats" || sub === undefined)) {
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
    }
    if (cmd === "harness" && sub === undefined) {
      const g = globals(tail);
      await cmdHarness({ json: g.json });
      return;
    }
    if (cmd === "score" && (sub === "stats" || sub === "report" || sub === "record" || sub === undefined)) {
      const g = globals(tail);
      if (sub === "report") {
        await cmdScoreReport({ json: g.json, storePath: flagOf(g.rest, "--store"), holdoutSize: numOf(g.rest, "--holdout", 64) });
        return;
      }
      if (sub === "record") {
        await cmdScoreRecord({
          pair: flagOf(g.rest, "--pair") ?? "",
          side: flagOf(g.rest, "--side") ?? "long",
          pnl: numOf(g.rest, "--pnl", 0),
          json: g.json,
          storePath: flagOf(g.rest, "--store"),
        });
        return;
      }
      await cmdScoreStats({ json: g.json, storePath: flagOf(g.rest, "--store") });
      return;
    }
    if (cmd === "committee" && sub === undefined) {
      const g = globals(tail);
      const pair = flagOf(g.rest, "--pair") ?? "";
      if (!pair) {
        console.error("Usage: jw3 committee --pair BASE/USDT [--exchange kucoin] [--json]");
        process.exitCode = 2;
        return;
      }
      await cmdCommittee({
        pair,
        exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    }
    if (cmd === "backtest" && sub === "live") {
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
    }
    if (cmd === "live" && sub === undefined) {
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
    }
    if (cmd === "backtest" && sub === "scalp") {
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
    }
    if (cmd === "farm" && (sub === "run" || sub === "leaderboard" || sub === undefined)) {
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
    }
    if (cmd === "paper") {
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
    }
    if (cmd === "poly" && (sub === "scan" || sub === undefined)) {
      const g = globals(tail);
      await cmdPolyScan({ json: g.json });
      return;
    }
    if (cmd === "scan" && (sub === "fade" || sub === undefined)) {
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
    }
    if (cmd === "forecast") {
      const g = globals(tail);
      const horizon = clampInt(numOf(g.rest, "--horizon", 12), 1, 120);
      if (!needNum(horizon, "--horizon", g.rest)) return;
      await cmdForecast({ pair: flagOf(g.rest, "--pair") ?? "", horizon, json: g.json });
      return;
    }
    if (cmd === "intel") {
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
    }
    if (cmd === "decide") {
      const g = globals(tail);
      await cmdDecide({
        pair: flagOf(g.rest, "--pair") ?? "",
        exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    }
    if (cmd === "oracle") {
      const g = globals(tail);
      const horizon = clampInt(numOf(g.rest, "--horizon", 12), 1, 120);
      if (!needNum(horizon, "--horizon", g.rest)) return;
      await cmdOracle({
        pair: flagOf(g.rest, "--pair") ?? "",
        exchange: flagOf(g.rest, "--exchange") ?? "kucoin",
        horizon,
        chartPath: flagOf(g.rest, "--chart") ?? undefined,
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    }
    if (cmd === "degen" && (sub === undefined || sub === "record" || sub === "paper-stats")) {
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
    }
    if (cmd === "ttm" && (sub === undefined || sub === "plan")) {
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
    }
    if (cmd === "spikes") {
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
    }
    if (cmd === "connections") {
      const g = globals(tail);
      await cmdConnections({ json: g.json, url: g.url, pat: g.pat });
      return;
    }
    if (cmd === "diary" && sub !== "note") {
      const g = globals(tail);
      await cmdDiary({ day: flagOf(g.rest, "--day"), startDay: flagOf(g.rest, "--start-day") ?? flagOf(g.rest, "--start"), endDay: flagOf(g.rest, "--end-day") ?? flagOf(g.rest, "--end"), json: g.json, url: g.url, pat: g.pat });
      return;
    }
    // Space form: `diary note` (same handler; mirrors `cancel all`). Must sit
    // below the guarded bare `diary` above.
    if (cmd === "diary-note" || (cmd === "diary" && sub === "note")) {
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
    }
    // Space form: `daily prep`.
    if (cmd === "daily-prep" || (cmd === "daily" && sub === "prep")) {
      const g = globals(tail);
      await cmdDailyPrep({ dry: tail.includes("--dry"), day: flagOf(g.rest, "--day"), json: g.json, url: g.url, pat: g.pat });
      return;
    }
    if (cmd === "risk") {
      const g = globals(tail);
      await cmdRisk({ json: g.json, state: g.rest.includes("--state"), url: g.url, pat: g.pat });
      return;
    }
    if (cmd === "news") {
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
    }
    // Space forms (`propose idea|bracket|predict|close-all`, plus
    // `propose close all`) are handled by the card branches below — the
    // guard keeps them from falling into the bare propose ticket.
    if (cmd === "propose" && sub !== "idea" && sub !== "bracket" && sub !== "predict" && sub !== "close-all" && sub !== "close") {
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
    }
    // Space form: `propose idea`.
    if (cmd === "propose-idea" || (cmd === "propose" && sub === "idea")) {
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
    }
    // Space form: `propose bracket`.
    if (cmd === "propose-bracket" || (cmd === "propose" && sub === "bracket")) {
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
    }
    // Space form: `propose predict`.
    if (cmd === "propose-predict" || (cmd === "propose" && sub === "predict")) {
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
    }
    // Space forms: `propose close-all` and `propose close all`.
    if (cmd === "propose-close-all" || (cmd === "propose" && (sub === "close-all" || sub === "close"))) {
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
    }
    if (cmd === "market") {
      const g = globals(tail);
      await cmdMarket({
        exchange: flagOf(g.rest, "--exchange") ?? "",
        pair: flagOf(g.rest, "--pair") ?? "",
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    }
    if (cmd === "screener") {
      const g = globals(tail);
      await cmdScreener({
        exchange: flagOf(g.rest, "--exchange") ?? "binance",
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    }
    if (cmd === "positions") {
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
    }
    if (cmd === "balances") {
      const g = globals(tail);
      await cmdBalances({ exchange: flagOf(g.rest, "--exchange"), json: g.json, url: g.url, pat: g.pat });
      return;
    }
    if (cmd === "orders") {
      const g = globals(tail);
      await cmdOrders({
        exchange: flagOf(g.rest, "--exchange") ?? "",
        pair: flagOf(g.rest, "--pair"),
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    }
    if (cmd === "order") {
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
    }
    if (cmd === "fills") {
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
    }
    // `pnl reconcile` (space form) is handled by the pnl-reconcile branch
    // below — the guard keeps it from falling into the bare pnl reader.
    if (cmd === "pnl" && sub !== "reconcile") {
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
    }
    // Space form: `pnl reconcile` (same handler; mirrors `cancel all`).
    // Sits below the guarded bare `pnl` above.
    if (cmd === "pnl-reconcile" || (cmd === "pnl" && sub === "reconcile")) {
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
    }
    if (cmd === "onchain") {
      const g = globals(tail);
      await cmdOnchain({ chains: flagOf(g.rest, "--chains"), json: g.json, url: g.url, pat: g.pat });
      return;
    }
    if (cmd === "execute") {
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
    }
    if (cmd === "close") {
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
    }
    if (cmd === "exits") {
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
    }
    if (cmd === "cancel-all" || (cmd === "cancel" && sub === "all")) {
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
    }
    if (cmd === "cancel") {
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
    }
    if (cmd === "reconcile") {
      const g = globals(tail);
      await cmdReconcile({
        exchange: flagOf(g.rest, "--exchange") ?? "",
        pair: flagOf(g.rest, "--pair") ?? "",
        json: g.json,
        url: g.url,
        pat: g.pat,
      });
      return;
    }
    if (cmd === "heat") {
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
    }
    if (cmd === "reserve" && (sub === "sweep" || sub === undefined)) {
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
    }
    if (cmd === "supervise") {
      const g = globals(tail);
      if (refusePaperFlag(g.rest, "jw3 supervise")) return;
      // Repeatable flags: --trail SPEC (×N), --loop SPEC (×N).
      const trailRaws: string[] = [];
      const loopRaws: string[] = [];
      for (let i = 0; i < g.rest.length; i++) {
        if (g.rest[i] === "--trail" && g.rest[i + 1] !== undefined) trailRaws.push(g.rest[++i] as string);
        else if (g.rest[i] === "--loop" && g.rest[i + 1] !== undefined) loopRaws.push(g.rest[++i] as string);
      }
      const configPath = flagOf(g.rest, "--config");
      let manifestTrails: { pair: string; side: "long" | "short"; size: number; exchange?: string; activationPct?: number; bouncebackPct?: number; polls?: number; live?: boolean; yes?: boolean }[] = [];
      let manifestLoops: { exchange: string; pair: string; direction?: "long" | "short"; sizeUsd?: number }[] = [];
      let heartbeatSec = numOf(g.rest, "--heartbeat-sec", SUPERVISE_DEFAULT_HEARTBEAT_SEC);
      let maxRestarts = numOf(g.rest, "--max-restarts", SUPERVISE_DEFAULT_MAX_RESTARTS);
      let maxLogBytes = SUPERVISE_DEFAULT_MAX_LOG_BYTES;
      let maxLogFiles = SUPERVISE_DEFAULT_MAX_LOG_FILES;
      if (configPath) {
        const m = loadManifest(configPath);
        manifestTrails = (m.trails ?? []) as typeof manifestTrails;
        manifestLoops = (m.loops ?? []) as typeof manifestLoops;
        if (typeof m.heartbeatSec === "number") heartbeatSec = m.heartbeatSec;
        if (typeof m.maxRestarts === "number") maxRestarts = m.maxRestarts;
        if (typeof m.maxLogBytes === "number") maxLogBytes = m.maxLogBytes;
        if (typeof m.maxLogFiles === "number") maxLogFiles = m.maxLogFiles;
      }
      if (!needNum(heartbeatSec, "--heartbeat-sec", g.rest) || !needNum(maxRestarts, "--max-restarts", g.rest)) return;
      try {
        const flagTrails = trailRaws.map((s) => parseTrailSpec(s));
        const flagLoops = loopRaws.map((s) => parseLoopSpec(s));
        await cmdSupervise(
          {
            trails: [...manifestTrails, ...flagTrails],
            loops: [...manifestLoops, ...flagLoops],
            heartbeatSec,
            maxRestarts,
            maxLogBytes,
            maxLogFiles,
            logDir: flagOf(g.rest, "--log-dir"),
            stateDir: flagOf(g.rest, "--state-dir"),
            heartbeatPath: flagOf(g.rest, "--heartbeat"),
            once: g.rest.includes("--once"),
            allowLive: g.rest.includes("--allow-live"),
            json: g.json,
          },
        );
      } catch (e) {
        console.error(`Bad supervise spec: ${e instanceof Error ? e.message : String(e)} — nothing was started.`);
        process.exitCode = 2;
      }
      return;
    }
    if (cmd === "defi") {
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
    }
    console.error(`Unknown command: ${[cmd, sub].filter(Boolean).join(" ")}\n\n${HELP}`);
    process.exitCode = 2;
  } catch (e) {
    console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

void main();
