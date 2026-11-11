/**
 * The npm package carries no test code (W8-L11h). `files` used to ship every
 * build artifact under dist/, including the test preload and fixtures. This
 * test walks the built output, finds every module the published entry point
 * cannot reach (test files and test-only helpers), and asserts the package
 * manifest excludes each one. The byte-level proof is `npm pack --dry-run`
 * in the lane gates.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = here;
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files?: string[] };

/** Positive/negative glob match, enough for the patterns this manifest uses. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*\*\//g, "(?:.*/)?").replace(/\*/g, "[^/]*");
  return new RegExp(`^${body}$`);
}

/** Would npm pack this dist-relative path, given the `files` patterns? */
function packed(rel: string): boolean {
  let included = false;
  for (const pattern of pkg.files ?? []) {
    if (pattern.startsWith("!")) {
      if (globToRegExp(pattern.slice(1)).test(rel)) return false;
    } else if (pattern === "dist" ? rel === "dist" || rel.startsWith("dist/") : globToRegExp(pattern).test(rel)) {
      included = true;
    }
  }
  return included;
}

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...jsFiles(path));
    else if (ent.name.endsWith(".js")) out.push(path);
  }
  return out;
}

/** Modules reachable from the published entry point via `from "./x.js"` imports. */
function reachableFromIndex(): Set<string> {
  const seen = new Set<string>();
  const stack = [join(dist, "index.js")];
  while (stack.length) {
    const current = stack.pop() as string;
    if (seen.has(current) || !existsSync(current)) continue;
    seen.add(current);
    for (const match of readFileSync(current, "utf8").matchAll(/from\s+"(\.[^"]+)"/g)) {
      const target = resolvePath(dirname(current), match[1] as string);
      stack.push(target.endsWith(".js") ? target : `${target}.js`);
    }
  }
  return seen;
}

describe("npm package excludes test-only build output", () => {
  it("the build is present", () => {
    assert.ok(existsSync(join(dist, "index.js")), "dist/index.js must exist (npm test builds first)");
    assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, "package.json files must be declared");
  });

  it("packs the runtime entry point and registry", () => {
    for (const rel of ["dist/index.js", "dist/help.js", "dist/mcp.js", "dist/commands/paper.js"]) {
      assert.ok(packed(rel), `${rel} must ship`);
    }
  });

  it("every *.test.js build artifact is excluded", () => {
    const tests = jsFiles(dist).filter((f) => f.endsWith(".test.js"));
    assert.ok(tests.length > 50, `expected the test build output, found ${tests.length}`);
    for (const file of tests) {
      const rel = relative(dirname(dist), file).split("\\").join("/");
      assert.ok(!packed(rel), `${rel} must not ship`);
    }
  });

  it("every non-test module unreachable from the entry point is excluded", () => {
    const reachable = reachableFromIndex();
    const orphans = jsFiles(dist)
      .filter((f) => !f.endsWith(".test.js") && !reachable.has(f))
      .map((f) => relative(dirname(dist), f).split("\\").join("/"));
    assert.ok(orphans.includes("dist/test-env.js"), "the network-guard preload is test-only");
    assert.ok(orphans.includes("dist/test-fixtures.js"), "the CLI runner fixture is test-only");
    for (const rel of orphans) {
      assert.ok(!packed(rel), `${rel} is test-only and must not ship`);
    }
  });
});
