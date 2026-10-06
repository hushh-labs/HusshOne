"""Explicit approved additive migration. Never alters existing directory schemas."""
import socket
import subprocess
import time
from pathlib import Path
import psycopg2
from psycopg2 import sql
from scripts.deploy_directory_api import gcloud, ENV, READER
from app.config import settings
from app.cloud_proxy import _find_binary, _connection_name
from app.database import _fetch_password_from_secret_manager


def provision():
    account=gcloud('auth','list','--filter=status:ACTIVE','--format=value(account)').stdout.strip()
    if account!='husshpuppy5@gmail.com':
        raise RuntimeError('Dedicated Hush identity required')
    name='business_directory'
    instance=_connection_name().split(':')[-1]
    existing=gcloud('sql','databases','list','--instance='+instance,'--format=value(name)').stdout.splitlines()
    if name not in existing:
        gcloud('sql','databases','create',name,'--instance='+instance)
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1',0)); port=reserve.getsockname()[1]
    binary=_find_binary()
    if not binary:
        raise RuntimeError('Diagnostic proxy unavailable')
    process=subprocess.Popen([binary,'--gcloud-auth','--address=127.0.0.1',f'--port={port}',_connection_name()],
        env=ENV,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    try:
        for _ in range(50):
            try:
                with socket.create_connection(('127.0.0.1',port),timeout=.3): break
            except OSError: time.sleep(.2)
        password=settings.DB_PASSWORD or _fetch_password_from_secret_manager()
        args=dict(host='127.0.0.1',port=port,user=settings.DB_USER,password=password,connect_timeout=8,
                  options='-c statement_timeout=10000 -c lock_timeout=2000')
        with psycopg2.connect(dbname=name,**args) as db:
            with db.cursor() as cursor:
                cursor.execute("SELECT to_regclass('public.businesses')")
                if cursor.fetchone()[0] is None:
                    cursor.execute((Path(__file__).with_name('general_business_schema.sql')).read_text())
                cursor.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO {}').format(sql.Identifier(name),sql.Identifier(READER)))
                cursor.execute(sql.SQL('GRANT USAGE ON SCHEMA public TO {}').format(sql.Identifier(READER)))
                cursor.execute(sql.SQL('GRANT SELECT ON public.businesses TO {}').format(sql.Identifier(READER)))
                cursor.execute("SELECT count(*) FROM public.businesses")
                print('General-business schema ready; existing rows:',cursor.fetchone()[0],flush=True)
    finally:
        process.terminate(); process.wait(timeout=10)


if __name__=='__main__':
    provision()
