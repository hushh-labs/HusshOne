from __future__ import annotations

import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app.main import app


response = TestClient(app).post(
    "/v2/nearby-network/discover",
    headers={"X-NWS-API-Key": os.getenv("NWS_API_KEY", "local-development-only")},
    json={
        "query": {"postal_code": "98033"},
        "top_n": 100,
        "initial_radius_km": 10,
        "max_radius_km": 35,
        "auto_expand": True,
        "diversity": True,
        "filters": {"minimum_confidence_grade": "B"},
    },
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
