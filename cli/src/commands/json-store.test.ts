/**
 * json-store characterization (C10-03): the shared helper must reproduce
 * the vote/score store mechanics — tolerant loads, 0600 saves. Written
 * red-first against the helper, then kept green (rule 7).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadJsonStore, resolveStorePath, saveJsonStore } from "./json-store.js";
import { makeSandbox } from "../test-fixtures.js";

type Mini = { version: number; hits: number };

const defaults = (): Mini => ({ version: 1, hits: 0 });
const sanitize = (raw: unknown, into: Mini): void => {
  const r = raw as Record<string, unknown>;
  if (Number.isInteger((r as { hits?: unknown }).hits)) into.hits = (r as { hits: number }).hits;
};

describe("json-store (shared 0600 JSON helper)", () => {
  it("round-trips through save/load with the same file shape", () => {
    const { dir, cleanup } = makeSandbox("jw3-json-store-");
    try {
      const path = resolveStorePath(dir, "mini.json", "/nowhere");
      saveJsonStore(path, { version: 1, hits: 7 });
      const back = loadJsonStore(path, defaults, sanitize);
      assert.equal(back.hits, 7);
      assert.equal(back.version, 1);
    } finally {
      cleanup();
    }
  });

  it("missing file falls back to defaults (never throws)", () => {
    const { dir, cleanup } = makeSandbox("jw3-json-store-");
    try {
      assert.deepEqual(loadJsonStore(join(dir, "absent.json"), defaults, sanitize), { version: 1, hits: 0 });
    } finally {
      cleanup();
    }
  });

  it("corrupt file falls back to defaults (never throws)", () => {
    const { dir, cleanup } = makeSandbox("jw3-json-store-");
    try {
      const path = join(dir, "broken.json");
      writeFileSync(path, "{not json");
      assert.deepEqual(loadJsonStore(path, defaults, sanitize), { version: 1, hits: 0 });
    } finally {
      cleanup();
    }
  });

  it("a throwing sanitizer falls back to defaults (never throws)", () => {
    const { dir, cleanup } = makeSandbox("jw3-json-store-");
    try {
      const path = join(dir, "odd.json");
      writeFileSync(path, JSON.stringify({ hits: 3 }));
      const boom = (): never => {
        throw new Error("bad shape");
      };
      assert.deepEqual(loadJsonStore(path, defaults, boom), { version: 1, hits: 0 });
    } finally {
      cleanup();
    }
  });

  it("creates the dir 0700 and the file 0600", () => {
    const { dir, cleanup } = makeSandbox("jw3-json-store-");
    try {
      const path = join(dir, "sub", "deep", "mini.json");
      saveJsonStore(path, { version: 1, hits: 1 });
      assert.ok(existsSync(path));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, "sub")).mode & 0o777, 0o700);
    } finally {
      cleanup();
    }
  });

  it("explicit dir wins over the config dir", () => {
    assert.equal(resolveStorePath("/tmp/x", "v.json", "/cfg"), join("/tmp", "x", "v.json"));
    assert.equal(resolveStorePath(undefined, "v.json", "/cfg"), join("/cfg", "v.json"));
  });
});
