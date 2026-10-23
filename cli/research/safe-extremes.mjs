/**
 * SAFE MIN/MAX FOR ARRAYS OF ANY SIZE.
 *
 * `Math.min(...arr)` passes every element as an ARGUMENT, and the
 * engine's argument limit is a few tens of thousands. So a spread over
 * a large array throws:
 *
 *   RangeError: Maximum call stack size exceeded
 *     at Math.min (...rows.map((r) => r.ts))
 *
 * Observed live: the deep conflict study has 987,620 rows, and
 * `Math.min(...rows.map((r) => r.ts))` crashed it. The fix at the
 * time was a hand-written reduce at that ONE site — and the pattern
 * was left in ~100 places across the research scripts, where any
 * script that reads the collector's full history will crash the same
 * way.
 *
 * So the rule lives here, once:
 *
 *   import { minOf, maxOf } from "./safe-extremes.mjs";
 *   const oldest = minOf(rows, (r) => r.ts);
 *
 * Both forms are safe on any size:
 *   minOf(values)            — an array of numbers
 *   minOf(rows, selector)    — a selector applied per element
 *
 * And a REDUCE, never a spread, so nothing is materialised twice.
 */

/**
 * The smallest value in an array, or Infinity for an empty array.
 * @param {number[]} values
 * @returns {number}
 */
export function minOf(values) {
  let m = Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < m) m = v;
  }
  return m;
}

/**
 * The largest value in an array, or -Infinity for an empty array.
 * @param {number[]} values
 * @returns {number}
 */
export function maxOf(values) {
  let m = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v > m) m = v;
  }
  return m;
}

/**
 * The smallest SELECTED value, without materialising a mapped array.
 * @param {Array<any>} rows
 * @param {(row: any) => number} selector
 * @returns {number} Infinity for an empty array
 */
export function minBy(rows, selector) {
  let m = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const v = selector(rows[i]);
    if (v < m) m = v;
  }
  return m;
}

/**
 * The largest SELECTED value, without materialising a mapped array.
 * @param {Array<any>} rows
 * @param {(row: any) => number} selector
 * @returns {number} -Infinity for an empty array
 */
export function maxBy(rows, selector) {
  let m = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    const v = selector(rows[i]);
    if (v > m) m = v;
  }
  return m;
}

/**
 * The oldest and newest timestamps in a set of rows.
 * @param {Array<{ts:number}>} rows
 * @returns {{start:number, end:number, spanMs:number}}
 */
export function timeSpan(rows) {
  const start = minBy(rows, (r) => r.ts);
  const end = maxBy(rows, (r) => r.ts);
  return { start, end, spanMs: end - start };
}
