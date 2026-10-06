"""Autonomous general-business discovery with durable ZIP/category checkpoints."""
import asyncio
import json
import re
import time
from datetime import datetime
from pathlib import Path
from sqlalchemy import text
from app.config import settings, runtime_state_dir
from app.scrape_contract import ScrapeStatus, haversine_km


def categories():
    values=[x.strip() for x in settings.BUSINESS_DISCOVERY_CATEGORIES.split(',') if x.strip()]
    if not values or len(values)>30 or any(not re.fullmatch(r'[a-zA-Z][a-zA-Z -]{1,70}',v) for v in values):
        raise ValueError('Configure 1–30 plain business categories')
    return list(dict.fromkeys(values))


def state_db():
    from app.general_business import queue_db
    return queue_db()


def initialise():
    with state_db() as db:
        db.execute('CREATE TABLE IF NOT EXISTS discovery_jobs(zip TEXT,category TEXT,area TEXT,status TEXT,next_at REAL DEFAULT 0,attempts INTEGER DEFAULT 0,PRIMARY KEY(zip,category))')
        db.execute('CREATE TABLE IF NOT EXISTS discovery_control(key TEXT PRIMARY KEY,value TEXT)')
        db.execute('CREATE TABLE IF NOT EXISTS discovery_calls(day TEXT PRIMARY KEY,calls INTEGER NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS business_websites(identity TEXT PRIMARY KEY,payload TEXT,status TEXT,next_at REAL DEFAULT 0)')
        db.execute("UPDATE discovery_jobs SET status='pending' WHERE status='collecting'")
        db.execute("UPDATE business_websites SET status='pending' WHERE status='collecting'")


def seed_jobs():
    from app import database
    with state_db() as db:
        pending=db.execute("SELECT count(*) FROM discovery_jobs WHERE status IN ('pending','retry','collecting')").fetchone()[0]
        if pending>100:
            return
        marker=db.execute("SELECT value FROM discovery_control WHERE key='last_zip'").fetchone()
        marker=marker[0] if marker else ''
    session=database.get_readonly_db_session()
    try:
        rows=session.execute(text('SELECT zip,city,state,lat,lng FROM public.zips WHERE zip>:marker ORDER BY zip LIMIT 50'),{'marker':marker}).mappings().all()
        if not marker:
            canary=session.execute(text("SELECT zip,city,state,lat,lng FROM public.zips WHERE zip='98033'")).mappings().all()
            rows=list(canary)+list(rows)
    finally:
        session.close()
    if not rows:
        return
    with state_db() as db:
        for row in rows:
            for category in categories():
                db.execute("INSERT OR IGNORE INTO discovery_jobs(zip,category,area,status) VALUES(?,?,?,'pending')",
                           (row['zip'],category,json.dumps(dict(row))))
        # Canary must not skip the ZIPs between the first page and 98033.
        ordered=[r['zip'] for r in rows if r['zip']!='98033']
        if ordered:
            db.execute("INSERT OR REPLACE INTO discovery_control VALUES('last_zip',?)",(max(ordered),))


def next_job():
    with state_db() as db:
        row=db.execute("SELECT zip,category,area,attempts FROM discovery_jobs WHERE status IN ('pending','retry','done','empty','partial') AND next_at<=? ORDER BY CASE WHEN status IN ('pending','retry') THEN 0 ELSE 1 END,rowid LIMIT 1",(time.time(),)).fetchone()
        return row


def reserve_call():
    day=datetime.now().astimezone().date().isoformat()
    with state_db() as db:
        count=db.execute('SELECT calls FROM discovery_calls WHERE day=?',(day,)).fetchone()
        if settings.BUSINESS_MAPS_DAILY_CAP>0 and count and count[0]>=settings.BUSINESS_MAPS_DAILY_CAP:
            return False
        db.execute('INSERT INTO discovery_calls VALUES(?,1) ON CONFLICT(day) DO UPDATE SET calls=calls+1',(day,))
    return True


def mark(job,status,delay):
    with state_db() as db:
        db.execute('UPDATE discovery_jobs SET status=?,next_at=?,attempts=attempts+1 WHERE zip=? AND category=?',
                   (status,time.time()+delay,job[0],job[1]))


