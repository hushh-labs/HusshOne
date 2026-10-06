"""Discover a candidate from an existing Maps identity, never a name search."""
from datetime import datetime, timezone
from urllib.parse import urlsplit, parse_qs

from app.website_enrichment import safe_url, WebsiteBlocked


def maps_identity_url(record):
    cid = str((record.get("raw") or {}).get("google_cid") or "")
    if cid.isdigit() and 0 < int(cid) < 2 ** 64:
        return "https://www.google.com/maps?cid=" + cid
    url = record.get("google_maps_uri")
    parts = urlsplit(safe_url(url))
    if parts.hostname not in ("google.com", "www.google.com", "maps.google.com"):
        raise WebsiteBlocked("No trusted Maps identity URL")
    legacy_cid = parse_qs(parts.query).get("cid", [""])[0]
    if parts.path in ("/", "/maps") and legacy_cid.isdigit() and 0 < int(legacy_cid) < 2 ** 64:
        return "https://www.google.com/maps?cid=" + legacy_cid
    if not parts.path.startswith("/maps"):
        raise WebsiteBlocked("No trusted Maps identity URL")
    if not (parse_qs(parts.query).get("cid") or parse_qs(parts.query).get("query_place_id") or "/place/" in parts.path):
        raise WebsiteBlocked("A Maps search is not a property identity")
    return url


def discover_website(record):
    from playwright.sync_api import sync_playwright
    from app.chrome_scraper import _detail_fields
    result = {"version": 1, "status": "needs_review", "identity": "unconfirmed",
              "collected_at": datetime.now(timezone.utc).isoformat(), "fields": {}, "pages": [],
              "requested_url": None, "scraped_via": "maps_website_discovery"}
    try:
        url = maps_identity_url(record)
        result["requested_url"] = url
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True, args=["--disable-gpu"])
            try:
                context = browser.new_context(service_workers="block", accept_downloads=False)
                # Never follow the business website in this browser; a separate
                # collector must validate its DNS and robots policy.
                def restrict(route):
                    host = urlsplit(route.request.url).hostname or ""
                    allowed = any(host == domain or host.endswith("." + domain)
                                  for domain in ("google.com", "gstatic.com", "googleusercontent.com"))
                    if allowed and route.request.method == "GET":
                        route.continue_()
                    else:
                        route.abort()
                context.route("**/*", restrict)
                if hasattr(context, "route_web_socket"):
                    context.route_web_socket("**/*", lambda ws: ws.close())
                page = context.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
                page.locator("h1").first.wait_for(timeout=15000)
                name = page.locator("h1").first.inner_text()
                details = _detail_fields(page)
                website = safe_url(details.get("website"))
                result["fields"]["website"] = {"value": website, "source_url": url,
                    "extraction": "maps_property_link", "collected_at": result["collected_at"]}
                result["pages"] = [{"url": url, "excerpt": name + " · " + str(details.get("formatted_address") or "")}]
                result["reason"] = "Discovered website candidate. Verify the property and website before using it."
                result["discovered_business"] = {"name": name, **details}
            finally:
                browser.close()
    except WebsiteBlocked as exc:
        result.update(status="blocked", reason=str(exc))
    except Exception:
        result.update(status="retry", reason="Maps website discovery unavailable; no URL guessed")
    return result
