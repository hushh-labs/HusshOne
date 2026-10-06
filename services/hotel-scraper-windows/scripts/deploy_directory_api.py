"""Reviewed additive provisioning/deploy; never touches directory row contents.

Only the scraper's isolated project identity is used. Secrets stay in memory.
Build context is an explicit code whitelist, not this entire desktop workspace.
"""
import argparse
import json
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import psycopg2
from psycopg2 import sql
from app.config import google_auth_environment, settings
from app.cloud_proxy import _find_binary, _connection_name
from app.database import _fetch_password_from_secret_manager

PROJECT = 'hushh-tech-prod'
REGION = 'us-central1'
SERVICE = 'hushh-directory-api'
ACCOUNT = f'directory-api@{PROJECT}.iam.gserviceaccount.com'
SECRET = 'directory-api-db-password'
READER = 'directory_api_reader'
TABLES = {'hotel_scraper':['hotels'], 'healthcare':['providers'], 'ria':['firms','advisers'], 'insurance':['producers']}
ENV = google_auth_environment()
ROOT = Path(__file__).resolve().parents[1]


def gcloud(*args, check=True, secret_input=None):
    result = subprocess.run(['gcloud.cmd',*args,'--project='+PROJECT,'--quiet'], env=ENV,
        input=secret_input, capture_output=True, text=True, timeout=600,
        creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if check and result.returncode:
        raise RuntimeError(result.stderr[-2500:])
    return result


def provision():
    account = gcloud('auth','list','--filter=status:ACTIVE','--format=value(account)').stdout.strip()
    if account != 'husshpuppy5@gmail.com':
        raise RuntimeError('Deployment requires the dedicated husshpuppy5 identity')
    if not gcloud('iam','service-accounts','describe',ACCOUNT,check=False).returncode == 0:
        gcloud('iam','service-accounts','create','directory-api','--display-name=Read-only directory API')
    # A newly-created service account may not yet be visible to IAM bindings.
    for attempt in range(5):
        binding = gcloud('projects','add-iam-policy-binding',PROJECT,'--member=serviceAccount:'+ACCOUNT,
                         '--role=roles/cloudsql.client','--condition=None',check=False)
        if binding.returncode == 0:
            break
        if 'does not exist' not in binding.stderr or attempt == 4:
            raise RuntimeError(binding.stderr[-2500:])
        time.sleep(2 ** attempt)
    exists = gcloud('secrets','describe',SECRET,check=False).returncode == 0
    password = gcloud('secrets','versions','access','latest','--secret='+SECRET).stdout if exists else secrets.token_urlsafe(40)
    # A separate diagnostic port never takes ownership of the desktop proxy.
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1',0))
        port = reservation.getsockname()[1]
    binary = _find_binary()
    if not binary:
        raise RuntimeError('Cloud SQL proxy binary unavailable')
    process = subprocess.Popen([binary,'--gcloud-auth','--address=127.0.0.1',f'--port={port}',_connection_name()],
        env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    try:
        for _ in range(50):
            try:
                with socket.create_connection(('127.0.0.1',port),timeout=.3):
                    break
            except OSError:
                time.sleep(.2)
        admin_password = settings.DB_PASSWORD or _fetch_password_from_secret_manager()
        connection_args = dict(host='127.0.0.1',port=port,user=settings.DB_USER,password=admin_password,
            connect_timeout=8,options='-c statement_timeout=10000 -c lock_timeout=2000')
        with psycopg2.connect(dbname='hotel_scraper',**connection_args) as db:
            with db.cursor() as cursor:
                cursor.execute('SELECT rolcreaterole FROM pg_roles WHERE rolname=current_user')
                if not cursor.fetchone()[0]:
                    raise RuntimeError('Database administrator intervention required: cannot create reader role')
                cursor.execute('SELECT rolsuper,rolcreaterole,rolcreatedb,rolinherit,rolbypassrls FROM pg_roles WHERE rolname=%s',(READER,))
                role = cursor.fetchone()
                if role and (not exists or any(role)):
                    raise RuntimeError('Existing reader role/secret requires administrator review; not overwritten')
                if not exists:
                    gcloud('secrets','create',SECRET,'--replication-policy=automatic')
                    gcloud('secrets','versions','add',SECRET,'--data-file=-',secret_input=password)
                if not role:
                    cursor.execute(sql.SQL('CREATE ROLE {} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %s').format(sql.Identifier(READER)),(password,))
                for database in TABLES:
                    cursor.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO {}').format(sql.Identifier(database),sql.Identifier(READER)))
        for database, tables in TABLES.items():
            with psycopg2.connect(dbname=database,**connection_args) as db:
                with db.cursor() as cursor:
                    cursor.execute(sql.SQL('GRANT USAGE ON SCHEMA public TO {}').format(sql.Identifier(READER)))
                    for table in tables:
                        cursor.execute(sql.SQL('GRANT SELECT ON TABLE public.{} TO {}').format(sql.Identifier(table),sql.Identifier(READER)))
            # Authenticate with the reader and prove no canonical write grants.
            reader_args = {**connection_args,'user':READER,'password':password}
            with psycopg2.connect(dbname=database,**reader_args) as db:
                with db.cursor() as cursor:
                    for table in tables:
                        cursor.execute("SELECT has_table_privilege(current_user,%s,'SELECT'),has_table_privilege(current_user,%s,'INSERT,UPDATE,DELETE,TRUNCATE')",('public.'+table,'public.'+table))
                        if cursor.fetchone() != (True,False):
                            raise RuntimeError('Reader privilege check failed; deployment blocked')
        gcloud('secrets','add-iam-policy-binding',SECRET,'--member=serviceAccount:'+ACCOUNT,'--role=roles/secretmanager.secretAccessor')
    finally:
        process.terminate()
        process.wait(timeout=10)
    print('Reader role, per-table SELECT grants and secret access verified',flush=True)


def deploy():
    repository = 'directory-api'
    if gcloud('artifacts','repositories','describe',repository,'--location='+REGION,check=False).returncode:
        gcloud('artifacts','repositories','create',repository,'--location='+REGION,'--repository-format=docker')
    image = f'{REGION}-docker.pkg.dev/{PROJECT}/{repository}/api:'+str(int(time.time()))
    build_root = Path(tempfile.mkdtemp(prefix='husshone-api-build-'))
    shutil.copytree(ROOT/'cloud_api',build_root/'cloud_api',ignore=shutil.ignore_patterns('__pycache__'))
    (build_root/'app').mkdir()
    for filename in ('business_lookup.py','config.py','database.py','models.py'):
        shutil.copyfile(ROOT/'app'/filename,build_root/'app'/filename)
    shutil.copyfile(ROOT/'cloud_api'/'Dockerfile',build_root/'Dockerfile')
    print('Submitting isolated read-only API build',flush=True)
    gcloud('builds','submit',str(build_root),'--tag='+image)
    gcloud('run','deploy',SERVICE,'--image='+image,'--region='+REGION,'--service-account='+ACCOUNT,
        '--add-cloudsql-instances='+_connection_name(),
        '--set-env-vars=SQL_USER='+READER+',SQL_INSTANCE='+_connection_name(),
        '--set-secrets=SQL_PASSWORD='+SECRET+':latest','--no-allow-unauthenticated',
        '--min-instances=0','--max-instances=2','--concurrency=8','--timeout=30','--memory=512Mi','--cpu=1')
    gcloud('run','services','add-iam-policy-binding',SERVICE,'--region='+REGION,
        '--member=domain:hushh.ai','--role=roles/run.invoker')
    print(gcloud('run','services','describe',SERVICE,'--region='+REGION,'--format=value(status.url)').stdout.strip(),flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action',choices=['provision','deploy'])
    args = parser.parse_args()
    if args.action == 'provision':
        provision()
    else:
        deploy()
