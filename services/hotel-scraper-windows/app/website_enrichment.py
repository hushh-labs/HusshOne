"""Bounded public-site collection. No browser, cookies, proxies or model calls.

Only evidence is proposed. Public-site statements never replace Maps or
owner-maintained columns. DNS answers are validated AND pinned to the socket,
including every redirect, so website links cannot reach local/cloud metadata.
"""
import hashlib
import http.client
import ipaddress
import json
import re
import socket
import ssl
import time
import asyncio
import multiprocessing
import math
import zlib
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

from app.config import settings
from app.free_scraper import normalize_name
from app.scrape_contract import haversine_km

AGENT = "HusshOneWebsiteBot/1.0"
RELEVANT = re.compile(r"about|contact|amenit|room|accommodat|polic|booking|reservation", re.I)
BUSINESS_TYPES = {"Hotel", "Motel", "LodgingBusiness", "LocalBusiness", "Resort", "Hostel",
                  "Restaurant", "CafeOrCoffeeShop", "Store", "AutoDealer", "GroceryStore",
                  "ClothingStore", "ElectronicsStore", "FurnitureStore", "HairSalon",
                  "BeautySalon", "HealthClub", "ProfessionalService", "ShoppingCenter"}


class WebsiteBlocked(ValueError):
    pass


def safe_url(value):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 33 for c in value):
        raise WebsiteBlocked("Invalid website URL")
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise WebsiteBlocked("Only public HTTP(S) websites without credentials are allowed")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError as exc:
        raise WebsiteBlocked("Invalid website port") from exc
    if port != (443 if parts.scheme == "https" else 80):
        raise WebsiteBlocked("Nonstandard website port blocked")
    host = parts.hostname.encode("idna").decode("ascii").lower().rstrip(".")
    try:
        if not ipaddress.ip_address(host).is_global:
            raise WebsiteBlocked("Non-public website address blocked")
    except ValueError as exc:
        if isinstance(exc, WebsiteBlocked):
            raise
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise WebsiteBlocked("Local website blocked")
    netloc = "[" + host + "]" if ":" in host else host
    return urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))


def _public_addresses(host, port):
    answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    addresses = list(dict.fromkeys(answer[4][0] for answer in answers))
    if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
        raise WebsiteBlocked("Website resolves to a non-public address")
    return addresses


def decode_body(body, encoding, cap):
    """Bound both transferred and expanded bytes; reject compression bombs."""
    encoding = encoding.strip().lower()
    if encoding in ("", "identity"):
        decoded = body
    elif encoding in ("gzip", "deflate"):
        try:
            decoder = zlib.decompressobj(31 if encoding == "gzip" else 15)
            decoded = decoder.decompress(body, cap + 1)
            if len(decoded) > cap or decoder.unconsumed_tail:
                raise WebsiteBlocked("Expanded website response exceeds size limit")
            if not decoder.eof or decoder.unused_data:
                raise WebsiteBlocked("Invalid compressed website response")
        except zlib.error as exc:
            raise WebsiteBlocked("Invalid compressed website response") from exc
    elif encoding == "br":
        import brotli
        decoder = brotli.Decompressor()
        chunks, size = [], 0
        try:
            # Small input chunks limit expansion before the next bound check.
            for offset in range(0, len(body), 64):
                data = body[offset:offset + 64]
                while True:
                    chunk = decoder.process(data, output_buffer_limit=cap - size + 1)
                    size += len(chunk)
                    if size > cap:
                        raise WebsiteBlocked("Expanded website response exceeds size limit")
                    chunks.append(chunk)
                    if decoder.can_accept_more_data():
                        break
                    data = b""
            if not decoder.is_finished():
                raise WebsiteBlocked("Invalid compressed website response")
            decoded = b"".join(chunks)
        except brotli.error as exc:
            raise WebsiteBlocked("Invalid compressed website response") from exc
    else:
        raise WebsiteBlocked("Unsupported compressed website response")
    if len(decoded) > cap:
        raise WebsiteBlocked("Expanded website response exceeds size limit")
    return decoded


