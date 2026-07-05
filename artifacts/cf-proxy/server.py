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
import threading
import time
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
DEFAULT_RECONNECT_TIME = int(os.getenv("CF_RECONNECT_TIME", "4"))
DEFAULT_MAX_RETRIES = int(os.getenv("CF_MAX_RETRIES", "3"))
POOL_SIZE = int(os.getenv("POOL_SIZE", "1"))
PORT = int(os.getenv("PORT", "7317"))

# Chrome flags shared by all sessions
_CHROMIUM_ARGS = ",".join([
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
])

# Resolve Chrome binary once at module level
def _find_chrome():
    import shutil
    return (
        shutil.which("google-chrome")
        or shutil.which("chromium")
        or shutil.which("chromium-browser")
    )

_CHROME_BIN = _find_chrome()


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
        self._cmd_q: queue.Queue = queue.Queue()
        self._res_q: queue.Queue = queue.Queue()
        self._seq = 0          # monotonic command sequence number
        self._seq_lock = threading.Lock()
        self._thread = threading.Thread(target=self._worker, daemon=True)
        self._thread.start()
        init = self._res_q.get(timeout=180)
        if not init.get("ok"):
            self._closed = True
            raise RuntimeError(init.get("error", "Chrome failed to start"))

    def _worker(self):
        try:
            from seleniumbase import SB
            _kw = dict(
                uc=True,
                headed=True,
                xvfb=False,
                chromium_arg=_CHROMIUM_ARGS,
            )
            if _CHROME_BIN:
                _kw["binary_location"] = _CHROME_BIN
            if self.proxy:
                proxy = self.proxy
                is_socks = proxy.startswith("socks5://") or proxy.startswith("socks4://") or proxy.startswith("socks://")
                if proxy.startswith("socks://"):
                    proxy = "socks5://" + proxy.split("//", 1)[1]
                if is_socks:
                    # UC mode + SeleniumBase's proxy= handling builds a proxy
                    # *extension* for anything it treats as needing auth, and
                    # that extension frequently breaks SOCKS session creation
                    # under undetected-chromedriver (the browser never finishes
                    # launching → "session creation failed"). Chromium speaks
                    # SOCKS5 natively, so route it through --proxy-server, which
                    # is applied at launch and does not disturb UC stealth.
                    _kw["chromium_arg"] = _CHROMIUM_ARGS + ",--proxy-server=" + proxy
                    print(f"[proxy] SOCKS proxy via --proxy-server={proxy}", flush=True)
                else:
                    # Plain HTTP/HTTPS proxy — strip the scheme to the host:port
                    # form SeleniumBase expects.
                    if proxy.startswith("http://") or proxy.startswith("https://"):
                        proxy = proxy.split("//", 1)[1]
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
        except Exception as e:
            self._res_q.put({"ok": False, "error": str(e)})
        finally:
            self._closed = True

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
        # Start initial warming
        for _ in range(self._size):
            self._start_warming()

    def _start_warming(self):
        with self._warming_lock:
            self._warming += 1
        t = threading.Thread(target=self._warm_one, daemon=True)
        t.start()

    def _warm_one(self):
        try:
            s = SessionThread()
            self._pool.put(s)
            with self._warming_lock:
                self._total_warmed += 1
            print(f"[pool] Session pre-warmed: {s.session_id} (pool size: {self._pool.qsize()})", flush=True)
        except Exception as e:
            with self._warming_lock:
                self._warm_failures += 1
            print(f"[pool] Failed to pre-warm session: {e}", flush=True)
        finally:
            with self._warming_lock:
                self._warming -= 1

    def acquire(self, timeout: float = 180.0) -> SessionThread:
        """
        Get a pre-warmed session. If the pool is empty, blocks until one is
        ready (up to timeout seconds). After acquiring, triggers background
        replenishment.
        """
        try:
            s = self._pool.get(timeout=timeout)
        except queue.Empty:
            # Pool exhausted and warming timed out — create one directly
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
