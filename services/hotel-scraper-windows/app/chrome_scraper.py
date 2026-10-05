"""Killable Google Maps scraper process.

Playwright can occasionally wedge below its normal action timeout. Keeping it
inside a child process lets the parent worker enforce a real deadline and kill
only the browser process tree that belongs to this application/profile.
"""
from __future__ import annotations

import asyncio
import atexit
import logging
import multiprocessing as mp
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urljoin, urlparse

from playwright.sync_api import sync_playwright

from app.chrome_auth import CHROME_PROFILE_DIR, ensure_chrome_profile_dir, get_chrome_executable
from app.config import settings
from app.scrape_contract import ScrapeResult, ScrapeStatus

logger = logging.getLogger("hotel_scraper.chrome_engine")

CHROME_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--blink-settings=imagesEnabled=false",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-infobars",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-sync",
    "--no-first-run",
    "--mute-audio",
]

RESULT_LINK_SELECTORS = (
    "a.hfpxzc",
    "a[aria-label][href*='/maps/place/']",
    "a[aria-label][href*='google.com/maps']",
)


class ScrapeBlocked(Exception):
    """Kept for callers that need to distinguish a Maps block."""


class ScrapeTimeout(RuntimeError):
    """The isolated browser process exceeded the configured deadline."""


def _clean(value: Optional[str]) -> Optional[str]:
    return value.replace("\x00", "").strip() or None if isinstance(value, str) else None


def _safe_reason(exc: BaseException) -> str:
    return (str(exc).splitlines()[0] if str(exc) else type(exc).__name__)[:200]


def _is_blocked(url: str, body: str) -> bool:
    lowered = body.lower()
    return "google.com/sorry" in url or "unusual traffic" in lowered or "captcha" in lowered


def _is_explicit_empty(body: str) -> bool:
    """Recognize only Maps' unambiguous empty-state copy.

    A generic ``no results`` or ``can't find`` substring can appear in a help
    panel, a broken page, or unrelated page chrome.  Empty is destructive to
    queue state, so anything less specific must remain a selector/transport
    failure for review.
    """
    normalized = re.sub(r"\s+", " ", body.lower()).strip()
    patterns = (
        r"\bno results (?:were )?found(?:\s+(?:for|matching)\b.*)?$",
        r"\b(?:your search|this search) did not match any results\b",
        r"\bgoogle maps (?:can't|couldn't) find\b",
    )
    return any(re.search(pattern, normalized) is not None for pattern in patterns)


def _absolute_maps_url(value: str) -> str:
    return urljoin("https://www.google.com", value)


def _extract_cid(maps_uri: Optional[str]) -> Optional[str]:
    """Extract Maps' stable CID from either supported URL representation.

    Google commonly supplies result links as a ``0x...:0x...`` feature pair
    instead of a ``?cid=`` URL.  The value after the colon is the same CID in
    hexadecimal form.  Converting it to decimal here means every discovered
    hotel gets the canonical, portable ``maps?cid=`` URL rather than falling
    back to a fragile search-result path.
    """
    if not maps_uri:
        return None
    decoded_uri = unquote(maps_uri)
    try:
        query = parse_qs(urlparse(decoded_uri).query)
        for key, values in query.items():
            if key.lower() == "cid" and values:
                cid = values[0].strip()
                if cid:
                    return cid
    except Exception:
        pass
    match = re.search(r"(?:[?&]|%3[fF]|%26)cid(?:=|%3[dD])(\d+)", decoded_uri)
    if match:
        return match.group(1)

    # Google Maps place links frequently encode the CID as the second member
    # of a ``0x<place hash>:0x<CID>`` pair (including inside a ``!1s`` data
    # segment).  CID values are unsigned 64-bit integers, so Python's integer
    # conversion retains the exact value without a floating-point round trip.
    hex_match = re.search(r"0x[0-9a-f]+:0x([0-9a-f]+)", decoded_uri, flags=re.I)
    if hex_match:
        try:
            return str(int(hex_match.group(1), 16))
        except ValueError:
            pass
    return None


def _canonical_maps_url(cid: Optional[str], fallback: Optional[str]) -> Optional[str]:
    return f"https://www.google.com/maps?cid={cid}" if cid else fallback


