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

# FIXED fingerprint (from a saved profile):
#  _fp_pickle → a pickled browserforge Fingerprint → launch_server(fingerprint=...),
#              reproduces the EXACT same fingerprint every launch.
#  _preset    → a real captured preset dict → launch_server(fingerprint_preset=...).
# Both funnel into config internally (from_browserforge / from_preset), same as a fresh
# generation — just fixed. When neither is set, Camoufox generates a fresh one from os.
_fp_b64 = cfg.pop("_fp_pickle", None)
_preset = cfg.pop("_preset", None)
if _fp_b64:
    import base64
    import pickle
    cfg["fingerprint"] = pickle.loads(base64.b64decode(_fp_b64))
    # A pinned fingerprint carries its own screen — don't also constrain it.
    cfg.pop("screen", None)
elif _preset:
    cfg["fingerprint_preset"] = _preset
    cfg.pop("screen", None)

scr = cfg.pop("screen", None)
if isinstance(scr, dict) and scr.get("width") and scr.get("height"):
    try:
        from browserforge.fingerprints import Screen
        w, h = int(scr["width"]), int(scr["height"])
        # Pin the fingerprint's screen to exactly this resolution.
        cfg["screen"] = Screen(min_width=w, max_width=w, min_height=h, max_height=h)
    except Exception:
        pass  # fall back to Camoufox's own random screen

# Bind the Playwright ws server to ALL interfaces, not just loopback. The api-server
# runs in a SEPARATE container and connects across the docker network; the default bind
# only reports a loopback host (ws://[::1]:PORT), which the api-server can't reach
# (ECONNREFUSED). This key falls through launch_options' **kwargs into Playwright's
# launchServer({host}). The api-server rewrites the reported host to the camoufox-proxy
# service name, so the actual reachable address is host=camoufox-proxy:PORT.
cfg["host"] = "0.0.0.0"

launch_server(**cfg)
