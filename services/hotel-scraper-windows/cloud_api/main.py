"""Cloud-only read service. No desktop lifespan, proxy, workers or controls."""
import asyncio
import os
from fastapi import FastAPI, HTTPException, Query
from sqlalchemy import create_engine
from sqlalchemy.engine import URL
from sqlalchemy.orm import Session
from sqlalchemy.exc import SQLAlchemyError
from app.business_lookup import BusinessSearch, Vertical, hotel_results, registry_results
from cloud_api.compression import Compression
from app.business_onboarding import OnboardingLookup, resolve_with_sessions
from fastapi import Response

app = FastAPI(title='HusshOne Read-only Directory API', docs_url=None, redoc_url=None)
app.add_middleware(Compression, enabled=os.getenv('ENABLE_RESPONSE_COMPRESSION', 'false').lower() == 'true')
engines = {}
DATABASES = {'hotel':'hotel_scraper','healthcare':'healthcare','ria':'ria','insurance':'insurance','business':'business_directory'}


def engine_for(vertical):
    # Created lazily on the event loop before dispatch; no connection/DDL here.
    if vertical not in engines:
        url = URL.create('postgresql+psycopg2', username=os.environ['SQL_USER'],
                         password=os.environ['SQL_PASSWORD'], database=DATABASES[vertical],
                         query={'host':'/cloudsql/' + os.environ['SQL_INSTANCE']})
        engines[vertical] = create_engine(url, pool_size=1, max_overflow=0, pool_timeout=3,
            pool_pre_ping=True, connect_args={'connect_timeout':5,
            'options':'-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000'})
    return engines[vertical]


def stored_search(request, pools):
    results, warnings, available = [], [], []
    for vertical, engine in pools.items():
        try:
            with Session(engine) as db:
                rows = hotel_results(db, request) if vertical == 'hotel' else registry_results(db, vertical, request)
                for rank, item in enumerate(rows):
                    item.update(_rank=rank, vertical=vertical, record_kind='canonical_directory', ownership_verified=False)
                    if vertical == 'hotel':
                        item.update(id=str(item['id']), canonical_table='hotels', native_identity={'id':str(item['id'])}, rich_fields=item.get('rich_fields') or {})
                results.extend(rows)
                available.append(vertical)
        except (SQLAlchemyError, KeyError):
            warnings.append(f'{vertical} directory unavailable or schema incompatible; omitted')
    if not available:
        raise HTTPException(503, 'Requested directories are unavailable; no data changed')
    results.sort(key=lambda row:(row['vertical'],row['canonical_table'],row['_rank']))
    page = results[request.offset:request.offset + request.limit]
    for row in page:
        row.pop('_rank', None)
    return {'ok':True, 'query':request.model_dump(), 'count':len(page),
            'has_more':len(results)>request.offset+request.limit, 'results':page,
            'available_directories':available, 'warnings':warnings,
            'target':{'backend':'cloud','project':'hushh-tech-prod','instance':os.getenv('SQL_INSTANCE'), 'database':'native directories'},
            'scope':'Stored public directory data only; no scraping or ownership verification initiated.'}


async def search(request):
    verticals = DATABASES if request.vertical == 'all' else [request.vertical]
    try:
        pools = {vertical:engine_for(vertical) for vertical in verticals}
    except KeyError:
        raise HTTPException(503, 'Read-only database configuration unavailable') from None
    return await asyncio.to_thread(stored_search, request, pools)


@app.get('/health')
def health():
    return {'ok':True, 'service':'read-only-directory-api'}


@app.get('/api/v1/businesses')
async def get_businesses(q: str | None = Query(None, min_length=1, max_length=200),
                         zip: str | None = Query(None, pattern=r'^\d{5}$'), vertical: Vertical = 'all',
                         category: str | None = Query(None,min_length=1,max_length=100),
                         limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0, le=10000)):
    if not (q and q.strip()) and not zip:
        raise HTTPException(422, 'Provide a name/query or five-digit ZIP')
    return await search(BusinessSearch(q=q, zip=zip, vertical=vertical, category=category, limit=limit, offset=offset))


@app.post('/api/v1/businesses/search')
async def post_businesses(request: BusinessSearch):
    return await search(request)


@app.post('/api/v1/businesses/onboarding/lookup')
async def onboarding_lookup(request: OnboardingLookup, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    try:
        pools = {vertical: engine_for(vertical) for vertical in DATABASES}
    except KeyError:
        raise HTTPException(503, 'Read-only database configuration unavailable') from None
    factories = {vertical: (lambda engine=engine: Session(engine)) for vertical, engine in pools.items()}
    return await asyncio.to_thread(resolve_with_sessions, request, factories)
