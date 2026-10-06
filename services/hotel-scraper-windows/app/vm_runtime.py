"""Adapters for the pinned repo services; no UI-thread I/O or paid Places calls."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from app.config import settings


def bundled_source_root():
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "app" / "vm_sources"
    return Path(__file__).resolve().parent / "vm_sources"


def source_root(vertical="hotel"):
    from app.worker_updates import active_root
    return active_root(bundled_source_root(), vertical)


def node_path():
    bundled = Path(getattr(sys, "_MEIPASS", "")) / "vm_runtime" / "node.exe"
    found = settings.VM_NODE_PATH or (str(bundled) if bundled.is_file() else shutil.which("node"))
    if not found or not Path(found).is_file():
        raise RuntimeError("The imported directory pipelines require the bundled Node.js runtime")
    return found


def _run_hotel_pipeline(records, city, state, zip_code):
    places = []
    for record in records:
        components = []
        if record.get("zip"):
            components.append({"types": ["postal_code"], "longText": record["zip"]})
        if record.get("state"):
            components.append({"types": ["administrative_area_level_1"], "shortText": record["state"]})
        places.append({"id": record.get("place_id"), "displayName": {"text": record.get("name")},
            "location": {"latitude": record.get("lat"), "longitude": record.get("lng")},
            "formattedAddress": record.get("formatted_address"), "addressComponents": components,
            "rating": record.get("rating"), "userRatingCount": record.get("user_ratings_total"),
            "priceLevel": record.get("price_level"), "nationalPhoneNumber": record.get("phone"),
            "websiteUri": record.get("website"), "googleMapsUri": record.get("google_maps_uri"),
            "primaryType": record.get("primary_type"), "types": record.get("types"),
            "businessStatus": record.get("business_status")})
    payload = {"zipRow": {"zip": zip_code, "city": city, "state": state}, "places": places}
    env = dict(os.environ)
    # The injected pipeline is a pure mapping invocation. Prevent any inherited
    # credentials or API keys being available even if upstream code changes.
    for key in list(env):
        if key.startswith(("PG", "GOOGLE_", "CLOUDSDK_")) or key in ("DATABASE_URL", "PLACES_API_KEY", "GMAIL_APP_PASSWORD"):
            env.pop(key, None)
    result = subprocess.run([node_path(), "--max-old-space-size=128", str(source_root() / "hotel-local-bridge.mjs")],
        input=json.dumps(payload), capture_output=True, text=True, timeout=30, env=env,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise RuntimeError("Imported hotel VM mapping failed; no batch was written")
    mapped = json.loads(result.stdout)
    if len(mapped) != len(records):
        raise RuntimeError("Imported hotel VM rejected records; refusing a partial silent write")
    names = {"dedupKey": "dedup_key", "formattedAddress": "formatted_address", "queryZip": "query_zip",
             "placeId": "place_id", "userRatingsTotal": "user_ratings_total", "priceLevel": "price_level",
             "googleMapsUri": "google_maps_uri", "primaryType": "primary_type", "businessStatus": "business_status"}
    output = []
    for original, vm in zip(records, mapped):
        row = dict(original)
        for field in ("dedupKey", "placeId", "name", "formattedAddress", "zip", "queryZip", "state", "lat", "lng",
                      "rating", "userRatingsTotal", "priceLevel", "phone", "website", "googleMapsUri", "primaryType", "types", "businessStatus"):
            row[names.get(field, field)] = vm.get(field)
        row["raw"] = {**(original.get("raw") or {}), "pipeline": "imported_hotel_vm",
                      "places_transport": "local_chrome", "feeding_transport": "guarded_desktop_outbox"}
        output.append(row)
    return output


async def map_browser_results(records, city, state, zip_code):
    if not records or not settings.VM_USE_IMPORTED_HOTEL_PIPELINE or os.getenv("HUSSHONE_TEST_MODE"):
        return records
    return await asyncio.to_thread(_run_hotel_pipeline, records, city, state, zip_code)
