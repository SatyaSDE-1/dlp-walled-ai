"""Policy and browser configuration. DOM selectors are shared with Electron."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from importlib import resources
from typing import List

# --------------------------------------------------------------------------- #
# Policy
# --------------------------------------------------------------------------- #
_DOM_CONFIG = json.loads((resources.files("dlp") / "inject" / "config.json").read_text(encoding="utf-8"))
MARKER = _DOM_CONFIG["marker"]

# Colour applied to every AI-generated response (any valid CSS colour).
RESPONSE_COLOR = _DOM_CONFIG["color"]

# Files larger than this are blocked before reading or scanning their contents.
MAX_FILE_BYTES = _DOM_CONFIG["maxFileBytes"]

# Files that exceed an inspection limit are blocked.
MAX_OCR_IMAGES_PER_PDF = 25
MAX_PDF_PAGES_RENDERED = 15
MAX_IMAGE_FRAMES = 5
MAX_IMAGE_PIXELS = 25_000_000
MAX_ARCHIVE_EXPANDED_BYTES = 60 * 1024 * 1024
MAX_ARCHIVE_DEPTH = 4  # Includes the uploaded archive itself.
MAX_ARCHIVE_MEMBERS = 10_000  # Across all nested archives.

# --------------------------------------------------------------------------- #
# Supported sites
# --------------------------------------------------------------------------- #
RESPONSE_SELECTORS = {
    "chatgpt": [
        "[data-message-role='assistant']",
        "[data-message-author-role='assistant']",
        "[data-turn='assistant']",
    ],
    "perplexity": [
        "[data-workflow-final-text] .prose",
        "[data-workflow-final-text] [data-renderer='lm']",
        "[id^='markdown-content-']",
        "[data-testid='answer']",
    ],
}

_USER_MESSAGE_SELECTORS = [
    "[data-message-role='user']",
    "[data-message-author-role='user']",
    "[data-turn='user']",
    "[data-testid='user-message']",
]
USER_MESSAGE_SELECTORS = {
    "chatgpt": [*_USER_MESSAGE_SELECTORS],
    "perplexity": [
        *_USER_MESSAGE_SELECTORS,
        "[data-message-bubble='right']",
        "[data-testid='query']",
        "[data-testid='user-query']",
    ],
}


@dataclass(frozen=True)
class Site:
    name: str
    hosts: List[str]
    # The prompt box. Used to decide "is this Enter key a prompt submission?".
    composer_selectors: List[str]
    # The send / submit button(s).
    send_selectors: List[str]
    # Containers holding AI-generated answers. Colour is applied to them and descendants.
    response_selectors: List[str]
    user_message_selectors: List[str] = field(default_factory=list)

    def to_js(self) -> dict:
        return {
            "name": self.name,
            "hosts": self.hosts,
            "composerSelectors": self.composer_selectors,
            "sendSelectors": self.send_selectors,
            **self.response_style(),
        }

    def response_style(self) -> dict:
        return {
            "responseSelectors": self.response_selectors,
            "userMessageSelectors": self.user_message_selectors,
        }


def _site(site_id: str) -> Site:
    site = _DOM_CONFIG["sites"][site_id]
    return Site(
        name=site["name"],
        hosts=site["hosts"],
        composer_selectors=site["composerSelectors"],
        send_selectors=site["sendSelectors"],
        response_selectors=RESPONSE_SELECTORS[site_id],
        user_message_selectors=USER_MESSAGE_SELECTORS[site_id],
    )


CHATGPT = _site("chatgpt")
PERPLEXITY = _site("perplexity")

SITES: List[Site] = [CHATGPT, PERPLEXITY]


def response_style_config() -> dict:
    return {
        "color": RESPONSE_COLOR,
        "sites": {"chatgpt": CHATGPT.response_style(), "perplexity": PERPLEXITY.response_style()},
    }
