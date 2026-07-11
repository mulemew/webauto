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

# ── Browser fingerprint spoofing (OPT-IN, default OFF) ───────────────────────
# FINGERPRINT_OS = "windows" | "mac" | "" (off). When set, each session is
# overlaid with a consistent OS profile (UA + UA-CH + navigator.platform +
# WebGL vendor/renderer strings + timezone/locale). Timezone/locale come from
# FINGERPRINT_TZ / FINGERPRINT_LOCALE if set, else are auto-detected from the
# session's EXIT IP (through its proxy) unless FINGERPRINT_AUTOGEO=0.
# NOTE: a half-consistent spoof can HURT Cloudflare Turnstile — test before
# relying on it, and prefer leaving it off for CF-heavy sites if it regresses.
FINGERPRINT_OS = os.getenv("FINGERPRINT_OS", "").strip().lower()
FINGERPRINT_TZ = os.getenv("FINGERPRINT_TZ", "").strip()
FINGERPRINT_LOCALE = os.getenv("FINGERPRINT_LOCALE", "").strip()
FINGERPRINT_LANGS = os.getenv("FINGERPRINT_LANGS", "").strip()
FINGERPRINT_AUTOGEO = os.getenv("FINGERPRINT_AUTOGEO", "1").strip() not in ("0", "false", "no", "")

# Minimal country-code → locale map for IP auto-detection (default en-US).
_CC_LOCALE = {
    "US": "en-US", "GB": "en-GB", "CA": "en-CA", "AU": "en-AU", "IE": "en-IE",
    "DE": "de-DE", "FR": "fr-FR", "ES": "es-ES", "IT": "it-IT", "NL": "nl-NL",
    "SE": "sv-SE", "NO": "nb-NO", "DK": "da-DK", "FI": "fi-FI", "PL": "pl-PL",
    "PT": "pt-PT", "BR": "pt-BR", "RU": "ru-RU", "UA": "uk-UA", "TR": "tr-TR",
    "JP": "ja-JP", "KR": "ko-KR", "CN": "zh-CN", "TW": "zh-TW", "HK": "zh-HK",
    "SG": "en-SG", "IN": "en-IN", "MX": "es-MX", "AR": "es-AR",
}

_geo_cache: dict = {}
_geo_lock = threading.Lock()

