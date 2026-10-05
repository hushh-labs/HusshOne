import re
import time
import logging
import unicodedata
import requests
from typing import List, Dict, Any, Optional
from app import geohash

logger = logging.getLogger("hotel_scraper.free_engine")

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
]

HEADERS = {
    "User-Agent": "HusshOne-DirectoryScraper/1.0 (Local Research Crawler; contact@hushh.ai)"
}

def normalize_name(name: str) -> str:
    """Matches production: ascii-folded, '&' -> 'and', punctuation -> single spaces, lowercase."""
    folded = unicodedata.normalize("NFKD", name or "")
    folded = re.sub(r"[\u0300-\u036f]", "", folded).lower().replace("&", " and ")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", folded)).strip()

def generate_dedup_key(name: str, lat: float, lng: float) -> str:
    """Production dedup_key format: '<normalized name>|<geohash6>'."""
    return f"{normalize_name(name)}|{geohash.encode(lat, lng, 6)}"

def _parse_overpass_elements(elements: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Helper to parse Overpass nodes/ways into standardized hotel records."""
    results = []
    for elem in elements:
        tags = elem.get("tags", {})
        name = tags.get("name")
        if not name:
            continue

        e_lat = elem.get("lat") or (elem.get("center", {}).get("lat"))
        e_lng = elem.get("lon") or (elem.get("center", {}).get("lon"))
        if e_lat is None or e_lng is None:
            continue

        # Address parsing
        addr_parts = []
        if "addr:housenumber" in tags and "addr:street" in tags:
            addr_parts.append(f"{tags['addr:housenumber']} {tags['addr:street']}")
        elif "addr:street" in tags:
            addr_parts.append(tags["addr:street"])
        if "addr:city" in tags:
            addr_parts.append(tags["addr:city"])
        if "addr:state" in tags:
            addr_parts.append(tags["addr:state"])
        if "addr:postcode" in tags:
            addr_parts.append(tags["addr:postcode"])

        formatted_addr = ", ".join(addr_parts) if addr_parts else None
        phone = tags.get("phone") or tags.get("contact:phone")
        website = tags.get("website") or tags.get("contact:website")
        primary_type = tags.get("tourism") or "hotel"
        dedup_key = generate_dedup_key(name, e_lat, e_lng)
        osm_id = f"{elem.get('type', 'node')}/{elem.get('id')}"

        results.append({
            "name": name,
            "dedup_key": dedup_key,
            "place_id": None,
            "osm_id": osm_id,
            "sources": ["osm"],
            "lat": e_lat,
            "lng": e_lng,
            "formatted_address": formatted_addr,
            "user_ratings_total": None,
            "price_level": None,
            "phone": phone,
            "website": website,
            "google_maps_uri": None,
            "primary_type": primary_type,
            "types": [primary_type, "lodging"],
            "rating": None,
            "business_status": None,
            "raw": {
                "scraped_via": "osm_overpass",
                "osm_tags": tags,
                "osm_element_type": elem.get("type", "node"),
                "osm_element_id": elem.get("id"),
            },
        })
    return results

def scrape_osm_lodgings_by_zip(
    zip_code: str,
    lat: Optional[float] = None,
    lng: Optional[float] = None
) -> List[Dict[str, Any]]:
    """
    Directly queries OpenStreetMap Overpass by defined postal ZIP code.
    If no explicit postal tag matches, falls back to a tight radius around centroid.
    100% Free / Zero API cost.
    """
    clean_zip = zip_code.strip()
    if clean_zip:
        query = f"""
        [out:json][timeout:20];
        (
          node["tourism"~"hotel|motel|guest_house|hostel|resort"]["addr:postcode"="{clean_zip}"];
          way["tourism"~"hotel|motel|guest_house|hostel|resort"]["addr:postcode"="{clean_zip}"];
        );
        out center tags;
        """
        for endpoint in OVERPASS_ENDPOINTS:
            try:
                logger.info(f"Querying Overpass by exact ZIP {clean_zip} on {endpoint}...")
                response = requests.post(endpoint, data={"data": query}, headers=HEADERS, timeout=12)
                if response.status_code == 200:
                    elements = response.json().get("elements", [])
                    res = _parse_overpass_elements(elements)
                    for record in res:
                        record["raw"]["query_zip"] = clean_zip
                        record["raw"]["query_mode"] = "postcode"
                    if res:
                        logger.info(f"Found {len(res)} lodgings with explicit ZIP {clean_zip} in OSM.")
                        return res
            except Exception as e:
                logger.debug(f"Overpass postcode query notice: {e}")
                continue

    # Fallback to localized 6km boundary around centroid if available
    if lat is not None and lng is not None:
        logger.info(f"Postal code tag empty in OSM; querying localized 6km boundary for ({lat}, {lng})...")
        results = scrape_osm_lodgings(lat, lng, radius_meters=6000)
        for record in results:
            record["raw"]["query_zip"] = clean_zip
            record["raw"]["query_mode"] = "centroid_radius"
        return results

    return []

def scrape_osm_lodgings(lat: float, lng: float, radius_meters: int = 12000) -> List[Dict[str, Any]]:
    """
    Queries public OpenStreetMap Overpass API for all hotels, motels, and guest houses.
    Zero API key required.
    """
    query = f"""
    [out:json][timeout:25];
    (
      node["tourism"~"hotel|motel|guest_house|hostel|resort"](around:{radius_meters},{lat},{lng});
      way["tourism"~"hotel|motel|guest_house|hostel|resort"](around:{radius_meters},{lat},{lng});
    );
    out center tags;
    """

    for endpoint in OVERPASS_ENDPOINTS:
        try:
            logger.info(f"Querying Overpass endpoint {endpoint} around ({lat}, {lng})...")
            response = requests.post(
                endpoint,
                data={"data": query},
                headers=HEADERS,
                timeout=15
            )
            if response.status_code == 200:
                data = response.json()
                elements = data.get("elements", [])
                results = _parse_overpass_elements(elements)
                logger.info(f"Overpass returned {len(results)} lodging records for ({lat}, {lng}).")
                return results
            else:
                logger.warning(f"Overpass endpoint {endpoint} returned HTTP {response.status_code}")
        except Exception as e:
            logger.warning(f"Failed querying Overpass endpoint {endpoint}: {e}")
            continue

    return []
