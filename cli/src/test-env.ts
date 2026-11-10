/**
 * Test-run preload (`npm test` → `node --import ./dist/test-env.js --test …`).
 *
 * Every test process gets a throwaway config home unless the caller already
 * chose one, so no test reads or writes the operator's ~/.config/jw3 —
 * credentials, state files, and the watchdog breaker that the live order
 * gate reads on every opening order (OQ-12). A tripped breaker on the
 * operator's machine must not turn the suite red, and a test must never
 * write next to a real one.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.JW3_CONFIG_HOME?.trim()) {
  process.env.JW3_CONFIG_HOME = mkdtempSync(join(tmpdir(), "jw3-test-config-"));
}
