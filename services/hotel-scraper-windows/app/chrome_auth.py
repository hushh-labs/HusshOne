import os
import sys
import time
import logging
import shutil
from playwright.sync_api import sync_playwright

logger = logging.getLogger("hotel_scraper.chrome_auth")

APP_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
LEGACY_CHROME_PROFILE_DIR = os.path.join(APP_DIR, "chrome_profile")
# Do not call user_data_dir() here: importing the app must remain side-effect
# free in unit tests and tooling.  The directory is created lazily below.
_runtime_base = os.getenv("LOCALAPPDATA") or os.path.expanduser("~/.husshone_hotel_scraper")
CHROME_PROFILE_DIR = os.path.join(_runtime_base, "HusshOne-Hotel-Scraper", "chrome_profile")
CHROME_SYSTEM_EXE = r"C:\Program Files\Google\Chrome\Application\chrome.exe"


def ensure_chrome_profile_dir() -> str:
    """Create the user-local scraper profile, migrating the legacy profile once.

    Cache directories and Chrome singleton locks are deliberately excluded. The
    copied profile remains tied to the same Windows user, preserving DPAPI
    protected login cookies without keeping an ever-growing repo-local cache.
    """
    if not os.path.exists(CHROME_PROFILE_DIR) and os.path.isdir(LEGACY_CHROME_PROFILE_DIR):
        try:
            shutil.copytree(
                LEGACY_CHROME_PROFILE_DIR,
                CHROME_PROFILE_DIR,
                ignore=shutil.ignore_patterns("Cache", "Code Cache", "GPUCache", "Singleton*"),
            )
            logger.info("Migrated legacy Chrome scraper profile to LocalAppData")
        except FileExistsError:
            pass
        except Exception as exc:
            logger.warning("Could not migrate legacy Chrome profile: %s", exc)
    os.makedirs(CHROME_PROFILE_DIR, exist_ok=True)
    return CHROME_PROFILE_DIR

def get_chrome_executable():
    """Returns path to system Chrome if present, else None (Playwright will use bundled Chromium)."""
    if os.path.exists(CHROME_SYSTEM_EXE):
        return CHROME_SYSTEM_EXE
    return None

def check_session_status():
    """Checks if the persistent Chrome profile directory exists and has session data."""
    if not os.path.exists(CHROME_PROFILE_DIR):
        return {"logged_in": False, "profile_exists": False, "message": "No Chrome profile found"}

    # Quick probe using playwright headless
    try:
        with sync_playwright() as p:
            args = ["--disable-blink-features=AutomationControlled", "--no-sandbox"]
            browser_context = p.chromium.launch_persistent_context(
                user_data_dir=CHROME_PROFILE_DIR,
                headless=True,
                executable_path=get_chrome_executable(),
                args=args,
                viewport={"width": 1280, "height": 800}
            )
            cookies = browser_context.cookies(["https://google.com", "https://accounts.google.com"])
            has_auth = any(c.get("name") in ("SID", "HSID", "SSID", "SAPISID") for c in cookies)
            browser_context.close()
            return {
                "logged_in": has_auth,
                "profile_exists": True,
                "cookies_count": len(cookies),
                "message": "Authenticated Google session active" if has_auth else "Chrome profile exists but not signed into Google"
            }
    except Exception as e:
        return {"logged_in": False, "profile_exists": True, "error": str(e)}

def open_interactive_login(email="husshpuppy5@gmail.com"):
    """
    Opens a visible Chrome window pointing to Google Login so the user or script
    can authenticate and persist the Google session in chrome_profile.
    """
    ensure_chrome_profile_dir()
    print(f"Launching visible Chrome with profile: {CHROME_PROFILE_DIR}...")

    with sync_playwright() as p:
        args = [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-infobars"
        ]
        context = p.chromium.launch_persistent_context(
            user_data_dir=CHROME_PROFILE_DIR,
            headless=False,
            executable_path=get_chrome_executable(),
            args=args,
            viewport=None
        )
        page = context.pages[0] if context.pages else context.new_page()

        # Navigate to Google Login
        page.goto("https://accounts.google.com/ServiceLogin?service=mail", wait_until="domcontentloaded")
        print(f"Please log in with {email} in the opened Chrome window.")

        # Try auto-filling email if field is ready
        try:
            page.wait_for_selector('input[type="email"]', timeout=4000)
            page.fill('input[type="email"]', email)
            page.keyboard.press("Enter")
            print("Pre-filled email and submitted. Complete password/verification in browser.")
        except Exception:
            pass

        # Wait until login is complete or user closes the window (up to 180s)
        start_wait = time.time()
        while time.time() - start_wait < 180:
            time.sleep(2)
            try:
                current_url = page.url
                # If redirected to Google home or myaccount, login succeeded
                if "myaccount.google.com" in current_url or "mail.google.com" in current_url or "google.com/search" in current_url:
                    print("Google authentication confirmed!")
                    break
            except Exception:
                # Window closed by user
                break

        context.close()
        print("Chrome profile saved.")

if __name__ == "__main__":
    open_interactive_login()
