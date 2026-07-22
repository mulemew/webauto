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

# launcher.py runs Camoufox's Playwright server and prints its ws endpoint on stdout.
# Config is passed as a JSON blob via env so we never have to shell-quote it, and the
# launcher (which can import camoufox) turns screen dict -> Screen object.
_LAUNCHER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "launcher.py")

_WS_RE = re.compile(r"(ws://[^\s]+)")


def _build_options(body: dict) -> dict:
    """Map the api-server's fingerprint/proxy config to Camoufox launch options."""
    # CAMOUFOX_HEADLESS controls headful vs headless. IMPORTANT: launch_server() forwards
    # `headless` straight to the browser process, which accepts a BOOL only — the string
    # "virtual" (valid on the Camoufox() context-manager, not here) makes the child exit
    # with "headless: expected boolean, got string". This container already runs its own
    # Xvfb :99 (DISPLAY=:99), so headless=False = a real, fully-rendered headful browser
    # on that display — no need for Camoufox's own virtual-display mode.
    #   "true"/"1"/"yes"/"on"      → True  (real headless, more detectable)
    #   anything else (default,     → False (headful on Xvfb :99 — the intended mode)
    #    incl. "false"/"virtual")
    _h = os.getenv("CAMOUFOX_HEADLESS", "false").strip().lower()
    _headless: bool = _h in ("true", "1", "yes", "on")
    opts: dict = {
        "headless": _headless,
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
    # FIXED fingerprint from a saved profile (from /generate): a pickled browserforge
    # Fingerprint (exact reproduction) OR a real preset dict. launcher.py turns these
    # into launch_server's fingerprint= / fingerprint_preset=. If neither is present,
    # Camoufox generates a fresh consistent one from `os`.
    fp = body.get("fingerprint") or {}
    if isinstance(fp, dict):
        if fp.get("fp"):
            opts["_fp_pickle"] = fp["fp"]
        elif fp.get("preset"):
            opts["_preset"] = fp["preset"]
        if not opts.get("os") and fp.get("os"):
            _fos = str(fp["os"]).strip().lower()
            if _fos in ("windows", "macos", "mac", "linux"):
                opts["os"] = "macos" if _fos == "mac" else _fos
    return opts


@app.get("/health")
def health():
    return jsonify({"ok": True, "sessions": len(_servers)})


def _g(obj, *names):
    for n in names:
        v = getattr(obj, n, None) if obj is not None else None
        if v is not None:
            return v
    return None


def _summ_from_fp(fp, os_name: str) -> dict:
    nav = getattr(fp, "navigator", None)
    scr = getattr(fp, "screen", None)
    vc = getattr(fp, "videoCard", None) or getattr(fp, "video_card", None)
    w, h = _g(scr, "width"), _g(scr, "height")
    return {
        "source": "browserforge",
        "os": "mac" if os_name == "macos" else os_name,
        "userAgent": _g(nav, "userAgent", "user_agent") or "",
        "platform": _g(nav, "platform") or "",
        "languages": _g(nav, "languages") or [],
        "screen": f"{w}x{h}" if w and h else "",
        "webglVendor": (_g(vc, "vendor") or "") if vc is not None else "",
        "webglRenderer": (_g(vc, "renderer") or "") if vc is not None else "",
        "hardwareConcurrency": _g(nav, "hardwareConcurrency", "hardware_concurrency"),
        "deviceMemory": _g(nav, "deviceMemory", "device_memory"),
    }


def _summ_from_preset(preset: dict, os_name: str) -> dict:
    # Preset dict shape isn't documented; pull common keys best-effort for display only.
    def pick(*keys):
        for k in keys:
            if isinstance(preset, dict) and preset.get(k):
                return preset[k]
        return ""
    return {
        "source": "preset",
        "os": "mac" if os_name == "macos" else os_name,
        "userAgent": pick("navigator.userAgent", "userAgent", "navigator:userAgent"),
        "screen": pick("screen", "screen.width") and str(pick("screen", "screen.width")) or "",
        "webglVendor": pick("webGl:vendor", "webGl.vendor", "webglVendor"),
        "webglRenderer": pick("webGl:renderer", "webGl.renderer", "webglRenderer"),
    }


@app.get("/generate")
def generate():
    """Generate ONE concrete, consistent fingerprint the user saves as a FIXED profile.
    source=browserforge (synthetic, from browserforge's real-world dataset) or
    source=preset (a REAL captured device preset). Returns { config, summary }: save
    `config` verbatim into the profile and POST it back as `fingerprint` on /launch;
    `summary` is human-readable for the UI. Never randomly hand-assign values — both
    sources are authentic + internally consistent (WAFs hash the WebGL fingerprint)."""
    os_name = (request.args.get("os") or "windows").strip().lower()
    if os_name == "mac":
        os_name = "macos"
    if os_name not in ("windows", "macos", "linux"):
        os_name = "windows"
    source = (request.args.get("source") or "browserforge").strip().lower()
    try:
        if source == "preset":
            from camoufox.fingerprints import get_random_preset
            preset = get_random_preset(os=os_name)
            if not preset:
                return jsonify({"error": f"no bundled preset available for os={os_name}"}), 404
            summary = _summ_from_preset(preset, os_name)
            return jsonify({"config": {"source": "preset", "os": os_name, "preset": preset, "summary": summary}, "summary": summary})
        # default: browserforge synthetic — pickle the Fingerprint so /launch reproduces it EXACTLY
        from browserforge.fingerprints import FingerprintGenerator
        import base64
        import pickle
        fp = FingerprintGenerator().generate(os=os_name)
        summary = _summ_from_fp(fp, os_name)
        fp_b64 = base64.b64encode(pickle.dumps(fp)).decode("ascii")
        return jsonify({"config": {"source": "browserforge", "os": os_name, "fp": fp_b64, "summary": summary}, "summary": summary})
    except Exception as e:
        import traceback
        return jsonify({"error": f"fingerprint generate failed ({source}): {e}\n{traceback.format_exc()}"}), 500


@app.post("/launch")
def launch():
    body = request.get_json(silent=True) or {}
    opts = _build_options(body)
    env = dict(os.environ)
    env["CAMOUFOX_CFG"] = json.dumps(opts)
    proc = subprocess.Popen(
        [sys.executable, _LAUNCHER_PATH],
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
