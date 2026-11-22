"""Optional OCR layer used to look for the marker inside images and scanned PDFs.

Two interchangeable back-ends are supported and chosen lazily at first use:

1. ``rapidocr`` and ``onnxruntime`` - default. Missing model assets may download on first use.
2. ``pytesseract`` - used if RapidOCR is missing and the ``tesseract`` binary exists.

Unavailable engines and failed reads raise ``OcrError`` so the scanner can block an
uninspected file. An empty string means OCR completed without finding text.
"""

from __future__ import annotations

import logging
import shutil
import threading
from importlib import import_module
from typing import Callable, Optional

from .config import MAX_IMAGE_PIXELS

log = logging.getLogger("dlp.ocr")


class OcrError(RuntimeError):
    pass


class OcrEngine:
    def __init__(self) -> None:
        self._lock = threading.Lock()  # OCR runtimes are not guaranteed thread-safe
        self._fn: Optional[Callable] = None
        self._name = "none"
        self._initialised = False

    # ------------------------------------------------------------------ #
    @property
    def name(self) -> str:
        self._init()
        return self._name

    @property
    def available(self) -> bool:
        self._init()
        return self._fn is not None

    def read(self, image) -> str:
        """Return the text found in a PIL image or raise OcrError."""
        self._init()
        if self._fn is None:
            raise OcrError("OCR is unavailable.")
        try:
            image = _prepare(image)
            with self._lock:
                text = self._fn(image)
            if not isinstance(text, str):
                raise ValueError("OCR returned an invalid text result")
            return text
        except OcrError:
            raise
        except Exception as exc:
            log.warning("OCR failed (%s: %s)", self._name, type(exc).__name__)
            raise OcrError("OCR could not scan the image.") from exc

    # ------------------------------------------------------------------ #
    def _init(self) -> None:
        if self._initialised:
            return
        with self._lock:
            if self._initialised:
                return
            for loader in (self._load_rapidocr, self._load_tesseract):
                try:
                    if loader():
                        break
                except Exception as exc:  # noqa: BLE001
                    log.debug("OCR back-end failed to load (%s)", type(exc).__name__)
            if self._fn is None:
                log.warning("No OCR back-end available - images / scanned PDFs cannot be inspected. "
                            "Install with: pip install rapidocr onnxruntime")
            else:
                log.info("OCR back-end: %s", self._name)
            self._initialised = True

    def _load_rapidocr(self) -> bool:
        import numpy as np

        # RapidOCR can defer importing its inference engine until the first image.
        import_module("onnxruntime")
        try:  # rapidocr >= 2 (current package name)
            from rapidocr import RapidOCR

            engine = RapidOCR()

            def run(img) -> str:
                out = engine(np.array(img))
                # A successful no-text result has a txts field. Detection-only
                # output indicates recognition did not complete.
                txts = out.txts
                return "\n".join(txts) if txts else ""

        except ImportError:  # legacy package name
            from rapidocr_onnxruntime import RapidOCR  # type: ignore

            engine = RapidOCR()

            def run(img) -> str:  # type: ignore[misc]
                result, _ = engine(np.array(img))
                return "\n".join(r[1] for r in result) if result else ""

        self._fn, self._name = run, "rapidocr"
        return True

    def _load_tesseract(self) -> bool:
        if not shutil.which("tesseract"):
            return False
        import pytesseract

        self._fn = lambda img: pytesseract.image_to_string(img)
        self._name = "tesseract"
        return True


def _prepare(image):
    """Normalise a PIL image for OCR: RGB, flatten transparency, upscale tiny images."""
    from PIL import Image

    if image.width * image.height > MAX_IMAGE_PIXELS:
        raise OcrError("The image exceeds the pixel scan limit.")
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        bg = Image.new("RGBA", image.size, (255, 255, 255, 255))
        bg.alpha_composite(image)
        image = bg
    image = image.convert("RGB")
    if image.width < 900:
        height = max(1, image.height * 900 // image.width)
        if 900 * height <= MAX_IMAGE_PIXELS:
            image = image.resize((900, height), Image.LANCZOS)
    return image
