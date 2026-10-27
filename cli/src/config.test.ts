import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseUrl, credPath, maskBearerArgs, resolvePat } from "./config.js";

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
