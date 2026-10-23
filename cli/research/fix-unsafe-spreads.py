"""
MECHANICALLY REPLACE THE UNSAFE SPREADS IN THE RESEARCH SCRIPTS.

`Math.min(...arr)` passes every element as an ARGUMENT, and the engine's
argument limit is a few tens of thousands — so a spread over a large
array throws "Maximum call stack size exceeded". Observed live: the deep
conflict study has 987,620 rows and `Math.min(...rows.map((r) => r.ts))`
crashed it. The fix at the time was a hand-written reduce at that ONE
site, and the pattern was left in ~170 places across the research
scripts, where any script that reads the collector's full history will
crash the same way.

THE TWO FORMS:
    Math.min(...arr)          ->  minOf(arr)
    Math.max(...arr)          ->  maxOf(arr)
    Math.min(...rows.map(f))  ->  minBy(rows, f)
    Math.max(...rows.map(f))  ->  maxBy(rows, f)

The second form needs care: the selector is an arbitrary expression, so
the whole `rows.map(<selector>)` must be captured, not just the
selector's head.

THE IMPORT: it must go after the LAST complete import statement, which
means after the line that ends an import block (`} from "...";`), not
after the line that starts one. Getting that wrong puts the import
inside a multi-line import's braces and breaks the file.
"""
import re
import glob
import os
import sys

RES = os.path.dirname(os.path.abspath(__file__))

# The mapped form: Math.min(...rows.map(SELECTOR)) — the selector runs
# to the matching close paren, so the pattern is matched with a small
# nesting-aware scan rather than a regex.
MAP_OPEN = re.compile(r'Math\.(min|max)\(\.\.\.([A-Za-z_$][\w$]*)\.map\(')
# The OUTER paren of Math.min( — the scan starts there so the returned
# end index is past the outer ')' and the replacement is exact.
OUTER_OPEN = re.compile(r'Math\.(min|max)\(')
PLAIN = re.compile(r'Math\.(min|max)\(\.\.\.([A-Za-z_$][\w$.]*)\)')
# A spread of a known-small constant list is safe.
SAFE_NAMES = {'HOLDS', 'GRID', 'holds', 'grid'}
IMPORT_LINE = 'import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";'
# The general form: Math.min(... followed by an arbitrary expression.
GENERAL = re.compile(r'Math\.(min|max)\(\.\.\.')


def scan_mapped(code, map_paren, outer_paren):
    """Return (selector, end_index) for Math.min(...rows.map(SELECTOR)).

    `map_paren` is the index of the '(' that opens .map( and
    `outer_paren` is the index of the '(' that opens Math.min(.

    The selector is the text between .map( and ITS matching ')'; the
    end index is just past the OUTER ')' — so the replacement consumes
    the whole Math.min(...) expression and nothing else.
    """
    # the selector: from just after .map('s '(' to its matching ')'
    i = map_paren + 1
    depth = 1
    in_str = None
    sel_end = None
    while i < len(code):
        ch = code[i]
        if in_str:
            if ch == '\\':
                i += 2
                continue
            if ch == in_str:
                in_str = None
        elif ch in ('"', "'", '`'):
            in_str = ch
        elif ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
            if depth == 0:
                sel_end = i
                break
        i += 1
    if sel_end is None:
        return None, map_paren
    selector = code[map_paren + 1:sel_end]
    # the outer ')': scan FROM the outer '(' — the outer '(' is itself
    # depth 1, so the scan must start AT it. Starting at outer_paren+1
    # stops at the MAP's ')' and leaves the outer ')' behind, which
    # produces `maxBy(rows, (r) => r.ts))`.
    j = outer_paren
    depth = 0
    in_str = None
    while j < len(code):
        ch = code[j]
        if in_str:
            if ch == '\\':
                j += 2
                continue
            if ch == in_str:
                in_str = None
        elif ch in ('"', "'", '`'):
            in_str = ch
        elif ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
            if depth == 0:
                return selector, j + 1
        j += 1
    return selector, sel_end + 1