def normalise(record,job):
    from app.general_business import BusinessRecord
    area=json.loads(job[2])
    raw=record.get('raw') or {}
    cid=raw.get('google_cid')
    if not cid or not str(cid).isdigit():
        raise ValueError('Missing stable Maps CID')
    lat,lng=record.get('lat'),record.get('lng')
    # Fail closed when location cannot be validated; never guess coordinates.
    if lat is None or lng is None or haversine_km(area['lat'],area['lng'],lat,lng)>settings.BUSINESS_MAX_DISTANCE_KM:
        raise ValueError('Coordinates missing or outside search area')
    if record.get('rating') is not None and not 1<=float(record['rating'])<=5:
        raise ValueError('Rating outside accepted range')
    address=record.get('formatted_address')
    postcode=re.search(r'\b[A-Z]{2}\s+(\d{5})(?:-\d{4})?\b',address or '')
    return BusinessRecord(source='maps',source_key=str(cid),name=record.get('name'),category=job[1],
        source_url=f'https://www.google.com/maps?cid={cid}',formatted_address=address,
        zip=postcode.group(1) if postcode else None,query_zip=job[0],lat=lat,lng=lng,
        phone=record.get('phone'),website=record.get('website'))


def acknowledge(job,records,status):
    from app.general_business import BusinessBatch
    import uuid
    # Queue records and complete the job in the SAME durable SQLite transaction.
    with state_db() as db:
        if records:
            db.execute("INSERT INTO batches VALUES(?,?, 'pending',NULL)",
                       (uuid.uuid4().hex,BusinessBatch(records=records).model_dump_json()))
            for record in records:
                if record.website:
                    db.execute("INSERT OR IGNORE INTO business_websites VALUES(?,?,'pending',0)",
                               (record.source+':'+record.source_key,record.model_dump_json()))
        db.execute('UPDATE discovery_jobs SET status=?,next_at=?,attempts=0 WHERE zip=? AND category=?',
                   (status,time.time()+30*86400,job[0],job[1]))


def lease():
    from app.directory_fleet import registry_engine
    connection=registry_engine('business').connect().execution_options(isolation_level='AUTOCOMMIT')
    try:
        if not connection.execute(text("SELECT pg_try_advisory_lock(hashtext('husshone-general-discovery'))")).scalar():
            raise RuntimeError('Another general-business collector owns the lease')
        return connection
    except Exception:
        connection.close()
        raise