def fetch_page(url):
    """One request, no implicit redirects. Connect to a validated numeric IP."""
    url = safe_url(url)
    parts = urlsplit(url)
    port = 443 if parts.scheme == "https" else 80
    ip = _public_addresses(parts.hostname, port)[0]
    timeout = min(20, max(1, settings.WEBSITE_TIMEOUT_SEC))
    connection = http.client.HTTPConnection(parts.hostname, port, timeout=timeout)
    sock = socket.create_connection((ip, port), timeout=timeout)
    try:
        if parts.scheme == "https":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=parts.hostname)
        connection.sock = sock
        connection.request("GET", urlunsplit(("", "", parts.path, parts.query, "")),
                           headers={"User-Agent": AGENT, "Accept": "text/html,text/plain", "Accept-Encoding": "gzip, deflate, br"})
        response = connection.getresponse()
        headers = {key.lower(): value for key, value in response.getheaders()}
        cap = min(2_000_000, max(1024, settings.WEBSITE_MAX_BYTES))
        body = response.read(cap + 1)
        if len(body) > cap:
            raise WebsiteBlocked("Website response exceeds size limit")
        body = decode_body(body, headers.get("content-encoding", "identity"), cap)
        return response.status, headers, body
    finally:
        connection.close()
        sock.close()