def _result_cards(page) -> Tuple[List[Any], Optional[str]]:
    cards = page.query_selector_all("div.Nv2PK")
    if cards:
        return cards, "div.Nv2PK"

    feed = page.query_selector("div[role='feed']")
    if not feed:
        return [], None
    selector = ", ".join(RESULT_LINK_SELECTORS)
    fallback = [child for child in feed.query_selector_all(":scope > div") if child.query_selector(selector)]
    return fallback, "div[role='feed'] > div with aria/link result"


def _result_link(card):
    for selector in RESULT_LINK_SELECTORS:
        link = card.query_selector(selector)
        if link:
            return link
    return None


def _rating_from_card(card) -> Optional[float]:
    element = card.query_selector("span.MW4etd")
    value = _clean(element.inner_text()) if element else None
    if value:
        try:
            return float(value)
        except ValueError:
            pass
    for element in card.query_selector_all("[aria-label]"):
        label = element.get_attribute("aria-label") or ""
        match = re.search(r"(?:^|\s)([1-5](?:\.\d+)?)\s*(?:stars?|star)", label, re.I)
        if match:
            try:
                return float(match.group(1))
            except ValueError:
                pass
    return None


class _Browser:
    """Playwright state, created only inside the isolated child process."""

    def __init__(self):
        self._pw = None
        self._ctx = None

    def page(self):
        if self._ctx is not None:
            try:
                _ = self._ctx.pages
            except Exception:
                self.close()
        if self._ctx is None:
            ensure_chrome_profile_dir()
            self._pw = sync_playwright().start()
            self._ctx = self._pw.chromium.launch_persistent_context(
                user_data_dir=CHROME_PROFILE_DIR,
                headless=True,
                executable_path=get_chrome_executable(),
                args=CHROME_ARGS,
                viewport={"width": 1280, "height": 840},
            )
            self._ctx.set_default_timeout(20_000)
        return self._ctx.pages[0] if self._ctx.pages else self._ctx.new_page()

    def close(self):
        try:
            if self._ctx:
                self._ctx.close()
        except Exception:
            pass
        try:
            if self._pw:
                self._pw.stop()
        except Exception:
            pass
        self._ctx = None
        self._pw = None


_browser = _Browser()


