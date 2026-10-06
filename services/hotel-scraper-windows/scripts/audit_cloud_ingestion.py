"""Read-only ingestion evidence. Never starts/stops the desktop-owned proxy."""
import json
import socket
import subprocess
import time
import psycopg2
from psycopg2 import sql
from app.config import settings, google_auth_environment
from app.database import _fetch_password_from_secret_manager
from app.cloud_proxy import _find_binary, _connection_name

TABLES = {'hotel_scraper':['hotels'], 'healthcare':['providers'], 'ria':['firms','advisers'], 'insurance':['producers']}


def audit():
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1',0))
        port = reserve.getsockname()[1]
    binary = _find_binary()
    if not binary:
        raise RuntimeError('Diagnostic proxy unavailable')
    process = subprocess.Popen([binary,'--gcloud-auth','--address=127.0.0.1',f'--port={port}',_connection_name()],
        env=google_auth_environment(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    output = {}
    try:
        for _ in range(50):
            try:
                with socket.create_connection(('127.0.0.1',port),timeout=.3):
                    break
            except OSError:
                time.sleep(.2)
        password = settings.DB_PASSWORD or _fetch_password_from_secret_manager()
        for database, tables in TABLES.items():
            result = {'tables':{}}
            output[database] = result
            try:
                with psycopg2.connect(host='127.0.0.1',port=port,user=settings.DB_USER,password=password,
                        dbname=database,connect_timeout=8,
                        options='-c default_transaction_read_only=on -c statement_timeout=20000 -c lock_timeout=1000') as db:
                    for table in tables:
                        try:
                            with db.cursor() as cursor:
                                cursor.execute(sql.SQL('SELECT count(*),max(first_seen),max(last_seen),count(*) FILTER (WHERE first_seen >= now()-interval \'1 hour\'),count(*) FILTER (WHERE last_seen >= now()-interval \'1 hour\') FROM public.{}').format(sql.Identifier(table)))
                                values = cursor.fetchone()
                                result['tables'][table] = dict(zip(('rows','latest_new_row','latest_seen','new_last_hour','seen_last_hour'),values))
                                cursor.execute('SELECT n_tup_ins,n_tup_upd FROM pg_stat_user_tables WHERE schemaname=%s AND relname=%s',('public',table))
                                result['tables'][table]['write_counters'] = cursor.fetchone()
                        except psycopg2.Error as exc:
                            db.rollback()
                            result['tables'][table] = {'error_type':type(exc).__name__}
                    with db.cursor() as cursor:
                        cursor.execute('SELECT now()')
                        result['database_time'] = cursor.fetchone()[0]
                        if database in ('healthcare','ria'):
                            cursor.execute('SELECT kind,started_at,finished_at,rows_seen,rows_upserted,ok FROM public.ingest_runs ORDER BY started_at DESC LIMIT 3')
                            result['recent_ingest_runs'] = cursor.fetchall()
                        elif database == 'insurance':
                            cursor.execute('SELECT state,status,producers_upserted,last_run_started_at,last_run_finished_at,last_error IS NOT NULL AS has_error FROM public.state_progress ORDER BY state')
                            result['states'] = cursor.fetchall()
            except psycopg2.Error as exc:
                result['error_type'] = type(exc).__name__
            print(json.dumps({database:result},default=str),flush=True)
        return output
    finally:
        process.terminate()
        process.wait(timeout=10)


if __name__ == '__main__':
    audit()
