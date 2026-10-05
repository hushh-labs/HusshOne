import os
import sys
import time
import socket
import threading
import multiprocessing
import webbrowser
import requests
import uvicorn
from app.config import settings
from app.runtime_logging import configure_logging, install_exception_hooks

def find_available_port(start_port=8080, max_attempts=50):
    """Finds an open port starting from start_port."""
    for port in range(start_port, start_port + max_attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return start_port

def start_backend_server(host: str, port: int):
    """Runs Uvicorn server in background thread."""
    from app.main import app
    config = uvicorn.Config(app=app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)
    server.run()

def wait_for_server(url: str, timeout_sec: float = 45.0) -> bool:
    """Polls the server until it responds to HTTP requests."""
    start_time = time.time()
    while time.time() - start_time < timeout_sec:
        try:
            resp = requests.get(f"{url}/api/status", timeout=1.0)
            if resp.status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(0.3)
    return False

def launch_pywebview(url: str):
    """Launches the app in a native desktop window using pywebview."""
    try:
        import webview
        window = webview.create_window(
            title="HusshOne Hotel Scraper & Directory Explorer",
            url=url,
            width=1280,
            height=860,
            min_size=(960, 600)
        )
        webview.start()
        return True
    except Exception as e:
        print(f"pywebview window could not be opened: {e}. Falling back to Desktop GUI...")
        return False

def launch_tkinter_gui(base_url: str):
    """Native Tkinter fallback desktop control window."""
    import tkinter as tk
    from tkinter import ttk, messagebox

    root = tk.Tk()
    root.title("HusshOne Hotel Scraper - Control Panel")
    root.geometry("640x520")
    root.configure(bg="#0f172a")

    # Header
    header_frame = tk.Frame(root, bg="#1e293b", pady=15, padx=20)
    header_frame.pack(fill="x")

    title_label = tk.Label(
        header_frame,
        text="HusshOne Hotel Scraper",
        font=("Segoe UI", 16, "bold"),
        fg="#ffffff",
        bg="#1e293b"
    )
    title_label.pack(anchor="w")

    subtitle_label = tk.Label(
        header_frame,
        text=f"Server running at {base_url} (hotel_scraper DB)",
        font=("Segoe UI", 9),
        fg="#94a3b8",
        bg="#1e293b"
    )
    subtitle_label.pack(anchor="w")

    # Status Panel
    status_frame = tk.Frame(root, bg="#0f172a", padx=20, pady=10)
    status_frame.pack(fill="x")

    status_var = tk.StringVar(value="Status: Running")
    status_lbl = tk.Label(status_frame, textvariable=status_var, font=("Segoe UI", 11, "bold"), fg="#10b981", bg="#0f172a")
    status_lbl.pack(anchor="w")

    progress_var = tk.StringVar(value="ZIP Queue: 41,485 / 41,488 completed (99.99%)")
    progress_lbl = tk.Label(status_frame, textvariable=progress_var, font=("Segoe UI", 9), fg="#cbd5e1", bg="#0f172a")
    progress_lbl.pack(anchor="w", pady=(4, 0))

    # Action Buttons Frame
    btn_frame = tk.Frame(root, bg="#0f172a", padx=20, pady=10)
    btn_frame.pack(fill="x")

    def open_browser():
        webbrowser.open(base_url)

    def trigger_start():
        try:
            requests.post(f"{base_url}/api/control/start", timeout=2)
            status_var.set("Status: Worker Running in Background")
            status_lbl.config(fg="#10b981")
        except Exception as ex:
            messagebox.showerror("Error", str(ex))

    def trigger_pause():
        try:
            requests.post(f"{base_url}/api/control/pause", timeout=2)
            status_var.set("Status: Worker Paused")
            status_lbl.config(fg="#f59e0b")
        except Exception as ex:
            messagebox.showerror("Error", str(ex))

    def trigger_stop():
        try:
            requests.post(f"{base_url}/api/control/stop", timeout=2)
            status_var.set("Status: Worker Stopped")
            status_lbl.config(fg="#ef4444")
        except Exception as ex:
            messagebox.showerror("Error", str(ex))

    def trigger_retry():
        try:
            res = requests.post(f"{base_url}/api/control/retry-failed", timeout=2)
            messagebox.showinfo("Retry", res.json().get("message", "Retry triggered"))
        except Exception as ex:
            messagebox.showerror("Error", str(ex))

    btn_browser = tk.Button(btn_frame, text="🌐 Open Full Web Dashboard", command=open_browser, bg="#059669", fg="white", font=("Segoe UI", 10, "bold"), padx=12, pady=6, relief="flat", cursor="hand2")
    btn_browser.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 8))

    btn_start = tk.Button(btn_frame, text="▶ Start Scraper", command=trigger_start, bg="#10b981", fg="white", font=("Segoe UI", 9, "bold"), padx=8, pady=4, relief="flat", cursor="hand2")
    btn_start.grid(row=1, column=0, padx=(0, 4), sticky="ew")

    btn_pause = tk.Button(btn_frame, text="⏸ Pause", command=trigger_pause, bg="#d97706", fg="white", font=("Segoe UI", 9, "bold"), padx=8, pady=4, relief="flat", cursor="hand2")
    btn_pause.grid(row=1, column=1, padx=(4, 0), sticky="ew")

    btn_stop = tk.Button(btn_frame, text="⏹ Stop", command=trigger_stop, bg="#dc2626", fg="white", font=("Segoe UI", 9, "bold"), padx=8, pady=4, relief="flat", cursor="hand2")
    btn_stop.grid(row=2, column=0, padx=(0, 4), pady=(6, 0), sticky="ew")

    btn_retry = tk.Button(btn_frame, text="🔄 Retry Failed ZIPs", command=trigger_retry, bg="#0284c7", fg="white", font=("Segoe UI", 9, "bold"), padx=8, pady=4, relief="flat", cursor="hand2")
    btn_retry.grid(row=2, column=1, padx=(4, 0), pady=(6, 0), sticky="ew")

    btn_frame.columnconfigure(0, weight=1)
    btn_frame.columnconfigure(1, weight=1)

    # Activity Log Textbox
    log_frame = tk.Frame(root, bg="#0f172a", padx=20, pady=10)
    log_frame.pack(fill="both", expand=True)

    log_label = tk.Label(log_frame, text="Recent Background Logs:", font=("Segoe UI", 9, "bold"), fg="#94a3b8", bg="#0f172a")
    log_label.pack(anchor="w", pady=(0, 4))

    log_text = tk.Text(log_frame, bg="#020617", fg="#38bdf8", font=("Consolas", 9), height=10, relief="flat", padx=8, pady=8)
    log_text.pack(fill="both", expand=True)

    def refresh_logs():
        try:
            r = requests.get(f"{base_url}/api/status", timeout=1.5)
            if r.status_code == 200:
                data = r.json()
                logs = data.get("logs", [])
                log_text.delete("1.0", tk.END)
                for entry in logs[-12:]:
                    log_text.insert(tk.END, f"[{entry.get('timestamp')}] {entry.get('message')}\n")
                log_text.see(tk.END)

                is_running = data.get("is_running", False)
                is_paused = data.get("is_paused", False)
                if is_running:
                    status_var.set("Status: Worker Running in Background" if not is_paused else "Status: Worker Paused")
                    status_lbl.config(fg="#10b981" if not is_paused else "#f59e0b")
                else:
                    status_var.set("Status: Worker Idle")
                    status_lbl.config(fg="#94a3b8")
        except Exception:
            pass
        root.after(2000, refresh_logs)

    root.after(1000, refresh_logs)
    root.mainloop()

