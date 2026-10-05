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
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

from app.config import settings
from app.free_scraper import normalize_name
from app.scrape_contract import haversine_km

AGENT = "HusshOneWebsiteBot/1.0"
RELEVANT = re.compile(r"about|contact|amenit|room|accommodat|polic|booking|reservation", re.I)
BUSINESS_TYPES = {"Hotel", "Motel", "LodgingBusiness", "LocalBusiness", "Resort", "Hostel"}


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
                           headers={"User-Agent": AGENT, "Accept": "text/html,text/plain", "Accept-Encoding": "identity"})
        response = connection.getresponse()
        headers = {key.lower(): value for key, value in response.getheaders()}
        cap = min(2_000_000, max(1024, settings.WEBSITE_MAX_BYTES))
        body = response.read(cap + 1)
        if len(body) > cap:
            raise WebsiteBlocked("Website response exceeds size limit")
        if headers.get("content-encoding", "identity").lower() != "identity":
            raise WebsiteBlocked("Unsupported compressed website response")
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

    def handle_data(self, data):
        if self._script is not None:
            self._script.append(data)
        if not self._skip:
            self.text.append(data)
            if self._anchor:
                self._anchor[1] += data[:300]


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
    if not name or name != expected:
        return False
    phone = _digits(record.get("phone"))
    if len(phone) == 10 and phone == _digits(node.get("telephone")):
        return True
    address = node.get("address")
    if isinstance(address, dict):
        postal = str(address.get("postalCode", ""))[:5]
        maps_postal = re.findall(r"\b\d{5}\b", record.get("formatted_address") or "")
        if re.fullmatch(r"\d{5}", postal) and postal in maps_postal:
            return True
    geo = node.get("geo")
    if isinstance(geo, dict):
        try:
            return haversine_km(float(record["lat"]), float(record["lng"]),
                                float(geo["latitude"]), float(geo["longitude"])) < 1
        except (KeyError, ValueError, TypeError):
            pass
    return False


def crawl_website(record, fetch=fetch_page, sleep=time.sleep):
    result = {"version": 1, "status": "retry", "requested_url": record.get("website"),
              "collected_at": datetime.now(timezone.utc).isoformat(), "pages": [], "fields": {},
              "identity": "unconfirmed", "scraped_via": "business_website"}
    robots = {}
    visited = set()
    deadline = time.monotonic() + 120
    try:
        start = safe_url(record.get("website"))
        origin_host = urlsplit(start).hostname.removeprefix("www.")

        def request(url, redirects=0, is_robots=False):
            if time.monotonic() > deadline:
                raise TimeoutError("Website crawl time budget exceeded")
            url = safe_url(url)
            parts = urlsplit(url)
            if parts.hostname.removeprefix("www.") != origin_host:
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
                return request(urljoin(url, headers["location"]), redirects + 1, is_robots)
            return code, headers, body, url

        urls = [start]
        matched = False
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
            if not matched:
                matches = [node for node in page.nodes if matched_business(node, record)]
                if len(matches) != 1:
                    result.update(status="needs_review", reason="Business identity not corroborated by name and phone/address/coordinates")
                    return result
                matched = True
                result["identity"] = "corroborated_public_data"
                for key in ("description", "telephone", "address", "checkinTime", "checkoutTime", "amenityFeature", "priceRange", "numberOfRooms"):
                    value = matches[0].get(key)
                    if value is not None and len(json.dumps(value)) <= 8000:
                        result["fields"][key] = {"value": value, "source_url": final, "extraction": "json_ld", "collected_at": result["collected_at"]}
            result["pages"].append({"url": final, "sha256": hashlib.sha256(body).hexdigest(),
                "description": page.description, "excerpt": " ".join(" ".join(page.text).split())[:3000]})
            if page.description and "description" not in result["fields"]:
                result["fields"]["description"] = {"value": page.description, "source_url": final,
                    "extraction": "meta_description", "collected_at": result["collected_at"]}
            for href, label in page.links[:200]:
                try:
                    link = safe_url(urljoin(final, href))
                    parts = urlsplit(link)
                    if parts.hostname.removeprefix("www.") == origin_host and not parts.query and RELEVANT.search(parts.path + " " + label):
                        if not re.search(r"\.(pdf|jpg|png|zip)$", parts.path, re.I) and link not in visited and link not in urls:
                            urls.append(link)
                except (ValueError, UnicodeError):
                    continue
        result["status"] = "collected"
    except WebsiteBlocked as exc:
        result.update(status="blocked", reason=str(exc)[:300])
    except (OSError, http.client.HTTPException, ValueError, UnicodeError, RecursionError) as exc:
        result.update(status="retry", reason=type(exc).__name__ + ": website collection failed")
    return result


def _crawl_child(connection, record):
    try:
        connection.send(crawl_website(record))
    except Exception:
        connection.send({"version": 1, "status": "retry", "reason": "Website process failed", "fields": {}, "pages": []})
    finally:
        connection.close()


async def collect_website(record, timeout=150):
    """Hard supervisor deadline also covers DNS and slow-response hangs."""
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe(duplex=False)
    process = context.Process(target=_crawl_child, args=(child, record), daemon=True)
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
                process.terminate()
            process.join(timeout=1)
            if process.is_alive():
                process.kill()
                process.join(timeout=1)