class Page(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.links, self.nodes, self.text = [], [], []
        self.description = None
        self._script = None
        self._skip = 0
        self._anchor = None
        self.headings, self.addresses = [], []
        self._heading = None
        self._address = None
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ("script", "style", "noscript"):
            self._skip += 1
        if tag == "script" and attrs.get("type", "").lower() == "application/ld+json":
            self._script = []
        if tag == "meta" and attrs.get("name", "").lower() == "description":
            self.description = attrs.get("content", "")[:2000]
        if tag == "a" and attrs.get("href"):
            self._anchor = [attrs["href"], ""]
        if tag in ("h1", "title"):
            self._heading = []
        if tag == "address":
            self._address = []

    def handle_endtag(self, tag):
        if tag == "script" and self._script is not None:
            try:
                self.nodes.extend(_nodes(json.loads("".join(self._script))))
            except (ValueError, RecursionError):
                pass
            self._script = None
        if tag in ("script", "style", "noscript"):
            self._skip = max(0, self._skip - 1)
        if tag == "a" and self._anchor:
            self.links.append(tuple(self._anchor))
            self._anchor = None
        if tag in ("h1", "title") and self._heading is not None:
            self.headings.append(" ".join(self._heading))
            self._heading = None
        if tag == "address" and self._address is not None:
            self.addresses.append(" ".join(self._address))
            self._address = None

    def handle_data(self, data):
        if self._script is not None:
            self._script.append(data)
        if not self._skip:
            self.text.append(data)
            if self._anchor:
                self._anchor[1] += data[:300]
            if self._heading is not None:
                self._heading.append(data)
            if self._address is not None:
                self._address.append(data)


def _nodes(value, depth=0):
    if depth > 8:
        return []
    if isinstance(value, list):
        return [node for item in value[:100] for node in _nodes(item, depth + 1)]
    if isinstance(value, dict):
        return [value] + _nodes(value.get("@graph", []), depth + 1)
    return []


def _digits(value):
    return re.sub(r"\D", "", str(value or ""))[-10:]


def matched_business(node, record):
    types = node.get("@type", [])
    if isinstance(types, str):
        types = [types]
    if not isinstance(types, list) or not BUSINESS_TYPES.intersection(t for t in types if isinstance(t, str)):
        return False
    name = normalize_name(str(node.get("name", "")))
    expected = normalize_name(record["name"])
    aliases = node.get("alternateName", [])
    aliases = [aliases] if isinstance(aliases, str) else aliases
    alias_match = isinstance(aliases, list) and expected in {normalize_name(a) for a in aliases if isinstance(a, str)}
    if not name or not expected or (name != expected and not alias_match):
        return False
    signals = 0
    phone = _digits(record.get("phone"))
    node_phone = _digits(node.get("telephone"))
    if len(phone) == 10 and len(node_phone) == 10 and phone != node_phone:
        return False
    if len(phone) == 10 and phone == _digits(node.get("telephone")):
        signals += 1
    address = node.get("address")
    if isinstance(address, dict):
        postal = str(address.get("postalCode", ""))[:5]
        maps_postal = re.findall(r"\b\d{5}\b", record.get("formatted_address") or "")
        if re.fullmatch(r"\d{5}", postal) and maps_postal and postal not in maps_postal:
            return False
        if re.fullmatch(r"\d{5}", postal) and postal in maps_postal:
            signals += 1
    geo = node.get("geo")
    if isinstance(geo, dict):
        try:
            coordinates = [float(record["lat"]), float(record["lng"]), float(geo["latitude"]), float(geo["longitude"])]
            if not all(math.isfinite(c) and abs(c) <= (90 if i % 2 == 0 else 180) for i, c in enumerate(coordinates)):
                return False
            distance = haversine_km(*coordinates)
            if distance >= 1:
                return False
            signals += 1
        except (KeyError, ValueError, TypeError):
            pass
    return signals >= (1 if name == expected else 2)


def visible_business(page, record):
    """Conservative fallback: exact heading name plus independent contact proof.

    Never guess an address from arbitrary navigation, chain-wide footer text,
    or a hotel's search ZIP. Ambiguous contact details remain evidence only.
    """
    expected = normalize_name(record.get("name", ""))
    headings = [normalize_name(part.strip()) for heading in page.headings
                for part in re.split(r"[|–—]", heading)]
    if not expected or expected not in headings:
        return None
    node = {"@type": "Hotel", "name": record["name"]}
    phones = {re.sub(r"[;?].*", "", href[4:]).strip()
              for href, _ in page.links if href.lower().startswith("tel:")}
    phones = {phone for phone in phones if re.fullmatch(r"[+\d\s().-]+", phone)
              and len(_digits(phone)) == 10}
    if len({_digits(phone) for phone in phones}) == 1:
        node["telephone"] = sorted(phones)[0]
    addresses = []
    for address in page.addresses:
        match = re.fullmatch(r"\s*(\d[^,]{1,200}),\s*([^,]{1,100}),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)(?:\s*,?\s*(?:US|USA|United States))?\s*", address)
        if match:
            street, city, state, postal = match.groups()
            addresses.append({"@type": "PostalAddress", "streetAddress": street.strip(),
                              "addressLocality": city.strip(), "addressRegion": state,
                              "postalCode": postal, "addressCountry": "US"})
    unique = {json.dumps(address, sort_keys=True): address for address in addresses}
    if len(unique) == 1:
        node["address"] = next(iter(unique.values()))
    return node if matched_business(node, record) else None


def page_fields(page, record):
    """Only independently corroborated property pages can propose fields."""
    matches = [node for node in page.nodes if matched_business(node, record)]
    extraction = "json_ld"
    if not matches:
        visible = visible_business(page, record)
        matches = [visible] if visible else []
        extraction = "visible_contact"
    if len(matches) != 1:
        return matches, {}, extraction
    node = matches[0]
    fields = {key: node[key] for key in
              ("description", "telephone", "address", "checkinTime", "checkoutTime", "amenityFeature", "priceRange", "numberOfRooms",
               "petsAllowed", "smokingAllowed", "starRating", "hasOfferCatalog", "containsPlace", "paymentAccepted", "currenciesAccepted")
              if node.get(key) is not None and len(json.dumps(node[key])) <= 8000}
    return matches, fields, extraction


def crawl_website(record, fetch=fetch_page, sleep=time.sleep, render=None):
    result = {"version": 1, "status": "retry", "requested_url": record.get("website"),
              "collected_at": datetime.now(timezone.utc).isoformat(), "pages": [], "fields": {},
              "identity": "unconfirmed", "scraped_via": "business_website"}
    robots = {}
    visited = set()
    matched = False
    deadline = time.monotonic() + 120
    try:
        start = safe_url(record.get("website"))
        origin_host = urlsplit(start).hostname.removeprefix("www.")
        allowed_hosts = {origin_host}

        def request(url, redirects=0, is_robots=False, redirect_chain=()):
            if time.monotonic() > deadline:
                raise TimeoutError("Website crawl time budget exceeded")
            url = safe_url(url)
            if url in redirect_chain:
                raise WebsiteBlocked("Website redirect loop detected")
            parts = urlsplit(url)
            if parts.hostname.removeprefix("www.") not in allowed_hosts:
                raise WebsiteBlocked("Cross-domain redirect/link needs review")
            origin = urlunsplit((parts.scheme, parts.netloc, "", "", ""))
            if not is_robots:
                if origin not in robots:
                    code, _, body, _ = request(origin + "/robots.txt", is_robots=True)
                    parser = RobotFileParser()
                    if code in (404, 410):
                        parser.parse([])
                    elif code == 200:
                        parser.parse(body.decode("utf-8", "replace").splitlines())
                    elif code in (401, 403):
                        raise WebsiteBlocked("robots.txt denies access")
                    else:
                        raise OSError("robots.txt unavailable; retry later")
                    robots[origin] = parser
                parser = robots[origin]
                if not parser.can_fetch(AGENT, url):
                    raise WebsiteBlocked("Page disallowed by robots.txt")
                rate = parser.request_rate(AGENT)
                delay = max(1, parser.crawl_delay(AGENT) or 0,
                            rate.seconds / rate.requests if rate and rate.requests else 0)
                if delay > 15:
                    raise WebsiteBlocked("Site requires a slower crawl; operator review needed")
                sleep(delay)
            code, headers, body = fetch(url)
            if code in (301, 302, 303, 307, 308):
                if redirects >= 3 or not headers.get("location"):
                    raise WebsiteBlocked("Website redirect limit exceeded")
                destination = safe_url(urljoin(url, headers["location"]))
                destination_parts = urlsplit(destination)
                destination_host = destination_parts.hostname.removeprefix("www.")
                if destination_host not in allowed_hosts:
                    # Only a permanent HTTP redirect from the supplied site
                    # can introduce another domain. Never a HTML/JS link.
                    # New domains get independent DNS and robots checks;
                    # property identity must still be corroborated afterward.
                    if is_robots or code not in (301, 308) or destination_parts.scheme != "https":
                        raise WebsiteBlocked("Cross-domain redirect/link needs review")
                    allowed_hosts.add(destination_host)
                    result.setdefault("redirects", []).append({"from": url, "to": destination, "status": code})
                return request(destination, redirects + 1, is_robots, (*redirect_chain, url))
            return code, headers, body, url

        urls = [start]
        while urls and len(result["pages"]) < min(6, max(1, settings.WEBSITE_MAX_PAGES)):
            url = urls.pop(0)
            if url in visited:
                continue
            visited.add(url)
            code, headers, body, final = request(url)
            if code in (401, 403, 429):
                raise WebsiteBlocked(f"Website restricted (HTTP {code}); no bypass attempted")
            if code >= 500:
                raise OSError(f"Website unavailable (HTTP {code})")
            if code != 200:
                raise WebsiteBlocked(f"Website returned HTTP {code}")
            if "text/html" not in headers.get("content-type", "").lower():
                raise WebsiteBlocked("Only HTML business pages are collected")
            page = Page(body.decode("utf-8", "replace"))
            matches, fields, extraction = page_fields(page, record)
            if not matched:
                if not matches and render is not None and b"<script" in body.lower():
                    try:
                        rendered = render(final, request)
                        rendered_page = Page(rendered.decode("utf-8", "replace"))
                        rendered_matches, rendered_fields, rendered_extraction = page_fields(rendered_page, record)
                        if rendered_matches:
                            page, body, matches = rendered_page, rendered, rendered_matches
                            fields, extraction = rendered_fields, rendered_extraction
                            result["render_method"] = "restricted_browser"
                    except Exception:
                        result["browser_fallback_failed"] = True
                if len(matches) > 1:
                    result["pages"].append({"url": final, "sha256": hashlib.sha256(body).hexdigest(),
                        "description": page.description, "excerpt": " ".join(" ".join(page.text).split())[:3000]})
                    result.update(status="needs_review", reason="Multiple matching business entries found; existing data left unchanged")
                    return result
                if not matches:
                    result["pages"].append({"url": final, "sha256": hashlib.sha256(body).hexdigest(),
                        "description": page.description, "excerpt": " ".join(" ".join(page.text).split())[:3000]})
                    for href, label in page.links[:200]:
                        try:
                            link = safe_url(urljoin(final, href))
                            parts = urlsplit(link)
                            if (parts.hostname.removeprefix("www.") == urlsplit(final).hostname.removeprefix("www.") and not parts.query
                                    and RELEVANT.search(parts.path + " " + label)
                                    and not re.search(r"\.(pdf|jpg|png|zip)$", parts.path, re.I)
                                    and link not in visited and link not in urls):
                                urls.append(link)
                        except (ValueError, UnicodeError):
                            continue
                    continue
                matched = True
                result["identity"] = "corroborated_public_data"
                result["business_name"] = matches[0]["name"]
                result["identity_node"] = {key: matches[0][key] for key in
                    ("@type", "name", "alternateName", "telephone", "address", "geo") if key in matches[0]}
            if len(matches) == 1:
                for key, value in fields.items():
                    # A later contact/policy page can fill absent evidence,
                    # but never override a prior property-page statement.
                    result["fields"].setdefault(key, {"value": value, "source_url": final,
                        "extraction": extraction, "collected_at": result["collected_at"],
                        "identity_node": {k: matches[0][k] for k in ("@type", "name", "alternateName", "telephone", "address", "geo") if k in matches[0]}})
                # Retain explicit statements, not inferred amenity booleans.
                statements = [" ".join(text.split()) for text in page.text if text.strip()]
                for key, pattern in (("amenityStatements", r"\b(?:wi-fi|wifi|parking|fitness centre|fitness center|swimming pool|breakfast)\b"),
                                     ("policyStatements", r"\b(?:check[ -]?in|check[ -]?out|pet policy|pets allowed|no pets|smoking|cancellation)\b")):
                    values = list(dict.fromkeys(text for text in statements if len(text) <= 500 and re.search(pattern, text, re.I)))[:20]
                    if values:
                        result["fields"].setdefault(key, {"value": values, "source_url": final,
                            "extraction": "visible_text", "collected_at": result["collected_at"]})
            result["pages"].append({"url": final, "sha256": hashlib.sha256(body).hexdigest(),
                "description": page.description, "excerpt": " ".join(" ".join(page.text).split())[:3000]})
            if len(matches) == 1 and page.description and "description" not in result["fields"]:
                result["fields"]["description"] = {"value": page.description, "source_url": final,
                    "extraction": "meta_description", "collected_at": result["collected_at"]}
            for href, label in page.links[:200]:
                try:
                    link = safe_url(urljoin(final, href))
                    parts = urlsplit(link)
                    if parts.hostname.removeprefix("www.") == urlsplit(final).hostname.removeprefix("www.") and not parts.query and RELEVANT.search(parts.path + " " + label):
                        if not re.search(r"\.(pdf|jpg|png|zip)$", parts.path, re.I) and link not in visited and link not in urls:
                            urls.append(link)
                except (ValueError, UnicodeError):
                    continue
        if matched:
            result["status"] = "collected"
        else:
            result.update(status="needs_review", reason="No property page matched the known name and contact/location details; existing data left unchanged")
    except WebsiteBlocked as exc:
        result.update(status="collected" if matched else "blocked", reason=str(exc)[:300])
        if matched:
            result["partial_collection"] = True
    except (OSError, http.client.HTTPException, ValueError, UnicodeError, RecursionError) as exc:
        result.update(status="collected" if matched else "retry", reason=type(exc).__name__ + ": website collection failed")
        if matched:
            result["partial_collection"] = True
    return result


def _crawl_child(connection, record, throughput=False):
    try:
        if __import__("os").name == "nt":
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.GetCurrentProcess.restype = wintypes.HANDLE
            kernel.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel.SetPriorityClass(kernel.GetCurrentProcess(), 0x20 if throughput else 0x4000)
        if record.get("_discover_website"):
            from app.website_discovery import discover_website
            discovery = discover_website(record)
            candidate = discovery.get("fields", {}).get("website", {}).get("value")
            if candidate:
                from app.website_browser import render_page
                result = crawl_website({**record, "website": candidate},
                    render=render_page if settings.WEBSITE_BROWSER_FALLBACK else None)
                result["discovery_source_url"] = discovery.get("requested_url")
                result["discovered_website"] = candidate
                connection.send(result)
            else:
                connection.send(discovery)
            return
        from app.website_browser import render_page
        connection.send(crawl_website(record, render=render_page if settings.WEBSITE_BROWSER_FALLBACK else None))
    except Exception:
        connection.send({"version": 1, "status": "retry", "reason": "Website process failed", "fields": {}, "pages": []})
    finally:
        connection.close()


async def collect_website(record, timeout=150):
    """Hard supervisor deadline also covers DNS and slow-response hangs."""
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe(duplex=False)
    process = context.Process(target=_crawl_child, args=(child, record, settings.SCRAPER_PERFORMANCE_MODE == 'throughput'), daemon=True)
    try:
        process.start()
        child.close()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if parent.poll():
                try:
                    return parent.recv()
                except EOFError:
                    break
            if not process.is_alive():
                break
            await asyncio.sleep(.1)
        return {"version": 1, "status": "retry", "reason": "Website process timed out or exited", "fields": {}, "pages": [],
                "collected_at": datetime.now(timezone.utc).isoformat(), "requested_url": record.get("website")}
    finally:
        parent.close()
        child.close()
        if process.pid:
            if process.is_alive():
                if __import__("os").name == "nt":
                    import subprocess
                    try:
                        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    except (OSError, subprocess.TimeoutExpired):
                        pass
                process.terminate()
            process.join(timeout=1)
            if process.is_alive():
                process.kill()
                process.join(timeout=1)
