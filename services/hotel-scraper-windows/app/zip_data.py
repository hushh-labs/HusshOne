import math
import requests
from typing import Dict, Any, Optional, List

KIRKLAND_LAT = 47.6769
KIRKLAND_LNG = -122.2060

def haversine_distance_km(lat1: float, lon1: float, lat2: float = KIRKLAND_LAT, lon2: float = KIRKLAND_LNG) -> float:
    """Calculates great-circle distance in kilometers from Kirkland, WA."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return round(R * c, 2)

# Top 60 major US lodging/hotel markets and travel hubs
MAJOR_US_HOTEL_ZIPS = [
    # Washington (Local)
    {"zip": "98101", "city": "Seattle", "state": "WA", "county": "King", "lat": 47.6101, "lng": -122.3344},
    {"zip": "98004", "city": "Bellevue", "state": "WA", "county": "King", "lat": 47.6163, "lng": -122.2009},
    {"zip": "98402", "city": "Tacoma", "state": "WA", "county": "Pierce", "lat": 47.2529, "lng": -122.4443},
    {"zip": "99201", "city": "Spokane", "state": "WA", "county": "Spokane", "lat": 47.6588, "lng": -117.4260},
    {"zip": "98660", "city": "Vancouver", "state": "WA", "county": "Clark", "lat": 45.6387, "lng": -122.6615},
    # California
    {"zip": "90028", "city": "Hollywood / Los Angeles", "state": "CA", "county": "Los Angeles", "lat": 34.1016, "lng": -118.3268},
    {"zip": "90210", "city": "Beverly Hills", "state": "CA", "county": "Los Angeles", "lat": 34.0736, "lng": -118.4004},
    {"zip": "90401", "city": "Santa Monica", "state": "CA", "county": "Los Angeles", "lat": 34.0195, "lng": -118.4912},
    {"zip": "94102", "city": "San Francisco", "state": "CA", "county": "San Francisco", "lat": 37.7794, "lng": -122.4174},
    {"zip": "92101", "city": "San Diego", "state": "CA", "county": "San Diego", "lat": 32.7157, "lng": -117.1611},
    {"zip": "95113", "city": "San Jose", "state": "CA", "county": "Santa Clara", "lat": 37.3337, "lng": -121.8907},
    {"zip": "92802", "city": "Anaheim / Disneyland", "state": "CA", "county": "Orange", "lat": 33.8033, "lng": -117.9189},
    {"zip": "95814", "city": "Sacramento", "state": "CA", "county": "Sacramento", "lat": 38.5816, "lng": -121.4944},
    {"zip": "93940", "city": "Monterey", "state": "CA", "county": "Monterey", "lat": 36.6002, "lng": -121.8947},
    # Nevada
    {"zip": "89109", "city": "Las Vegas (The Strip)", "state": "NV", "county": "Clark", "lat": 36.1285, "lng": -115.1666},
    {"zip": "89101", "city": "Las Vegas (Downtown)", "state": "NV", "county": "Clark", "lat": 36.1716, "lng": -115.1391},
    {"zip": "89501", "city": "Reno", "state": "NV", "county": "Washoe", "lat": 39.5296, "lng": -119.8138},
    # New York
    {"zip": "10019", "city": "New York (Midtown/Times Sq)", "state": "NY", "county": "New York", "lat": 40.7654, "lng": -73.9857},
    {"zip": "10001", "city": "New York (Chelsea/Penn)", "state": "NY", "county": "New York", "lat": 40.7501, "lng": -73.9996},
    {"zip": "11201", "city": "Brooklyn / DUMBO", "state": "NY", "county": "Kings", "lat": 40.6937, "lng": -73.9904},
    {"zip": "14201", "city": "Buffalo", "state": "NY", "county": "Erie", "lat": 42.8962, "lng": -78.8872},
    # Florida
    {"zip": "33139", "city": "Miami Beach (South Beach)", "state": "FL", "county": "Miami-Dade", "lat": 25.7907, "lng": -80.1300},
    {"zip": "33131", "city": "Miami (Downtown/Brickell)", "state": "FL", "county": "Miami-Dade", "lat": 25.7679, "lng": -80.1903},
    {"zip": "32801", "city": "Orlando (Downtown)", "state": "FL", "county": "Orange", "lat": 28.5383, "lng": -81.3792},
    {"zip": "32819", "city": "Orlando (Universal/Intl Dr)", "state": "FL", "county": "Orange", "lat": 28.4489, "lng": -81.4727},
    {"zip": "33040", "city": "Key West", "state": "FL", "county": "Monroe", "lat": 24.5551, "lng": -81.7800},
    {"zip": "33602", "city": "Tampa", "state": "FL", "county": "Hillsborough", "lat": 27.9506, "lng": -82.4572},
    {"zip": "33301", "city": "Fort Lauderdale", "state": "FL", "county": "Broward", "lat": 26.1224, "lng": -80.1373},
    # Texas
    {"zip": "78701", "city": "Austin (Downtown)", "state": "TX", "county": "Travis", "lat": 30.2711, "lng": -97.7437},
    {"zip": "77002", "city": "Houston (Downtown)", "state": "TX", "county": "Harris", "lat": 29.7589, "lng": -95.3677},
    {"zip": "75201", "city": "Dallas (Downtown)", "state": "TX", "county": "Dallas", "lat": 32.7876, "lng": -96.7995},
    {"zip": "78205", "city": "San Antonio (Riverwalk)", "state": "TX", "county": "Bexar", "lat": 29.4241, "lng": -98.4936},
    {"zip": "76102", "city": "Fort Worth", "state": "TX", "county": "Tarrant", "lat": 32.7555, "lng": -97.3308},
    # Illinois
    {"zip": "60611", "city": "Chicago (Magnificent Mile)", "state": "IL", "county": "Cook", "lat": 41.8925, "lng": -87.6200},
    {"zip": "60601", "city": "Chicago (The Loop)", "state": "IL", "county": "Cook", "lat": 41.8856, "lng": -87.6251},
    # Hawaii
    {"zip": "96815", "city": "Honolulu (Waikiki)", "state": "HI", "county": "Honolulu", "lat": 21.2763, "lng": -157.8272},
    {"zip": "96761", "city": "Lahaina / Maui", "state": "HI", "county": "Maui", "lat": 20.8783, "lng": -156.6825},
    # Colorado
    {"zip": "80202", "city": "Denver (Downtown)", "state": "CO", "county": "Denver", "lat": 39.7539, "lng": -104.9977},
    {"zip": "81611", "city": "Aspen", "state": "CO", "county": "Pitkin", "lat": 39.1911, "lng": -106.8175},
    {"zip": "80903", "city": "Colorado Springs", "state": "CO", "county": "El Paso", "lat": 38.8339, "lng": -104.8214},
    # Arizona
    {"zip": "85004", "city": "Phoenix (Downtown)", "state": "AZ", "county": "Maricopa", "lat": 33.4502, "lng": -112.0740},
    {"zip": "85251", "city": "Scottsdale", "state": "AZ", "county": "Maricopa", "lat": 33.4942, "lng": -111.9261},
    {"zip": "85701", "city": "Tucson", "state": "AZ", "county": "Pima", "lat": 32.2217, "lng": -110.9705},
    # Massachusetts
    {"zip": "02116", "city": "Boston (Back Bay)", "state": "MA", "county": "Suffolk", "lat": 42.3503, "lng": -71.0772},
    {"zip": "02138", "city": "Cambridge / Harvard", "state": "MA", "county": "Middlesex", "lat": 42.3736, "lng": -71.1097},
    # Georgia
    {"zip": "30303", "city": "Atlanta (Downtown)", "state": "GA", "county": "Fulton", "lat": 33.7537, "lng": -84.3916},
    {"zip": "31401", "city": "Savannah (Historic)", "state": "GA", "county": "Chatham", "lat": 32.0762, "lng": -81.0998},
    # Louisiana
    {"zip": "70112", "city": "New Orleans (French Quarter)", "state": "LA", "county": "Orleans", "lat": 29.9547, "lng": -90.0751},
    # Tennessee
    {"zip": "37203", "city": "Nashville (Music Row/Gulch)", "state": "TN", "county": "Davidson", "lat": 36.1524, "lng": -86.7925},
    {"zip": "38103", "city": "Memphis (Beale St)", "state": "TN", "county": "Shelby", "lat": 35.1434, "lng": -90.0521},
    # Pennsylvania
    {"zip": "19102", "city": "Philadelphia (Center City)", "state": "PA", "county": "Philadelphia", "lat": 39.9526, "lng": -75.1652},
    {"zip": "15222", "city": "Pittsburgh (Downtown)", "state": "PA", "county": "Allegheny", "lat": 40.4406, "lng": -79.9959},
    # District of Columbia
    {"zip": "20001", "city": "Washington", "state": "DC", "county": "District of Columbia", "lat": 38.9101, "lng": -77.0163},
    # Oregon
    {"zip": "97201", "city": "Portland (Downtown)", "state": "OR", "county": "Multnomah", "lat": 45.5051, "lng": -122.6750},
    # North Carolina
    {"zip": "28202", "city": "Charlotte (Uptown)", "state": "NC", "county": "Mecklenburg", "lat": 35.2271, "lng": -80.8431},
    {"zip": "28801", "city": "Asheville", "state": "NC", "county": "Buncombe", "lat": 35.5951, "lng": -82.5515},
    # Utah
    {"zip": "84101", "city": "Salt Lake City", "state": "UT", "county": "Salt Lake", "lat": 40.7608, "lng": -111.8910},
    {"zip": "84060", "city": "Park City", "state": "UT", "county": "Summit", "lat": 40.6461, "lng": -111.4980},
    # South Carolina
    {"zip": "29401", "city": "Charleston (Historic)", "state": "SC", "county": "Charleston", "lat": 32.7765, "lng": -79.9311},
]

def geocode_free_location(location_query: str) -> Optional[Dict[str, Any]]:
    """
    Geocodes a custom ZIP code or city query using free public OpenStreetMap Nominatim.
    Zero API key required.
    """
    clean_q = location_query.strip()
    # Check if in known list first
    for item in MAJOR_US_HOTEL_ZIPS:
        if item["zip"] == clean_q or item["city"].lower() == clean_q.lower():
            dist = haversine_distance_km(item["lat"], item["lng"])
            return {**item, "dist_km_from_kirkland": dist}

    # Free Nominatim lookup
    try:
        url = f"https://nominatim.openstreetmap.org/search?format=json&q={requests.utils.quote(clean_q + ', USA')}&limit=1"
        headers = {"User-Agent": "HusshOne-Scraper/1.0 (contact@hushh.ai)"}
        resp = requests.get(url, headers=headers, timeout=6)
        if resp.status_code == 200:
            data = resp.json()
            if data:
                res = data[0]
                lat = float(res.get("lat"))
                lng = float(res.get("lon"))
                dist = haversine_distance_km(lat, lng)
                display_name = res.get("display_name", "")
                parts = [p.strip() for p in display_name.split(",")]
                city = parts[0] if len(parts) > 0 else clean_q
                state = parts[-3] if len(parts) >= 3 else "US"
                return {
                    "zip": clean_q if clean_q.isdigit() else f"Z-{abs(hash(clean_q)) % 100000:05d}",
                    "city": city,
                    "state": state,
                    "county": "Custom",
                    "lat": lat,
                    "lng": lng,
                    "dist_km_from_kirkland": dist
                }
    except Exception:
        pass
    return None
