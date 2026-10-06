import os
import sys
import shutil
import subprocess
import re
from pathlib import Path
import PyInstaller.__main__

def build():
    print("==================================================")
    print("Building HusshOne-Hotel-Scraper Windows Executable")
    print("==================================================")

    base_dir = os.path.dirname(os.path.abspath(__file__))
    version = (Path(base_dir) / "VERSION").read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise RuntimeError("VERSION must use major.minor.patch, e.g. 1.0.1")
    dist_dir = os.path.join(base_dir, "releases", f"v{version}")
    build_dir = os.path.join(base_dir, "build", f"v{version}")
    if os.path.exists(dist_dir):
        raise RuntimeError(f"Release v{version} already exists. Bump VERSION before building.")
    spec_file = os.path.join(base_dir, "husshone_hotel_scraper.spec")
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        raise RuntimeError("Node.js/npm are required to package the imported directory workers")
    subprocess.run([npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
                   cwd=os.path.join(base_dir, "app", "vm_sources"), check=True)

    args = [
        spec_file,
        "--clean",
        "--noconfirm",
        "--distpath", dist_dir,
        "--workpath", build_dir,
    ]

    print(f"Running PyInstaller with spec: {spec_file}...")
    PyInstaller.__main__.run(args)

    exe_path = os.path.join(dist_dir, "HusshOne-Hotel-Scraper", "HusshOne-Hotel-Scraper.exe")
    if os.path.exists(exe_path):
        print("\n==================================================")
        print("BUILD SUCCESSFUL!")
        print(f"Executable Location:")
        print(f"-> {exe_path}")
        print("==================================================")
    else:
        raise RuntimeError(f"Build did not produce the expected executable: {exe_path}")

if __name__ == "__main__":
    build()
