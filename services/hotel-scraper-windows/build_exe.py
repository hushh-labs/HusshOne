import os
import sys
import shutil
import PyInstaller.__main__

def build():
    print("==================================================")
    print("Building HusshOne-Hotel-Scraper Windows Executable")
    print("==================================================")

    base_dir = os.path.dirname(os.path.abspath(__file__))
    dist_dir = os.path.join(base_dir, "dist")
    build_dir = os.path.join(base_dir, "build")
    spec_file = os.path.join(base_dir, "husshone_hotel_scraper.spec")

    args = [
        spec_file,
        "--clean",
        "--noconfirm",
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
        print("\nBuild completed. Check dist/ folder.")

if __name__ == "__main__":
    build()
