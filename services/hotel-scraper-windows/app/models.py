"""ORM models mirroring the production Cloud SQL `hotel_scraper` schema.

The production tables already exist and are shared with other tooling, so these
models must match them exactly. The app never creates or alters tables on
PostgreSQL. SQLite (dev/tests only) gets its tables from `create_all`, with
JSON standing in for Postgres arrays/jsonb.
"""
from datetime import datetime, timezone
from sqlalchemy import (
    Boolean, CHAR, Column, String, Integer, BigInteger, Float, DateTime, Date,
    ForeignKey, Numeric, REAL, Text, JSON, func, text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import declarative_base

Base = declarative_base()

TextArray = ARRAY(Text).with_variant(JSON(), "sqlite")
JsonDoc = JSONB().with_variant(JSON(), "sqlite")
# Cloud SQL uses PostgreSQL's fixed-width character type for these keys.  SQLite
# keeps a normal string representation for the dev/test backend.
ZipChar = CHAR(5).with_variant(String(5), "sqlite")
StateChar = CHAR(2).with_variant(String(2), "sqlite")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ZipCode(Base):
    __tablename__ = "zips"

    zip = Column(ZipChar, primary_key=True)
    city = Column(Text, nullable=True)
    state = Column(StateChar, nullable=True)
    county = Column(Text, nullable=True)
    lat = Column(Float, nullable=False)
    lng = Column(Float, nullable=False)
    dist_km_from_kirkland = Column(Float, nullable=True)
    osm_status = Column(Text, nullable=False, default="pending", server_default=text("'pending'"))
    places_status = Column(Text, nullable=False, default="pending", server_default=text("'pending'"))
    places_calls = Column(Integer, nullable=False, default=0, server_default=text("0"))
    hotels_found = Column(Integer, nullable=False, default=0, server_default=text("0"))
    last_error = Column(Text, nullable=True)
    last_scraped_at = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(
        DateTime(timezone=True), nullable=False, default=utcnow,
        server_default=func.now(), onupdate=utcnow,
    )

    def to_dict(self):
        return {
            "zip": self.zip,
            "city": self.city,
            "state": self.state,
            "county": self.county,
            "lat": self.lat,
            "lng": self.lng,
            "dist_km_from_kirkland": self.dist_km_from_kirkland,
            "osm_status": self.osm_status,
            "places_status": self.places_status,
            "places_calls": self.places_calls,
            "hotels_found": self.hotels_found,
            "last_error": self.last_error,
            "last_scraped_at": self.last_scraped_at.isoformat() if self.last_scraped_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class Hotel(Base):
    __tablename__ = "hotels"
    # `geog` is GENERATED ALWAYS STORED in Cloud SQL from lat/lng.  It stays
    # unmapped because SQLite cannot evaluate PostGIS generated expressions;
    # schema_guard verifies the production expression before writes are enabled.

    id = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    dedup_key = Column(Text, nullable=False, unique=True)
    place_id = Column(Text, nullable=True, unique=True)
    osm_id = Column(Text, nullable=True)
    sources = Column(TextArray, nullable=False, default=list, server_default=text("'{}'"))
    name = Column(Text, nullable=False)
    formatted_address = Column(Text, nullable=True)
    zip = Column(ZipChar, nullable=True)
    query_zip = Column(ZipChar, ForeignKey("zips.zip"), nullable=True)
    state = Column(StateChar, nullable=True)
    lat = Column(Float, nullable=True)
    lng = Column(Float, nullable=True)
    # Cloud SQL stores rating as PostgreSQL REAL (float4), not FLOAT8.
    rating = Column(REAL().with_variant(Float(), "sqlite"), nullable=True)
    user_ratings_total = Column(Integer, nullable=True)
    price_level = Column(Text, nullable=True)
    phone = Column(Text, nullable=True)
    website = Column(Text, nullable=True)
    google_maps_uri = Column(Text, nullable=True)
    primary_type = Column(Text, nullable=True)
    types = Column(TextArray, nullable=True)
    business_status = Column(Text, nullable=True)
    raw = Column(JsonDoc, nullable=True)
    first_seen = Column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now())
    last_seen = Column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now())

    # Photo columns belong to a separate photo pipeline; this app never writes them.
    photo_refs = Column(TextArray, nullable=False, default=list, server_default=text("'{}'"))
    photos = Column(JsonDoc, nullable=False, default=list, server_default=text("'[]'"))
    photos_status = Column(Text, nullable=False, default="pending", server_default=text("'pending'"))
    photos_count = Column(Integer, nullable=False, default=0, server_default=text("0"))
    photos_fetched_at = Column(DateTime(timezone=True), nullable=True)
    photos_error = Column(Text, nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "dedup_key": self.dedup_key,
            "place_id": self.place_id,
            "osm_id": self.osm_id,
            "sources": list(self.sources or []),
            "name": self.name,
            "formatted_address": self.formatted_address,
            "zip": self.zip,
            "query_zip": self.query_zip,
            "state": self.state,
            "lat": self.lat,
            "lng": self.lng,
            "rating": self.rating,
            "user_ratings_total": self.user_ratings_total,
            "price_level": self.price_level,
            "phone": self.phone,
            "website": self.website,
            "google_maps_uri": self.google_maps_uri,
            "primary_type": self.primary_type,
            "types": list(self.types or []),
            "business_status": self.business_status,
            "photos_status": self.photos_status,
            "photos_count": self.photos_count,
            "first_seen": self.first_seen.isoformat() if self.first_seen else None,
            "last_seen": self.last_seen.isoformat() if self.last_seen else None,
        }


class PhotoSpend(Base):
    """Daily Places photo-media fetch counter, written by the separate photo pipeline."""
    __tablename__ = "photo_spend"

    day = Column(Date, primary_key=True)
    media_fetches = Column(
        BigInteger().with_variant(Integer, "sqlite"), nullable=False,
        default=0, server_default=text("0"),
    )


class EmailReport(Base):
    """Existing Cloud SQL delivery-audit table used by the alert reporter."""
    __tablename__ = "email_reports"

    id = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    sent_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now())
    recipients = Column(TextArray, nullable=True)
    zips_done = Column(Integer, nullable=True)
    zips_left = Column(Integer, nullable=True)
    hotels_total = Column(Integer, nullable=True)
    places_calls_total = Column(Integer, nullable=True)
    est_cost_usd = Column(Numeric, nullable=True)
    ok = Column(Boolean, nullable=False, default=True, server_default=text("true"))
    error = Column(Text, nullable=True)
