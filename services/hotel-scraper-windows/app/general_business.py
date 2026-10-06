"""Durable, bounded general-business intake; never writes the four native directories."""
import asyncio
from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import uuid
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field, HttpUrl, model_validator
from sqlalchemy import inspect, text
from app.config import runtime_state_dir, settings

router = APIRouter(prefix='/api/general-businesses', tags=['General business intake'])


class BusinessRecord(BaseModel):
    source: str = Field(pattern=r'^[a-z][a-z0-9_-]{1,39}$')
    source_key: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=500)
    category: str = Field(min_length=1, max_length=100)
    source_url: HttpUrl
    formatted_address: str | None = Field(None, max_length=1000)
    zip: str | None = Field(None, pattern=r'^\d{5}$')
    state: str | None = Field(None, pattern=r'^[A-Z]{2}$')
    lat: float | None = Field(None, ge=-90, le=90, allow_inf_nan=False)
    lng: float | None = Field(None, ge=-180, le=180, allow_inf_nan=False)
    phone: str | None = Field(None, max_length=100)
    website: HttpUrl | None = None
    query_zip: str | None = Field(None,pattern=r'^\d{5}$')
    evidence: dict | None = None

    @model_validator(mode='after')
    def clean(self):
        for field in ('name','category','source_key'):
            setattr(self, field, getattr(self, field).strip())
            if not getattr(self, field):
                raise ValueError('Identity, name and category must not be blank')
        if (self.lat is None) != (self.lng is None):
            raise ValueError('Coordinates must be supplied together')
        return self


class BusinessBatch(BaseModel):
    records: list[BusinessRecord] = Field(min_length=1, max_length=200)


@contextmanager
def queue_db():
    db = sqlite3.connect(Path(runtime_state_dir())/'general_business_outbox.sqlite3', timeout=10)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=FULL')
    db.execute('CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,error TEXT)')
    db.execute('CREATE TABLE IF NOT EXISTS controls(id INTEGER PRIMARY KEY,enabled INTEGER NOT NULL)')
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def enqueue(batch):
    run_id = uuid.uuid4().hex
    with queue_db() as db:
        db.execute('INSERT INTO batches VALUES(?,?,?,NULL)', (run_id, batch.model_dump_json(), 'pending'))
    return run_id


def enabled(value=None):
    with queue_db() as db:
        if value is not None:
            db.execute('INSERT OR REPLACE INTO controls VALUES(1,?)',(int(value),))
        row = db.execute('SELECT enabled FROM controls WHERE id=1').fetchone()
        return bool(row and row[0])


UPSERT = '''INSERT INTO public.businesses
 (source,source_key,name,category,source_url,formatted_address,zip,state,lat,lng,phone,website,raw)
 SELECT source,source_key,name,category,source_url,formatted_address,zip,state,lat,lng,phone,website,raw
 FROM jsonb_to_recordset(CAST(:payload AS jsonb)) AS r(source text,source_key text,name text,category text,
 source_url text,formatted_address text,zip text,state text,lat double precision,lng double precision,
 phone text,website text,raw jsonb)
 ON CONFLICT(source,source_key) DO UPDATE SET
 formatted_address=COALESCE(NULLIF(businesses.formatted_address,''),EXCLUDED.formatted_address),
 zip=COALESCE(businesses.zip,EXCLUDED.zip),state=COALESCE(businesses.state,EXCLUDED.state),
 lat=COALESCE(businesses.lat,EXCLUDED.lat),lng=COALESCE(businesses.lng,EXCLUDED.lng),
 phone=COALESCE(NULLIF(businesses.phone,''),EXCLUDED.phone),
 website=COALESCE(NULLIF(businesses.website,''),EXCLUDED.website),
 raw=businesses.raw || EXCLUDED.raw,last_seen=now()
 RETURNING id'''


