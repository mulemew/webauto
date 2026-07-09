#!/usr/bin/env python3
"""
cf-proxy: SeleniumBase UC sidecar for Cloudflare bypass.

Manages isolated Chrome sessions via SeleniumBase undetected-chromedriver (UC mode).
Exposes a REST API consumed by the Node.js api-server to transparently bypass
Cloudflare JS challenges, Turnstile, and WAF for any website.

Sessions are backed by a warm pool: Chrome instances are pre-launched in the
background so that POST /sessions returns near-instantly instead of waiting
60-120 s for a cold Chrome start.
"""
import os
import queue
import shutil
import subprocess
import socket
import threading
import time
import traceback
import uuid
from flask import Flask, request, jsonify

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False

_sessions: dict = {}
_sessions_lock = threading.Lock()

# ── Global GUI-input lock ────────────────────────────────────────────────────
# All sessions share ONE Xvfb virtual display (:99) and therefore ONE mouse
# cursor + keyboard focus. SeleniumBase's uc_gui_click_captcha() and xdotool
# clicks move that single shared pointer and raise/focus a window. If two
# concurrent sessions try to click a captcha at the same time they fight over
# the cursor and focus, so both clicks land in the wrong window and both
# captchas fail. Serialise every OS-level GUI interaction behind this lock so
# concurrent seleniumbase tasks each get an uninterrupted turn at the display.
_gui_lock = threading.Lock()

SESSION_TIMEOUT_S = int(os.getenv("SESSION_TIMEOUT_S", "1800"))
SESSION_START_TIMEOUT_S = int(os.getenv("SESSION_START_TIMEOUT_S", "180"))
CHROME_START_ATTEMPTS = int(os.getenv("CHROME_START_ATTEMPTS", "1"))
DEFAULT_RECONNECT_TIME = int(os.getenv("CF_RECONNECT_TIME", "4"))
DEFAULT_MAX_RETRIES = int(os.getenv("CF_MAX_RETRIES", "3"))
POOL_SIZE = int(os.getenv("POOL_SIZE", "1"))
PORT = int(os.getenv("PORT", "7317"))

# Chrome flags shared by all sessions
_CHROMIUM_ARGS = [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=AutomationControlled",
    "--disable-infobars",
    "--no-first-run",
    "--disable-component-extensions-with-background-pages",
    "--no-default-browser-check",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-site-isolation-trials",
]

# Resolve Chrome binary once at module level
def _find_chrome():
    import shutil
    return (
        shutil.which("google-chrome")
        or shutil.which("chromium")
        or shutil.which("chromium-browser")
    )

_CHROME_BIN = _find_chrome()
_thread_local = threading.local()
_popen_patch_lock = threading.Lock()
_popen_patch_installed = False
_orig_popen = subprocess.Popen


def _join_chromium_args(*groups) -> list[str]:
    """
    Merge Chromium args as a list.

    SeleniumBase accepts either a comma-separated string or a list. Use a list:
    flags such as "--disable-features=IsolateOrigins,site-per-process" contain
    a comma and are mis-split when passed as one string.
    """
    args: list[str] = []
    for group in groups:
        if not group:
            continue
        if isinstance(group, (list, tuple)):
            candidates = group
        else:
            candidates = str(group).split(",")
        for arg in candidates:
            arg = str(arg).strip()
            if arg:
                args.append(arg)
    return args


def _is_chrome_browser_launch(cmd) -> bool:
    try:
        if isinstance(cmd, (list, tuple)):
            exe = str(cmd[0])
            cmd_args = [str(x) for x in cmd[1:]]
        else:
            parts = str(cmd).split()
            exe = parts[0] if parts else ""
            cmd_args = parts[1:]
        base = os.path.basename(exe)
        is_chrome = base in {
            "chrome",
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
        } or (_CHROME_BIN and os.path.realpath(exe) == os.path.realpath(_CHROME_BIN))
        if not is_chrome:
            return False
        # Do not intercept probes such as "chromium --version". Only the real
        # UC browser launch has a remote-debugging port / user data dir.
        return any(
            a.startswith("--remote-debugging-port=") or a.startswith("--user-data-dir=")
            for a in cmd_args
        )
    except Exception:
        return False


def _install_chrome_popen_patch():
    """
    SeleniumBase UC launches Chrome with stdout/stderr=PIPE but does not consume
    those streams. In noisy container/Xvfb environments Chromium can block on a
    full stderr pipe before DevTools starts, which then surfaces only as:
      session not created: cannot connect to chrome at 127.0.0.1:<port>

    Redirect only Chrome's stdio to per-session files. Chromedriver/service
    subprocesses are left untouched.
    """
    global _popen_patch_installed
    with _popen_patch_lock:
        if _popen_patch_installed:
            return

        def _patched_popen(cmd, *args, **kwargs):
            if _is_chrome_browser_launch(cmd):
                stdout_path = getattr(_thread_local, "chrome_stdout_path", None)
                stderr_path = getattr(_thread_local, "chrome_stderr_path", None)
                handles = []
                try:
                    if stdout_path:
                        out_f = open(stdout_path, "ab", buffering=0)
                        kwargs["stdout"] = out_f
                        handles.append(out_f)
                    elif kwargs.get("stdout") == subprocess.PIPE:
                        kwargs["stdout"] = subprocess.DEVNULL
                    if stderr_path:
                        err_f = open(stderr_path, "ab", buffering=0)
                        kwargs["stderr"] = err_f
                        handles.append(err_f)
                    elif kwargs.get("stderr") == subprocess.PIPE:
                        kwargs["stderr"] = subprocess.DEVNULL
                    if kwargs.get("stdin") == subprocess.PIPE:
                        kwargs["stdin"] = subprocess.DEVNULL
                    return _orig_popen(cmd, *args, **kwargs)
                finally:
                    for h in handles:
                        try:
                            h.close()
                        except Exception:
                            pass
            return _orig_popen(cmd, *args, **kwargs)

        subprocess.Popen = _patched_popen
        _popen_patch_installed = True


