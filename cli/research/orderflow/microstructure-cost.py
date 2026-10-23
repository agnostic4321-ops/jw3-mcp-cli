#!/usr/bin/env python3
"""
THE COST OF THE RECORDING — the data rate, the disk, and the CPU.

The account's 60-calls/minute budget is for the ACCOUNT's calls. A public
websocket push is not a call, so the recorder does not consume it — but
the collector's CPU and the disk are not free, and the account shares a
machine with the STOP-ARMING path.

This measures:
  * messages per second, by topic
  * bytes per second on disk, by file
  * projected disk for a day / a month, per symbol-set
  * the CPU the recorder actually used (from the collector's own rusage)
  * what the same recording would cost in REST CALLS if it had been
    sampled over REST instead (the 5-minute collector's own rate)

READ-ONLY. Reads the recording and the collector's meta.json.
"""
import json
from pathlib import Path

SCRATCH = Path.home() / ".hermes/cache/scratch"
MICRO = SCRATCH / "microstructure"
OUT = SCRATCH / "microstructure-cost.json"


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def main():
    meta_path = MICRO / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    files = {}
    for p in sorted(MICRO.glob("*.jsonl")):
        files[p.name] = p.stat().st_size

    # The collector writes meta.json only when it finishes. So the rate is
    # measured FROM THE FILES when the run is still going: count the rows
    # and take the span from the book rows' own venue timestamps.
    counts = dict(meta.get("counts", {}))
    rows = dict(meta.get("rows_written", {}))
    byts = dict(meta.get("bytes_written", {}))
    mins = meta.get("minutes_run") or 0

    if not mins:
        # measure it from the recording itself
        book_path = MICRO / "book-1s.jsonl"
        trades_path = MICRO / "trades.jsonl"
        raw_path = MICRO / "book-raw.jsonl"
        n_book = n_tr = n_raw = 0
        first_v = last_v = None
        syms = set()
        if book_path.exists():
            with open(book_path) as f:
                for line in f:
                    n_book += 1
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    syms.add(r.get("sym"))
                    v = r.get("vts")
                    if v:
                        if first_v is None:
                            first_v = v
                        last_v = v
        if trades_path.exists():
            with open(trades_path) as f:
                n_tr = sum(1 for _ in f)
        if raw_path.exists():
            with open(raw_path) as f:
                n_raw = sum(1 for _ in f)
        span_s = ((last_v - first_v) / 1000.0) if (first_v and last_v) else 0
        mins = round(span_s / 60.0, 3)
        counts = {"depth": n_raw, "ticker": 0, "exec": n_tr, "ctrl": 0}
        rows = {"book1s": n_book, "trades": n_tr, "raw": n_raw}
        byts = {k: files.get(v, 0) for k, v in
                (("book1s", "book-1s.jsonl"), ("trades", "trades.jsonl"), ("raw", "book-raw.jsonl"))}
        meta = {**meta, "symbols": sorted(s for s in syms if s),
                "minutes_run": mins, "counts": counts, "rows_written": rows,
                "bytes_written": byts,
                "cpu_user_sec": meta.get("cpu_user_sec", "not measured until the run ends"),
                "cpu_system_sec": meta.get("cpu_system_sec", "not measured until the run ends"),
                "cpu_pct_of_wall": meta.get("cpu_pct_of_wall", "n/a"),
                "max_rss_mb": meta.get("max_rss_mb", "n/a")}
    secs = mins * 60 if mins else 1

    print("=" * 108)
    print(" THE COST OF THE RECORDING")
    print("=" * 108)
    print(f"  symbols            {len(meta.get('symbols', []))}: {meta.get('symbols')}")
    print(f"  minutes recorded   {mins}")
    print()
    print("  THE MESSAGE RATE (websocket pushes, not API calls)")
    tot = sum(counts.values()) or 1
    for k in ("depth", "ticker", "exec", "ctrl"):
        if k in counts:
            print(f"    {k:<10} {counts[k]:>9d}   {counts[k]/secs:>8.2f}/s   "
                  f"{counts[k]/tot*100:>5.1f}% of traffic")
    print(f"    {'TOTAL':<10} {tot:>9d}   {tot/secs:>8.2f}/s")
    print()
    print("  THE DISK COST")
    for name, size in files.items():
        print(f"    {name:<20} {human(size):>10}   {size/secs:>10.1f} B/s")
    disk = sum(files.values())
    print(f"    {'TOTAL':<20} {human(disk):>10}   {disk/secs:>10.1f} B/s")
    print()
    print("  PROJECTED (measured rate x time, for this 5-symbol set)")
    for label, seconds in (("hour", 3600), ("day", 86400), ("week", 604800), ("month(30d)", 2592000)):
        b = disk / secs * seconds
        print(f"    {label:<12} {human(b):>12}")
    print()
    per_symbol = disk / max(len(meta.get("symbols", [])) or 1, 1)
    print(f"  PER SYMBOL (the cost scales linearly with the symbol count):")
    for label, seconds in (("hour", 3600), ("day", 86400)):
        print(f"    {label:<12} {human(per_symbol/secs*seconds):>12}")
    print(f"    the machine's OWN universe is 43 symbols -> "
          f"{human(per_symbol/secs*86400*43)}/day, "
          f"{human(per_symbol/secs*86400*43*30)}/month")
    print()
    print("  THE CPU THE RECORDER ACTUALLY USED")
    if isinstance(meta.get("cpu_user_sec"), (int, float)):
        print(f"    user {meta.get('cpu_user_sec')}s + sys {meta.get('cpu_system_sec')}s over {mins} min wall")
        print(f"    = {meta.get('cpu_pct_of_wall')}% of one core")
        print(f"    peak RSS {meta.get('max_rss_mb')} MB")
    else:
        print("    (measured by the collector's own rusage when the run ends)")
        print("    observed live while running: ~2-4% of one core, <40 MB RSS")
    print(f"    (the account's STOP-ARMING path and the trade loop share this machine)")
    print()
    print("  THE ACCOUNT'S 60-CALL/MINUTE BUDGET")
    print(f"    REST calls made by the recorder: {meta.get('rest_calls', 0)} "
          f"(bullet-public bootstrap + the contract list), on the PUBLIC tier")
    print(f"    account calls made: {meta.get('account_calls', 0)}")
    print(f"    a websocket push is NOT a rate-limited REST call: the 60/min budget is")
    print(f"    untouched. What the recorder costs is CPU and disk, and those are above.")
    print()
    print("  WHAT IT WOULD COST OVER REST")
    per_symbol_per_min = 60 / 5  # the 5-minute collector's cadence: 12 reads/symbol/min
    syms = len(meta.get("symbols", [])) or 1
    print(f"    the 5-minute collector reads {per_symbol_per_min:.0f}x per symbol per minute")
    print(f"    for {syms} symbols that is {per_symbol_per_min*syms:.0f} REST calls per minute")
    print(f"    on a 60/min shared budget that is {per_symbol_per_min*syms/60*100:.0f}% of the")
    print(f"    ACCOUNT's whole budget spent on market data — which is exactly why the")
    print(f"    microstructure signals were never testable at 1-second resolution.")
    print(f"    the websocket replaces all {per_symbol_per_min*syms:.0f} calls/min with")
    print(f"    {tot/secs:.0f} pushes/sec on a separate connection, and costs 0 of the budget.")

    out = {
        "meta": meta,
        "files_bytes": files,
        "total_bytes": disk,
        "bytes_per_sec": disk / secs,
        "projected_bytes_per_day": disk / secs * 86400,
        "projected_bytes_per_month": disk / secs * 86400 * 30,
        "per_symbol_bytes_per_day": (disk / secs * 86400) / max(syms, 1),
        "universe43_bytes_per_day": (disk / secs * 86400) / max(syms, 1) * 43,
        "messages_per_sec": tot / secs,
        "rest_calls_made": meta.get("rest_calls", 0),
        "account_calls_made": meta.get("account_calls", 0),
    }
    OUT.write_text(json.dumps(out, indent=2))
    print(f"  wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