def flush_one(engine=None):
    with queue_db() as db:
        row = db.execute("SELECT id,payload FROM batches WHERE status='pending' ORDER BY rowid LIMIT 1").fetchone()
    if not row:
        return False
    from app.directory_fleet import registry_engine
    engine = engine if engine is not None else registry_engine('business')
    with engine.connect() as connection:
        columns = {c['name']:c for c in inspect(connection).get_columns('businesses',schema='public')}
        required = {'id','source','source_key','name','category','source_url','formatted_address',
                    'zip','state','lat','lng','phone','website','raw','first_seen','last_seen'}
        if set(columns) != required:
            raise RuntimeError('General-business schema mismatch; writes blocked')
        expected_types={name:'TEXT' for name in required}
        expected_types.update(id='BIGINT',lat='DOUBLE PRECISION',lng='DOUBLE PRECISION',raw='JSONB',
                              first_seen='TIMESTAMP',last_seen='TIMESTAMP')
        if any(str(columns[name]['type']).split('(')[0]!=kind for name,kind in expected_types.items()):
            raise RuntimeError('General-business column types mismatch; writes blocked')
        unique = inspect(connection).get_unique_constraints('businesses',schema='public')
        if not any(c['column_names']==['source','source_key'] for c in unique):
            raise RuntimeError('General-business identity constraint missing')
    run_id, payload = row
    batch = BusinessBatch.model_validate_json(payload)
    collected = datetime.now(timezone.utc).isoformat()
    # Split at repeated identity, preserving input order and avoiding PostgreSQL's
    # 'cannot affect row a second time' error. All segments share one transaction.
    segments, segment, keys = [], [], set()
    for record in batch.records:
        item = record.model_dump(mode='json')
        evidence=item.pop('evidence',None)
        query_zip=item.pop('query_zip',None)
        key = (item['source'],item['source_key'])
        if key in keys:
            segments.append(segment); segment=[]; keys=set()
        keys.add(key)
        item['raw']={'scraped_via':item['source'],'run_id':run_id,'collected_at':collected,
                     'source_url':item['source_url'],'ownership_verified':False}
        if query_zip:
            item['raw']['query_zip']=query_zip
        if evidence:
            item['raw']['website_enrichment']=evidence
        if item['source']=='osm':
            item['raw']['license']='ODbL-1.0'
        segment.append(item)
    if segment:
        segments.append(segment)
    with engine.begin() as connection:
        locked = connection.execute(text("SELECT pg_try_advisory_xact_lock(hashtext('husshone-general-business'))")).scalar()
        if not locked:
            return False
        for segment in segments:
            result=connection.execute(text(UPSERT),{'payload':json.dumps(segment)}).fetchall()
            if len(result)!=len(segment):
                raise RuntimeError('Business batch acknowledgement mismatch')
    # Crash between commit and acknowledgement safely replays idempotent upserts.
    with queue_db() as db:
        db.execute("UPDATE batches SET status='written',error=NULL WHERE id=?",(run_id,))
    return True


class GeneralWorker:
    def __init__(self):
        self.task = None
        self.state = 'stopped'
        self.error_type = None

    async def start(self):
        await asyncio.to_thread(enabled, True)
        if not self.task or self.task.done():
            self.task=asyncio.create_task(self.run())

    async def pause(self, remember=True):
        prior=await asyncio.to_thread(enabled)
        await asyncio.to_thread(enabled, False)
        # Never cancel an in-flight thread/transaction. It finishes before exit.
        if self.task:
            await self.task
        if not remember and prior:
            await asyncio.to_thread(enabled,True)
        self.state='paused'

    async def run(self):
        from app.general_discovery import discovery
        await discovery.start()
        try:
            await self.write_loop()
        finally:
            await discovery.stop()

    async def write_loop(self):
        from app.general_discovery import discovery
        while await asyncio.to_thread(enabled):
            try:
                await discovery.start()
                self.state='running'
                worked=await asyncio.to_thread(flush_one)
                self.error_type=None
                if not worked:
                    self.state='waiting_for_data'
                await asyncio.sleep(.1 if worked else 2)
            except Exception as exc:
                self.state='retrying'
                self.error_type=type(exc).__name__
                await asyncio.sleep(5)

    def status(self):
        with queue_db() as db:
            counts=dict(db.execute('SELECT status,count(*) FROM batches GROUP BY status'))
            written=db.execute("SELECT COALESCE(sum(json_array_length(payload,'$.records')),0) FROM batches WHERE status='written'").fetchone()[0]
        from app.general_discovery import discovery
        discovery_status=discovery.status()
        state=self.state
        if self.state=='waiting_for_data':
            state={'discovering':'running','backoff':'backoff','retrying':'retrying','blocked':'degraded',
                   'daily_cap':'daily_cap','waiting_for_refresh':'waiting_for_refresh'}.get(discovery_status['state'],self.state)
        return {'state':state,'error_type':self.error_type,'database':'business_directory','source':'Local Maps + verified websites + OSM extract intake',
                'discovery':discovery_status,
                'progress':{'pending_batches':counts.get('pending',0),'written_batches':counts.get('written',0),'rowsUpserted':written},
                'desired_running':enabled()}


general_worker = GeneralWorker()


@router.post('/batches',status_code=202)
async def submit_batch(batch: BusinessBatch, request: Request):
    from app.directory_fleet import require_local_control
    require_local_control(request)
    run_id=await asyncio.to_thread(enqueue,batch)
    return {'status':'durably_queued','run_id':run_id,'count':len(batch.records),
            'message':'Queued locally; written only after database validation and successful commit'}