# Chrome flags shared by all sessions
_CHROMIUM_ARGS = [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--no-first-run",
    "--disable-component-extensions-with-background-pages",
    "--no-default-browser-check",
    # Chrome keeps only the LAST --disable-features on the command line, so all
    # disabled features must live in ONE flag — splitting them (as two separate
    # --disable-features=) silently dropped AutomationControlled, re-exposing the
    # automation tell. Keep them merged.
    "--disable-features=AutomationControlled,IsolateOrigins,site-per-process",
    "--disable-site-isolation-trials",
    # Stop WebRTC/STUN from leaking the real IP by bypassing the proxy (WebRTC
    # uses direct UDP). Keeps RTCPeerConnection present (so "no WebRTC" is not a
    # tell) but only allows proxied UDP -> no real-IP STUN leak.
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
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
                    # Inject the per-session timezone into Chrome's OWN process
                    # env (V8/ICU honour TZ). This is the RELIABLE way to spoof
                    # the timezone — unlike CDP setTimezoneOverride it survives
                    # uc_open_with_reconnect and every navigation.
                    chrome_tz = getattr(_thread_local, "chrome_tz", None)
                    if chrome_tz:
                        env = dict(kwargs.get("env") or os.environ)
                        env["TZ"] = chrome_tz
                        kwargs["env"] = env
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


# ── Fingerprint spoofing helpers ─────────────────────────────────────────────

def _detect_geo(proxy):
    """Best-effort: resolve (timezone, locale) for the session's EXIT IP.

    Routes the lookup through the session's proxy when one is set, so the geo
    matches what the target site sees. Cached per proxy. Returns (None, None)
    on any failure — the caller falls back to manual env / defaults.
    """
    key = proxy or "direct"
    with _geo_lock:
        if key in _geo_cache:
            return _geo_cache[key]

    import requests as _rq
    proxies = None
    if proxy:
        p = proxy
        if p.startswith("socks5h://") or p.startswith("socks4a://") or p.startswith("socks://"):
            p = "socks5://" + p.split("//", 1)[1]
        proxies = {"http": p, "https": p}
    pmask = (proxy or "direct").split("@")[-1]

    # Try a couple of free, no-key geo services with a retry each. WARP exits via
    # Cloudflare's shared IPs, which ip-api.com often rate-limits/blocks (that is
    # why France-over-WARP silently fell back to UTC/en-US), and a fresh proxy
    # tunnel may not be up on the first try — so retry and try a fallback source.
    endpoints = [
        ("http://ip-api.com/json/?fields=status,message,timezone,countryCode",
         lambda d: (d.get("timezone"), (d.get("countryCode") or "").upper())),
        ("https://ipwho.is/",
         lambda d: ((d.get("timezone") or {}).get("id"), (d.get("country_code") or "").upper())),
        ("https://ipapi.co/json/",
         lambda d: (d.get("timezone"), (d.get("country_code") or d.get("country") or "").upper())),
    ]
    tz, locale = None, None
    for url, parse in endpoints:
        host = url.split("/")[2]
        for attempt in range(2):
            try:
                r = _rq.get(url, proxies=proxies, timeout=12, headers={"User-Agent": "curl/8"})
                d = r.json()
                _tz, cc = parse(d)
                if _tz:
                    tz, locale = _tz, _CC_LOCALE.get(cc)
                    print(f"[fingerprint] geo via {host} proxy={pmask} -> "
                          f"tz={tz} cc={cc} locale={locale}", flush=True)
                    break
                print(f"[fingerprint] geo {host} proxy={pmask} attempt {attempt+1}: "
                      f"no tz in {str(d)[:120]}", flush=True)
            except Exception as e:
                print(f"[fingerprint] geo {host} proxy={pmask} attempt {attempt+1} failed: {e}", flush=True)
            time.sleep(1)
        if tz:
            break

    if not tz:
        print(f"[fingerprint] geo detect FAILED for proxy={pmask} — "
              f"timezone/locale stay default. Set them manually per task.", flush=True)
    with _geo_lock:
        _geo_cache[key] = (tz, locale)
    return tz, locale


def _resolve_tz_locale(proxy, man_tz, man_locale, auto_geo):
    """Manual value wins; otherwise auto-detect from the exit IP if enabled."""
    tz = man_tz or None
    locale = man_locale or None
    if (not tz or not locale) and auto_geo:
        auto_tz, auto_locale = _detect_geo(proxy)
        tz = tz or auto_tz
        locale = locale or auto_locale
    return tz, (locale or "en-US")


def _fp_ua(os_name: str, major: str) -> str:
    """Build the User-Agent string for a spoofed OS profile.

    Used both as a LAUNCH flag (--user-agent, survives uc_open_with_reconnect —
    this is what stops sites from reading the real "X11; Linux" UA) and by the
    CDP overlay so the two always agree. Note Windows 10 AND 11 both report
    "Windows NT 10.0" in the UA — the OS version is only distinguishable via
    UA Client Hints (platformVersion), set separately in the CDP metadata.
    """
    if os_name == "mac":
        return (f"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                f"(KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36")
    return (f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            f"(KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36")


def _fp_profile(os_name: str, major: str, full: str) -> dict:
    """Canonical values for a spoofed OS profile — the single source of truth
    shared by the launch-loaded MAIN-world extension and the (secondary,
    pre-navigation) CDP overlay, so the two never diverge."""
    if os_name == "mac":
        platform = "MacIntel"
        meta_platform, meta_pv, meta_arch = "macOS", "14.5.0", "arm"
        webgl_vendor = "Google Inc. (Apple)"
        webgl_renderer = "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)"
    else:
        platform = "Win32"
        meta_platform, meta_pv, meta_arch = "Windows", "15.0.0", "x86"
        webgl_vendor = "Google Inc. (Intel)"
        webgl_renderer = ("ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) "
                          "Direct3D11 vs_5_0 ps_5_0, D3D11)")
    brands = [
        {"brand": "Chromium", "version": major},
        {"brand": "Google Chrome", "version": major},
        {"brand": "Not.A/Brand", "version": "99"},
    ]
    full_versions = [
        {"brand": "Chromium", "version": full},
        {"brand": "Google Chrome", "version": full},
        {"brand": "Not.A/Brand", "version": "99.0.0.0"},
    ]
    return {
        "ua": _fp_ua(os_name, major),
        "platform": platform,
        "vendor": "Google Inc.",
        "webgl_vendor": webgl_vendor,
        "webgl_renderer": webgl_renderer,
        "ua_ch": {
            "brands": brands, "fullVersionList": full_versions,
            "platform": meta_platform, "platformVersion": meta_pv,
            "architecture": meta_arch, "bitness": "64", "model": "",
            "mobile": False, "wow64": False, "uaFullVersion": full,
        },
    }


# MAIN-world content script: spoofs the JS-observable fingerprint BEFORE any page
# script runs, on every frame and navigation. Immune to uc_open_with_reconnect
# (it is not CDP), so unlike the CDP overlay it actually reaches the landing page
# and CF's Turnstile iframe — and it never re-exposes automation.
_FP_EXT_JS = r"""(function(){
'use strict';
var P=__PLATFORM__, VEND=__VENDOR__, LANGS=__LANGS__, GLV=__GLV__, GLR=__GLR__, UACH=__UACH__;
function def(o,k,v){try{Object.defineProperty(o,k,{get:function(){return v;},configurable:true});}catch(e){}}
def(navigator,'platform',P);
def(navigator,'vendor',VEND);
def(navigator,'language',LANGS[0]);
def(navigator,'languages',Object.freeze(LANGS.slice()));
try{
  var NUA=window.NavigatorUAData;
  // Only the OS-revealing fields need spoofing; keep the real brands /
  // fullVersionList / model so the object stays as native as possible.
  var over=function(r){r=r||{};r.platform=UACH.platform;r.platformVersion=UACH.platformVersion;r.architecture=UACH.architecture;r.bitness=UACH.bitness;r.wow64=UACH.wow64;return r;};
  if(NUA&&NUA.prototype){
    // Patch the PROTOTYPE so navigator.userAgentData stays a genuine
    // NavigatorUAData instance (passes instanceof / native checks) and only the
    // OS bits change.
    try{Object.defineProperty(NUA.prototype,'platform',{get:function(){return UACH.platform;},configurable:true});}catch(e){}
    try{
      var g=NUA.prototype.getHighEntropyValues;
      var patched=function(h){try{return Promise.resolve(g.call(this,h)).then(over);}catch(e){return Promise.resolve(over({brands:UACH.brands,fullVersionList:UACH.fullVersionList,mobile:UACH.mobile,model:UACH.model,uaFullVersion:UACH.uaFullVersion}));}};
      try{patched.toString=function(){return g.toString();};}catch(e){}
      Object.defineProperty(NUA.prototype,'getHighEntropyValues',{value:patched,writable:true,configurable:true});
    }catch(e){}
  }else{
    // Fallback (engine without a NavigatorUAData global): object replacement.
    def(navigator,'userAgentData',{brands:UACH.brands,mobile:UACH.mobile,platform:UACH.platform,
      getHighEntropyValues:function(h){return Promise.resolve(over({brands:UACH.brands,fullVersionList:UACH.fullVersionList,mobile:UACH.mobile,model:UACH.model,uaFullVersion:UACH.uaFullVersion}));},
      toJSON:function(){return {brands:UACH.brands,mobile:UACH.mobile,platform:UACH.platform};}});
  }
}catch(e){}
function patchGL(proto){
  if(!proto||!proto.getParameter)return;
  var g=proto.getParameter;
  function getParameter(x){if(x===37445)return GLV;if(x===37446)return GLR;return g.apply(this,arguments);}
  try{getParameter.toString=function(){return 'function getParameter() { [native code] }';};}catch(e){}
  proto.getParameter=getParameter;
}
try{patchGL(window.WebGLRenderingContext&&WebGLRenderingContext.prototype);}catch(e){}
try{patchGL(window.WebGL2RenderingContext&&WebGL2RenderingContext.prototype);}catch(e){}
})();"""


def _write_fp_extension(os_name: str, major: str, full: str, lang_list: list) -> str:
    """Generate a per-session unpacked MV3 extension whose MAIN-world,
    document_start content script spoofs navigator.platform / userAgentData /
    languages / WebGL. Returns the extension directory (loaded via
    --load-extension). Caller cleans it up on session close."""
    import json, tempfile
    prof = _fp_profile(os_name, major, full)
    langs = lang_list or ["en-US", "en"]
    js = _FP_EXT_JS
    for tok, val in (
        ("__PLATFORM__", prof["platform"]),
        ("__VENDOR__", prof["vendor"]),
        ("__LANGS__", langs),
        ("__GLV__", prof["webgl_vendor"]),
        ("__GLR__", prof["webgl_renderer"]),
        ("__UACH__", prof["ua_ch"]),
    ):
        js = js.replace(tok, json.dumps(val))
    manifest = {
        "manifest_version": 3,
        "name": "fp",
        "version": "1.0",
        "content_scripts": [{
            "matches": ["<all_urls>"],
            "js": ["fp.js"],
            "run_at": "document_start",
            "all_frames": True,
            "world": "MAIN",
        }],
    }
    d = tempfile.mkdtemp(prefix="cf-fp-ext-")
    with open(os.path.join(d, "manifest.json"), "w") as f:
        json.dump(manifest, f)
    with open(os.path.join(d, "fp.js"), "w") as f:
        f.write(js)
    return d


def _apply_fingerprint(sb, proxy=None, fp=None):
    """Overlay a consistent OS fingerprint on this session via CDP.

    `fp` is the per-session config from POST /sessions ({os,timezone,locale,
    auto_geo}); when absent, falls back to the FINGERPRINT_* env defaults. No-op
    unless an OS profile is selected. Must be RE-APPLIED after every
    uc_open_with_reconnect (that drops CDP overrides).
    """
    fp = fp or {}
    os_name = (fp.get("os") or FINGERPRINT_OS or "").strip().lower()
    if os_name not in ("windows", "mac"):
        return
    man_tz = (fp.get("timezone") if fp.get("timezone") is not None else FINGERPRINT_TZ) or ""
    man_locale = (fp.get("locale") if fp.get("locale") is not None else FINGERPRINT_LOCALE) or ""
    auto_geo = fp.get("auto_geo") if fp.get("auto_geo") is not None else FINGERPRINT_AUTOGEO
    try:
        import re as _re
        ver = _get_chrome_version(_CHROME_BIN) or ""
        m = _re.search(r"(\d+)\.\d+\.\d+\.\d+", ver)
        full = m.group(0) if m else "150.0.0.0"
        major = full.split(".")[0]

        # Prefer values already resolved before launch (create_session) so we
        # don't run geo detection twice; fall back to resolving here for the
        # env-default warm-pool path.
        if fp.get("_tz") is not None or fp.get("_locale") is not None:
            tz, locale = fp.get("_tz") or "", fp.get("_locale") or ""
        else:
            tz, locale = _resolve_tz_locale(proxy, man_tz, man_locale, auto_geo)
        langs = FINGERPRINT_LANGS or (f"{locale},{locale.split('-')[0]},en" if locale else "en-US,en")
        lang_list = [x.strip() for x in langs.split(",") if x.strip()]

        prof = _fp_profile(os_name, major, full)
        ua = fp.get("_ua") or prof["ua"]
        platform = prof["platform"]
        webgl_vendor = prof["webgl_vendor"]
        webgl_renderer = prof["webgl_renderer"]
        meta = prof["ua_ch"]

        sb.driver.execute_cdp_cmd("Network.setUserAgentOverride", {
            "userAgent": ua,
            "platform": platform,
            "acceptLanguage": ",".join(lang_list) or "en-US,en",
            "userAgentMetadata": meta,
        })
        if tz:
            try:
                sb.driver.execute_cdp_cmd("Emulation.setTimezoneOverride", {"timezoneId": tz})
            except Exception:
                pass
        if locale:
            try:
                sb.driver.execute_cdp_cmd("Emulation.setLocaleOverride", {"locale": locale})
            except Exception:
                pass

        init_js = (
            "(function(){"
            "try{Object.defineProperty(navigator,'platform',{get:function(){return %s;}});}catch(e){}"
            "try{Object.defineProperty(navigator,'vendor',{get:function(){return 'Google Inc.';}});}catch(e){}"
            "try{var L=%s;Object.defineProperty(navigator,'languages',{get:function(){return L;}});}catch(e){}"
            "function P(p){if(!p)return;var g=p.getParameter;p.getParameter=function(x){"
            "if(x===37445)return %s;if(x===37446)return %s;return g.call(this,x);};}"
            "try{P(window.WebGLRenderingContext&&WebGLRenderingContext.prototype);}catch(e){}"
            "try{P(window.WebGL2RenderingContext&&WebGL2RenderingContext.prototype);}catch(e){}"
            "})();"
        ) % (
            repr(platform),
            "[" + ",".join(repr(x) for x in lang_list) + "]",
            repr(webgl_vendor),
            repr(webgl_renderer),
        )
        sb.driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": init_js})
        print(
            f"[fingerprint] applied {os_name} profile "
            f"(Chrome {major}, tz={tz or 'default'}, locale={locale})",
            flush=True,
        )
    except Exception as e:
        print(f"[fingerprint] failed to apply: {e}", flush=True)


# ── Speech-to-text (reCAPTCHA audio solver) ──────────────────────────────────
# Local faster-whisper runs offline on CPU: no API key, no per-IP rate limit,
# no future paywall. The model is loaded once and reused across sessions.

_whisper_model = None
_whisper_lock = threading.Lock()


def _get_whisper():
    global _whisper_model
    if _whisper_model is None:
        with _whisper_lock:
            if _whisper_model is None:
                from faster_whisper import WhisperModel
                size = os.getenv("WHISPER_MODEL", "small")
                _whisper_model = WhisperModel(size, device="cpu", compute_type="int8")
                print(f"[whisper] model loaded: {size}", flush=True)
    return _whisper_model


def _normalize_answer(text: str) -> str:
    # reCAPTCHA audio answers are lowercase words/digits separated by spaces.
    cleaned = "".join(c if (c.isalnum() or c.isspace()) else " " for c in (text or "").lower())
    return " ".join(cleaned.split())


def _transcribe_bytes(data: bytes, engine: str = "whisper") -> str:
    """Transcribe raw audio bytes (reCAPTCHA serves MP3) to text."""
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(data)
        path = f.name
    try:
        if engine == "google":
            # Convert to 16 kHz mono WAV and use the free Google endpoint.
            import speech_recognition as sr
            from pydub import AudioSegment
            wav_path = path + ".wav"
            AudioSegment.from_file(path).set_channels(1).set_frame_rate(16000).export(wav_path, format="wav")
            try:
                r = sr.Recognizer()
                with sr.AudioFile(wav_path) as source:
                    audio = r.record(source)
                return _normalize_answer(r.recognize_google(audio) or "")
            finally:
                try:
                    os.unlink(wav_path)
                except Exception:
                    pass
        # default: local faster-whisper
        model = _get_whisper()
        segments, _info = model.transcribe(path, language="en", beam_size=5)
        return _normalize_answer(" ".join(seg.text for seg in segments))
    finally:
        try:
            os.unlink(path)
        except Exception:
            pass


# ── SessionThread ────────────────────────────────────────────────────────────

class SessionThread:
    """One Chrome session running in a dedicated thread (Selenium is not thread-safe)."""

    def __init__(self, proxy: str = None, fingerprint: dict = None):
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
        # Per-session fingerprint config; may carry pre-resolved "_tz"/"_locale"
        # (computed in create_session before launch). timezone -> Chrome TZ env,
        # locale -> --lang launch flag (both applied at launch in _worker), plus
        # UA/UA-CH/platform/WebGL re-applied via CDP after uc_open_with_reconnect.
        self.fingerprint = fingerprint if isinstance(fingerprint, dict) else None
        # Temp dir of the per-session fingerprint extension (if any); cleaned up
        # on close.
        self._fp_ext_dir = None
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
                    args = list(_CHROMIUM_ARGS)
                    # LAUNCH-LEVEL fingerprint: timezone via Chrome's TZ env
                    # (injected in the popen patch) and language via --lang, both
                    # of which survive uc_open_with_reconnect (CDP overrides do
                    # not). Pre-resolved in create_session as _tz/_locale.
                    _thread_local.chrome_tz = None
                    _fp = self.fingerprint or {}
                    _fp_tz = _fp.get("_tz")
                    _fp_locale = _fp.get("_locale")
                    _fp_ua_str = _fp.get("_ua")
                    if _fp_tz:
                        _thread_local.chrome_tz = _fp_tz
                    if _fp_locale:
                        args.append(f"--lang={_fp_locale}")
                    if _fp_ua_str:
                        # Launch-level UA: survives uc_open_with_reconnect, so the
                        # real "X11; Linux" UA is never exposed on the landing
                        # page (the CDP override alone re-applied too late).
                        args.append(f"--user-agent={_fp_ua_str}")
                    if _fp_tz or _fp_locale or _fp_ua_str:
                        print(
                            f"[fingerprint] launch flags tz={_fp_tz or '-'} "
                            f"lang={_fp_locale or '-'} ua={'set' if _fp_ua_str else '-'}",
                            flush=True,
                        )
                    # LAUNCH-LEVEL fingerprint (JS side): a MAIN-world extension
                    # that spoofs navigator.platform / userAgentData / languages /
                    # WebGL before any page script runs. Unlike the CDP overlay it
                    # survives uc_open_with_reconnect and never touches CDP, so it
                    # reaches the landing page + Turnstile without re-exposing
                    # automation to Cloudflare.
                    _fp_os_name = (_fp.get("os") or "").strip().lower()
                    if _fp_os_name in ("windows", "mac"):
                        try:
                            import re as _re2
                            _cver = _get_chrome_version(_CHROME_BIN) or ""
                            _cm = _re2.search(r"(\d+\.\d+\.\d+\.\d+)", _cver)
                            _cfull = _cm.group(1) if _cm else "150.0.0.0"
                            _cmajor = _cfull.split(".")[0]
                            _loc = _fp_locale or "en-US"
                            _langs_str = FINGERPRINT_LANGS or (
                                f"{_loc},{_loc.split('-')[0]},en" if _loc else "en-US,en")
                            _llist = [x.strip() for x in _langs_str.split(",") if x.strip()]
                            _ext_dir = _write_fp_extension(_fp_os_name, _cmajor, _cfull, _llist)
                            args.append(f"--disable-extensions-except={_ext_dir}")
                            args.append(f"--load-extension={_ext_dir}")
                            self._fp_ext_dir = _ext_dir
                            print(
                                f"[fingerprint] MAIN-world extension loaded "
                                f"({_fp_os_name}, Chrome {_cmajor}, langs={_llist})",
                                flush=True,
                            )
                        except Exception as _ee:
                            print(f"[fingerprint] extension build failed: {_ee}", flush=True)
                    chrome_args = _join_chromium_args(args)
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
                        is_socks = (
                            proxy.startswith("socks5://") or proxy.startswith("socks5h://")
                            or proxy.startswith("socks4://") or proxy.startswith("socks4a://")
                            or proxy.startswith("socks://")
                        )
                        # Normalise every SOCKS variant to socks5:// for Chrome's
                        # --proxy-server (it does remote DNS for socks5 anyway).
                        # socks5h:// in particular was NOT recognised before, so it
                        # fell through to SB(proxy=socks5h://…) and failed with
                        # "Proxy String is NOT in the expected format".
                        for _scheme in ("socks://", "socks5h://", "socks4a://"):
                            if proxy.startswith(_scheme):
                                proxy = "socks5://" + proxy.split("//", 1)[1]
                                break
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
                        # Overlay an OS fingerprint (opt-in; no-op unless
                        # FINGERPRINT_OS is set) before the session serves goto.
                        _apply_fingerprint(sb, self.proxy, self.fingerprint)
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
        if self._fp_ext_dir:
            try:
                import shutil
                shutil.rmtree(self._fp_ext_dir, ignore_errors=True)
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
    fp = (body or {}).get("fingerprint") if isinstance(body, dict) else None
    _fp_os = (fp.get("os") or "").strip().lower() if isinstance(fp, dict) else ""
    fp_on = _fp_os in ("windows", "mac")
    if fp_on:
        # Resolve timezone/locale + UA NOW so they can be baked into the Chrome
        # launch (TZ env + --lang + --user-agent). This is what makes them
        # reliable: the CDP overrides alone were racy across
        # uc_open_with_reconnect (some geos stuck, UA/platform sometimes fell
        # back to the real Linux values).
        man_tz = (fp.get("timezone") if fp.get("timezone") is not None else FINGERPRINT_TZ) or ""
        man_locale = (fp.get("locale") if fp.get("locale") is not None else FINGERPRINT_LOCALE) or ""
        auto_geo = fp.get("auto_geo") if fp.get("auto_geo") is not None else FINGERPRINT_AUTOGEO
        try:
            _tz, _locale = _resolve_tz_locale(proxy, man_tz, man_locale, auto_geo)
        except Exception as e:
            print(f"[fingerprint] tz/locale resolve failed: {e}", flush=True)
            _tz, _locale = man_tz, man_locale
        import re as _re
        _ver = _get_chrome_version(_CHROME_BIN) or ""
        _m = _re.search(r"(\d+)\.\d+\.\d+\.\d+", _ver)
        _major = _m.group(1) if _m else "150"
        fp = {**fp, "_tz": _tz, "_locale": _locale, "_ua": _fp_ua(_fp_os, _major)}
    try:
        if proxy or fp_on:
            # A proxy AND launch-level fingerprint (TZ env + --lang) must be set
            # at Chrome launch, so neither can come from the warm pool (those are
            # launched proxy-less and fingerprint-less). Cold-start a dedicated
            # session carrying both.
            s = SessionThread(proxy=proxy, fingerprint=(fp if fp_on else None))
        else:
            s = _pool.acquire()
    except Exception as e:
        return _err(str(e), 500)
    # Cold-started fingerprinted sessions already baked TZ/--lang in at launch
    # and applied the CDP overlay in _worker, so nothing more to do here.
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
            # DO NOT touch CDP here. The whole point of uc_open_with_reconnect is
            # that CDP is disconnected so Cloudflare can't see automation. An
            # embedded Turnstile widget keeps evaluating after the page loads, so
            # any execute_cdp_cmd / execute_script now (e.g. re-applying the
            # fingerprint) re-exposes the automation mid-validation and the widget
            # reports "Verification failed". The fingerprint's durable parts
            # (UA / timezone / language) are already baked in at launch and need
            # no CDP; platform/UA-CH are handled out-of-band, not here.

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


def _find_session_window(sb):
    """Return THIS session's Chrome window id on the shared Xvfb :99.

    All sessions share one display, so a physical click hits whatever window is
    stacked on top — often an idle warm-pool "New Tab" window rather than the
    task's page. Pick the window whose name matches this session's current page
    title (and is NOT "New Tab") so we raise/click the RIGHT one.
    """
    import subprocess
    try:
        target = (sb.driver.title or "").strip()
    except Exception:
        target = ""
    wids = []
    for cls in ["chrome", "chromium", "Chromium", "google-chrome"]:
        try:
            out = subprocess.run(
                ["xdotool", "search", "--onlyvisible", "--class", cls],
                capture_output=True, text=True, timeout=3,
            ).stdout
            wids = [w for w in out.split() if w.strip()]
            if wids:
                break
        except Exception:
            continue
    if not wids:
        return None
    best = None
    for w in wids:
        try:
            name = subprocess.run(
                ["xdotool", "getwindowname", w],
                capture_output=True, text=True, timeout=2,
            ).stdout.strip()
        except Exception:
            name = ""
        # Exact-ish match on the page title wins immediately.
        if target and len(target) > 2 and target[:32] in name:
            return w
        # Otherwise remember the first window that has navigated somewhere
        # (i.e. is not the pristine warm-pool "New Tab").
        if name and "New Tab" not in name and best is None:
            best = w
    return best or wids[0]


def _raise_window(wid):
    """Bring a window to the front + give it focus (best-effort)."""
    if not wid:
        return
    import subprocess
    for args in (
        ["xdotool", "windowactivate", "--sync", wid],
        ["xdotool", "windowraise", wid],
    ):
        try:
            subprocess.run(args, timeout=3, capture_output=True)
        except Exception:
            pass


def _human_mouse_drift(target_x=None, target_y=None):
    """Move the shared Xvfb :99 pointer along a jittery, eased, human-like path.

    Turnstile's behavioural check watches the pointer; a dead-static page scores
    bot-like. The previous mouse-sim did this from the app container with ONE
    HTTP round-trip PER move (100-200 moves = minutes), so it was cut. This does
    it NATIVELY with local xdotool: fast (~1-1.5s), and genuine OS-level input
    (isTrusted=true) that never touches CDP — so it can't re-expose automation.

    Caller must hold _gui_lock and have raised the right window (the pointer is
    shared across sessions on the one display).
    """
    import subprocess, random
    try:
        out = subprocess.run(
            ["xdotool", "getmouselocation", "--shell"],
            capture_output=True, text=True, timeout=2,
        ).stdout
        pos = {k: int(v) for k, v in (p.split("=", 1) for p in out.split() if "=" in p)
               if k in ("X", "Y")}
        x0, y0 = pos.get("X", 640), pos.get("Y", 400)
    except Exception:
        x0, y0 = 640, 400
    tx = target_x if target_x is not None else random.randint(480, 820)
    ty = target_y if target_y is not None else random.randint(340, 560)
    steps = random.randint(18, 30)
    for i in range(1, steps + 1):
        t = i / steps
        ease = t * t * (3 - 2 * t)  # smoothstep in/out
        x = x0 + (tx - x0) * ease + random.uniform(-6, 6)
        y = y0 + (ty - y0) * ease + random.uniform(-6, 6)
        try:
            subprocess.run(
                ["xdotool", "mousemove", "--sync", str(int(x)), str(int(y))],
                timeout=1, capture_output=True,
            )
        except Exception:
            pass
        time.sleep(random.uniform(0.01, 0.045))


def _element_abs_xy(sb, css, dx=0, dy_frac=0.5, wid=None):
    """Absolute Xvfb-screen coords of a point inside a TOP-LEVEL element (e.g. the
    reCAPTCHA anchor iframe) for an OS-level xdotool click. dx = px from the
    element's left edge, dy_frac = fraction of its height for y. Returns (x, y) or
    None. Call on default_content with the driver CONNECTED."""
    import subprocess
    try:
        rect = sb.execute_script(
            "var e=document.querySelector(arguments[0]);"
            "if(!e)return null;var r=e.getBoundingClientRect();"
            "return {x:r.x,y:r.y,w:r.width,h:r.height};", css)
    except Exception:
        rect = None
    if not rect or not rect.get("w"):
        return None
    win_x = win_y = title_bar = 0
    try:
        if wid is None:
            wid = _find_session_window(sb)
        if wid:
            _raise_window(wid)
            geo = subprocess.run(
                ["xdotool", "getwindowgeometry", "--shell", wid],
                capture_output=True, text=True, timeout=3,
            ).stdout
            for line in geo.strip().split("\n"):
                if line.startswith("X="):
                    win_x = int(line.split("=")[1])
                elif line.startswith("Y="):
                    win_y = int(line.split("=")[1])
            wi = sb.execute_script("return {oh:window.outerHeight,ih:window.innerHeight};")
            title_bar = max(0, (wi.get("oh", 0) - wi.get("ih", 0)))
    except Exception:
        pass
    ax = int(rect["x"]) + dx + win_x
    ay = int(rect["y"]) + int(rect["h"] * dy_frac) + win_y + title_bar
    return (ax, ay)


def _turnstile_token(sb):
    """Return the Turnstile response token (native OR reCAPTCHA-compat), or ''."""
    try:
        return sb.execute_script(
            "var q='input[name=\"cf-turnstile-response\"],textarea[name=\"cf-turnstile-response\"],"
            "textarea[name=\"g-recaptcha-response\"]';"
            "var els=document.querySelectorAll(q);"
            "for(var i=0;i<els.length;i++){if(els[i].value&&els[i].value.length>20)return els[i].value;}"
            "return '';"
        ) or ""
    except Exception:
        return ""


def _poll_turnstile_token(sb, secs):
    """Wait for the Turnstile token for up to `secs`.

    Cloudflare validates the click over the next few seconds and is watching for
    automation the whole time. Reading the token uses execute_script (CDP), so
    polling every second pokes the page throughout CF's validation window and
    itself trips 'Verification failed'. Instead stay SILENT for an initial quiet
    window (this is what the known-good 07-05 build did with a plain sleep), then
    check only sparingly."""
    quiet = min(3.0, secs)
    time.sleep(quiet)
    tok = _turnstile_token(sb)
    if tok and len(tok) > 20:
        return tok
    deadline = time.time() + max(0.0, secs - quiet)
    while time.time() < deadline:
        time.sleep(2)
        tok = _turnstile_token(sb)
        if tok and len(tok) > 20:
            return tok
    return _turnstile_token(sb)


def _detached_wait(sb, secs, during=None):
    """Wait `secs` with the chromedriver/CDP session DETACHED.

    THE crux of embedded-Turnstile solving: the widget keeps evaluating after the
    page loads, and if an automation/DevTools session is attached while it does,
    Cloudflare detects it and fails the widget — the exact reason
    uc_open_with_reconnect disconnects during full-page challenges. We were never
    disconnecting for the embedded widget (token reads / form fill / window lookup
    all keep the driver attached), so CF failed it every time.

    Detach, optionally run `during()` (OS-level xdotool still reaches the browser
    while detached), let CF verify/validate completely undisturbed, then reattach.
    Falls back to a plain connected sleep if this SB build lacks disconnect()."""
    detached = False
    try:
        sb.driver.disconnect()
        detached = True
    except Exception:
        pass
    if during:
        try:
            during()
        except Exception:
            pass
    time.sleep(secs)
    if detached:
        for _ in range(4):
            try:
                sb.driver.connect()
                return
            except Exception:
                time.sleep(1)


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

        # Already solved (managed / auto mode)?
        tok = _turnstile_token(sb)
        if tok and len(tok) > 20:
            return {"solved": True, "method": "auto", "attempt": 0}

        # Raise THIS session's window (needs the driver) so the pointer/click land
        # on the task page and not an idle warm-pool "New Tab".
        try:
            with _gui_lock:
                _raise_window(_find_session_window(sb))
        except Exception:
            pass

        # Non-interactive Turnstile (the "Verifying..." spinner) issues a token on
        # its own — it just needs TIME and a live pointer, with NO automation
        # attached. Detach the driver, drift the mouse (OS-level, still works while
        # detached), and let CF verify undisturbed, then reattach and check.
        def _drift():
            try:
                with _gui_lock:
                    _human_mouse_drift()
            except Exception:
                pass

        _detached_wait(sb, 16, during=_drift)
        tok = _turnstile_token(sb)
        if tok and len(tok) > 20:
            return {"solved": True, "method": "auto-wait", "attempt": 0}

        # Still no token -> treat it as an INTERACTIVE widget that needs a
        # checkbox click. ONE click per attempt, then WAIT for CF to validate —
        # do NOT combine uc_gui + xdotool in the same pass or loop fast. Rapid
        # repeated clicks on the checkbox make Turnstile report "Verification
        # failed".
        for attempt in range(max_retries):
            method = "uc_gui" if attempt == 0 else "xdotool"

            if method == "uc_gui":
                # Strategy 1: SB's built-in PyAutoGUI clicker. Raise THIS session's
                # window first so the OS-level click lands on the task page and not
                # an idle warm-pool "New Tab" stacked on the shared Xvfb :99.
                try:
                    with _gui_lock:
                        _raise_window(_find_session_window(sb))
                        time.sleep(0.3)
                        sb.uc_gui_click_captcha()
                except Exception:
                    pass
                # Validate the click with the driver DETACHED (see _detached_wait).
                _detached_wait(sb, 8)
                tok = _turnstile_token(sb)
                if tok and len(tok) > 20:
                    return {"solved": True, "method": "uc_gui", "attempt": attempt + 1}
                continue

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
                    wid = None
                    try:
                        # Pick + raise THIS session's window (not an idle warm-pool
                        # "New Tab" window stacked on top of the shared Xvfb :99).
                        wid = _find_session_window(sb)
                        if wid:
                            _raise_window(wid)
                            time.sleep(0.3)
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
                            # Re-raise inside the lock so a concurrent session
                            # can't steal the top window between raise and click.
                            _raise_window(wid)
                            subprocess.run(
                                ["xdotool", "mousemove", "--sync", str(abs_x), str(abs_y)],
                                timeout=3, capture_output=True,
                            )
                            subprocess.run(["xdotool", "click", "1"], timeout=2, capture_output=True)
                            time.sleep(1)
                            # ── Diagnostic ────────────────────────────────────
                            # Grab the WHOLE Xvfb :99 screen WITH the pointer
                            # (scrot -p) so we can see exactly where the physical
                            # click landed relative to the Turnstile checkbox —
                            # the definitive way to tell a coordinate miss from a
                            # CF rejection. Retrieve after a run with:
                            #   docker compose cp cf-proxy:/tmp/cf-turnstile-last.png ./
                            try:
                                subprocess.run(
                                    ["scrot", "-p", "-o", "/tmp/cf-turnstile-last.png"],
                                    timeout=5, capture_output=True,
                                )
                                print(
                                    "[turnstile] saved screen diagnostic to "
                                    f"/tmp/cf-turnstile-last.png (cursor aimed at {abs_x},{abs_y})",
                                    flush=True,
                                )
                            except Exception:
                                pass
                    except Exception:
                        pass
            except Exception:
                pass

            # Validate this SINGLE xdotool click with the driver DETACHED (see
            # _detached_wait) — no fast re-clicks, no attached automation session.
            _detached_wait(sb, 8)
            tok = _turnstile_token(sb)
            if tok and len(tok) > 20:
                return {"solved": True, "method": "xdotool", "attempt": attempt + 1}

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


@app.route("/transcribe", methods=["POST"])
def transcribe():
    """Speech-to-text for the reCAPTCHA audio solver.

    Accepts the audio either as a raw body (Content-Type audio/* or
    application/octet-stream) or as JSON {"audio_b64": ...} / {"url": ...}.
    Query/JSON `engine` selects "whisper" (default, local) or "google".
    Shared by the Playwright backend (which downloads the mp3 itself and POSTs
    it here) and the cf-proxy native solver.
    """
    engine = request.args.get("engine")
    if not engine and request.is_json:
        engine = (request.json or {}).get("engine")
    engine = (engine or os.getenv("STT_ENGINE", "whisper")).lower()
    data = None
    try:
        if request.is_json:
            body = request.json or {}
            if body.get("audio_b64"):
                import base64
                data = base64.b64decode(body["audio_b64"])
            elif body.get("url"):
                import requests as _rq
                data = _rq.get(body["url"], timeout=30).content
        else:
            data = request.get_data()
    except Exception as e:
        return _err(f"failed to read audio: {e}", 400)
    if not data:
        return _err("no audio provided", 400)
    try:
        text = _transcribe_bytes(data, engine=engine)
        return jsonify({"ok": True, "text": text, "engine": engine})
    except Exception as e:
        return _err(str(e), 500)


@app.route("/sessions/<sid>/solve-recaptcha-audio", methods=["POST"])
def solve_recaptcha_audio(sid):
    """Solve a reCAPTCHA v2 checkbox via its audio challenge, natively in
    Selenium (cross-origin frame switching) + local Whisper. Mirrors the
    oyz8/Host2Play approach. Returns {solved, blocked, message}."""
    s = _get(sid)
    if not s:
        return _err("Session not found")
    body = request.json or {}
    max_rounds = int(body.get("max_rounds", 4))
    timeout = int(body.get("timeout", 120))
    engine = (body.get("engine") or os.getenv("STT_ENGINE", "whisper")).lower()

    def _fn(sb):
        import requests as _rq
        d = sb.driver

        def token_present():
            try:
                return bool(sb.execute_script(
                    "var t=document.querySelector(\"textarea#g-recaptcha-response, "
                    "textarea[name='g-recaptcha-response']\");"
                    "return !!(t && t.value && t.value.length>0);"
                ))
            except Exception:
                return False

        def find(css):
            from selenium.webdriver.common.by import By
            return d.find_element(By.CSS_SELECTOR, css)

        if token_present():
            return {"solved": True, "blocked": False, "message": "already solved"}

        # 1. Click the anchor checkbox — OS-level (xdotool) with the driver
        # DETACHED while reCAPTCHA scores it. A WebDriver click with the
        # automation session attached is exactly what reCAPTCHA flags as a bot;
        # an OS-level trusted click on a detached driver (plus a Windows
        # fingerprint + residential IP) is what actually passes on the checkbox.
        d.switch_to.default_content()
        _anchor_css = ("iframe[src*='api2/anchor'], "
                       "iframe[src*='recaptcha/api2/anchor'], "
                       "iframe[src*='enterprise/anchor']")
        try:
            _wid = _find_session_window(sb)
        except Exception:
            _wid = None
        cbxy = _element_abs_xy(sb, _anchor_css, dx=30, dy_frac=0.5, wid=_wid)
        if cbxy:
            def _click_checkbox():
                import subprocess
                try:
                    with _gui_lock:
                        _raise_window(_wid)
                        _human_mouse_drift(cbxy[0], cbxy[1])
                        subprocess.run(
                            ["xdotool", "mousemove", "--sync", str(cbxy[0]), str(cbxy[1])],
                            timeout=2, capture_output=True,
                        )
                        subprocess.run(["xdotool", "click", "1"], timeout=2, capture_output=True)
                except Exception:
                    pass
            # detach → drift+click (OS-level) → let reCAPTCHA score undisturbed → reconnect
            _detached_wait(sb, 3, during=_click_checkbox)
        else:
            # Couldn't locate the anchor iframe — fall back to a WebDriver click.
            try:
                anchor = find(_anchor_css)
                d.switch_to.frame(anchor)
                find("#recaptcha-anchor, .recaptcha-checkbox").click()
            except Exception:
                pass
            finally:
                d.switch_to.default_content()
            time.sleep(2)
        if token_present():
            return {"solved": True, "blocked": False, "message": "passed on checkbox"}

        # 2. Switch the challenge frame to audio mode.
        try:
            bframe = find("iframe[src*='api2/bframe'], iframe[src*='recaptcha/api2/bframe'], iframe[src*='enterprise/bframe']")
            d.switch_to.frame(bframe)
        except Exception:
            d.switch_to.default_content()
            return {"solved": False, "blocked": False, "message": "reCAPTCHA challenge frame (bframe) not found"}
        try:
            find("#recaptcha-audio-button, button.rc-button-audio").click()
            time.sleep(1.5)
        except Exception:
            pass

        # 3. Audio rounds.
        for rnd in range(max_rounds):
            # Blocked for this IP?
            try:
                blk = find(".rc-doscaptcha-header-text, .rc-audiochallenge-error-message").text or ""
                if "try again later" in blk.lower() or "automated queries" in blk.lower():
                    d.switch_to.default_content()
                    return {"solved": False, "blocked": True,
                            "message": "reCAPTCHA blocked the audio challenge for this IP (rotate proxy/WARP)"}
            except Exception:
                pass

            audio_url = None
            try:
                audio_url = find(".rc-audiochallenge-tdownload-link").get_attribute("href")
            except Exception:
                pass
            if not audio_url:
                try:
                    audio_url = find("#audio-source").get_attribute("src")
                except Exception:
                    pass
            if not audio_url:
                time.sleep(1.5)
                continue

            try:
                data = _rq.get(audio_url, timeout=30).content
            except Exception:
                time.sleep(1)
                continue
            if not data:
                time.sleep(1)
                continue

            try:
                answer = _transcribe_bytes(data, engine=engine)
            except Exception as e:
                d.switch_to.default_content()
                return {"solved": False, "blocked": False, "message": f"transcription failed: {e}"}
            if not answer:
                time.sleep(1)
                continue

            try:
                inp = find("#audio-response, input.rc-audiochallenge-response-field")
                inp.clear()
                inp.send_keys(answer)
                find("#recaptcha-verify-button, button.rc-audiochallenge-verify-button").click()
            except Exception:
                pass

            # Validate the submitted answer with the driver DETACHED (reCAPTCHA
            # watches for the automation session while it verifies, same as CF).
            d.switch_to.default_content()
            _detached_wait(sb, 3)
            if token_present():
                return {"solved": True, "blocked": False, "message": f"solved via audio (round {rnd + 1})"}
            # Re-enter bframe for the next clip.
            try:
                bframe = find("iframe[src*='api2/bframe'], iframe[src*='recaptcha/api2/bframe'], iframe[src*='enterprise/bframe']")
                d.switch_to.frame(bframe)
            except Exception:
                pass
            time.sleep(1)

        d.switch_to.default_content()
        return {"solved": False, "blocked": False, "message": f"not solved after {max_rounds} audio rounds"}

    try:
        result = s.run(_fn, timeout=timeout + 15)
        return jsonify({"ok": True, **result})
    except Exception as e:
        return _err(str(e), 500)


if __name__ == "__main__":
    print(f"CF Proxy starting on port {PORT} (pool size: {POOL_SIZE})", flush=True)
    app.run(host="0.0.0.0", port=PORT, threaded=True)
