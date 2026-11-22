"""Tests for the stdio IPC server (dlp/server.py).

* Dispatcher tests: pure logic, with a fake dialog.
* Process tests: spawn the real server exactly as Electron will and talk to it over its pipes.
"""

import asyncio
import base64
import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

from dlp.guard import Guard
from dlp.server import PROTOCOL_VERSION, Dispatcher, Server
from samples import make_samples as ms

M = ms.MARKER
ROOT = Path(__file__).resolve().parent.parent


class FakeDialog:
    def __init__(self, answer=True):
        self.answer, self.calls = answer, []

    def __call__(self, d):
        self.calls.append(d)
        return self.answer


def call(dispatcher, op, payload=None, rid=1):
    req = {"id": rid, "op": op}
    if payload is not None:
        req["payload"] = payload
    return asyncio.run(dispatcher.handle(req))


@pytest.fixture
def disp():
    d = FakeDialog(True)
    return Dispatcher(Guard(dialog=d), color="#123456"), d


# ------------------------------------------------------------------ dispatcher
def test_ping(disp):
    r = call(disp[0], "ping")
    assert r["ok"] and r["result"]["pong"] and r["result"]["marker"] == M
    assert r["result"]["protocol"] == PROTOCOL_VERSION


def test_init_script_is_the_shared_builder(disp):
    script = call(disp[0], "init_script")["result"]["script"]
    assert "__WALLED_CONFIG__" in script and M in script and "#123456" in script
    assert "chatgpt.com" in script and "perplexity.ai" in script     # site config comes from config.py


def test_prompt_clean_continue_cancel(disp):
    d, dialog = disp
    assert call(d, "prompt", {"site": "ChatGPT", "text": "hello"})["result"] == {"allow": True}
    assert dialog.calls == []
    assert call(d, "prompt", {"site": "ChatGPT", "text": f"x {M}"})["result"] == {"allow": True}
    dialog.answer = False
    assert call(d, "prompt", {"site": "ChatGPT", "text": f"y {M}"})["result"] == {"allow": False}
    assert len(dialog.calls) == 2


def test_file_ops(disp):
    d, dialog = disp
    dialog.answer = False
    sensitive = ms.SENSITIVE_BODY.encode()
    b64 = base64.b64encode(sensitive).decode()
    r = call(d, "file", {"site": "Perplexity", "name": "a.txt", "mimeType": "image/png",
                        "size": len(sensitive), "b64": b64})
    assert r["result"] == {"allow": False} and dialog.calls[0].label == "a.txt"
    clean = ms.CLEAN_BODY.encode()
    b64 = base64.b64encode(clean).decode()
    assert call(d, "file", {"site": "x", "name": "b.txt", "size": len(clean), "b64": b64})["result"] == {"allow": True}
    r = call(d, "file", {"site": "x", "name": "big", "size": 10**9, "b64": None})["result"]
    assert r["allow"] is False and r["error"]["code"] == "file_too_large"
    r = call(d, "file", {"site": "x", "name": "broken", "size": 9, "b64": "!!invalid!!"})["result"]
    assert r["allow"] is False and r["error"]["code"] == "file_decode_failed"


def test_request_inspection_op(disp):
    d, dialog = disp
    dialog.answer = False
    body = base64.b64encode(json.dumps({"q": f"hi {M}"}).encode()).decode()
    assert call(d, "request", {"site": "ChatGPT", "body_b64": body})["result"] == {"allow": False}
    r = call(d, "request", {"site": "ChatGPT", "body_b64": "!!notbase64!!"})["result"]
    assert r["allow"] is False and r["error"]["code"] == "request_decode_failed"


@pytest.mark.parametrize("req,code", [
    ({"id": 1, "op": "nope"}, "unknown_op"),
    ({"id": 1}, "bad_request"),
    ({"op": "ping"}, "bad_request"),
    ({"id": True, "op": "ping"}, "bad_request"),
    ({"id": 1, "op": "ping", "payload": []}, "bad_request"),
    ({"id": 1, "op": "prompt", "payload": {"site": "x", "text": 5}}, "bad_request"),
    ({"id": 1, "op": "prompt", "payload": {"site": "x" * 500, "text": "a"}}, "bad_request"),
    ({"id": 1, "op": "file", "payload": {"site": "x", "name": "a", "size": -1, "b64": None}}, "bad_request"),
    ({"id": 1, "op": "file", "payload": {"site": "x", "name": "a", "mimeType": 5, "size": 0, "b64": ""}}, "bad_request"),
    ({"id": 1, "op": "request", "payload": {"site": "x", "body_b64": False}}, "bad_request"),
    ("not an object", "bad_request"),
])
def test_malformed_requests(disp, req, code):
    r = asyncio.run(disp[0].handle(req))
    assert r["ok"] is False and r["error"]["code"] == code
    assert disp[1].calls == []                                   # nothing reached the dialog


