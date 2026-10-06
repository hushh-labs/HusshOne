"""One real ZIP/category canary using an isolated proxy and browser profile.

Dry-run by default. --write commits validated real business records through the
same schema-guarded durable outbox writer, never the existing four tables.
"""
import argparse
import json
import socket
import subprocess
import time
from pathlib import Path
from sqlalchemy import create_engine,text
from sqlalchemy.engine import URL
from app.config import settings,google_auth_environment,runtime_state_dir
from app.cloud_proxy import _find_binary,_connection_name
from app.database import _fetch_password_from_secret_manager
from app.chrome_scraper import _BrowserProcess
from app.general_business import BusinessBatch,enqueue,flush_one
from app.general_discovery import normalise


def canary(write=False):
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1',0));port=reserve.getsockname()[1]
    proxy=subprocess.Popen([_find_binary(),'--gcloud-auth','--address=127.0.0.1',f'--port={port}',_connection_name()],
        env=google_auth_environment(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    browser=_BrowserProcess(str(Path(runtime_state_dir())/'general-canary-chrome'))
    engines=[]
    try:
        for _ in range(50):
            try:
                with socket.create_connection(('127.0.0.1',port),timeout=.3):break
            except OSError:time.sleep(.2)
        password=settings.DB_PASSWORD or _fetch_password_from_secret_manager()
        def engine(name):
            value=create_engine(URL.create('postgresql+psycopg2',username=settings.DB_USER,password=password,
                host='127.0.0.1',port=port,database=name),connect_args={'options':'-c statement_timeout=30000 -c lock_timeout=2000'})
            engines.append(value);return value
        with engine('hotel_scraper').connect() as connection:
            area=dict(connection.execute(text("SELECT zip,city,state,lat,lng FROM public.zips WHERE zip='98033'")).mappings().one())
        result=browser.scrape(area['city'],area['state'],'98033',10,'restaurants')
        job=('98033','restaurants',json.dumps(area),0)
        records=[];rejected=0
        for record in result.records:
            try:records.append(normalise(record,job))
            except (ValueError,TypeError):rejected+=1
        print(json.dumps({'scrape_status':result.status.value,'found':len(result.records),'validated':len(records),'rejected':rejected,'write_requested':write}),flush=True)
        if write and records:
            run_id=enqueue(BusinessBatch(records=records))
            target=engine('business_directory')
            for _ in range(100):
                if not flush_one(target):break
            with target.connect() as connection:
                count=connection.execute(text("SELECT count(*) FROM public.businesses WHERE raw->>'run_id'=:run_id"),{'run_id':run_id}).scalar()
            print(json.dumps({'run_id':run_id,'verified_cloud_rows':count}),flush=True)
    finally:
        browser.close()
        for value in engines:value.dispose()
        proxy.terminate();proxy.wait(timeout=10)


if __name__=='__main__':
    from multiprocessing import freeze_support
    freeze_support()
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write',action='store_true')
    canary(parser.parse_args().write)
