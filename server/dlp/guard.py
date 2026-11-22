# /Users/anurag/waller-ai/walled-dlp/walled-dlp/server/dlp/guard.py

"""Decision engine: scan -> ask the user -> allow / block.

The IPC dispatcher forwards three kinds of requests here:

* ``on_prompt``   - from the injected JS, when the user presses Enter / Send.
* ``on_file``     - from the injected JS, for every file about to be attached.
* ``on_request``  - a JSON request body supplied by an IPC caller.

Everything that talks to the user goes through ``self._confirm`` which serialises dialogs
(only one on screen at a time) and runs the blocking native dialog off the event loop.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
from typing import Callable, Iterable

from . import config
from .dialog import Detection, confirm
from .scanner import Scanner, ScanResult

log = logging.getLogger("dlp.guard")


def blocked(code: str, message: str) -> dict:
    return {"allow": False, "error": {"code": code, "message": message}}


class Guard:
    def __init__(self, scanner: Scanner | None = None,
                 dialog: Callable[[Detection], bool] = confirm) -> None:
        self.scanner = scanner or Scanner()
        self._dialog = dialog
        self._dialog_lock = asyncio.Lock()

    # ------------------------------------------------------------------ #
    # Entry points
    # ------------------------------------------------------------------ #
    async def on_prompt(self, payload: dict) -> dict:
        """payload: {site, text}"""
        site, text = payload.get("site"), payload.get("text")
        if not isinstance(site, str) or not isinstance(text, str):
            return blocked("bad_prompt", "The prompt could not be read.")
        try:
            found = self._prompt_has_marker(text)
        except Exception as exc:
            log.warning("Prompt scan failed (%s)", type(exc).__name__)
            return blocked("prompt_scan_failed", "The prompt could not be scanned.")
        if not found:
            return {"allow": True}

        return await self._confirm(Detection("prompt", site, text))

    async def on_file(self, payload: dict) -> dict:
        """Inspect the decoded file and validate its browser-supplied metadata."""
        name, site, size = payload.get("name"), payload.get("site"), payload.get("size")
        mime_type = payload.get("mimeType", "")
        if (not isinstance(name, str) or not isinstance(site, str) or type(size) is not int or size < 0
                or not isinstance(mime_type, str) or len(mime_type) > 1024):
            return blocked("bad_file", "The file metadata is invalid.")
        limit = config.MAX_FILE_BYTES
        if size > limit:
            return blocked("file_too_large", f"The file exceeds the {limit}-byte scan limit.")
        b64 = payload.get("b64")
        if not isinstance(b64, str):
            return blocked("file_unreadable", "The file could not be read.")
        if len(b64) > 4 * ((limit + 2) // 3):
            return blocked("file_too_large", f"The file exceeds the {limit}-byte scan limit.")
        try:
            data = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError):
            return blocked("file_decode_failed", "The file data is invalid base64.")
        if len(data) > limit:
            return blocked("file_too_large", f"The file exceeds the {limit}-byte scan limit.")
        if len(data) != size:
            return blocked("file_size_mismatch", "The file data does not match the selected file size.")

        try:
            result = await asyncio.to_thread(self.scanner.scan_file, name, data)
            if not isinstance(result, ScanResult) or type(result.found) is not bool:
                raise TypeError("File scan returned an invalid decision")
        except Exception as exc:
            log.warning("File scan failed (%s)", type(exc).__name__)
            return blocked("file_scan_failed", "The file could not be scanned.")
        if result.error is not None:
            log.warning("File inspection blocked because scanning was incomplete")
            return blocked("file_scan_failed", result.error or "The file could not be scanned.")
        if not result.found:
            return {"allow": True}

        return await self._confirm(Detection("file", site, name, result.where, result.file_type, size))

    async def on_request(self, site: str, body: bytes | None) -> dict:
        """Inspect a supplied JSON request body."""
        if body is None:
            return blocked("request_unreadable", "The prompt request body is unavailable.")
        try:
            document = parse_json(body)
            if not isinstance(document, dict):
                return blocked("request_unreadable", "The prompt request is not a JSON object.")
        except (UnicodeError, ValueError, RecursionError):
            return blocked("request_unreadable", "The prompt request could not be read as UTF-8 JSON.")
        try:
            hits = list(dict.fromkeys(s for s in _json_strings(document) if self._prompt_has_marker(s)))
        except Exception as exc:
            log.warning("Prompt request scan failed (%s)", type(exc).__name__)
            return blocked("prompt_scan_failed", "The prompt request could not be scanned.")
        if not hits:
            return {"allow": True}
        current = _current_prompt(site, document)
        detail = f"This request contains {len(hits)} distinct sensitive values." if len(hits) > 1 else ""
        preview = current if current is not None and current in hits else hits[0]
        return await self._confirm(Detection("prompt", site, preview, detail))

    # ------------------------------------------------------------------ #
    def _prompt_has_marker(self, text: str) -> bool:
        found = self.scanner.scan_text(text)
        if type(found) is not bool:
            raise TypeError("Prompt scan returned an invalid decision")
        return found

    async def _confirm(self, detection: Detection) -> dict:
        try:
            async with self._dialog_lock:
                answer = await asyncio.to_thread(self._dialog, detection)
        except Exception as exc:
            log.warning("Confirmation failed (%s)", type(exc).__name__)
            return blocked("confirmation_failed", "The confirmation dialog could not be shown.")
        allow = answer is True
        log.info("Sensitive %s -> %s", detection.kind, "CONTINUE" if allow else "CANCEL")
        return {"allow": allow}


def parse_json(raw: bytes):
    return json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_reject_constant)


def _reject_constant(_value: str):
    raise ValueError("Non-finite JSON number")


def _unique_object(pairs: list) -> dict:
    obj = dict(pairs)
    if len(obj) != len(pairs):
        raise ValueError("Duplicate JSON keys")
    return obj


def _json_strings(doc: dict) -> Iterable[str]:
    """Scan decoded keys as well as values so JSON escaping cannot hide a marker."""
    stack = [doc]
    while stack:
        node = stack.pop()
        if isinstance(node, str):
            yield node
        elif isinstance(node, dict):
            yield from node
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)


def _current_prompt(site: str, document: dict) -> str | None:
    """Identify submitted text to use in the confirmation preview."""
    if site == config.PERPLEXITY.name:
        query = document.get("query_str")
        return query if isinstance(query, str) else None
    if site != config.CHATGPT.name:
        return None

    messages = document.get("messages")
    if not isinstance(messages, list) or len(messages) != 1 or not isinstance(messages[0], dict):
        return None
    message = messages[0]
    author = message.get("author", {"role": "user"})
    if not isinstance(author, dict) or author.get("role") != "user":
        return None
    content = message.get("content")
    parts = content.get("parts") if isinstance(content, dict) else None
    if isinstance(parts, list) and len(parts) == 1 and isinstance(parts[0], str):
        return parts[0]
    return None