def _scrape_sync(city: str, state: str, zip_code: str, max_results: int) -> ScrapeResult:
    query = f"hotels in ZIP {zip_code} {city or ''} {state or ''}".strip()
    search_url = f"https://www.google.com/maps/search/{query.replace(' ', '+')}?hl=en&gl=us"
    try:
        page = _browser.page()
        page.goto(search_url, wait_until="domcontentloaded")
        body = page.inner_text("body") or ""
        if _is_blocked(page.url, body):
            _browser.close()
            return ScrapeResult(ScrapeStatus.BLOCKED, reason="Google served a captcha or traffic block", query=query)

        try:
            consent = page.query_selector(
                'button[aria-label*="Accept all"], button[aria-label*="Agree"], form[action*="consent"] button'
            )
            if consent:
                consent.click()
        except Exception:
            pass

        selector = ", ".join(RESULT_LINK_SELECTORS)
        try:
            page.wait_for_selector(selector, timeout=10_000)
        except Exception:
            body = page.inner_text("body") or ""
            if _is_blocked(page.url, body):
                _browser.close()
                return ScrapeResult(ScrapeStatus.BLOCKED, reason="Google served a captcha or traffic block", query=query)
            if _is_explicit_empty(body):
                return ScrapeResult(ScrapeStatus.EXPLICIT_EMPTY, reason="Maps explicitly reported no results", query=query)
            _browser.close()
            return ScrapeResult(ScrapeStatus.SELECTOR_FAILURE, reason="Maps result selectors did not load", query=query)

        feed = page.query_selector("div[role='feed']")
        cards, card_selector = _result_cards(page)
        if feed:
            previous_count = -1
            for _ in range(12):
                cards, card_selector = _result_cards(page)
                if len(cards) >= max_results or (len(cards) == previous_count and len(cards) > 0):
                    break
                previous_count = len(cards)
                page.evaluate("(el) => el.scrollBy(0, 1200)", feed)
                page.wait_for_timeout(900)

        cards, card_selector = _result_cards(page)
        if not cards:
            body = page.inner_text("body") or ""
            if _is_explicit_empty(body):
                return ScrapeResult(ScrapeStatus.EXPLICIT_EMPTY, reason="Maps explicitly reported no results", query=query)
            _browser.close()
            return ScrapeResult(ScrapeStatus.SELECTOR_FAILURE, reason="Maps returned no parseable result cards", query=query)

        results: List[Dict[str, Any]] = []
        seen = set()
        for card in cards[:max_results]:
            try:
                link = _result_link(card)
                name = _clean(link.get_attribute("aria-label")) if link else None
                href = link.get_attribute("href") if link else None
                maps_uri = _absolute_maps_url(href) if href else None
                cid = _extract_cid(maps_uri)
                identity = cid or (name, maps_uri)
                if not name or identity in seen:
                    continue
                seen.add(identity)

                lat = lng = None
                if maps_uri:
                    match = re.search(r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)", maps_uri)
                    if match:
                        lat, lng = float(match.group(1)), float(match.group(2))

                raw: Dict[str, Any] = {
                    "scraped_via": "chrome_google_maps",
                    "query": query,
                    "source_url": maps_uri,
                }
                if cid:
                    raw["google_cid"] = cid
                results.append({
                    "name": name,
                    "sources": ["places"],
                    "place_id": None,
                    "formatted_address": None,
                    "lat": lat,
                    "lng": lng,
                    "rating": _rating_from_card(card),
                    "user_ratings_total": None,
                    "phone": None,
                    "website": None,
                    "google_maps_uri": _canonical_maps_url(cid, maps_uri),
                    "primary_type": "hotel",
                    "types": ["hotel", "lodging"],
                    "raw": raw,
                })
            except Exception as exc:
                logger.debug("Error parsing Maps result card: %s", exc)

        if not results:
            _browser.close()
            return ScrapeResult(
                ScrapeStatus.SELECTOR_FAILURE,
                reason="Maps cards contained no parseable hotels",
                query=query,
                selector=card_selector,
            )
        return ScrapeResult(ScrapeStatus.SUCCESS, results, query=query, selector=card_selector)
    except Exception as exc:
        _browser.close()
        return ScrapeResult(ScrapeStatus.TRANSPORT_FAILURE, reason=_safe_reason(exc), query=query)


def _child_main(connection) -> None:
    """Child entry point. It owns Chrome and its persistent profile."""
    try:
        while True:
            message = connection.recv()
            command = message.get("command")
            if command == "scrape":
                result = _scrape_sync(
                    message["city"], message["state"], message["zip_code"], message["max_results"]
                )
                connection.send({"ok": True, "result": result.as_dict()})
            elif command == "close":
                _browser.close()
                connection.send({"ok": True})
            elif command == "shutdown":
                _browser.close()
                connection.send({"ok": True})
                return
    except EOFError:
        pass
    except Exception as exc:
        try:
            connection.send({"ok": False, "error": _safe_reason(exc)})
        except Exception:
            pass
    finally:
        _browser.close()
        try:
            connection.close()
        except Exception:
            pass


