/**
 * OQ-09 goldens — every verdict-stack command and every decision producer,
 * byte-identical to what the pre-OQ-09 seats produced.
 *
 * The cases (fixture inputs, injected fetchers/clock/venue, no network) are
 * in verdict-golden.cases.ts; the recorded outputs in verdict.golden.json
 * (recorded on the pre-OQ-09 seats). Phase 1 of OQ-09 changes no
 * decision, so every case must match byte for byte — key order included.
 * Re-record ONLY for an owner-approved change: JW3_VERDICT_GOLDEN_RECORD=1.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASES, loadGoldens, runCase, writeGoldens, type Golden } from "./verdict-golden.cases.js";

const RECORD = process.env.JW3_VERDICT_GOLDEN_RECORD === "1";

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

const ENV_KEYS = ["JW3_CONFIG_HOME", "JW3_MCP_PAT", "JW3_ACCOUNT_USD", "JW3_FEE_TIER_OK"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let home = "";
before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), "jw3-oq09-home-"));
  process.env.JW3_CONFIG_HOME = home;
  delete process.env.JW3_MCP_PAT;
  delete process.env.JW3_ACCOUNT_USD;
  delete process.env.JW3_FEE_TIER_OK;
});
after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(home, { recursive: true, force: true });
});

const goldens: Record<string, Golden> = RECORD ? {} : loadGoldens();

describe("OQ-09 goldens: every verdict-stack command and decision producer, byte-identical", () => {
  for (const [name, run] of CASES) {
    it(name, async () => {
      const got = await runCase(run);
      if (RECORD) {
        goldens[name] = got;
        return;
      }
      const want = goldens[name];
      assert.ok(want, `no golden recorded for ${name}`);
      assert.deepEqual(got, want);
      // Byte-identical, key order included (deepEqual ignores key order).
      assert.equal(JSON.stringify(got), JSON.stringify(want), `key order changed for ${name}`);
    });
  }
  it("records a golden for every case and nothing else", () => {
    if (RECORD) return;
    assert.deepEqual(Object.keys(goldens).sort(), CASES.map(([n]) => n).sort());
  });
  it("guard: degen still trades on the fixture (the retired seats did not take the live path)", async () => {
    if (RECORD) return;
    const entry = CASES.find(([n]) => n === "degen split models, tuned store → long fire (decisions + venue calls)");
    assert.ok(entry, "the degen fire golden case is gone — the live path lost its pin");
    const got = await runCase(entry[1]);
    const sent = (got.decisions ?? []).filter((d) => d.status === "sent");
    assert.ok(sent.some((d) => d.tool === "execute_trade"), "degen fire sent no live order");
    assert.ok((got.calls ?? []).some((c) => c.name === "execute_trade"), "degen fire made no venue execute_trade call");
  });
  after(() => {
    if (RECORD) writeGoldens(goldens);
  });
});
