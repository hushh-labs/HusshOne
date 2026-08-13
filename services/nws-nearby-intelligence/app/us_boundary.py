"""Offline U.S. coordinate coverage from the official Census state boundary release."""

from __future__ import annotations

import json
import struct
from functools import lru_cache
from hashlib import sha256
from pathlib import Path

from app.nws_models import GeoPoint

_DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "geography" / "us" / "2025"
_SHAPEFILE = _DATA_DIR / "state-boundaries-500k.shp"
_MANIFEST = _DATA_DIR / "manifest.json"


def _ring_contains(point: GeoPoint, ring: tuple[tuple[float, float], ...]) -> bool:
    """Ray-cast one closed polygon ring using longitude as x and latitude as y."""

    inside = False
    x, y = point.longitude, point.latitude
    previous_x, previous_y = ring[-1]
    for current_x, current_y in ring:
        crosses = (current_y > y) != (previous_y > y)
        if crosses:
            intersection_x = (previous_x - current_x) * (y - current_y) / (
                previous_y - current_y
            ) + current_x
            if x < intersection_x:
                inside = not inside
        previous_x, previous_y = current_x, current_y
    return inside


class UsBoundaryIndex:
    """Union of Census state/territory polygons; no network reverse geocoder required."""

    def __init__(
        self,
        shapes: tuple[tuple[tuple[tuple[float, float], ...], ...], ...],
    ) -> None:
        if not shapes:
            raise ValueError("US boundary index cannot be empty")
        self._shapes = shapes

    def contains(self, point: GeoPoint) -> bool:
        for rings in self._shapes:
            # Shapefile polygon parts encode outer rings and holes. Even-odd parity
            # works for both and avoids treating a lake or interior hole as US land.
            if sum(_ring_contains(point, ring) for ring in rings) % 2 == 1:
                return True
        return False

    def intersects_quantized_cell(self, point: GeoPoint, *, decimals: int) -> bool:
        """Check the privacy-coarsened cell without retaining the raw coordinate.

        A point very near a coastline can move just offshore when rounded to two
        decimals. Testing the center, edges, and corners of the represented cell
        preserves the coarsening boundary while avoiding that false negative.
        """

        half_step = 0.5 * (10 ** (-decimals))
        offsets = (-half_step, 0.0, half_step)
        return any(
            self.contains(
                GeoPoint(
                    max(-90.0, min(90.0, point.latitude + latitude_offset)),
                    max(-180.0, min(180.0, point.longitude + longitude_offset)),
                )
            )
            for latitude_offset in offsets
            for longitude_offset in offsets
        )


def _read_polygon_shapes(path: Path) -> UsBoundaryIndex:
    payload = path.read_bytes()
    if len(payload) < 100 or struct.unpack(">i", payload[:4])[0] != 9994:
        raise RuntimeError("Invalid Census state-boundary shapefile header")
    shapes: list[tuple[tuple[tuple[float, float], ...], ...]] = []
    offset = 100
    while offset + 8 <= len(payload):
        _, length_words = struct.unpack(">2i", payload[offset : offset + 8])
        offset += 8
        content_length = length_words * 2
        content = payload[offset : offset + content_length]
        offset += content_length
        if len(content) < 44:
            continue
        shape_type = struct.unpack("<i", content[:4])[0]
        if shape_type == 0:
            continue
        if shape_type != 5:
            raise RuntimeError(f"Unsupported Census boundary shape type: {shape_type}")
        part_count, point_count = struct.unpack("<2i", content[36:44])
        parts_start = 44
        points_start = parts_start + part_count * 4
        if points_start + point_count * 16 > len(content):
            raise RuntimeError("Truncated Census boundary polygon record")
        starts = list(struct.unpack(f"<{part_count}i", content[parts_start:points_start]))
        starts.append(point_count)
        points = tuple(
            struct.unpack(
                "<2d",
                content[points_start + index * 16 : points_start + (index + 1) * 16],
            )
            for index in range(point_count)
        )
        rings = tuple(points[starts[index] : starts[index + 1]] for index in range(part_count))
        shapes.append(rings)
    return UsBoundaryIndex(tuple(shapes))


@lru_cache(maxsize=1)
def get_us_boundary_index() -> UsBoundaryIndex:
    manifest = json.loads(_MANIFEST.read_text(encoding="utf-8"))
    digest = sha256(_SHAPEFILE.read_bytes()).hexdigest()
    if digest != manifest["boundary_file_sha256"]:
        raise RuntimeError("US boundary digest does not match its release manifest")
    return _read_polygon_shapes(_SHAPEFILE)
