_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def encode(lat: float, lng: float, precision: int = 6) -> str:
    lat_lo, lat_hi, lng_lo, lng_hi = -90.0, 90.0, -180.0, 180.0
    out, bits, bit_count, even = [], 0, 0, True
    while len(out) < precision:
        if even:
            mid = (lng_lo + lng_hi) / 2
            if lng >= mid:
                bits = (bits << 1) | 1
                lng_lo = mid
            else:
                bits <<= 1
                lng_hi = mid
        else:
            mid = (lat_lo + lat_hi) / 2
            if lat >= mid:
                bits = (bits << 1) | 1
                lat_lo = mid
            else:
                bits <<= 1
                lat_hi = mid
        even = not even
        bit_count += 1
        if bit_count == 5:
            out.append(_BASE32[bits])
            bits, bit_count = 0, 0
    return "".join(out)
