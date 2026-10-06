"""Read-only canary/soak; never connects to or writes Cloud SQL.

python scripts/website_soak.py --record hotel-canary.json --hours 72
Input: JSON hotel record with name, website and known phone/address/coordinates.
Output: JSON lines. Default: one pass. Stops on the first failed canary.
"""
import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.website_enrichment import collect_website, safe_url


async def run(record, hours=0, interval=900):
    safe_url(record.get("website"))
    if not isinstance(record.get("name"), str) or not record["name"].strip():
        raise ValueError("Canary requires a property name")
    deadline = time.monotonic() + hours * 3600
    passes, failures = 0, 0
    while True:
        started = time.monotonic()
        result = await collect_website(record)
        passes += 1
        failed = result.get("status") != "collected"
        failures += int(failed)
        print(json.dumps({"pass": passes, "status": result.get("status"), "reason": result.get("reason"),
            "elapsed_seconds": round(time.monotonic() - started, 2), "pages": len(result.get("pages", [])),
            "fields": sorted(result.get("fields", {})), "production_changed": False}), flush=True)
        if time.monotonic() >= deadline or failed:
            break
        await asyncio.sleep(min(interval, max(0, deadline - time.monotonic())))
    print(json.dumps({"passes": passes, "failures": failures, "production_changed": False}), flush=True)
    return 1 if failures else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", type=Path, required=True)
    parser.add_argument("--hours", type=float, default=0)
    parser.add_argument("--interval", type=int, default=900)
    args = parser.parse_args()
    if not 0 <= args.hours <= 168 or args.interval < 900:
        parser.error("hours must be 0..168; interval must be at least 900 seconds")
    if args.record.stat().st_size > 100_000:
        parser.error("Record file exceeds limit")
    return asyncio.run(run(json.loads(args.record.read_text(encoding="utf-8")), args.hours, args.interval))


if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    sys.exit(main())