def scan_expr(code, start):
    """Read a balanced expression from `start` and return (text, end_index).

    The expression ends at the ')' that closes the Math.min( call, so
    the scan counts the parens/brackets/braces from that point.
    """
    i = start
    depth = 0
    in_str = None
    while i < len(code):
        ch = code[i]
        if in_str:
            if ch == '\\':
                i += 2
                continue
            if ch == in_str:
                in_str = None
        elif ch in ('"', "'", '`'):
            in_str = ch
        elif ch in '([{':
            depth += 1
        elif ch in ')]}':
            if depth == 0:
                # the ')' that closes Math.min(
                return code[start:i], i + 1
            depth -= 1
        i += 1
    return None, start


def fix_file(path):
    src = open(path).read()
    original = src

    # 1. the mapped form
    out = []
    pos = 0
    while True:
        m = MAP_OPEN.search(src, pos)
        if not m:
            out.append(src[pos:])
            break
        out.append(src[pos:m.start()])
        # the selector is the map() body; the OUTER ')' must also be
        # consumed, so the scan runs from the map's '(' to the outer ')'
        outer_paren = m.start() + len('Math.') + len(m.group(1))
        selector, end = scan_mapped(src, m.end() - 1, outer_paren)
        if selector is None or not selector.strip():
            out.append(src[m.start():end])
            pos = end
            continue
        helper = 'minBy' if m.group(1) == 'min' else 'maxBy'
        out.append('%s(%s, %s)' % (helper, m.group(2), selector.strip()))
        pos = end
    src = ''.join(out)

    # 2. the plain form
    def repl_plain(m):
        fn, arr = m.group(1), m.group(2)
        if arr in SAFE_NAMES:
            return m.group(0)
        helper = 'minOf' if fn == 'min' else 'maxOf'
        return '%s(%s)' % (helper, arr)

    src = PLAIN.sub(repl_plain, src)

    # 3. the GENERAL form: Math.min(...EXPR) where EXPR is any array
    # expression — an Object.values(), a .filter(), a nested member. The
    # plain minOf(EXPR)/maxOf(EXPR) works for all of them, because it
    # iterates whatever array the expression produces.
    def repl_general(code):
        out = []
        pos = 0
        while True:
            m = GENERAL.search(code, pos)
            if not m:
                out.append(code[pos:])
                break
            out.append(code[pos:m.start()])
            expr_start = m.end()
            expr, expr_end = scan_expr(code, expr_start)
            if expr is None:
                out.append(code[m.start():m.end()])
                pos = m.end()
                continue
            helper = 'minOf' if m.group(1) == 'min' else 'maxOf'
            out.append('%s(%s)' % (helper, expr.strip()))
            pos = expr_end
        return ''.join(out)

    src = repl_general(src)

    if src == original:
        return 0, False

    # 3. the import, after the last COMPLETE import statement
    if 'safe-extremes.mjs' not in src:
        lines = src.split('\n')
        last = -1
        i = 0
        while i < len(lines):
            l = lines[i]
            if l.startswith('import '):
                # a multi-line import ends at the line with `from "..."`
                j = i
                while j < len(lines) and ' from "' not in lines[j] and ' from \'' not in lines[j]:
                    j += 1
                last = j
                i = j + 1
                continue
            i += 1
        if last >= 0:
            lines.insert(last + 1, IMPORT_LINE)
        else:
            # a SHEBANG must stay the first line, so the import goes
            # after it — putting it above breaks the file.
            at = 1 if lines and lines[0].startswith('#!') else 0
            lines.insert(at, IMPORT_LINE)
        src = '\n'.join(lines)

    open(path, 'w').write(src)
    return 1, True


def main():
    changed = []
    for path in sorted(glob.glob(os.path.join(RES, '*.mjs'))):
        base = os.path.basename(path)
        if base in ('safe-extremes.mjs', 'test-no-unsafe-spreads.mjs'):
            continue
        _, did = fix_file(path)
        if did:
            changed.append(base)
    print('  the files changed: %d' % len(changed))
    for c in changed:
        print('    ', c)


if __name__ == '__main__':
    main()