def main():
    multiprocessing.freeze_support()
    install_exception_hooks(configure_logging())
    host = settings.HOST
    default_port = settings.PORT
    default_url = f"http://{host}:{default_port}"

    # Check CLI arguments
    use_headless_vm = "--headless" in sys.argv or "--daemon" in sys.argv
    use_browser_only = "--browser" in sys.argv
    use_tk_only = "--gui" in sys.argv

    # Check if a background server is already active on default port
    server_already_running = False
    try:
        r = requests.get(f"{default_url}/api/status", timeout=0.8)
        if r.status_code == 200:
            server_already_running = True
    except Exception:
        server_already_running = False

    if server_already_running:
        print(f"Detected existing background server active on {default_url}. Connecting to it...")
        base_url = default_url
    else:
        port = find_available_port(default_port)
        base_url = f"http://{host}:{port}"
        print(f"Starting background server on {base_url}...")
        server_thread = threading.Thread(
            target=start_backend_server,
            args=(host, port),
            daemon=True
        )
        server_thread.start()

        if not wait_for_server(base_url, timeout_sec=45.0):
            print("Warning: Backend server took longer than expected to report status.")

    if use_headless_vm:
        print(f"=== VM MODE: Running headless background scraper on {base_url} ===")
        print("Scraper is running in the background. Press Ctrl+C to terminate.")
        try:
            # Self-healing supervisor: (re)starts the worker whenever it is not running
            # (e.g. Cloud SQL was briefly unreachable at launch, or the loop exited).
            while True:
                try:
                    status = requests.get(f"{base_url}/api/status", timeout=10).json()
                    # A deliberate Stop from the UI ("Stopped") is respected; anything else is restarted.
                    if not status.get("is_running") and status.get("stats", {}).get("current_action") != "Stopped":
                        r = requests.post(f"{base_url}/api/control/start", timeout=60).json()
                        print(f"Worker start: {r.get('status')} - {r.get('message')}")
                except Exception as e:
                    print(f"Supervisor check failed: {e}")
                time.sleep(30.0)
        except KeyboardInterrupt:
            print("Stopping VM background worker...")
            try:
                requests.post(f"{base_url}/api/control/stop", timeout=3)
            except Exception:
                pass
            sys.exit(0)
    elif use_browser_only:
        print(f"Opening browser at {base_url}...")
        webbrowser.open(base_url)
        try:
            while True:
                time.sleep(1.0)
        except KeyboardInterrupt:
            print("Shutting down...")
            sys.exit(0)
    elif use_tk_only:
        launch_tkinter_gui(base_url)
    else:
        # Default: try opening native desktop window via pywebview; fallback to Tkinter GUI
        launched = launch_pywebview(base_url)
        if not launched:
            launch_tkinter_gui(base_url)

if __name__ == "__main__":
    main()