class Discovery:
    def __init__(self):
        self.task=None
        self.stopping=False
        self.retry_at=0
        self.progress={'state':'stopped','records_queued':0,'rejected':0}

    def status(self):
        return dict(self.progress)

    async def start(self):
        if settings.BUSINESS_DISCOVERY_ENABLED and time.monotonic()>=self.retry_at and not (self.task and not self.task.done()):
            self.stopping=False
            self.task=asyncio.create_task(self.run())

    async def stop(self):
        self.stopping=True
        if self.task:
            await asyncio.gather(self.task,return_exceptions=True)

    async def wait(self,seconds):
        end=time.monotonic()+seconds
        while not self.stopping and time.monotonic()<end:
            await asyncio.sleep(min(1,end-time.monotonic()))

    async def run(self):
        from app.chrome_scraper import _BrowserProcess
        browser=_BrowserProcess(str(Path(runtime_state_dir())/'general-business-chrome'))
        owner=None
        collectors=[]
        try:
            owner=await asyncio.to_thread(lease)
            await asyncio.to_thread(initialise)
            collectors=[asyncio.create_task(self.enrich_loop()) for _ in range(4 if settings.SCRAPER_PERFORMANCE_MODE=='throughput' else 1)]
            while not self.stopping:
                self.progress['state']='discovering'
                await asyncio.to_thread(owner.execute,text('SELECT 1'))
                await asyncio.to_thread(seed_jobs)
                job=await asyncio.to_thread(next_job)
                if not job:
                    self.progress['state']='waiting_for_refresh'
                    await self.wait(60)
                    continue
                if not await asyncio.to_thread(reserve_call):
                    self.progress['state']='daily_cap'
                    await self.wait(60)
                    continue
                await asyncio.to_thread(mark,job,'collecting',0)
                self.progress.update(zip=job[0],category=job[1])
                area=json.loads(job[2])
                try:
                    result=await asyncio.to_thread(browser.scrape,area['city'],area['state'],job[0],50,job[1])
                    if result.status==ScrapeStatus.EXPLICIT_EMPTY:
                        await asyncio.to_thread(acknowledge,job,[],'empty')
                    elif result.status!=ScrapeStatus.SUCCESS:
                        delay=min(3600,300*3**min(job[3],3))
                        await asyncio.to_thread(mark,job,'retry',delay)
                        self.progress.update(state='backoff',reason=result.status.value)
                        await self.wait(delay)
                    else:
                        records=[]
                        for source in result.records:
                            try:
                                record=normalise(source,job)
                                records.append(record)
                            except (ValueError,TypeError):
                                self.progress['rejected']+=1
                        if result.records and not records:
                            await asyncio.to_thread(mark,job,'quarantined',30*86400)
                        else:
                            await asyncio.to_thread(acknowledge,job,records,'partial' if len(result.records)>=50 else 'done')
                            self.progress['records_queued']+=len(records)
                except Exception as exc:
                    await asyncio.to_thread(mark,job,'retry',300)
                    self.progress.update(state='retrying',reason=type(exc).__name__)
                    await self.wait(30)
                await self.wait(max(3,settings.BUSINESS_MAPS_DELAY_SEC))
        except Exception as exc:
            self.progress.update(state='blocked',reason=type(exc).__name__)
            self.retry_at=time.monotonic()+60
        finally:
            self.stopping=True
            if collectors:
                await asyncio.gather(*collectors,return_exceptions=True)
            await asyncio.to_thread(browser.close)
            if owner is not None:
                # A pooled connection must not retain a session advisory lock.
                try:
                    await asyncio.to_thread(owner.execute,text("SELECT pg_advisory_unlock(hashtext('husshone-general-discovery'))"))
                except Exception:
                    pass  # Disconnection releases the session lock at PostgreSQL.
                finally:
                    await asyncio.to_thread(owner.close)

    async def enrich_loop(self):
        from app.general_business import BusinessRecord,BusinessBatch
        from app.website_enrichment import collect_website
        from app.website_backfill import fill_candidates
        from app.performance import collector_limit
        from types import SimpleNamespace
        import uuid
        while not self.stopping:
            if collector_limit()<1:
                await self.wait(5)
                continue
            def claim():
                with state_db() as db:
                    db.execute('BEGIN IMMEDIATE')
                    row=db.execute("SELECT identity,payload FROM business_websites WHERE status='pending' AND next_at<=? ORDER BY rowid LIMIT 1",(time.time(),)).fetchone()
                    if row:
                        db.execute("UPDATE business_websites SET status='collecting' WHERE identity=?",(row[0],))
                    return row
            job=await asyncio.to_thread(claim)
            if not job:
                await self.wait(2)
                continue
            try:
                record=BusinessRecord.model_validate_json(job[1])
                result=await collect_website(record.model_dump(mode='json'),timeout=60)
                record.evidence=result
                snapshot=SimpleNamespace(**record.model_dump(mode='json'))
                for field,(value,proof) in fill_candidates(snapshot,result).items():
                    setattr(record,field,value)
                record=BusinessRecord.model_validate(record.model_dump())
                def finish():
                    with state_db() as db:
                        if result.get('status')=='retry':
                            db.execute("UPDATE business_websites SET status='pending',next_at=? WHERE identity=?",(time.time()+3600,job[0]))
                        else:
                            db.execute("INSERT INTO batches VALUES(?,?, 'pending',NULL)",(uuid.uuid4().hex,BusinessBatch(records=[record]).model_dump_json()))
                            db.execute("UPDATE business_websites SET status='done' WHERE identity=?",(job[0],))
                await asyncio.to_thread(finish)
            except Exception:
                def retry():
                    with state_db() as db:
                        db.execute("UPDATE business_websites SET status='pending',next_at=? WHERE identity=?",(time.time()+3600,job[0]))
                await asyncio.to_thread(retry)


discovery=Discovery()
