"""Sensitive-marker detection for prompts and files (text, PDF, images).

Matching rules
--------------
* Prompts and plain-text content: exact, case-sensitive match of ``WALLED_SENSITIVE``.
* Text that comes out of PDF extraction or OCR is matched *tolerantly*
  (``WALLED SENSITIVE``, ``WALLED-SENSITIVE`` ...) because extraction and OCR routinely
  turn an underscore into a space or drop it altogether.

The scanner never raises on malformed input: a file it cannot parse yields
``ScanResult(found=False, error=...)`` and the caller decides what to do.
"""

from __future__ import annotations

import io
import logging
import math
import re
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from typing import Optional

from . import config
from .ocr import OcrEngine, OcrError

log = logging.getLogger("dlp.scanner")

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff"}
PDF_VECTOR_PAINT = frozenset({b"S", b"s", b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*", b"sh"})


@dataclass
class ScanResult:
    found: bool
    file_type: str = "unknown"      # text | pdf | image | archive | binary | empty
    where: str = ""                 # human-readable hint: "page 2", "OCR", ...
    error: Optional[str] = None


class Scanner:
    def __init__(self, marker: str = config.MARKER, ocr: Optional[OcrEngine] = None) -> None:
        self.marker = marker
        self.ocr = ocr or OcrEngine()
        # Tolerant pattern built from the marker: WALLED_SENSITIVE -> WALLED[\s_.-]{0,3}SENSITIVE
        parts = [re.escape(p) for p in re.split(r"[_\s]+", marker) if p]
        self._fuzzy = re.compile(r"[\s_.\-]{0,3}".join(parts), re.IGNORECASE)
        self._raw_variants = [marker.encode(enc) for enc in ("utf-8", "utf-16-le", "utf-16-be")]

    # ------------------------------------------------------------------ #
    # Text
    # ------------------------------------------------------------------ #
    def scan_text(self, text: str) -> bool:
        """Exact match - used for typed prompts."""
        return self.marker in text

    def _fuzzy_hit(self, text: str) -> bool:
        return bool(text) and (self.marker in text or self._fuzzy.search(text) is not None)

    # ------------------------------------------------------------------ #
    # Files
    # ------------------------------------------------------------------ #
    def scan_file(self, name: str, data: bytes) -> ScanResult:
        kind = "unknown"
        try:
            kind = sniff_type(name, data)
            if kind == "archive":
                return self._scan_archive(data)
            return self._scan_content(kind, data)
        except OcrError as exc:
            return ScanResult(False, kind, error=str(exc))
        except Exception as exc:  # noqa: BLE001
            log.warning("File parser failed (%s)", type(exc).__name__)
            return ScanResult(False, kind, error="The file could not be scanned.")

    def _scan_content(self, kind: str, data: bytes) -> ScanResult:
        if kind == "pdf":
            return self._scan_pdf(data)
        if kind == "image":
            return self._scan_image(data)
        if kind == "text":
            return self._scan_text_bytes(data, kind) if data else ScanResult(False, "empty")
        return ScanResult(False, kind, error="Unsupported file type.")

    # -- text / generic bytes ------------------------------------------- #
    def _raw_hit(self, data: bytes) -> bool:
        return any(v in data for v in self._raw_variants)

    def _scan_text_bytes(self, data: bytes, kind: str) -> ScanResult:
        if self._raw_hit(data):
            return ScanResult(True, kind, "file contents")
        return ScanResult(False, kind)

    # -- PDF -------------------------------------------------------------- #
    def _scan_pdf(self, data: bytes) -> ScanResult:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            return ScanResult(False, "pdf", error="Encrypted PDFs are blocked.")
        catalog = reader.trailer["/Root"]
        names = catalog.get("/Names")
        if "/AF" in catalog or (names is not None and "/EmbeddedFiles" in names.get_object()):
            return ScanResult(False, "pdf", error="PDFs with embedded files are blocked.")

        # Keep the first hit while checking the rest of the document for inspection errors.
        first_hit = "PDF contents" if self._raw_hit(data) else ""
        meta = " ".join(str(v) for v in (reader.metadata or {}).values())
        if not first_hit and self._fuzzy_hit(meta):
            first_hit = "PDF metadata"

        pages_to_render = []
        ocr_budget = config.MAX_OCR_IMAGES_PER_PDF

        paints_vectors = False

        def visit_operator(operator, _operands, _transform, _text_matrix):
            nonlocal paints_vectors
            if operator in PDF_VECTOR_PAINT:
                paints_vectors = True

        for idx, page in enumerate(reader.pages, start=1):
            annotations = page.get("/Annots")
            if "/AF" in page or (annotations is not None and any(
                    item.get_object().get("/Subtype") == "/FileAttachment" for item in annotations.get_object())):
                return ScanResult(False, "pdf", error="PDFs with embedded files are blocked.")
            paints_vectors = False
            text = page.extract_text(visitor_operand_before=visit_operator) or ""
            if not first_hit and self._fuzzy_hit(text):
                first_hit = f"page {idx} text"
            if len(text.strip()) < 20 or paints_vectors:
                pages_to_render.append(idx - 1)
                if len(pages_to_render) > config.MAX_PDF_PAGES_RENDERED:
                    return ScanResult(False, "pdf", error="The PDF exceeds the rendered-page scan limit.")

            # Embedded images (scans, screenshots pasted into a PDF).
            images = page.images
            if len(images) > ocr_budget:
                return ScanResult(False, "pdf", error="The PDF exceeds the embedded-image scan limit.")
            for img in images:
                ocr_budget -= 1
                pil = _open_image(img.data)
                if pil is None:
                    return ScanResult(False, "pdf", error=f"An image on PDF page {idx} could not be decoded.")
                with pil:
                    image_text = self.ocr.read(pil)
                    if not first_hit and self._fuzzy_hit(image_text):
                        first_hit = f"page {idx} image (OCR)"

        # Vector outlines can carry text regardless of the amount of extractable text.
        if pages_to_render:
            if not self.ocr.available:
                return ScanResult(False, "pdf", error="OCR is unavailable for this PDF.")
            rendered_hit = self._scan_rendered_pages(data, pages_to_render)
            first_hit = first_hit or rendered_hit

        return ScanResult(bool(first_hit), "pdf", first_hit or "")

    def _scan_rendered_pages(self, data: bytes, page_indexes: list) -> Optional[str]:
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(data)
        first_hit = None
        try:
            scale = 2.0
            for i in page_indexes:
                page = pdf[i]
                try:
                    width, height = (math.ceil(length * scale) for length in page.get_size())
                    if width < 1 or height < 1 or width * height > config.MAX_IMAGE_PIXELS:
                        raise OcrError("A rendered PDF page exceeds the image scan limit.")
                    bitmap = page.render(scale=scale)
                    try:
                        with bitmap.to_pil() as image:
                            text = self.ocr.read(image)
                            if not first_hit and self._fuzzy_hit(text):
                                first_hit = f"page {i + 1} (rendered + OCR)"
                    finally:
                        bitmap.close()
                finally:
                    page.close()
        finally:
            pdf.close()
        return first_hit

    # -- images ------------------------------------------------------------ #
    def _scan_image(self, data: bytes) -> ScanResult:
        pil = _open_image(data)
        if pil is None:
            return ScanResult(False, "image", error="The image could not be decoded.")
        with pil:
            first_hit = "image metadata" if self._raw_hit(data) else ""
            if not self.ocr.available:
                return ScanResult(False, "image", error="OCR is unavailable for this image.")
            frame_count = getattr(pil, "n_frames", 1)
            if frame_count > config.MAX_IMAGE_FRAMES:
                return ScanResult(False, "image", error="The image exceeds the frame scan limit.")
            for index in range(frame_count):
                pil.seek(index)
                text = self.ocr.read(pil)
                if not first_hit and self._fuzzy_hit(text):
                    first_hit = "text in image (OCR)"
        return ScanResult(bool(first_hit), "image", first_hit)

    # -- zip-based containers (docx, xlsx, pptx, zip) -------------------- #
    def _scan_archive(self, data: bytes) -> ScanResult:
        budget = config.MAX_ARCHIVE_EXPANDED_BYTES
        members_left = config.MAX_ARCHIVE_MEMBERS
        pending: list[tuple[bytes, tuple[str, ...]]] = [(data, ())]
        first_hit = "archive contents" if self._raw_hit(data) else ""
        while pending:
            archive, location = pending.pop()
            with zipfile.ZipFile(io.BytesIO(archive)) as zf:
                entries = zf.infolist()
                members_left -= len(entries)
                if members_left < 0:
                    return ScanResult(False, "archive", error="The archive exceeds the member scan limit.")
                for info in entries:
                    if info.is_dir() and info.file_size == 0:
                        continue
                    if info.file_size > budget:
                        return ScanResult(False, "archive", error="The archive exceeds the expanded scan limit.")
                    budget -= info.file_size
                    member = zf.read(info)
                    if len(member) != info.file_size:
                        return ScanResult(False, "archive", error="An archive member could not be fully read.")

                    member_path = (*location, info.filename)
                    office_hit = self._office_text_hit(info.filename, member)
                    if office_hit and not first_hit:
                        first_hit = f"inside '{'/'.join(member_path)}' (Office text)"
                    kind = sniff_type(info.filename, member)
                    if kind == "archive":
                        if len(member_path) >= config.MAX_ARCHIVE_DEPTH:
                            return ScanResult(False, "archive", error="The archive exceeds the nesting scan limit.")
                        if not first_hit and self._raw_hit(member):
                            first_hit = f"inside '{'/'.join(member_path)}'"
                        pending.append((member, member_path))
                        continue

                    result = self._scan_content(kind, member)
                    if result.error is not None:
                        return ScanResult(False, "archive", error=result.error)
                    if result.found and not first_hit:
                        first_hit = f"inside '{'/'.join(member_path)}' ({result.where})"

        return ScanResult(bool(first_hit), "archive", first_hit)

    def _office_text_hit(self, name: str, data: bytes) -> bool:
        """Read logical text in Office parts where styling can split the marker across runs."""
        name = name.lower()
        if not name.endswith(".xml"):
            return False
        if name.startswith(("word/document.", "word/header", "word/footer", "word/footnotes.",
                            "word/endnotes.", "word/comments.")):
            namespace, blocks, text_tag = "wordprocessingml", ("p",), "t"
        elif name.startswith(("ppt/slides/", "ppt/notesslides/")):
            namespace, blocks, text_tag = "drawingml", ("p",), "t"
        elif name == "xl/sharedstrings.xml" or name.startswith("xl/worksheets/"):
            namespace, blocks, text_tag = "spreadsheetml", ("si", "is", "v"), "t"
        else:
            return False

        root = ET.fromstring(data)
        for uri in (f"http://schemas.openxmlformats.org/{namespace}/2006/main",
                    f"http://purl.oclc.org/ooxml/{namespace}/main"):
            ns = "{" + uri + "}"
            for tag in blocks:
                for block in root.iter(ns + tag):
                    if tag == "v":
                        text = block.text or ""
                    else:
                        text = "".join(node.text or "" for node in block.iter(ns + text_tag))
                    if self.scan_text(text):
                        return True
        return False


# ---------------------------------------------------------------------------- #
# helpers
# ---------------------------------------------------------------------------- #
def sniff_type(name: str, data: bytes) -> str:
    head = data[:16]
    ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    if data[:1024].lstrip().startswith(b"%PDF-") or b"%PDF-" in data[:1024]:
        return "pdf"
    if (
        head.startswith((b"\x89PNG", b"\xff\xd8\xff", b"GIF8", b"BM", b"II*\x00", b"MM\x00*"))
        or (head[:4] == b"RIFF" and data[8:12] == b"WEBP")
    ):
        return "image"
    if head.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
        return "archive"
    # A corrupt file with a supported extension still goes through the appropriate parser.
    if ext == ".pdf":
        return "pdf"
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in {".zip", ".docx", ".xlsx", ".pptx"}:
        return "archive"
    return "text" if _looks_textual(data) else "binary"


def _looks_textual(data: bytes) -> bool:
    try:
        if data.startswith((b"\xff\xfe", b"\xfe\xff")):
            return "\x00" not in data.decode("utf-16")
        data.decode("utf-8")
    except UnicodeError:
        return False
    return re.search(rb"[\x00-\x08\x0e-\x1f\x7f]", data) is None


def _open_image(data: bytes):
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(data))
    except Exception:  # noqa: BLE001
        return None
    if img.width * img.height > config.MAX_IMAGE_PIXELS:
        img.close()
        raise OcrError("The image exceeds the pixel scan limit.")
    try:
        img.load()
    except Exception:  # noqa: BLE001
        img.close()
        return None
    return img
