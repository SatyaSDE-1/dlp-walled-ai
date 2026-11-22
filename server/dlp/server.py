# /Users/anurag/waller-ai/walled-dlp/walled-dlp/server/dlp/server.py
"""Local IPC server: lets the Electron app drive the existing scanner / guard / dialog code.

Transport
---------
Newline-delimited JSON over this process's **stdin / stdout** - i.e. an anonymous pipe owned by
the Electron parent. There is no TCP port, no socket file and no authentication token to leak:
only the process that spawned us can talk to us, and when it dies the pipe closes and we exit.

    parent -> child   {"id": 7, "op": "prompt", "payload": {"site": "ChatGPT", "text": "..."}}
    child  -> parent  {"id": 7, "ok": true,  "result": {"allow": false}}
                      {"id": 7, "ok": false, "error": {"code": "bad_request", "message": "..."}}
    child  -> parent  {"event": "ready", "protocol": 1, "version": "...", "pid": 123}   (once, at start-up)

Operations (all thin wrappers - no scanning logic lives here)
------------------------------------------------------------
    ping         -> {pong, version, marker, protocol}
    init_script  -> {script}                 page-side hooks built by dlp.injector
    prompt       {site, text}                -> decision     Guard.on_prompt
    file         {site, name, size, mimeType?, b64} -> decision     Guard.on_file
    request      {site, body_b64}            -> decision     Guard.on_request
    shutdown     -> {}                       then the process exits

stdout is reserved for the protocol. Application diagnostics use a private copy of stderr.
Unstructured parser and OCR output is discarded to keep document content out of the logs.

A decision is ``{"allow": true}`` or ``{"allow": false}``. Failed inspections return
``{"allow": false, "error": {"code": "...", "message": "..."}}``. Invalid protocol
messages use the existing ``ok: false`` envelope.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import json
import logging
import os
import sys
import threading
from concurrent.futures import CancelledError
from typing import Any, Awaitable, Callable, Dict, Optional, TextIO

from . import __version__, config
from .dialog import Detection, close_dialogs
from .guard import Guard, blocked, parse_json
from .injector import build_init_script
from .scanner import Scanner

PROTOCOL_VERSION = 1
MAX_PROMPT_CHARS = 20_000_000
MAX_BASE64_BYTES = 4 * ((config.MAX_FILE_BYTES + 2) // 3)
# JSON may use six wire bytes per prompt character (a Unicode escape).
MAX_MESSAGE_BYTES = max(6 * MAX_PROMPT_CHARS, MAX_BASE64_BYTES) + 16 * 1024
MAX_PENDING_REQUESTS = 4
log = logging.getLogger("dlp.server")


class ProtocolError(Exception):
    """The request was malformed; reported to the caller as ``bad_request``."""


def _req_str(payload: dict, key: str, max_len: int = 256, default: Optional[str] = None) -> str:
    value = payload.get(key, default)
    if not isinstance(value, str):
        raise ProtocolError(f"'{key}' must be a string")
    if len(value) > max_len:
        raise ProtocolError(f"'{key}' is too long")
    return value


class Dispatcher:
    """Pure request -> response logic. No I/O, so it is trivially unit-testable."""

    def __init__(self, guard: Guard, color: str = config.RESPONSE_COLOR, debug: bool = False) -> None:
        self.guard = guard
        self.color = color
        self.debug = debug
        self._ops: Dict[str, Callable[[dict], Awaitable[Any]]] = {
            "ping": self._ping,
            "init_script": self._init_script,
            "prompt": self._prompt,
            "file": self._file,
            "request": self._request,
            "shutdown": self._shutdown,
        }

    async def handle(self, request: Any, *, at_capacity: bool = False) -> dict:
        rid = None
        try:
            if not isinstance(request, dict):
                raise ProtocolError("request must be a JSON object")
            candidate = request.get("id")
            if type(candidate) is not int and not (isinstance(candidate, str) and len(candidate) <= 256):
                raise ProtocolError("'id' must be an integer or a string up to 256 characters")
            rid = candidate
            op = request.get("op")
            if not isinstance(op, str):
                raise ProtocolError("'op' must be a string")
            payload = request.get("payload", {})
            if not isinstance(payload, dict):
                raise ProtocolError("'payload' must be an object")
            fn = self._ops.get(op)
            if fn is None:
                return _error(rid, "unknown_op", "Unknown operation.")
            if at_capacity:
                return _error(rid, "busy", "The backend is already handling too many requests.")
            return {"id": rid, "ok": True, "result": await fn(payload)}
        except ProtocolError as exc:
            return _error(rid, "bad_request", str(exc))
        except Exception as exc:  # noqa: BLE001 - never let one request kill the server
            log.error("Operation failed (%s)", type(exc).__name__)
            return _error(rid, "internal", "The backend operation failed.")

    # -- operations ------------------------------------------------------ #
    async def _ping(self, _payload: dict) -> dict:
        return {"pong": True, "version": __version__, "marker": config.MARKER, "protocol": PROTOCOL_VERSION}

    async def _init_script(self, _payload: dict) -> dict:
        return {"script": build_init_script(self.color, self.debug)}

    async def _prompt(self, payload: dict) -> dict:
        site = _req_str(payload, "site", 64)
        text = _req_str(payload, "text", max_len=MAX_PROMPT_CHARS)
        return await self.guard.on_prompt({"site": site, "text": text})

    async def _file(self, payload: dict) -> dict:
        site = _req_str(payload, "site", 64)
        name = _req_str(payload, "name", 1024)
        mime_type = _req_str(payload, "mimeType", 1024, default="")
        size = payload.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise ProtocolError("'size' must be a non-negative integer")
        b64 = payload.get("b64")
        if b64 is not None and not isinstance(b64, str):
            raise ProtocolError("'b64' must be a string or null")
        return await self.guard.on_file({"site": site, "name": name, "mimeType": mime_type, "size": size, "b64": b64})

    async def _request(self, payload: dict) -> dict:
        site = _req_str(payload, "site", 64)
        raw = payload.get("body_b64")
        if not isinstance(raw, str):
            raise ProtocolError("'body_b64' must be a string")
        if len(raw) > MAX_BASE64_BYTES:
            return blocked("request_too_large", "The prompt request exceeds the inspection limit.")
        try:
            body = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            return blocked("request_decode_failed", "The prompt request data is invalid base64.")
        if len(body) > config.MAX_FILE_BYTES:
            return blocked("request_too_large", "The prompt request exceeds the inspection limit.")
        return await self.guard.on_request(site, body)

    async def _shutdown(self, _payload: dict) -> dict:
        return {}


def _error(rid: Any, code: str, message: str) -> dict:
    return {"id": rid, "ok": False, "error": {"code": code, "message": message}}


# ---------------------------------------------------------------------------- #
# I/O loop
# ---------------------------------------------------------------------------- #
class Server:
    def __init__(self, dispatcher: Dispatcher, stdin: Any, out: TextIO) -> None:
        self.dispatcher = dispatcher
        self._stdin = stdin
        self._out = out
        self._tasks: set = set()

    def send(self, message: dict) -> None:
        line = json.dumps(message, separators=(",", ":"))
        self._out.write(line + "\n")
        self._out.flush()

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue(maxsize=1)

        def enqueue(raw: bytes | None) -> bool:
            pending = queue.put(raw)
            try:
                future = asyncio.run_coroutine_threadsafe(pending, loop)
            except RuntimeError:
                pending.close()
                return False
            try:
                future.result()
                return True
            except CancelledError:
                return False

        def reader() -> None:  # blocking reads live in a thread: works on every OS
            try:
                while raw := self._stdin.readline(MAX_MESSAGE_BYTES + 1):
                    if not enqueue(raw) or len(raw) > MAX_MESSAGE_BYTES:
                        return  # The line has no trustworthy ID and cannot be safely resumed.
            except OSError:
                pass
            enqueue(None)

        threading.Thread(target=reader, name="stdin-reader", daemon=True).start()
        self.send({"event": "ready", "protocol": PROTOCOL_VERSION, "version": __version__, "pid": os.getpid()})

        while True:
            raw = await queue.get()
            if raw is None:
                log.info("stdin closed - shutting down")
                break
            if len(raw) > MAX_MESSAGE_BYTES:
                self.send(_error(None, "message_too_large", "The IPC message exceeds the size limit."))
                break
            if not raw.endswith(b"\n"):
                self.send(_error(None, "bad_json", "request is not terminated by a newline"))
                break
            line = raw.strip()
            if not line:
                continue
            try:
                request = parse_json(line)
            except (ValueError, RecursionError):
                self.send(_error(None, "bad_json", "request is not valid JSON"))
                continue
            if isinstance(request, dict) and request.get("op") == "shutdown":
                response = await self.dispatcher.handle(request)
                self.send(response)
                if response["ok"]:
                    break
                continue
            if len(self._tasks) >= MAX_PENDING_REQUESTS:
                self.send(await self.dispatcher.handle(request, at_capacity=True))
                continue
            task = asyncio.create_task(self._serve_one(request))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _serve_one(self, request: Any) -> None:
        self.send(await self.dispatcher.handle(request))


# ---------------------------------------------------------------------------- #
# entry point
# ---------------------------------------------------------------------------- #
def _claim_streams() -> tuple[TextIO, TextIO]:
    """Keep private streams for protocol replies and application diagnostics."""
    proto = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
    diagnostics = os.fdopen(os.dup(2), "w", encoding="utf-8", errors="backslashreplace")
    # Document parsers and OCR runtimes may print arbitrary document content.
    with open(os.devnull, "wb") as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
    return proto, diagnostics


def _auto_dialog(answer: str) -> Callable[[Detection], bool]:
    def dialog(d: Detection) -> bool:
        log.warning("AUTO-ANSWER %s for %s", answer.upper(), d.kind)
        return answer == "continue"

    return dialog


def parse_args(argv: Optional[list] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Walled DLP backend (IPC over stdin/stdout)")
    p.add_argument("--color", default=config.RESPONSE_COLOR, help="CSS colour for AI responses")
    p.add_argument("--no-ocr-warmup", action="store_true", help="Do not pre-load OCR models at start-up")
    p.add_argument("--auto-answer", choices=["continue", "cancel"],
                   help="TEST ONLY: answer every confirmation automatically instead of showing the dialog")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


def main(argv: Optional[list] = None) -> int:
    args = parse_args(argv)
    proto, diagnostics = _claim_streams()
    handler = logging.StreamHandler(diagnostics)
    handler.addFilter(logging.Filter("dlp"))
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, handlers=[handler],
                        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s", datefmt="%H:%M:%S")

    scanner = Scanner()
    guard = Guard(scanner, dialog=_auto_dialog(args.auto_answer)) if args.auto_answer else Guard(scanner)
    if args.auto_answer:
        log.warning("--auto-answer=%s is for tests only: no dialog will be shown", args.auto_answer)

    if not args.no_ocr_warmup:   # load OCR models in the background so the first image scan is fast
        threading.Thread(target=lambda: scanner.ocr.available, name="ocr-warmup", daemon=True).start()

    server = Server(Dispatcher(guard, color=args.color, debug=args.verbose), sys.stdin.buffer, proto)

    async def serve() -> None:
        try:
            await server.run()
        finally:
            # Close the native helper before asyncio waits for the dialog worker thread.
            close_dialogs()

    exit_code = 0
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        log.error("IPC server stopped (%s)", type(exc).__name__)
        exit_code = 1
    # The stdin reader thread may still be blocked in readline(); letting the interpreter tear down
    # around it aborts with "could not acquire lock ... at interpreter shutdown". Everything has been
    # answered and flushed by now, so leave immediately.
    for stream in (proto, diagnostics):
        try:
            stream.flush()
        except Exception:  # noqa: BLE001
            pass
    os._exit(exit_code)


if __name__ == "__main__":
    sys.exit(main())
