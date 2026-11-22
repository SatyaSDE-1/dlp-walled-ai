"""Tk-based native window used on Windows (and as a universal fallback).

Run as a child process so Tk always owns the main thread of its own interpreter:

    python -m dlp.dialog_tk TITLE MESSAGE CONTINUE_LABEL CANCEL_LABEL

Exit code 0 = Continue, 1 = Cancel (also if the window is closed).
"""

from __future__ import annotations

import sys


def main(argv: list) -> int:
    if len(argv) != 5:
        return 1
    _, title, message, ok_label, cancel_label = argv

    import tkinter as tk
    from tkinter import ttk

    result = {"ok": False}
    root = tk.Tk()
    root.title(title)
    root.resizable(False, False)
    root.attributes("-topmost", True)

    frame = ttk.Frame(root, padding=18)
    frame.pack(fill="both", expand=True)
    ttk.Label(frame, text=message, justify="left", wraplength=460).pack(anchor="w")

    buttons = ttk.Frame(frame)
    buttons.pack(anchor="e", pady=(16, 0))

    def choose(ok: bool) -> None:
        result["ok"] = ok
        root.destroy()

    cancel = ttk.Button(buttons, text=cancel_label, command=lambda: choose(False))
    cancel.pack(side="right")
    ttk.Button(buttons, text=ok_label, command=lambda: choose(True)).pack(side="right", padx=(0, 8))

    root.protocol("WM_DELETE_WINDOW", lambda: choose(False))
    root.bind("<Escape>", lambda _e: choose(False))

    # Centre on screen, then take focus.
    root.update_idletasks()
    w, h = root.winfo_reqwidth(), root.winfo_reqheight()
    root.geometry(f"+{(root.winfo_screenwidth() - w) // 2}+{(root.winfo_screenheight() - h) // 3}")
    root.lift()
    root.focus_force()
    cancel.focus_set()
    root.mainloop()
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
