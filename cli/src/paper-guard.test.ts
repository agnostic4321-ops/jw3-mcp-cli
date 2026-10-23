/**
 * Paper guard — paper code must never touch fund-moving paths.
 *
 * Static check over the paper sources: none of the venue/fund tool names
 * may appear as a quoted tool call, and no import may reach the MCP
 * transport or the trade ticket module. Fails the suite on violation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Works both from src/ (ts) and dist/ (compiled js) layouts. */
function readPaperSource(rel: string): string {
  const candidates = [join(here, rel), join(here, "..", "src", rel)];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return readFileSync(p, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error(`paper guard: cannot locate source for ${rel}`);
}

// Rel paths from src/commands/ (and mirrored under dist/commands/).
const PAPER_SOURCES = ["paper-store.ts", "paper-marks.ts", "commands/paper.ts"];

// Fund-moving / venue tool names — never a quoted tool call in paper code.
const BANNED_TOOLS = [
  "execute_trade",
  "close_position",
  "set_exits",
  "cancel_order",
  "list_open_orders",
  "propose_trade",
  "reserve_sweep",
  "read_live_datum",
  "read_closed_pnl",
  "list_fills",
];

// Modules that can move money or touch the venue.
const BANNED_IMPORTS = ["../mcp.js", "./trade.js", "../trade.js", "mcp-server"];

describe("paper guard: no fund-moving paths", () => {
  for (const rel of PAPER_SOURCES) {
    it(`${rel} contains no fund-moving tool calls or transports`, () => {
      const src = readPaperSource(rel);
      for (const tool of BANNED_TOOLS) {
        const quoted = new RegExp(`["'\`]${tool}["'\`]`);
        assert.ok(!quoted.test(src), `${rel} references banned tool ${tool}`);
      }
      for (const mod of BANNED_IMPORTS) {
        assert.ok(!src.includes(mod), `${rel} imports banned module ${mod}`);
      }
      assert.ok(!/callTool\s*\(/.test(src), `${rel} calls callTool`);
      assert.ok(!/\bfetch\s*\(/.test(src), `${rel} performs fetch`);
    });
  }
});
