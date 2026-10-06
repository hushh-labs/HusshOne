"""Conservative mappings from corroborated website evidence to blank columns."""
import re
from urllib.parse import urlsplit

from app.free_scraper import normalize_name
from app.website_enrichment import safe_url, matched_business

FIELDS = ("phone", "formatted_address", "zip", "state")
US_STATES = set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI".split())


def blank(value):
    return value is None or (isinstance(value, str) and not value.strip())


def fill_candidates(row, result):
    """No inference, overwrite, identity changes, ratings or geospatial edits."""
    if result.get("status") != "collected" or result.get("identity") != "corroborated_public_data":
        return {}
    business_name = normalize_name(str(result.get("business_name", "")))
    identity = result.get("identity_node")
    if identity is not None:
        current = {field: getattr(row, field, None) for field in ("name", "phone", "formatted_address", "lat", "lng")}
        if not isinstance(identity, dict) or not matched_business(identity, current):
            return {}
    elif not business_name or business_name != normalize_name(row.name):
        return {}
    try:
        host = urlsplit(safe_url(row.website)).hostname.removeprefix("www.")
    except (ValueError, UnicodeError):
        return {}
    def evidence(field):
        fields = result.get("fields")
        item = fields.get(field) if isinstance(fields, dict) else None
        if not isinstance(item, dict) or item.get("extraction") not in ("json_ld", "visible_contact"):
            return None
        # New visible/page-specific evidence must pass identity checks again
        # against the locked, current row, not merely its queue snapshot.
        proof = item.get("identity_node")
        if item.get("extraction") == "visible_contact" and not isinstance(proof, dict):
            return None
        if proof is not None:
            current = {field: getattr(row, field, None) for field in ("name", "phone", "formatted_address", "lat", "lng")}
            if not isinstance(proof, dict) or not matched_business(proof, current):
                return None
        try:
            if urlsplit(safe_url(item.get("source_url"))).hostname.removeprefix("www.") != host:
                return None
        except (ValueError, UnicodeError):
            return None
        return item
    proposed = {}
    phone = evidence("telephone")
    if phone and isinstance(phone.get("value"), str):
        text = phone["value"].strip()
        if len(text) <= 64 and re.fullmatch(r"[+\d\s().-]+", text) and 7 <= len(re.sub(r"\D", "", text)) <= 15:
            proposed["phone"] = (text, phone)
    address = evidence("address")
    if address and isinstance(address.get("value"), dict):
        value = address["value"]
        country = value.get("addressCountry", "US")
        if isinstance(country, dict):
            country = country.get("name")
        region = value.get("addressRegion")
        postal = value.get("postalCode")
        known_postal = re.findall(r"\b\d{5}(?:-\d{4})?\b", row.formatted_address or "")
        if (country in ("US", "USA", "United States", "United States of America")
                and isinstance(region, str) and region.upper() in US_STATES
                and isinstance(postal, str) and re.fullmatch(r"\d{5}(?:-\d{4})?", postal)
                and (blank(row.state) or row.state == region.upper())
                and (blank(row.zip) or row.zip == postal[:5])
                and (not known_postal or postal[:5] in {item[:5] for item in known_postal})):
            proposed["zip"] = (postal[:5], address)
            proposed["state"] = (region.upper(), address)
            street, city = value.get("streetAddress"), value.get("addressLocality")
            if all(isinstance(part, str) and part.strip() and len(part) <= 300 and "\x00" not in part for part in (street, city)):
                proposed["formatted_address"] = (f"{street.strip()}, {city.strip()}, {region.upper()} {postal}", address)
    return {field: item for field, item in proposed.items() if blank(getattr(row, field))}
