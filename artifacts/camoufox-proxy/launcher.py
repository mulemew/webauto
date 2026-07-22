"""Launch ONE Camoufox Playwright server from a JSON config in $CAMOUFOX_CFG.

Runs as a subprocess of server.py. Camoufox/browserforge want a `Screen` OBJECT (it
calls screen.is_set()), not a plain dict — so we convert `screen: {width,height}` here,
inside the process that has camoufox importable. launch_server() blocks and prints the
ws:// endpoint to stdout, which server.py reads back.
"""
import json
import os

from camoufox.server import launch_server

cfg = json.loads(os.environ["CAMOUFOX_CFG"])

scr = cfg.pop("screen", None)
if isinstance(scr, dict) and scr.get("width") and scr.get("height"):
    try:
        from browserforge.fingerprints import Screen
        w, h = int(scr["width"]), int(scr["height"])
        # Pin the fingerprint's screen to exactly this resolution.
        cfg["screen"] = Screen(min_width=w, max_width=w, min_height=h, max_height=h)
    except Exception:
        pass  # fall back to Camoufox's own random screen

launch_server(**cfg)
