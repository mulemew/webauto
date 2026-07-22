"""camoufox-proxy — a tiny launcher sidecar for the Camoufox anti-detect browser.

This is a SEPARATE provider. It does NOT touch the SeleniumBase cf-proxy at all.

Camoufox is a patched Firefox whose fingerprint (canvas/WebGL/screen/UA/…) is injected
at the C++/engine level — internally consistent, no headless GPU needed. It speaks the
Playwright protocol, so instead of re-implementing a whole session HTTP API we just
launch a Camoufox *Playwright server* per session with the requested fingerprint/proxy
and hand the api-server its ws:// endpoint. The api-server then drives it with native
playwright-core (firefox.connect) through its existing PageAdapter — no new endpoints.

Endpoints:
  GET  /health                      -> {ok}
  POST /launch  {os,screen,locale,timezone,humanize,proxy} -> {id, ws}
  POST /release {id}                -> {ok}
"""
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid

from flask import Flask, jsonify, request

app = Flask(__name__)
PORT = int(os.getenv("PORT", "7318"))

# id -> {proc, ws}
_servers = {}
_lock = threading.Lock()

# The child runs Camoufox's Playwright server and prints its ws endpoint on stdout.
# Config is passed as a JSON blob via env so we never have to shell-quote it.
_LAUNCHER = (
    "import json,os;"
    "from camoufox.server import launch_server;"
    "cfg=json.loads(os.environ['CAMOUFOX_CFG']);"
    "launch_server(**cfg)"
)

_WS_RE = re.compile(r"(ws://[^\s]+)")


def _build_options(body: dict) -> dict:
    """Map the api-server's fingerprint/proxy config to Camoufox launch options."""
    opts: dict = {
        # "virtual" runs headful on a virtual display (Xvfb) — headless is detectable.
        "headless": os.getenv("CAMOUFOX_HEADLESS", "virtual"),
        # Camoufox rotates a realistic, internally-consistent fingerprint for the OS.
        "geoip": True,
        "humanize": bool(body.get("humanize", True)),
    }
    _os = (body.get("os") or "").strip().lower()
    if _os in ("windows", "macos", "mac", "linux"):
        opts["os"] = "macos" if _os == "mac" else _os
    scr = body.get("screen")
    if isinstance(scr, str) and "x" in scr:
        try:
            w, h = scr.lower().split("x", 1)
            opts["screen"] = {"width": int(w), "height": int(h)}
        except Exception:
            pass
    if body.get("locale"):
        opts["locale"] = body["locale"]
    proxy = body.get("proxy")
    if isinstance(proxy, dict) and proxy.get("server"):
        p = {"server": proxy["server"]}
        if proxy.get("username"):
            p["username"] = proxy["username"]
        if proxy.get("password"):
            p["password"] = proxy["password"]
        opts["proxy"] = p
    return opts


@app.get("/health")
def health():
    return jsonify({"ok": True, "sessions": len(_servers)})


@app.post("/launch")
def launch():
    body = request.get_json(silent=True) or {}
    opts = _build_options(body)
    env = dict(os.environ)
    env["CAMOUFOX_CFG"] = json.dumps(opts)
    proc = subprocess.Popen(
        [sys.executable, "-c", _LAUNCHER],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    # Read stdout until the ws endpoint appears (or the child dies / times out).
    ws = None
    deadline = time.time() + int(os.getenv("CAMOUFOX_LAUNCH_TIMEOUT", "120"))
    tail = []
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                break
            continue
        tail.append(line.rstrip())
        tail[:] = tail[-40:]
        m = _WS_RE.search(line)
        if m:
            ws = m.group(1)
            break
    if not ws:
        try:
            proc.kill()
        except Exception:
            pass
        return jsonify({"error": "Camoufox server did not report a ws endpoint\n" + "\n".join(tail)}), 500
    sid = str(uuid.uuid4())
    with _lock:
        _servers[sid] = {"proc": proc, "ws": ws}
    # Drain the child's remaining stdout in the background so it never blocks on a full pipe.
    threading.Thread(target=_drain, args=(proc,), daemon=True).start()
    print(f"[camoufox] launched {sid} ws={ws} os={opts.get('os')}", flush=True)
    return jsonify({"id": sid, "ws": ws})


def _drain(proc):
    try:
        for _ in proc.stdout:
            pass
    except Exception:
        pass


@app.post("/release")
def release():
    body = request.get_json(silent=True) or {}
    sid = body.get("id")
    with _lock:
        entry = _servers.pop(sid, None)
    if entry:
        try:
            entry["proc"].send_signal(signal.SIGTERM)
            try:
                entry["proc"].wait(timeout=8)
            except Exception:
                entry["proc"].kill()
        except Exception:
            pass
        print(f"[camoufox] released {sid}", flush=True)
    return jsonify({"ok": True})


if __name__ == "__main__":
    print(f"camoufox-proxy starting on :{PORT}", flush=True)
    from waitress import serve
    serve(app, host="0.0.0.0", port=PORT, threads=16)