def _tail_file(path: str | None, max_bytes: int = 6000) -> str:
    if not path or not os.path.exists(path):
        return ""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
            data = f.read(max_bytes)
        return data.decode("utf-8", errors="replace").strip()
    except Exception:
        return ""


def _get_chrome_version(binary: str | None) -> str | None:
    if not binary:
        return None
    try:
        out = subprocess.run([binary, '--version'], capture_output=True, text=True, timeout=5).stdout.strip()
        return out or None
    except Exception:
        return None


def _get_uc_driver_version() -> str | None:
    try:
        uc_driver = _get_uc_driver_path()
        if not os.path.exists(uc_driver):
            return None
        out = subprocess.run([uc_driver, '--version'], capture_output=True, text=True, timeout=5).stdout.strip()
        return out or None
    except Exception:
        return None


def _get_uc_driver_path() -> str:
    import seleniumbase
    drivers_dir = os.path.join(os.path.dirname(seleniumbase.__file__), 'drivers')
    return os.path.join(drivers_dir, 'uc_driver')


def _assert_uc_driver_accessible():
    """Fail fast on the common root-owned uc_driver problem in Docker."""
    try:
        uc_driver = _get_uc_driver_path()
    except Exception:
        return
    if not os.path.exists(uc_driver):
        # Let SeleniumBase create/download it if needed.
        return
    missing = []
    if not os.access(uc_driver, os.R_OK):
        missing.append("read")
    if not os.access(uc_driver, os.X_OK):
        missing.append("execute")
    # SeleniumBase UC may patch uc_driver at runtime. If the file or directory
    # remains root-owned after USER app, startup can fail as PermissionError or
    # hang until SessionThread init times out.
    if not os.access(uc_driver, os.W_OK):
        missing.append("write")
    parent = os.path.dirname(uc_driver)
    if not os.access(parent, os.W_OK):
        missing.append("write-driver-dir")
    if missing:
        raise PermissionError(
            f"uc_driver is not accessible to the runtime user "
            f"({','.join(missing)} missing): {uc_driver}"
        )


def _is_proxy_reachable(proxy: str, timeout_s: float = 1.0) -> tuple[bool, str]:
    from urllib.parse import urlparse
    parsed = urlparse(proxy if '://' in proxy else f'socks5://{proxy}')
    host = parsed.hostname or ''
    port = parsed.port or 0
    if not host or not port:
        return False, f'invalid proxy address: {proxy}'
    try:
        with socket.create_connection((host, port), timeout=timeout_s):
            return True, ''
    except Exception as e:
        return False, f'{host}:{port} unreachable from cf-proxy: {e}'


def _resolve_selector(selector: str):
    from selenium.webdriver.common.by import By
    if selector.startswith("xpath="):
        return By.XPATH, selector[6:]
    if selector.startswith("css="):
        return By.CSS_SELECTOR, selector[4:]
    if selector.startswith("id="):
        return By.ID, selector[3:]
    if selector.startswith("text="):
        return By.XPATH, f"//*[contains(text(), \"{selector[5:]}\")]"
    return By.CSS_SELECTOR, selector


def _is_cf_challenge(sb) -> bool:
    try:
        title = sb.driver.title or ""
        url = sb.get_current_url() or ""
        body_text = sb.execute_script("return document.body?.innerText || ''") or ""
        return (
            "Just a moment" in title
            or "Attention Required" in title
            or "challenges.cloudflare.com" in url
            or "cf-browser-verification" in body_text
            or "Checking your browser" in body_text
        )
    except Exception:
        return False


def _classify_start_error(error_text: str) -> str:
    text = (error_text or '').lower()
    if 'proxy unreachable' in text or 'proxy' in text and 'unreachable' in text:
        return f'Chrome failed to start because the configured proxy is unreachable from cf-proxy: {error_text}'
    if 'cannot connect to chrome' in text or 'session not created' in text or 'chrome' in text and 'connect' in text:
        return (
            'Chrome/UC driver session could not be created. This usually means the Chrome binary '
            'crashed on launch or the uc_driver version does not match the installed Chrome version. '
            f'Details: {error_text}'
        )
    return f'Chrome failed to start: {error_text}'


# ── SessionThread ────────────────────────────────────────────────────────────

