"""Bounded read-only lookup across the four native directory databases."""
import asyncio
from typing import Literal
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import MetaData, Table, or_, select
from app import database
from app.config import database_target
from app.models import Hotel

router = APIRouter(prefix="/api/v1/businesses", tags=["Business lookup"])
Vertical = Literal["all", "hotel", "healthcare", "ria", "insurance", "business"]


class BusinessSearch(BaseModel):
    q: str | None = Field(None, min_length=1, max_length=200)
    zip: str | None = Field(None, pattern=r"^\d{5}$")
    vertical: Vertical = "all"
    category: str | None = Field(None, min_length=1, max_length=100)
    limit: int = Field(20, ge=1, le=100)
    offset: int = Field(0, ge=0, le=10000)

    @model_validator(mode="after")
    def require_filter(self):
        if self.q is not None:
            self.q = self.q.strip()
        if not self.q and not self.zip:
            raise ValueError("Provide a name/query or a five-digit ZIP")
        return self


def literal_pattern(value):
    return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def hotel_results(db, request):
    columns = [Hotel.id, Hotel.name, Hotel.formatted_address, Hotel.zip, Hotel.query_zip,
               Hotel.state, Hotel.lat, Hotel.lng, Hotel.phone, Hotel.website,
               Hotel.google_maps_uri, Hotel.primary_type, Hotel.types, Hotel.rating,
               Hotel.sources, Hotel.last_seen,
               Hotel.raw["website_enrichment"]["fields"].label("rich_fields")]
    query = select(*columns)
    if request.q:
        pattern = literal_pattern(request.q)
        query = query.where(or_(Hotel.name.ilike(pattern, escape="\\"),
                               Hotel.formatted_address.ilike(pattern, escape="\\")))
    if request.zip:
        query = query.where(or_(Hotel.zip == request.zip, Hotel.query_zip == request.zip))
    return [dict(row) for row in db.execute(query.order_by(Hotel.id).limit(
        request.offset + request.limit + 1)).mappings()]


REGISTRY_TABLES = {"healthcare": {"providers": ("npi", ("organization_name", "first_name", "last_name"))},
                   "ria": {"firms": ("crd", ("firm_name",)), "advisers": ("crd", ("first_name", "last_name"))},
                   "insurance": {"producers": ("id", ("full_name", "first_name", "last_name"))},
                   "business": {"businesses": ("id", ("name",))}}
PUBLIC_COLUMNS = {"npi", "crd", "id", "source_state", "license_no", "npn", "organization_name",
                  "name", "category", "source", "source_key", "source_url", "formatted_address",
                  "first_name", "last_name", "firm_name", "full_name", "credential", "entity_type",
                  "primary_taxonomy_code", "primary_taxonomy_desc", "sec_number", "aum",
                  "current_firm_crd", "current_firm_name", "registration_status", "status",
                  "license_types", "lines_of_authority", "address_line1", "address_line2",
                  "street1", "street2", "city", "state", "zip", "country", "phone", "website",
                  "lat", "lng", "sources", "first_seen", "last_seen"}


def registry_results(db, vertical, request):
    rows = []
    for table_name, (key, names) in REGISTRY_TABLES[vertical].items():
        table = Table(table_name, MetaData(), schema="public", autoload_with=db.connection())
        columns=[table.c[c] for c in sorted(PUBLIC_COLUMNS & set(table.c.keys()))]
        if vertical=='business':
            columns.extend([table.c.raw['website_enrichment']['fields'].label('rich_fields'),
                            table.c.raw['query_zip'].as_string().label('query_zip')])
        query = select(*columns)
        if request.q:
            query = query.where(or_(*(table.c[c].ilike(literal_pattern(request.q), escape="\\") for c in names)))
        if request.zip:
            query = query.where(or_(table.c.zip == request.zip,table.c.raw['query_zip'].as_string()==request.zip)) if vertical=='business' else query.where(table.c.zip == request.zip)
        if vertical == 'business' and request.category:
            query = query.where(table.c.category == request.category)
        for row in db.execute(query.order_by(table.c[key]).limit(request.offset + request.limit + 1)).mappings():
            item = dict(row)
            item["name"] = next((item.get(c) for c in ("name", "organization_name", "firm_name", "full_name") if item.get(c)),
                                " ".join(str(item.get(c) or "") for c in ("first_name", "last_name")).strip())
            identity = {"source_state": item["source_state"], "license_no": item["license_no"]} if vertical == "insurance" else {key: str(item[key])}
            if vertical == 'business':
                identity = {'source':item['source'],'source_key':item['source_key']}
            item.update(id=str(item[key]), canonical_table=table_name, native_identity=identity)
            rows.append(item)
    return rows


def search_stored_businesses(request):
    from app.directory_fleet import registry_session
    results, warnings, available = [], [], []
    verticals = ("hotel", "healthcare", "ria", "insurance", "business") if request.vertical == "all" else (request.vertical,)
    for vertical in verticals:
        db = None
        try:
            db = database.get_readonly_db_session() if vertical == "hotel" else registry_session(vertical)
            rows = hotel_results(db, request) if vertical == "hotel" else registry_results(db, vertical, request)
            for rank, item in enumerate(rows):
                item["_rank"] = rank
                item.update(vertical=vertical, record_kind="canonical_directory", ownership_verified=False)
                if vertical == "hotel":
                    item.update(id=str(item["id"]), canonical_table="hotels", native_identity={"id": str(item["id"])},
                                rich_fields=item.get("rich_fields") or {})
            results.extend(rows)
            available.append(vertical)
        except (database.DatabaseUnavailable, database.SQLAlchemyError, KeyError):
            warnings.append(f"{vertical} directory unavailable or schema incompatible; omitted")
        finally:
            if db is not None:
                db.rollback()
                db.close()
    if not available:
        raise database.DatabaseUnavailable("Requested directories are unavailable")
    results.sort(key=lambda item: (item["vertical"], item["canonical_table"], item["_rank"]))
    page = results[request.offset:request.offset + request.limit]
    for item in page:
        item.pop("_rank", None)
    return {"ok": True, "query": request.model_dump(), "count": len(page),
            "has_more": len(results) > request.offset + request.limit, "results": page,
            "target": database_target(), "available_directories": available, "warnings": warnings,
            "scope": "Stored public directory data only; no scraping or ownership verification initiated."}


async def execute_search(request):
    try:
        return await asyncio.to_thread(search_stored_businesses, request)
    except (database.DatabaseUnavailable, database.SQLAlchemyError):
        raise HTTPException(503, "Requested directories are unavailable; no data was changed") from None


@router.get("")
async def get_businesses(q: str | None = Query(None, min_length=1, max_length=200),
                         zip: str | None = Query(None, pattern=r"^\d{5}$"), vertical: Vertical = "all",
                         category: str | None = Query(None, min_length=1, max_length=100),
                         limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0, le=10000)):
    if not (q and q.strip()) and not zip:
        raise HTTPException(422, "Provide a name/query or a five-digit ZIP")
    return await execute_search(BusinessSearch(q=q, zip=zip, vertical=vertical, category=category, limit=limit, offset=offset))


@router.post("/search")
async def post_businesses(request: BusinessSearch):
    return await execute_search(request)
