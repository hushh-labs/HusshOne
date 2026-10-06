# -*- mode: python ; coding: utf-8 -*-

import os
import shutil
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

block_cipher = None

datas = [
    ('app/templates', 'app/templates'),
    ('app/static', 'app/static'),
    ('.env.example', '.'),
    ('app/vm_sources', 'app/vm_sources'),
]

node = os.environ.get('VM_NODE_PATH') or shutil.which('node')
unzip = os.environ.get('VM_UNZIP_PATH') or shutil.which('unzip') or 'C:/Program Files/Git/usr/bin/unzip.exe'
if not node or not Path(node).is_file() or not Path(unzip).is_file():
    raise RuntimeError('Install Node.js and Git unzip before packaging the four directory workers')
if not Path('app/vm_sources/node_modules/pg/package.json').is_file():
    raise RuntimeError('Run npm ci --ignore-scripts in app/vm_sources before packaging')
vm_binaries = [(node, 'vm_runtime'), (unzip, 'vm_runtime/unzip')]
for dependency in ('msys-2.0.dll', 'msys-bz2-1.dll'):
    path = Path(unzip).parent / dependency
    if path.is_file():
        vm_binaries.append((str(path), 'vm_runtime/unzip'))

hiddenimports = [
    'brotli',
    '_brotli',
    'uvicorn',
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespans',
    'uvicorn.lifespans.on',
    'jinja2',
    'sqlalchemy',
    'sqlalchemy.sql.default_comparator',
    'pydantic',
    'pydantic_settings',
    'requests',
    'webview',
    'clr_loader',
    'pythonnet',
    'app.zip_data',
    'app.free_scraper',
    'app.chrome_scraper',
    'app.chrome_auth',
    'app.cloud_proxy',
    'app.geohash',
    'psycopg2',
    'sqlalchemy.dialects.postgresql',
    'sqlalchemy.dialects.postgresql.psycopg2',
]

a = Analysis(
    ['desktop.py'],
    pathex=[],
    binaries=vm_binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='HusshOne-Hotel-Scraper',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='HusshOne-Hotel-Scraper',
)