def test_at_capacity_rejects_before_scanning(disp):
    request = {"id": 1, "op": "prompt", "payload": {"site": "ChatGPT", "text": M}}
    response = asyncio.run(disp[0].handle(request, at_capacity=True))
    assert response["ok"] is False and response["error"]["code"] == "busy"
    assert not disp[1].calls


# --------------------------------------------------------------- real process
class Proc:
    def __init__(self, *extra):
        self.p = subprocess.Popen(
            [sys.executable, "-u", "-m", "dlp.server", "--no-ocr-warmup", *extra],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.ready = self.read()

    def read(self):
        line = self.p.stdout.readline()
        assert line, f"server closed stdout; stderr: {self.p.stderr.read()[:500]!r}"
        return json.loads(line)          # raises if anything but protocol JSON is on stdout

    def rpc(self, op, payload=None, rid=1):
        self.p.stdin.write((json.dumps({"id": rid, "op": op, "payload": payload or {}}) + "\n").encode())
        self.p.stdin.flush()
        return self.read()


def test_process_handshake_and_ping():
    s = Proc()
    try:
        assert s.ready["event"] == "ready" and s.ready["protocol"] == PROTOCOL_VERSION
        assert s.rpc("ping")["result"]["pong"] is True
    finally:
        s.p.kill()


def test_process_decisions_use_auto_answer():
    s = Proc("--auto-answer", "cancel")
    try:
        assert s.rpc("prompt", {"site": "ChatGPT", "text": f"a {M}"}, rid=1)["result"] == {"allow": False}
        assert s.rpc("prompt", {"site": "ChatGPT", "text": "fine"}, rid=2)["result"] == {"allow": True}
    finally:
        s.p.kill()


def test_stdout_stays_clean_even_when_libraries_log_and_print():
    """OCR (RapidOCR) is chatty. Scan an image and a scanned PDF; every stdout line must still be protocol JSON."""
    s = Proc("--auto-answer", "continue")
    try:
        for i, (name, data) in enumerate([("s.png", ms.image_bytes(ms.SENSITIVE_BODY, "PNG")),
                                          ("s.pdf", ms.pdf_from_image(ms.SENSITIVE_BODY))], start=1):
            r = s.rpc("file", {"site": "ChatGPT", "name": name, "size": len(data),
                               "b64": base64.b64encode(data).decode()}, rid=i)
            assert r["id"] == i and r["ok"] and r["result"] == {"allow": True}
    finally:
        s.p.kill()


def test_concurrent_requests_are_answered_independently():
    s = Proc("--auto-answer", "continue")
    try:
        for i in range(1, 6):
            s.p.stdin.write((json.dumps({"id": i, "op": "ping"}) + "\n").encode())
        s.p.stdin.flush()
        assert sorted(s.read()["id"] for _ in range(5)) == [1, 2, 3, 4, 5]
    finally:
        s.p.kill()


@pytest.mark.parametrize("line", [
    b"{this is not json\n",
    b'{"id":1,"op":"shutdown","op":"ping"}\n',
    b'{"id":1,"op":"ping","payload":{"number":NaN}}\n',
    '{"id":1,"op":"ping"}'.encode("utf-16") + b"\n",
])
def test_bad_json_line_does_not_kill_server(line):
    s = Proc()
    try:
        s.p.stdin.write(line)
        s.p.stdin.flush()
        assert s.read()["error"]["code"] == "bad_json"
        assert s.rpc("ping")["ok"]
    finally:
        s.p.kill()


@pytest.mark.parametrize("raw,code", [
    (b"x" * 80 + b"\n", "message_too_large"),
    (b'{"id":1,"op":"shutdown"}', "bad_json"),
])
def test_invalid_framing_stops_before_dispatch(monkeypatch, raw, code):
    monkeypatch.setattr("dlp.server.MAX_MESSAGE_BYTES", 64)
    out = io.StringIO()
    asyncio.run(Server(Dispatcher(Guard()), io.BytesIO(raw), out).run())
    ready, response = (json.loads(line) for line in out.getvalue().splitlines())
    assert ready["event"] == "ready" and response["error"]["code"] == code


def test_exits_when_parent_closes_the_pipe():
    s = Proc()
    s.p.stdin.close()                                            # what happens when Electron dies
    assert s.p.wait(timeout=10) == 0


def test_shutdown_op_exits_cleanly():
    s = Proc()
    assert s.rpc("shutdown")["ok"]
    assert s.p.wait(timeout=10) == 0
