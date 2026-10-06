"""Restricted JS rendering: browser never makes an unrestricted network request."""
from app.website_enrichment import AGENT, WebsiteBlocked


def render_page(url, request):
    from playwright.sync_api import sync_playwright
    count, size = 0, 0
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True,
            proxy={"server": "http://127.0.0.1:9", "bypass": "<-loopback>"},
            args=["--disable-background-networking", "--disable-quic", "--disable-gpu"])
        try:
            context = browser.new_context(service_workers="block", user_agent=AGENT,
                                          accept_downloads=False)
            if not hasattr(context, "route_web_socket"):
                raise WebsiteBlocked("Browser version cannot block WebSockets")
            context.route_web_socket("**/*", lambda ws: ws.close())
            def route_request(route):
                nonlocal count, size
                count += 1
                if count > 20 or route.request.method != "GET" or route.request.resource_type not in ("document", "script", "stylesheet", "xhr", "fetch"):
                    route.abort()
                    return
                try:
                    code, headers, body, final = request(route.request.url)
                    size += len(body)
                    if size > 4_000_000 or final != route.request.url or code != 200:
                        route.abort()
                        return
                    route.fulfill(status=code, body=body,
                        headers={"content-type": headers.get("content-type", "text/plain")})
                except (ValueError, OSError):
                    route.abort()
            context.route("**/*", route_request)
            page = context.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(1500)
            body = page.content().encode("utf-8")
            if len(body) > 2_000_000:
                raise WebsiteBlocked("Rendered page exceeds size limit")
            return body
        finally:
            browser.close()