class SessionThread:
    """One Chrome session running in a dedicated thread (Selenium is not thread-safe)."""

    def __init__(self, proxy: str = None):
        self.session_id = str(uuid.uuid4())
        self.last_used = time.time()
        self.created_at = time.time()
        self._closed = False
        # Optional upstream proxy. SeleniumBase is picky about proxy formats:
        # - plain HTTP proxy:   host:port or http://host:port
        # - authenticated HTTP: user:pass@host:port
        # - SOCKS5:             socks5://host:port
        # We normalize the incoming URL before passing it to SB so callers can
        # send a full proxy URL without needing to know SeleniumBase's quirks.
        self.proxy = (proxy or "").strip() or None
        self._log_dir = os.path.join("/tmp/cf-proxy-logs", self.session_id)
        os.makedirs(self._log_dir, exist_ok=True)
        self._chrome_stdout_path = os.path.join(self._log_dir, "chrome.stdout.log")
        self._chrome_stderr_path = os.path.join(self._log_dir, "chrome.stderr.log")
        self._cmd_q: queue.Queue = queue.Queue()
        self._res_q: queue.Queue = queue.Queue()
        self._seq = 0          # monotonic command sequence number
        self._seq_lock = threading.Lock()
        self._thread = threading.Thread(target=self._worker, daemon=True)
        self._thread.start()
        # This should be longer than SeleniumBase/UC's own startup wait so the
        # worker can return the real Chrome/driver error instead of the parent
        # racing it and surfacing a generic "worker did not return" timeout.
        # Default is 180s; override with SESSION_START_TIMEOUT_S if needed.
        #
        # 120s is enough for a legitimate cold UC-Chrome start on a slow box.
        # If we haven't heard back by then, the worker is stuck (e.g. Chrome
        # hung on Xvfb / uc_driver deadlock) and no amount of extra waiting
        # will change that — surface it as an actionable error.
        try:
            init = self._res_q.get(timeout=SESSION_START_TIMEOUT_S)
        except queue.Empty:
            self._closed = True
            raise RuntimeError(
                f"SessionThread init timed out after {SESSION_START_TIMEOUT_S}s waiting for Chrome/UC driver startup "
                "(worker did not return a result). Check container logs for [worker] lines."
            )
        if not init.get("ok"):
            self._closed = True
            raise RuntimeError(init.get("error", "Chrome failed to start"))

    def _worker(self):
        attempts = max(CHROME_START_ATTEMPTS, 1)
        last_error = None
        chrome_version = _get_chrome_version(_CHROME_BIN)
        uc_driver_version = _get_uc_driver_version()
        if chrome_version or uc_driver_version:
            print(
                f"[chrome] binary={chrome_version or 'unknown'} "
                f"uc_driver={uc_driver_version or 'unknown'}",
                flush=True,
            )
        try:
            for attempt in range(1, attempts + 1):
                try:
                    _install_chrome_popen_patch()
                    _thread_local.chrome_stdout_path = self._chrome_stdout_path
                    _thread_local.chrome_stderr_path = self._chrome_stderr_path
                    from seleniumbase import SB
                    _assert_uc_driver_accessible()
                    chrome_args = _join_chromium_args(_CHROMIUM_ARGS)
                    _kw = dict(
                        uc=True,
                        headed=True,
                        xvfb=False,
                        chromium_arg=chrome_args,
                    )
                    if _CHROME_BIN:
                        _kw["binary_location"] = _CHROME_BIN
                    if self.proxy:
                        proxy = self.proxy
                        is_socks = proxy.startswith("socks5://") or proxy.startswith("socks4://") or proxy.startswith("socks://")
                        if proxy.startswith("socks://"):
                            proxy = "socks5://" + proxy.split("//", 1)[1]
                        if is_socks:
                            ok, err = _is_proxy_reachable(proxy)
                            if not ok:
                                raise RuntimeError(f"Proxy unreachable before Chrome start: {err}")
                            _kw["chromium_arg"] = _join_chromium_args(
                                chrome_args,
                                "--proxy-server=" + proxy,
                            )
                            print(f"[proxy] SOCKS proxy via --proxy-server={proxy}", flush=True)
                        else:
                            if proxy.startswith("http://") or proxy.startswith("https://"):
                                proxy = proxy.split("//", 1)[1]
                            ok, err = _is_proxy_reachable(proxy)
                            if not ok:
                                raise RuntimeError(f"Proxy unreachable before Chrome start: {err}")
                            _kw["proxy"] = proxy
                            print(f"[proxy] HTTP proxy via SB(proxy={proxy})", flush=True)
                    with SB(**_kw) as sb:
                        self._res_q.put({"ok": True})
                        while True:
                            item = self._cmd_q.get()
                            if item is None:
                                break
                            seq, fn = item
                            try:
                                result = fn(sb)
                                self._res_q.put({"ok": True, "result": result, "seq": seq})
                            except Exception as e:
                                self._res_q.put({"ok": False, "error": str(e), "seq": seq})
                        return
                except Exception as e:
                    last_error = e
                    # Some UC / Selenium exceptions have str(e) == "" — always
                    # fall back to repr / class name so /health.last_error is
                    # never a blank string.
                    err_text = str(e).strip() or repr(e) or type(e).__name__
                    err_text = f"{type(e).__name__}: {err_text}"
                    chrome_stderr_tail = _tail_file(self._chrome_stderr_path)
                    if chrome_stderr_tail:
                        err_text = f"{err_text}\n[chrome-stderr-tail]\n{chrome_stderr_tail}"
                    tb = traceback.format_exc()
                    print(f"[worker] Chrome start attempt {attempt} failed: {err_text}\n{tb}", flush=True)
                    # A proxy that cannot be reached will never succeed on retry —
                    # fail fast with a clear message instead of burning retries.
                    if "Proxy unreachable" in err_text:
                        self._res_q.put({"ok": False, "error": _classify_start_error(err_text)})
                        return
                    if attempt < attempts:
                        time.sleep(2 * attempt)
                        continue
                    self._res_q.put({"ok": False, "error": _classify_start_error(err_text)})
                    return
                finally:
                    for attr in ("chrome_stdout_path", "chrome_stderr_path"):
                        try:
                            delattr(_thread_local, attr)
                        except Exception:
                            pass
            fallback = 'Chrome failed to start'
            if last_error is not None:
                le = str(last_error).strip() or repr(last_error) or type(last_error).__name__
                fallback = f"{type(last_error).__name__}: {le}"
            self._res_q.put({"ok": False, "error": _classify_start_error(fallback)})
        finally:
            self._closed = True
            self._cleanup_logs()

    def _cleanup_logs(self):
        try:
            log_dir = getattr(self, "_log_dir", None)
            if log_dir:
                log_real = os.path.realpath(log_dir)
                log_root_real = os.path.realpath("/tmp/cf-proxy-logs")
                if log_real.startswith(log_root_real + os.sep):
                    shutil.rmtree(log_real, ignore_errors=True)
        except Exception:
            pass

    def run(self, fn, timeout: float = 60.0):
        if self._closed:
            raise RuntimeError("Session closed")
        self.last_used = time.time()
        with self._seq_lock:
            self._seq += 1
            seq = self._seq
        self._cmd_q.put((seq, fn))
        deadline = time.time() + timeout + 8
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise RuntimeError("Command timed out")
            result = self._res_q.get(timeout=remaining)
            # Skip stale results from previously timed-out commands
            if result.get("seq") is not None and result["seq"] != seq:
                continue
            if not result["ok"]:
                raise RuntimeError(result.get("error", "Command failed"))
            return result.get("result")

    def close(self):
        self._closed = True
        try:
            self._cmd_q.put(None)
            self._thread.join(timeout=15)
            if not self._thread.is_alive():
                self._cleanup_logs()
        except Exception:
            pass


