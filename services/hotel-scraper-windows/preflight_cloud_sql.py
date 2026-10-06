"""Read-only, dedicated-identity preflight for the production Cloud SQL path.

This starts the app-managed Cloud SQL Auth Proxy, obtains the configured
database password through the dedicated gcloud profile without displaying it,
runs ``SELECT 1``, and compares the production catalog to the approved schema
contract. It does not queue ZIPs, scrape Maps, insert/update/delete rows, or
run DDL.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any

from app import cloud_proxy, database
from app.config import settings


def _result(*, connected: bool, schema_compatible: bool | None, error: str | None) -> dict[str, Any]:
    return {
        "read_only": True,
        "dedicated_account": settings.GCP_GCLOUD_ACCOUNT,
        "gcloud_config_name": settings.GCP_GCLOUD_CONFIG_NAME,
        "database_connected": connected,
        "schema_compatible": schema_compatible,
        "error": error,
        "database_state": dict(database.db_state),
        "schema_diagnostics": list(database.schema_state.get("diagnostics") or []),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the app-managed Cloud SQL path without writing data")
    parser.add_argument("--timeout", type=int, default=45, help="seconds to wait for proxy/database readiness (default: 45)")
    args = parser.parse_args()
    if args.timeout < 5 or args.timeout > 120:
        parser.error("--timeout must be between 5 and 120 seconds")

    if settings.DB_BACKEND != "cloud":
        print(json.dumps(_result(connected=False, schema_compatible=None, error="DB_BACKEND must be cloud"), indent=2))
        return 2
    if settings.ALLOW_UNMANAGED_CLOUD_SQL_CONNECTION:
        print(json.dumps(_result(
            connected=False,
            schema_compatible=None,
            error="Refusing preflight while unmanaged Cloud SQL connections are enabled",
        ), indent=2))
        return 2

    deadline = time.monotonic() + args.timeout
    last_error: str | None = None
    cloud_proxy.start_watchdog()
    try:
        while time.monotonic() < deadline:
            cloud_proxy.ensure_proxy()
            engine = database.ensure_engine()
            if engine is not None and database.check_connection():
                try:
                    compatible = database.check_schema_compatible(force=True)
                except Exception as exc:  # catalog failures must be reported, never ignored
                    last_error = str(exc).splitlines()[0][:300] or type(exc).__name__
                    break
                payload = _result(
                    connected=True,
                    schema_compatible=compatible,
                    error=None if compatible else "Production schema differs from the approved write contract",
                )
                print(json.dumps(payload, indent=2, default=str))
                return 0 if compatible else 3
            last_error = str(database.db_state.get("error") or "Database/proxy not ready")[:300]
            time.sleep(1)
        print(json.dumps(_result(connected=False, schema_compatible=None, error=last_error), indent=2, default=str))
        return 1
    finally:
        # The normal app will start its own isolated proxy. Stopping this
        # short-lived preflight child avoids leaving a listener on port 5432.
        cloud_proxy.stop_proxy()


if __name__ == "__main__":
    sys.exit(main())
