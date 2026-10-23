import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── `scalp start` MUST NOT PLACE A LADDER OF RESTING LIMITS ───────────
//
// `scalp start --yes` places REAL leveraged orders, and it placed them
// as a LADDER of RESTING LIMIT orders.
//
// The exit legs are venue-native CONDITIONALS that attach to a
// POSITION. A resting limit has no position until it fills, so between
// placement and fill there is nothing for a stop to attach to: the
// order rests on the book UNPROTECTED and becomes a leveraged naked
// position the moment price reaches it.
//
// OBSERVED LIVE on 2026-10-21: `scalp start --yes` placed a PEPE/USDT
// buy limit at 0.00000456. It RESTED (filled: 0), so no position
// existed, and the TP and stop could not attach. The order was a
// $14.23 leveraged order with NO STOP, waiting to become a naked
// leveraged position. It had to be cancelled by hand.
//
// The live path solves this by entering at the MARKET: the position
// exists immediately, so the legs attach at once. A ladder cannot
// become a market entry without ceasing to be a ladder.
//
// So this path REFUSES to place, and points at the path that can. The
// preview still works — the plan is useful for sizing.
//
// The two things that must NOT come back:
//   - a place of a resting limit without a position
//   - a set_exits with a take-profit but no stop

// The test is compiled to dist/commands/, so the package root is two
// levels up. The source file sits at <root>/src/commands/scalp.ts.
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..", "..");
const SRC = readFileSync(join(PKG_ROOT, "src", "commands", "scalp.ts"), "utf8");

let failures = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// ── the refusal exists and is unconditional ────────────────────────────
check("the path refuses", /no trade: `scalp start` places RESTING LIMIT orders/.test(SRC));
check(
  "the refusal explains WHY (a resting limit has no position to protect)",
  // The message is built by string concatenation, so the two halves are
  // on separate lines.
  /has no position/.test(SRC) && /for a stop to attach to/.test(SRC),
);
check("the refusal points at the safe path", /jw3 live --pair/.test(SRC));
check("the refusal is a hard stop", /process\.exitCode = 1;[\s\S]{0,80}return;/.test(SRC));

// ── NO order is placed after the refusal ───────────────────────────────
//
// The decisive check: there must be NO `execute_trade` call in the
// start path at all. If the code places an order anywhere in
// cmdScalpStart, the naked-order exposure is back.
const startIdx = SRC.indexOf("export async function cmdScalpStart");
const killIdx = SRC.indexOf("export async function cmdScalpKill");
check("the start function is found", startIdx > -1);
check("the kill function is found", killIdx > -1);
if (startIdx > -1 && killIdx > -1) {
  const startBody = SRC.slice(startIdx, killIdx);
  check(
    "the start path places NO order",
    !startBody.includes('"execute_trade"'),
    "a resting limit without a position is a naked leveraged order",
  );
  check(
    "the start path arms NO exits",
    !startBody.includes('"set_exits"'),
    "a take-profit with no stop is unbounded loss",
  );
  check(
    "the start path writes NO state file",
    !startBody.includes("writeFileSync(statePath"),
    "a state file for a trade that was never placed would block the pair forever",
  );
}

// ── the SAFE path (kill) still works ───────────────────────────────────
//
// `scalp kill` is the path that CLOSES a position and cancels orders.
// It must keep working: it is the recovery path for any state left by
// the old behaviour.
if (killIdx > -1) {
  const killBody = SRC.slice(killIdx);
  check("the kill path still cancels orders", /cancel/i.test(killBody));
  check("the kill path still closes positions", /close/i.test(killBody));
}

// ── the preview still works ────────────────────────────────────────────
//
// The refusal is on the PLACE path. The dry run must still show the
// plan, because it is useful for sizing.
check("the preview still prints the plan", /SCALP START/.test(SRC));
check("the dry run still says nothing was sent", /Dry run — nothing sent/.test(SRC));

// ── the live path is the one that places ──────────────────────────────
const liveSrc = readFileSync(join(PKG_ROOT, "src", "commands", "live.ts"), "utf8");
check(
  "the live path still places a MARKET entry (the position exists at once)",
  /type: "market"/.test(liveSrc),
);
check(
  "the live path still arms both legs",
  /slPrice/.test(liveSrc) || /set_exits/.test(liveSrc),
);

console.log();
if (failures > 0) {
  console.log(`${failures} check(s) failed — scalp start can still place an unprotected leveraged order.`);
  process.exit(1);
}
console.log("scalp start cannot place an unprotected leveraged order.");