# ── Warm session pool ────────────────────────────────────────────────────────

class SessionPool:
    """
    Pre-warms Chrome instances in the background so POST /sessions returns
    near-instantly instead of waiting for a cold Chrome launch (60-120 s on
    low-powered devices).

    After a session is acquired, the pool immediately starts warming a
    replacement in the background.
    """

    def __init__(self, size: int = 1):
        self._pool: queue.Queue = queue.Queue()
        self._size = max(size, 1)
        self._warming = 0
        self._warming_lock = threading.Lock()
        self._total_warmed = 0
        self._warm_failures = 0
        self._consecutive_failures = 0
        self._last_error: str | None = None
        self._last_error_at: float = 0.0
        # Start initial warming
        for _ in range(self._size):
            self._start_warming()

    def _start_warming(self):
        # Don't stack up warm threads beyond the target pool size — if we're
        # already warming enough replacements, skip. Prevents runaway spawning
        # when acquire() is called in tight loops after failures.
        with self._warming_lock:
            if self._warming >= self._size:
                return
            self._warming += 1
        t = threading.Thread(target=self._warm_one, daemon=True)
        t.start()

    def _warm_one(self):
        try:
            s = SessionThread()
            self._pool.put(s)
            with self._warming_lock:
                self._total_warmed += 1
                self._consecutive_failures = 0
                self._last_error = None
            print(f"[pool] Session pre-warmed: {s.session_id} (pool size: {self._pool.qsize()})", flush=True)
        except Exception as e:
            # Build a message that's never empty — some Selenium / UC driver
            # exceptions have str(e) == "" which hid the root cause and made
            # /health show last_error="".
            err_text = str(e).strip() or repr(e) or type(e).__name__
            err_text = f"{type(e).__name__}: {err_text}"
            tb = traceback.format_exc()
            with self._warming_lock:
                self._warm_failures += 1
                self._consecutive_failures += 1
                self._last_error = err_text
                self._last_error_at = time.time()
                consecutive = self._consecutive_failures
            print(f"[pool] Failed to pre-warm session (consecutive={consecutive}): {err_text}\n{tb}", flush=True)
            # Retry with capped exponential backoff so a transient failure
            # (e.g. Chrome momentarily unavailable) doesn't leave the pool
            # permanently drained. Bounded so we don't hot-loop forever when
            # Chrome/uc_driver are actually broken — /health surfaces the
            # sustained failure so operators can see it.
            if consecutive <= 10:
                backoff = min(2 ** min(consecutive, 6), 60)
                threading.Timer(backoff, self._start_warming).start()
                print(f"[pool] Scheduling retry in {backoff}s", flush=True)
        finally:
            with self._warming_lock:
                self._warming -= 1

    def _is_unhealthy(self) -> tuple[bool, str | None]:
        """Return (unhealthy, reason). Unhealthy = several consecutive warm
        failures with no successful warm since. Used by acquire() to fail
        fast instead of blocking callers for the full timeout on a broken
        Chrome/uc_driver setup."""
        with self._warming_lock:
            if self._consecutive_failures >= 3 and self._pool.qsize() == 0:
                return True, self._last_error
            return False, None

    def acquire(self, timeout: float = 180.0) -> SessionThread:
        """
        Get a pre-warmed session. If the pool is empty, blocks until one is
        ready (up to timeout seconds). After acquiring, triggers background
        replenishment.

        Fails fast with the last warm error if the pool is currently in a
        sustained failure state — otherwise callers would block for the full
        timeout only to hit the same failure on the fallback cold-start.
        """
        # Fail fast when pool is demonstrably broken
        unhealthy, reason = self._is_unhealthy()
        if unhealthy:
            raise RuntimeError(
                f"cf-proxy session pool is unhealthy (consecutive warm failures). "
                f"Last error: {reason or 'unknown'}"
            )

        # Defensive: if the pool is empty and nothing is warming, kick a warm
        # attempt now so we're not just waiting on a queue that will never
        # receive anything.
        with self._warming_lock:
            need_kick = self._pool.qsize() == 0 and self._warming == 0
        if need_kick:
            self._start_warming()

        try:
            s = self._pool.get(timeout=timeout)
        except queue.Empty:
            # Pool exhausted and warming timed out — bubble up the last real
            # error if we have one, otherwise fall back to a direct cold start
            # (this path handles the "first call ever, warming just slow" case).
            _, reason = self._is_unhealthy()
            if reason:
                raise RuntimeError(
                    f"cf-proxy session pool timed out after {timeout}s "
                    f"(last warm error: {reason})"
                )
            print("[pool] Pool empty, cold-starting a session", flush=True)
            s = SessionThread()

        # Check if the pre-warmed session is still alive
        if s._closed:
            print(f"[pool] Pre-warmed session {s.session_id} was dead, creating new one", flush=True)
            s = SessionThread()

        # Replenish the pool in background
        self._start_warming()
        return s

    def status(self) -> dict:
        with self._warming_lock:
            return {
                "ready": self._pool.qsize(),
                "warming": self._warming,
                "target_size": self._size,
                "total_warmed": self._total_warmed,
                "warm_failures": self._warm_failures,
                "consecutive_failures": self._consecutive_failures,
                "last_error": self._last_error,
                "last_error_at": self._last_error_at or None,
            }


