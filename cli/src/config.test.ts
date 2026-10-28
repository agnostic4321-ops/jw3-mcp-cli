import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseUrl, clearPat, configDir, credPath, maskBearerArgs, resolvePat, savePat } from "./config.js";

describe("config", () => {
  it("strips trailing slashes + honors override", () => {
    assert.equal(baseUrl("https://x.supabase.co///"), "https://x.supabase.co");
    assert.ok(baseUrl().includes("supabase.co"));
  });
  it("prefers flag, then env, then file — never throws", () => {
    const savedPat = process.env.JW3_MCP_PAT;
    const savedHome = process.env.JW3_CONFIG_HOME;
    delete process.env.JW3_MCP_PAT;
    try {
      const dir = mkdtempSync(join(tmpdir(), "jw3-cli-"));
      process.env.JW3_CONFIG_HOME = dir;
      assert.equal(resolvePat(), null);
      writeFileSync(join(dir, "credentials.json"), JSON.stringify({ pat: "jw3_mcp_file" }));
      assert.equal(credPath(), join(dir, "credentials.json"));
      assert.equal(resolvePat(), "jw3_mcp_file");
      process.env.JW3_MCP_PAT = "jw3_mcp_env";
      assert.equal(resolvePat(), "jw3_mcp_env");
      assert.equal(resolvePat("jw3_mcp_flag"), "jw3_mcp_flag");
    } finally {
      if (savedPat === undefined) delete process.env.JW3_MCP_PAT;
      else process.env.JW3_MCP_PAT = savedPat;
      if (savedHome === undefined) delete process.env.JW3_CONFIG_HOME;
      else process.env.JW3_CONFIG_HOME = savedHome;
    }
  });
  it("ignores blank overrides and falls back to the default dir", () => {
    const savedHome = process.env.JW3_CONFIG_HOME;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const savedPat = process.env.JW3_MCP_PAT;
    delete process.env.JW3_MCP_PAT;
    try {
      process.env.JW3_CONFIG_HOME = "   ";
      process.env.XDG_CONFIG_HOME = "";
      assert.match(configDir(), /jw3$/);
      assert.match(credPath(), /jw3[\\/]credentials\.json$/);
    } finally {
      if (savedHome === undefined) delete process.env.JW3_CONFIG_HOME;
      else process.env.JW3_CONFIG_HOME = savedHome;
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      if (savedPat === undefined) delete process.env.JW3_MCP_PAT;
      else process.env.JW3_MCP_PAT = savedPat;
    }
  });
  it("savePat trims, stores 0600 under a 0700 dir, and refuses empties", () => {
    const savedHome = process.env.JW3_CONFIG_HOME;
    const dir = mkdtempSync(join(tmpdir(), "jw3-cli-pat-"));
    process.env.JW3_CONFIG_HOME = dir;
    try {
      savePat("  jw3_mcp_trimmed  ");
      assert.equal(resolvePat(), "jw3_mcp_trimmed");
      assert.equal(statSync(credPath()).mode & 0o777, 0o600);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.throws(() => savePat("   "), /empty/);
      // The refused write leaves the stored PAT untouched.
      assert.equal(resolvePat(), "jw3_mcp_trimmed");
      assert.equal(clearPat(), true);
      assert.equal(resolvePat(), null);
    } finally {
      if (savedHome === undefined) delete process.env.JW3_CONFIG_HOME;
      else process.env.JW3_CONFIG_HOME = savedHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("maskBearerArgs", () => {
  it("masks --pat values in both spellings", () => {
    assert.deepEqual(maskBearerArgs(["trail", "--pat", "jw3_mcp_secret", "--pair", "SOL/USDT"]), [
      "trail",
      "--pat",
      "[REDACTED]",
      "--pair",
      "SOL/USDT",
    ]);
    assert.deepEqual(maskBearerArgs(["--pat=jw3_mcp_secret"]), ["--pat=[REDACTED]"]);
  });
  it("masks bare tokens and leaves ordinary args alone", () => {
    assert.deepEqual(maskBearerArgs(["loop", "jw3_mcp_abc123"]), ["loop", "[REDACTED]"]);
    assert.deepEqual(maskBearerArgs(["--pair", "SOL/USDT", "--size", "1"]), ["--pair", "SOL/USDT", "--size", "1"]);
  });
  it("does not mutate the input array", () => {
    const argv = ["--pat", "jw3_mcp_x"];
    maskBearerArgs(argv);
    assert.deepEqual(argv, ["--pat", "jw3_mcp_x"]);
  });
});