class _BrowserProcess:
    def __init__(self):
        self._proc = None
        self._conn = None
        self._lock = threading.RLock()
        self._last_used = 0.0
        self._zip_count = 0

    @staticmethod
    def _profile_chrome_pids(profile: Path, *, headless_only: bool = False) -> Optional[List[int]]:
        """Return PIDs for Chrome processes using this exact scraper profile.

        ``None`` means process inspection was unavailable. The profile path is
        passed through an environment variable rather than interpolated into a
        shell command, so it cannot alter the process query.
        """
        resolved_profile = str(profile.resolve())
        try:
            if os.name == "nt":
                env = os.environ.copy()
                env["HUSSHONE_CHROME_PROFILE_PATH"] = resolved_profile
                env["HUSSHONE_HEADLESS_ONLY"] = "1" if headless_only else "0"
                command = (
                    "$needle = $env:HUSSHONE_CHROME_PROFILE_PATH; "
                    "$headlessOnly = $env:HUSSHONE_HEADLESS_ONLY -eq '1'; "
                    "Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | "
                    "Where-Object { $_.CommandLine -and "
                    "$_.CommandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and "
                    "(!$headlessOnly -or $_.CommandLine.IndexOf('--headless', "
                    "[System.StringComparison]::OrdinalIgnoreCase) -ge 0) } | "
                    "ForEach-Object { $_.ProcessId }"
                )
                completed = subprocess.run(
                    ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    env=env,
                )
                if completed.returncode != 0:
                    return None
                pids = []
                for value in completed.stdout.splitlines():
                    try:
                        pids.append(int(value.strip()))
                    except ValueError:
                        continue
                return pids

            completed = subprocess.run(
                ["ps", "-axo", "pid=,command="], capture_output=True, text=True, timeout=5
            )
            if completed.returncode != 0:
                return None
            pids = []
            for line in completed.stdout.splitlines():
                parts = line.strip().split(maxsplit=1)
                if (
                    len(parts) != 2
                    or "chrome" not in parts[1].lower()
                    or resolved_profile not in parts[1]
                ):
                    continue
                if headless_only and "--headless" not in parts[1].lower():
                    continue
                try:
                    pids.append(int(parts[0]))
                except ValueError:
                    continue
            return pids
        except (OSError, subprocess.SubprocessError):
            return None

    @classmethod
    def _profile_in_use_by_chrome(cls, profile: Path) -> Optional[bool]:
        """Return whether a live Chrome command references ``profile``.

        ``None`` means process inspection was unavailable, which is treated as
        *in use*. That conservative result prevents stale-lock cleanup from
        deleting Chrome's active singleton files during an interactive login.
        """
        pids = cls._profile_chrome_pids(profile)
        return None if pids is None else bool(pids)

    @staticmethod
    def _kill_verified_pid(pid: int) -> None:
        """Kill only a PID already verified to be Chrome + this profile."""
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return
        os.kill(pid, 15)

    def _terminate_orphaned_headless_profile_chrome(self, profile: Path) -> None:
        """Remove only headless Chrome left behind by a dead scraper child.

        Interactive authentication uses the same profile but is not headless,
        so it is deliberately excluded. Normal active scraper children are
        owned by ``self._proc`` and are stopped before this method runs.
        """
        pids = self._profile_chrome_pids(profile, headless_only=True)
        if pids is None:
            logger.warning("Could not inspect Chrome processes; orphan cleanup skipped.")
            return
        for pid in pids:
            try:
                self._kill_verified_pid(pid)
                logger.info("Terminated orphaned headless Chrome PID %s for scraper profile.", pid)
            except (OSError, subprocess.SubprocessError):
                logger.warning("Could not terminate verified orphaned Chrome PID %s.", pid)

    def _clear_stale_profile_locks(self, *, cleanup_orphans: bool = False) -> None:
        profile = Path(CHROME_PROFILE_DIR)
        locks = [
            profile / name
            for name in ("SingletonLock", "SingletonCookie", "SingletonSocket")
            if (profile / name).exists() or (profile / name).is_symlink()
        ]
        if not locks:
            return
        if cleanup_orphans:
            self._terminate_orphaned_headless_profile_chrome(profile)
        in_use = self._profile_in_use_by_chrome(profile)
        if in_use is not False:
            logger.warning(
                "Chrome profile lock cleanup skipped because the profile is %s.",
                "in use" if in_use else "not safely inspectable",
            )
            return
        for path in locks:
            try:
                path.unlink()
            except OSError:
                logger.debug("Could not clear stale Chrome profile lock %s", path)

    def _clear_profile_cache(self) -> None:
        """Bound profile growth without touching cookies or saved sessions."""
        profile = Path(CHROME_PROFILE_DIR).resolve()
        cache_paths = (
            "Default/Cache",
            "Default/Code Cache",
            "Default/GPUCache",
            "Default/Service Worker/CacheStorage",
            "ShaderCache",
            "GrShaderCache",
        )
        for relative in cache_paths:
            target = (profile / relative).resolve()
            if profile not in target.parents or not target.is_dir():
                continue
            try:
                shutil.rmtree(target)
            except OSError:
                logger.debug("Could not clear Chrome cache directory %s", target)

    def _start_locked(self) -> None:
        if self._proc is not None and self._proc.is_alive() and self._conn is not None:
            return
        self._stop_locked(force=True)
        # A worker only reaches this point after it acquired the database-wide
        # advisory lock, so a matching headless browser is safe to treat as an
        # orphan from a dead earlier worker rather than another live scraper.
        self._clear_stale_profile_locks(cleanup_orphans=True)
        context = mp.get_context("spawn")
        parent_conn, child_conn = context.Pipe()
        proc = context.Process(
            target=_child_main,
            args=(child_conn,),
            name="husshone-maps-scraper",
            daemon=True,
        )
        proc.start()
        child_conn.close()
        self._proc, self._conn = proc, parent_conn
        self._zip_count = 0

    @staticmethod
    def _kill_process_tree(proc) -> None:
        if proc is None:
            return
        pid = proc.pid
        if os.name == "nt" and pid:
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=10,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except Exception:
                pass
        try:
            if proc.is_alive():
                proc.terminate()
            proc.join(timeout=5)
        except Exception:
            pass

    def _stop_locked(self, force: bool = False) -> None:
        conn, proc = self._conn, self._proc
        self._conn, self._proc = None, None
        if conn is not None and proc is not None and proc.is_alive() and not force:
            try:
                conn.send({"command": "shutdown"})
                if conn.poll(10):
                    conn.recv()
            except Exception:
                pass
        self._kill_process_tree(proc)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        self._clear_stale_profile_locks()

    def scrape(self, city: str, state: str, zip_code: str, max_results: int) -> ScrapeResult:
        with self._lock:
            if self._zip_count >= settings.CHROME_RECYCLE_AFTER_ZIPS:
                logger.info("Recycling Chrome after %d ZIPs", self._zip_count)
                self._stop_locked()
                if settings.CHROME_CLEAR_CACHE_ON_RECYCLE:
                    self._clear_profile_cache()
            self._start_locked()
            try:
                self._conn.send({
                    "command": "scrape", "city": city, "state": state,
                    "zip_code": zip_code, "max_results": max_results,
                })
                if not self._conn.poll(settings.SCRAPER_PROCESS_TIMEOUT_SEC):
                    self._stop_locked(force=True)
                    raise ScrapeTimeout(f"Maps browser made no progress for {settings.SCRAPER_PROCESS_TIMEOUT_SEC}s")
                response = self._conn.recv()
            except (EOFError, BrokenPipeError, OSError) as exc:
                self._stop_locked(force=True)
                return ScrapeResult(ScrapeStatus.TRANSPORT_FAILURE, reason=_safe_reason(exc))

            self._zip_count += 1
            self._last_used = time.time()
            if not response.get("ok"):
                return ScrapeResult(ScrapeStatus.TRANSPORT_FAILURE, reason=response.get("error", "browser child failed"))
            payload = response["result"]
            return ScrapeResult(
                ScrapeStatus(payload["status"]),
                records=payload.get("records") or [],
                reason=payload.get("reason"),
                query=payload.get("query"),
                selector=payload.get("selector"),
            )

    def close(self) -> None:
        with self._lock:
            self._stop_locked()

    def close_if_idle(self, max_idle_sec: float) -> None:
        with self._lock:
            if self._proc is not None and time.time() - self._last_used > max_idle_sec:
                self._stop_locked()


_browser_process = _BrowserProcess()
atexit.register(_browser_process.close)


async def scrape_google_maps_hotels(
    city: str, state: str, zip_code: str, max_results: Optional[int] = None
) -> ScrapeResult:
    return await asyncio.to_thread(_browser_process.scrape, city, state, zip_code, max_results or settings.MAPS_MAX_RESULTS)


async def close_browser() -> None:
    await asyncio.to_thread(_browser_process.close)


async def close_browser_if_idle(max_idle_sec: float = 120) -> None:
    await asyncio.to_thread(_browser_process.close_if_idle, max_idle_sec)