_pool = SessionPool(POOL_SIZE)


# ── Cleanup worker ───────────────────────────────────────────────────────────

def _cleanup_worker():
    while True:
        time.sleep(60)
        expired = []
        with _sessions_lock:
            for sid, s in list(_sessions.items()):
                if s._closed or (time.time() - s.last_used > SESSION_TIMEOUT_S):
                    expired.append(sid)
        for sid in expired:
            with _sessions_lock:
                s = _sessions.pop(sid, None)
            if s:
                try:
                    s.close()
                except Exception:
                    pass


threading.Thread(target=_cleanup_worker, daemon=True).start()


def _get(sid):
    with _sessions_lock:
        s = _sessions.get(sid)
    if not s or s._closed:
        return None
    return s


def _err(msg, code=404):
    return jsonify({"error": msg}), code


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/health")
def health():
    pool_status = _pool.status()
    return jsonify({
        "ok": True,
        "sessions": len(_sessions),
        "pool": pool_status,
    })


@app.route("/sessions", methods=["POST"])
def create_session():
    body = request.json if request.is_json else {}
    proxy = (body or {}).get("proxy") if isinstance(body, dict) else None
    try:
        if proxy:
            # A proxy must be set at Chrome launch, so it cannot come from the
            # warm pool (those are launched proxy-less). Cold-start a dedicated
            # session bound to the requested proxy instead.
            s = SessionThread(proxy=proxy)
        else:
            s = _pool.acquire()
    except Exception as e:
        return _err(str(e), 500)
    with _sessions_lock:
        _sessions[s.session_id] = s
    return jsonify({"session_id": s.session_id}), 201


@app.route("/sessions/<sid>", methods=["DELETE"])
def delete_session(sid):
    with _sessions_lock:
        s = _sessions.pop(sid, None)
    if s:
        s.close()
    return jsonify({"ok": True})


