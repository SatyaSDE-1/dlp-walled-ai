"""Build the shared document initialization script returned by the init_script operation."""

from __future__ import annotations

import json
from importlib import resources

from . import config


def build_init_script(color: str = config.RESPONSE_COLOR, debug: bool = False) -> str:
    cfg = {
        "marker": config.MARKER,
        "color": color,
        "maxFileBytes": config.MAX_FILE_BYTES,
        "debug": debug,
        "sites": [s.to_js() for s in config.SITES],
    }
    js = (resources.files("dlp") / "inject" / "guard.js").read_text(encoding="utf-8")
    return f"""(() => {{
        const config = {json.dumps(cfg)};
        window.__WALLED_CONFIG__ = config;
        {js}
        const host = location.hostname.toLowerCase();
        const site = config.sites.find((entry) => entry.hosts.some((name) => host === name || host.endsWith('.' + name)));
        if (site) installWalledGuard(config, site, (action) => window.__walledScan(action));
    }})();"""
