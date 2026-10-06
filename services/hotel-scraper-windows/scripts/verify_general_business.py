"""Rollback-only production canary for the new table and SELECT-only reader."""
import json
import socket
import subprocess
import time
import psycopg2
from sqlalchemy import create_engine, inspect
from sqlalchemy.engine import URL
from app.general_business import UPSERT
from scripts.deploy_directory_api import ENV, READER
from app.cloud_proxy import _find_binary, _connection_name
from app.config import settings
from app.database import _fetch_password_from_secret_manager


def verify():
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1',0));port=reserve.getsockname()[1]
    process=subprocess.Popen([_find_binary(),'--gcloud-auth','--address=127.0.0.1',f'--port={port}',_connection_name()],
        env=ENV,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    try:
        for _ in range(50):
            try:
                with socket.create_connection(('127.0.0.1',port),timeout=.3):break
            except OSError:time.sleep(.2)
        password=settings.DB_PASSWORD or _fetch_password_from_secret_manager()
        engine=create_engine(URL.create('postgresql+psycopg2',username=settings.DB_USER,password=password,
            host='127.0.0.1',port=port,database='business_directory'),connect_args={
            'options':'-c statement_timeout=10000 -c lock_timeout=2000'})
        from sqlalchemy import text
        with engine.connect() as connection:
            transaction=connection.begin()
            try:
                before=connection.execute(text('SELECT count(*) FROM public.businesses')).scalar()
                fixture=dict(source='rollback_canary',source_key='never_persisted',name='Rollback canary',category='test',
                             source_url='https://example.invalid',phone='original',raw={})
                assert len(connection.execute(text(UPSERT),{'payload':json.dumps([fixture])}).fetchall())==1
                fixture['phone']='replacement'
                connection.execute(text(UPSERT),{'payload':json.dumps([fixture])})
                assert connection.execute(text("SELECT phone FROM public.businesses WHERE source='rollback_canary'")).scalar()=='original'
                types={c['name']:str(c['type']) for c in inspect(connection).get_columns('businesses',schema='public')}
                permissions=connection.execute(text("SELECT has_table_privilege(:role,'public.businesses','SELECT'),has_table_privilege(:role,'public.businesses','INSERT,UPDATE,DELETE,TRUNCATE')"),{'role':READER}).one()
                assert tuple(permissions)==(True,False)
            finally:
                transaction.rollback()
            assert connection.execute(text('SELECT count(*) FROM public.businesses')).scalar()==before
        engine.dispose()
        print('Canary rolled back; original values preserved; SELECT-only reader verified; column types:',types)
    finally:
        process.terminate();process.wait(timeout=10)


if __name__=='__main__':verify()
