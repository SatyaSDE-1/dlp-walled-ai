import asyncio
import base64
import json
import subprocess
import sys

import pytest

from dlp import dialog
from dlp.dialog import Detection, build_message
from dlp.guard import Guard
from samples import make_samples as ms

M = ms.MARKER


class FakeDialog:
    def __init__(self, answer=True):
        self.answer = answer
        self.calls = []

    def __call__(self, detection):
        self.calls.append(detection)
        return self.answer


def run(coro):
    return asyncio.run(coro)


# ------------------------------------------------------------------ guard logic
def test_clean_prompt_no_dialog():
    d = FakeDialog()
    g = Guard(dialog=d)
    assert run(g.on_prompt({"site": "ChatGPT", "text": "hello"})) == {"allow": True}
    assert d.calls == []


def test_sensitive_prompt_continue_and_cancel():
    d = FakeDialog(True)
    g = Guard(dialog=d)
    assert run(g.on_prompt({"site": "ChatGPT", "text": f"x {M}"}))["allow"] is True
    assert d.calls[0].kind == "prompt" and M in d.calls[0].label
    d.answer = False
    assert run(g.on_prompt({"site": "ChatGPT", "text": f"y {M}"}))["allow"] is False


def test_sensitive_file_dialog_details():
    d = FakeDialog(False)
    g = Guard(dialog=d)
    raw = ms.SENSITIVE_BODY.encode()
    data = base64.b64encode(raw).decode()
    out = run(g.on_file({"site": "Perplexity", "name": "plan.txt", "size": len(raw), "b64": data}))
    assert out == {"allow": False}
    det = d.calls[0]
    assert (det.kind, det.label, det.site) == ("file", "plan.txt", "Perplexity")


def test_clean_file_no_dialog():
    d = FakeDialog()
    g = Guard(dialog=d)
    raw = ms.CLEAN_BODY.encode()
    data = base64.b64encode(raw).decode()
    assert run(g.on_file({"site": "x", "name": "a.txt", "size": len(raw), "b64": data}))["allow"] is True
    assert d.calls == []


def test_oversize_file_is_blocked():
    d = FakeDialog()
    g = Guard(dialog=d)
    decision = run(g.on_file({"site": "x", "name": "big.bin", "size": 10**9, "b64": None}))
    assert decision["allow"] is False and decision["error"]["code"] == "file_too_large"
    assert d.calls == []


def test_prompt_and_file_scanner_failures_block(monkeypatch):
    d = FakeDialog()
    g = Guard(dialog=d)

    def fail(*_args):
        raise RuntimeError("scan failure")

    monkeypatch.setattr(g.scanner, "scan_text", fail)
    monkeypatch.setattr(g.scanner, "scan_file", fail)
    prompt = run(g.on_prompt({"site": "ChatGPT", "text": "hello"}))
    upload = run(g.on_file({"site": "ChatGPT", "name": "a.txt", "size": 5, "b64": "aGVsbG8="}))
    assert prompt["allow"] is False and prompt["error"]["code"] == "prompt_scan_failed"
    assert upload["allow"] is False and upload["error"]["code"] == "file_scan_failed"
    assert d.calls == []


# ------------------------------------------------------------ request inspection
def test_network_request_asks_about_sensitive_content():
    d = FakeDialog(False)
    g = Guard(dialog=d)
    body = json.dumps({"messages": [{"content": {"parts": [f"hi {M}"]}}]}).encode()
    assert run(g.on_request("ChatGPT", body)) == {"allow": False}
    assert len(d.calls) == 1


def test_request_requires_its_own_approval():
    d = FakeDialog(True)
    g = Guard(dialog=d)
    assert run(g.on_prompt({"site": "ChatGPT", "text": f"hi {M}"})) == {"allow": True}
    body = json.dumps({"messages": [{"content": {"parts": [f"hi {M}"]}}]}).encode()
    d.answer = False
    assert run(g.on_request("ChatGPT", body)) == {"allow": False}
    assert len(d.calls) == 2


def test_network_clean_request_untouched():
    d = FakeDialog()
    g = Guard(dialog=d)
    assert run(g.on_request("ChatGPT", b'{"q": "hello"}')) == {"allow": True}
    assert d.calls == []


def test_dialogs_are_serialised():
    active, peak = 0, 0

    def slow(_d):
        nonlocal active, peak
        import time
        active += 1
        peak = max(peak, active)
        time.sleep(0.05)
        active -= 1
        return True

    async def go():
        g = Guard(dialog=slow)
        await asyncio.gather(*(g.on_prompt({"site": "s", "text": f"{M} {i}"}) for i in range(4)))

    run(go())
    assert peak == 1


# ------------------------------------------------------------------- dialog text
def test_message_for_prompt_and_file():
    p = build_message(Detection("prompt", "ChatGPT", f"secret {M}"))
    assert "TEXT PROMPT" in p and M in p and "Continue" in p and "Cancel" in p
    f = build_message(Detection("file", "Perplexity", "plan.pdf", "page 2 text", "pdf", 2048))
    assert "FILE" in f and "plan.pdf" in f and "2.0 KB" in f and "page 2 text" in f


def test_long_prompt_is_truncated():
    msg = build_message(Detection("prompt", "ChatGPT", "A" * 5000))
    assert len(msg) < 800


@pytest.mark.parametrize("status, output, allowed", [
    (0, "Continue\n", True),
    (0, "Cancel\n", False),
    (1, "", False),
    (1, "Continue\n", False),
    (0, "Unexpected\n", False),
])
def test_mac_dialog_command_and_result(monkeypatch, status, output, allowed):
    seen = {}

    def fake_run(cmd, *, input_text):
        seen.update(cmd=cmd, input_text=input_text)
        return subprocess.CompletedProcess(cmd, status, stdout=output, stderr="")

    monkeypatch.setattr(dialog, "_run_dialog", fake_run)
    assert dialog._mac("hello") is allowed
    assert seen["cmd"][0] == "/usr/bin/osascript" and "Continue" in " ".join(seen["cmd"])
    assert seen["input_text"] == "hello" and "hello" not in " ".join(seen["cmd"])


def test_dialog_failure_blocks(monkeypatch):
    monkeypatch.setattr(dialog.sys, "platform", "darwin")

    def boom(*a, **k):
        raise OSError("no display")

    monkeypatch.setattr(dialog, "_mac", boom)
    assert dialog.confirm(Detection("prompt", "x", M)) is False