@app.route("/sessions/<sid>/goto", methods=["POST"])
def goto(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    url = body.get("url", "about:blank")
    bypass_cf = body.get("bypass_cf", True)
    reconnect_time = body.get("reconnect_time", DEFAULT_RECONNECT_TIME)
    max_retries = body.get("max_retries", DEFAULT_MAX_RETRIES)
    timeout = body.get("timeout", 60)

    def _fn(sb):
        if bypass_cf:
            sb.uc_open_with_reconnect(url, reconnect_time=reconnect_time)

            # ── Post-navigation CF challenge handling ────────────────────
            # uc_open_with_reconnect handles JS challenges by disconnecting
            # CDP during page load. But Turnstile interactive challenges
            # (click checkbox) need explicit clicking via uc_gui_click_captcha.
            for attempt in range(max_retries):
                if not _is_cf_challenge(sb):
                    break

                # Strategy 1: Use SB's built-in GUI captcha clicker.
                # Serialise behind the shared GUI lock — see _gui_lock docstring.
                try:
                    with _gui_lock:
                        sb.uc_gui_click_captcha()
                        time.sleep(3)
                except Exception:
                    pass

                if not _is_cf_challenge(sb):
                    break

                # Strategy 2: Re-open with longer reconnect time
                try:
                    sb.uc_open_with_reconnect(
                        url,
                        reconnect_time=reconnect_time + (attempt + 1) * 2,
                    )
                    time.sleep(2)
                except Exception:
                    pass

                if not _is_cf_challenge(sb):
                    break

                # Strategy 3: Try uc_gui_click_captcha again after reconnect
                try:
                    with _gui_lock:
                        sb.uc_gui_click_captcha()
                        time.sleep(3)
                except Exception:
                    pass
        else:
            sb.open(url)
            time.sleep(1)
            if _is_cf_challenge(sb):
                sb.uc_open_with_reconnect(url, reconnect_time=reconnect_time)
                if _is_cf_challenge(sb):
                    try:
                        with _gui_lock:
                            sb.uc_gui_click_captcha()
                            time.sleep(3)
                    except Exception:
                        pass

        cf_status = "challenged" if _is_cf_challenge(sb) else "passed"
        return {"url": sb.get_current_url(), "cf_status": cf_status}

    try:
        result = s.run(_fn, timeout=timeout + reconnect_time * max_retries + 30)
        if isinstance(result, dict):
            return jsonify({"ok": True, "url": result["url"], "cf_status": result["cf_status"]})
        return jsonify({"ok": True, "url": result})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/click", methods=["POST"])
def click(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    selector = body.get("selector", "")
    timeout = body.get("timeout", 30)

    def _fn(sb):
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        by, val = _resolve_selector(selector)
        el = WebDriverWait(sb.driver, timeout).until(EC.element_to_be_clickable((by, val)))
        el.click()

    try:
        s.run(_fn, timeout=timeout + 5)
        return jsonify({"ok": True})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/hover", methods=["POST"])
def hover(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    selector = body.get("selector", "")
    timeout = body.get("timeout", 30)

    def _fn(sb):
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.action_chains import ActionChains
        by, val = _resolve_selector(selector)
        el = WebDriverWait(sb.driver, timeout).until(EC.presence_of_element_located((by, val)))
        ActionChains(sb.driver).move_to_element(el).perform()

    try:
        s.run(_fn, timeout=timeout + 5)
        return jsonify({"ok": True})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/wait-for-selector", methods=["POST"])
def wait_for_selector(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    selector = body.get("selector", "")
    timeout_ms = body.get("timeout", 30000)
    timeout_s = timeout_ms / 1000.0

    def _fn(sb):
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        by, val = _resolve_selector(selector)
        WebDriverWait(sb.driver, timeout_s).until(EC.presence_of_element_located((by, val)))

    try:
        s.run(_fn, timeout=timeout_s + 5)
        return jsonify({"ok": True})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/wait-for-navigation", methods=["POST"])
def wait_for_navigation(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    timeout_ms = body.get("timeout", 30000)
    timeout_s = timeout_ms / 1000.0

    def _fn(sb):
        start = time.time()
        while time.time() - start < timeout_s:
            state = sb.execute_script("return document.readyState")
            if state == "complete":
                return sb.get_current_url()
            time.sleep(0.2)
        return sb.get_current_url()

    try:
        url = s.run(_fn, timeout=timeout_s + 5)
        return jsonify({"ok": True, "url": url})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/evaluate", methods=["POST"])
def evaluate(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    script = body.get("script", "")
    args = body.get("args", [])
    timeout = body.get("timeout", 30)

    def _fn(sb):
        return sb.execute_script(script, *args)

    try:
        result = s.run(_fn, timeout=timeout + 5)
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/screenshot", methods=["GET", "POST"])
def screenshot(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")

    def _fn(sb):
        result = sb.driver.get_screenshot_as_base64()
        if not result or not isinstance(result, str):
            raise RuntimeError("Screenshot returned empty or invalid data — browser may have crashed")
        return result

    try:
        data = s.run(_fn, timeout=15)
        return jsonify({"ok": True, "data": data})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/url", methods=["GET"])
def get_url(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")

    def _fn(sb):
        return sb.get_current_url()

    try:
        url = s.run(_fn, timeout=10)
        return jsonify({"ok": True, "url": url})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/title", methods=["GET"])
def get_title(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")

    def _fn(sb):
        return sb.driver.title

    try:
        title = s.run(_fn, timeout=10)
        return jsonify({"ok": True, "title": title})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/cookies", methods=["GET"])
def get_cookies(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")

    def _fn(sb):
        return sb.driver.get_cookies()

    try:
        cookies = s.run(_fn, timeout=10)
        return jsonify({"ok": True, "cookies": cookies})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/keyboard/type", methods=["POST"])
def keyboard_type(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    text = body.get("text", "")
    delay_ms = body.get("delay", 0)

    def _fn(sb):
        from selenium.webdriver.common.action_chains import ActionChains
        if delay_ms:
            for ch in text:
                ActionChains(sb.driver).send_keys(ch).perform()
                time.sleep(delay_ms / 1000.0)
        else:
            ActionChains(sb.driver).send_keys(text).perform()

    try:
        extra = len(text) * (delay_ms / 1000.0) if delay_ms else 0
        s.run(_fn, timeout=extra + 15)
        return jsonify({"ok": True})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/keyboard/press", methods=["POST"])
def keyboard_press(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    key = body.get("key", "")

    def _fn(sb):
        from selenium.webdriver.common.keys import Keys
        from selenium.webdriver.common.action_chains import ActionChains
        KEY_MAP = {
            "Enter": Keys.ENTER, "Tab": Keys.TAB, "Escape": Keys.ESCAPE,
            "Space": Keys.SPACE, "ArrowUp": Keys.ARROW_UP,
            "ArrowDown": Keys.ARROW_DOWN, "ArrowLeft": Keys.ARROW_LEFT,
            "ArrowRight": Keys.ARROW_RIGHT, "Backspace": Keys.BACK_SPACE,
            "Delete": Keys.DELETE, "Home": Keys.HOME, "End": Keys.END,
        }
        ActionChains(sb.driver).send_keys(KEY_MAP.get(key, key)).perform()

    try:
        s.run(_fn, timeout=10)
        return jsonify({"ok": True})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/mouse/move", methods=["POST"])
def mouse_move(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    x, y = body.get("x", 0), body.get("y", 0)

    def _fn(sb):
        from selenium.webdriver.common.action_chains import ActionChains
        ActionChains(sb.driver).move_by_offset(int(x), int(y)).perform()
        # Reset action state so next move is absolute-like
        ActionChains(sb.driver).move_by_offset(-int(x), -int(y)).perform()

    try:
        s.run(_fn, timeout=10)
        return jsonify({"ok": True})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/mouse/click", methods=["POST"])
def mouse_click(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    x, y = body.get("x", 0), body.get("y", 0)

    def _fn(sb):
        import subprocess
        # Prefer xdotool for OS-level physical clicks (undetectable by CF)
        try:
            # Serialise behind the shared GUI lock — concurrent sessions share
            # ONE Xvfb :99 pointer/focus; interleaved mousemove+click across
            # sessions would land clicks in the wrong window. See _gui_lock.
            with _gui_lock:
                subprocess.run(
                    ["xdotool", "mousemove", "--sync", str(int(x)), str(int(y))],
                    timeout=3, capture_output=True,
                )
                subprocess.run(["xdotool", "click", "1"], timeout=2, capture_output=True)
            return
        except Exception:
            pass
        # Fallback: Selenium ActionChains (CDP-level, better than JS dispatch)
        from selenium.webdriver.common.action_chains import ActionChains
        ActionChains(sb.driver).move_by_offset(int(x), int(y)).click().perform()
        ActionChains(sb.driver).move_by_offset(-int(x), -int(y)).perform()

    try:
        s.run(_fn, timeout=10)
        return jsonify({"ok": True})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/find-element", methods=["POST"])
def find_element(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    selector = body.get("selector", "")

    def _fn(sb):
        by, val = _resolve_selector(selector)
        els = sb.driver.find_elements(by, val)
        if not els:
            return None
        el = els[0]
        r = el.rect
        return {"found": True, "rect": {"x": r["x"], "y": r["y"], "width": r["width"], "height": r["height"]}}

    try:
        result = s.run(_fn, timeout=15)
        if not result:
            return jsonify({"found": False})
        return jsonify(result)
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/element/click", methods=["POST"])
def element_click(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    selector = body.get("selector", "")

    def _fn(sb):
        by, val = _resolve_selector(selector)
        sb.driver.find_element(by, val).click()

    try:
        s.run(_fn, timeout=15)
        return jsonify({"ok": True})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/element/evaluate", methods=["POST"])
def element_evaluate(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    selector = body.get("selector", "")
    script = body.get("script", "")

    def _fn(sb):
        by, val = _resolve_selector(selector)
        el = sb.driver.find_element(by, val)
        return sb.execute_script(script, el)

    try:
        result = s.run(_fn, timeout=15)
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/element/screenshot", methods=["POST"])
def element_screenshot(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    selector = body.get("selector", "")

    def _fn(sb):
        by, val = _resolve_selector(selector)
        el = sb.driver.find_element(by, val)
        result = el.screenshot_as_base64
        if not result or not isinstance(result, str):
            raise RuntimeError("Element screenshot returned empty or invalid data")
        return result

    try:
        data = s.run(_fn, timeout=15)
        return jsonify({"ok": True, "data": data})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/wait-for-new-page", methods=["POST"])
def wait_for_new_page(sid):
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    timeout_ms = body.get("timeout", 30000)
    timeout_s = timeout_ms / 1000.0

    def _fn(sb):
        initial = set(sb.driver.window_handles)
        start = time.time()
        while time.time() - start < timeout_s:
            current = set(sb.driver.window_handles)
            new_handles = current - initial
            if new_handles:
                sb.driver.switch_to.window(new_handles.pop())
                return sb.get_current_url()
            time.sleep(0.2)
        raise TimeoutError("No new page within timeout")

    try:
        url = s.run(_fn, timeout=timeout_s + 5)
        return jsonify({"ok": True, "url": url, "session_id": sid})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/is-closed", methods=["GET"])
def is_closed(sid):
    s = _get(sid)
    return jsonify({"closed": s is None or s._closed})


@app.route("/sessions/<sid>/click-turnstile", methods=["POST"])
def click_turnstile(sid):
    """Click an embedded Turnstile widget using SB's uc_gui_click_captcha.

    This uses PyAutoGUI/xdotool OS-level clicks that are undetectable by CF.
    Works for embedded Turnstile widgets (not just full-page challenges).
    """
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    max_retries = body.get("max_retries", 3)
    timeout = body.get("timeout", 60)

    def _fn(sb):
        import subprocess

        for attempt in range(max_retries):
            # Check if Turnstile token is already populated (auto-solved)
            try:
                token = sb.execute_script(
                    "var i=document.querySelector('input[name=\"cf-turnstile-response\"]');"
                    "return i ? i.value : '';"
                )
                if token and len(token) > 20:
                    return {"solved": True, "method": "auto", "attempt": attempt}
            except Exception:
                pass

            # Strategy 1: SB's built-in uc_gui_click_captcha (PyAutoGUI)
            try:
                with _gui_lock:
                    sb.uc_gui_click_captcha()
                    time.sleep(3)
            except Exception:
                pass

            # Check if solved after click
            try:
                token = sb.execute_script(
                    "var i=document.querySelector('input[name=\"cf-turnstile-response\"]');"
                    "return i ? i.value : '';"
                )
                if token and len(token) > 20:
                    return {"solved": True, "method": "uc_gui", "attempt": attempt + 1}
            except Exception:
                pass

            # Strategy 2: Locate Turnstile iframe and xdotool-click its checkbox
            # Use xdotool getwindowgeometry for accurate window position in Xvfb
            try:
                rect = sb.execute_script("""
                    var frames = document.querySelectorAll('iframe');
                    for (var i = 0; i < frames.length; i++) {
                        var src = frames[i].src || '';
                        if (src.indexOf('challenges.cloudflare.com') >= 0 || src.indexOf('turnstile') >= 0) {
                            var r = frames[i].getBoundingClientRect();
                            if (r.width > 0 && r.height > 0)
                                return {x: r.x + 30, y: r.y + r.height / 2, w: r.width, h: r.height};
                        }
                    }
                    var containers = document.querySelectorAll('.cf-turnstile, [data-sitekey]');
                    for (var i = 0; i < containers.length; i++) {
                        var r = containers[i].getBoundingClientRect();
                        if (r.width > 0 && r.height > 0)
                            return {x: r.x + 30, y: r.y + r.height / 2, w: r.width, h: r.height};
                    }
                    return null;
                """)
                if rect:
                    # Get accurate window position via xdotool instead of
                    # window.screenX/screenY which are unreliable in Xvfb
                    win_x, win_y, title_bar = 0, 0, 0
                    try:
                        # Find Chrome window ID
                        wid = None
                        for cls in ["chrome", "chromium", "Chrome", "Chromium", "google-chrome"]:
                            try:
                                out = subprocess.run(
                                    ["xdotool", "search", "--onlyvisible", "--class", cls],
                                    capture_output=True, text=True, timeout=3,
                                ).stdout.strip()
                                wids = [w for w in out.split("\n") if w.strip()]
                                if wids:
                                    wid = wids[0]
                                    break
                            except Exception:
                                continue
                        if wid:
                            # xdotool getwindowgeometry gives accurate position
                            geo = subprocess.run(
                                ["xdotool", "getwindowgeometry", "--shell", wid],
                                capture_output=True, text=True, timeout=3,
                            ).stdout
                            for line in geo.strip().split("\n"):
                                if line.startswith("X="):
                                    win_x = int(line.split("=")[1])
                                elif line.startswith("Y="):
                                    win_y = int(line.split("=")[1])
                            # Compute title bar from outer vs inner height
                            win_info = sb.execute_script(
                                "return {oh: window.outerHeight, ih: window.innerHeight};"
                            )
                            title_bar = max(0, (win_info.get("oh", 0) - win_info.get("ih", 0)))
                    except Exception:
                        # Fallback to JS-based coordinates
                        win_info = sb.execute_script(
                            "return {sx: window.screenX||0, sy: window.screenY||0, "
                            "oh: window.outerHeight, ih: window.innerHeight};"
                        )
                        win_x = int(win_info.get("sx", 0))
                        win_y = int(win_info.get("sy", 0))
                        title_bar = max(0, (win_info.get("oh", 0) - win_info.get("ih", 0)))

                    abs_x = int(rect["x"]) + win_x
                    abs_y = int(rect["y"]) + win_y + title_bar
                    print(f"[turnstile] xdotool click at ({abs_x}, {abs_y}) "
                          f"win=({win_x},{win_y}) title_bar={title_bar} "
                          f"rect=({rect['x']},{rect['y']})", flush=True)
                    try:
                        # Serialise the physical pointer move+click behind the
                        # shared GUI lock — see _gui_lock docstring.
                        with _gui_lock:
                            subprocess.run(
                                ["xdotool", "mousemove", "--sync", str(abs_x), str(abs_y)],
                                timeout=3, capture_output=True,
                            )
                            subprocess.run(["xdotool", "click", "1"], timeout=2, capture_output=True)
                            time.sleep(4)
                    except Exception:
                        pass

                    # Check again
                    try:
                        token = sb.execute_script(
                            "var i=document.querySelector('input[name=\"cf-turnstile-response\"]');"
                            "return i ? i.value : '';"
                        )
                        if token and len(token) > 20:
                            return {"solved": True, "method": "xdotool", "attempt": attempt + 1}
                    except Exception:
                        pass
            except Exception:
                pass

            # Brief wait before retry
            time.sleep(2)

        return {"solved": False, "method": "none", "attempt": max_retries}

    try:
        result = s.run(_fn, timeout=timeout + 10)
        return jsonify({"ok": True, **result})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/frames", methods=["GET"])
def list_frames(sid):
    """List all frames/iframes including their URLs — needed by the Turnstile detector."""
    s = _get(sid)
    if not s:
        return _err("Session not found")

    def _fn(sb):
        result = []
        try:
            frames_js = sb.execute_script("""
                var result = [];
                var iframes = document.querySelectorAll('iframe');
                for (var i = 0; i < iframes.length; i++) {
                    try { result.push({url: iframes[i].src || '', name: iframes[i].name || ''}); }
                    catch(e) { result.push({url: '', name: ''}); }
                }
                return result;
            """)
            if frames_js:
                result = frames_js
        except Exception:
            pass
        return result

    try:
        frames = s.run(_fn, timeout=10)
        return jsonify({"ok": True, "frames": frames})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/open-pages", methods=["GET"])
def open_pages(sid):
    s = _get(sid)
    if not s:
        return jsonify({"count": 0})

    def _fn(sb):
        return len(sb.driver.window_handles)

    try:
        count = s.run(_fn, timeout=10)
        return jsonify({"ok": True, "count": count})
    except Exception as e:
        return _err(str(e), 500)


if __name__ == "__main__":
    print(f"CF Proxy starting on port {PORT} (pool size: {POOL_SIZE})", flush=True)
    app.run(host="0.0.0.0", port=PORT, threaded=True)
