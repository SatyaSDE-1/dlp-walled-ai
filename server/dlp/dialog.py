"""Native desktop confirmation dialog.

Platform strategy (all produce a real OS window - never an in-browser popup):

* macOS   : ``osascript`` -> AppleScript ``display dialog`` (Continue / Cancel buttons)
* Linux   : ``zenity`` or ``kdialog`` when installed
* Windows : Tk window (``dlp/dialog_tk.py``) run in a child process
* fallback: the same Tk window on any platform where the above is unavailable

``confirm`` is blocking and returns ``True`` for *Continue* and ``False`` for *Cancel*.
Any failure to show the dialog returns ``False`` - for a DLP tool, failing closed (block)
is the safe default.
"""

from __future__ import annotations

import html
import json
import logging
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass
from typing import List, Optional

log = logging.getLogger("dlp.dialog")

TITLE = "Walled DLP - Sensitive content detected"
CONTINUE = "Continue"
CANCEL = "Cancel"
PREVIEW_CHARS = 280
CONFIRM_TIMEOUT_SECONDS = 90
_dialog_lock = threading.Lock()
_dialog_processes: set[subprocess.Popen] = set()
_closing_dialogs = False


@dataclass
class Detection:
    kind: str                 # "prompt" | "file"
    site: str                 # "ChatGPT" | "Perplexity"
    label: str                # prompt text, or file name
    detail: str = ""          # e.g. "page 2 text", "text in image (OCR)"
    file_type: str = ""       # "pdf" | "image" | "text" ...
    size: Optional[int] = None


def build_message(d: Detection) -> str:
    """Plain-text body shared by every dialog back-end."""
    label = _preview(d.label)
    site = _preview(d.site)
    detail = _preview(d.detail)
    if d.kind == "prompt":
        lines = [
            "Sensitive content was detected in a TEXT PROMPT.",
            "",
            f"Destination: {site}",
            f"Prompt: \"{label}\"",
        ]
        if detail:
            lines.append(detail)
    else:
        kind = f" ({d.file_type})" if d.file_type else ""
        lines = [
            "Sensitive content was detected in a FILE.",
            "",
            f"Destination: {site}",
            f"File name: {label}{kind}",
        ]
        if d.size is not None:
            lines.append(f"Size: {_human(d.size)}")
        if detail:
            lines.append(f"Found in: {detail}")
    lines += ["", f"Choose \"{CONTINUE}\" to send it anyway, or \"{CANCEL}\" to block it."]
    return "\n".join(lines)


def _preview(value: str) -> str:
    printable = "".join(char if char.isprintable() else " " for char in value[:PREVIEW_CHARS])
    return printable.rstrip() + ("..." if len(value) > PREVIEW_CHARS else "")


def confirm(d: Detection) -> bool:
    message = build_message(d)
    try:
        if sys.platform == "darwin":
            return _mac(message)
        if sys.platform.startswith("linux"):
            result = _linux(message)
            if result is not None:
                return result
        return _tk(message)
    except Exception as exc:  # noqa: BLE001
        log.error("Could not complete confirmation dialog (%s)", type(exc).__name__)
        return False


# ---------------------------------------------------------------------------- #
# back-ends
# ---------------------------------------------------------------------------- #
def close_dialogs() -> None:
    """Dismiss active dialogs and prevent queued confirmations from opening during shutdown."""
    global _closing_dialogs
    with _dialog_lock:
        _closing_dialogs = True
        for proc in _dialog_processes:
            try:
                proc.kill()
            except OSError as exc:
                log.warning("Could not close confirmation dialog (%s)", type(exc).__name__)


def _run_dialog(cmd: List[str], *, input_text: str | None = None) -> subprocess.CompletedProcess:
    with _dialog_lock:
        if _closing_dialogs:
            return subprocess.CompletedProcess(cmd, 1, "", "")
        stdin = subprocess.PIPE if input_text is not None else subprocess.DEVNULL
        proc = subprocess.Popen(cmd, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8")
        _dialog_processes.add(proc)
    try:
        with proc:
            try:
                stdout, stderr = proc.communicate(input=input_text, timeout=CONFIRM_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
                raise
        return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)
    finally:
        with _dialog_lock:
            _dialog_processes.discard(proc)


def _mac(message: str) -> bool:
    options = json.dumps({"withTitle": TITLE, "buttons": [CANCEL, CONTINUE],
                          "defaultButton": CANCEL, "cancelButton": CANCEL, "withIcon": "caution"})
    script = f"""ObjC.import('Foundation');
const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const message = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
const app = Application.currentApplication();
app.includeStandardAdditions = true;
app.displayDialog(message, {options}).buttonReturned;
"""
    proc = _run_dialog(["/usr/bin/osascript", "-l", "JavaScript", "-e", script], input_text=message)
    # Pressing Cancel makes osascript exit non-zero (error -128), which is exactly "cancel".
    return proc.returncode == 0 and proc.stdout.strip() == CONTINUE


def _linux(message: str) -> Optional[bool]:
    if shutil.which("zenity"):
        proc = _run_dialog(
            ["zenity", "--question", "--default-cancel", "--title", TITLE, "--text", html.escape(message),
             "--ok-label", CONTINUE, "--cancel-label", CANCEL, "--width", "480"]
        )
        return proc.returncode == 0
    if shutil.which("kdialog"):
        proc = _run_dialog(
            ["kdialog", "--title", TITLE, "--yes-label", CONTINUE, "--no-label", CANCEL,
             "--warningyesno", html.escape(message).replace("\n", "<br>")]
        )
        return proc.returncode == 0
    return None


def _tk(message: str) -> bool:
    proc = _run_dialog([sys.executable, "-m", "dlp.dialog_tk", TITLE, message, CONTINUE, CANCEL])
    return proc.returncode == 0


def _human(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{n} B"
