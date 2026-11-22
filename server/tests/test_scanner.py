import io
import zipfile

import pytest

from dlp.scanner import Scanner, sniff_type
from samples import make_samples as ms

M = ms.MARKER


@pytest.fixture(scope="module")
def scanner():
    return Scanner()


# ---------------------------------------------------------------- prompts / text
def test_prompt_exact_match(scanner):
    assert scanner.scan_text(f"please summarise {M} for me")
    assert not scanner.scan_text("an ordinary prompt")
    assert not scanner.scan_text("walled_sensitive")          # case-sensitive for typed text


def test_text_file(scanner):
    assert scanner.scan_file("a.txt", ms.SENSITIVE_BODY.encode()).found
    assert not scanner.scan_file("a.txt", ms.CLEAN_BODY.encode()).found


def test_utf16_text_file(scanner):
    assert scanner.scan_file("u16.txt", f"hello {M}".encode("utf-16")).found


def test_source_code_and_unknown_extension(scanner):
    assert scanner.scan_file("notes", f"# {M}\nprint(1)".encode()).found


def test_empty_file(scanner):
    r = scanner.scan_file("e.txt", b"")
    assert not r.found and r.file_type == "empty"


# ----------------------------------------------------------------------- PDF
def test_pdf_text_layer(scanner):
    r = scanner.scan_file("s.pdf", ms.pdf_with_text(ms.SENSITIVE_BODY))
    assert r.found and r.file_type == "pdf"


def test_pdf_clean(scanner, monkeypatch):
    def unexpected_render(*_args):
        pytest.fail("An ordinary text PDF does not need page rendering")

    monkeypatch.setattr(scanner, "_scan_rendered_pages", unexpected_render)
    result = scanner.scan_file("c.pdf", ms.pdf_with_text(ms.CLEAN_BODY))
    assert not result.found and result.error is None


def test_pdf_scanned_needs_ocr(scanner):
    r = scanner.scan_file("scan.pdf", ms.pdf_from_image(ms.SENSITIVE_BODY))
    assert r.found and "OCR" in r.where


def test_pdf_vector_text_in_form_with_extractable_page_text(scanner, monkeypatch):
    from PIL import Image, ImageDraw, ImageFont
    from pypdf import PdfReader
    from reportlab.pdfgen import canvas

    # Convert a fixture glyph mask to PDF paths. The finished PDF contains no raster image.
    with Image.new("1", (540, 70)) as mask:
        ImageDraw.Draw(mask).text((4, 0), M, font=ImageFont.load_default(size=48), fill=1)
        data = io.BytesIO()
        pdf = canvas.Canvas(data)
        pdf.drawString(30, 740, "Ordinary selectable text about the quarterly report")
        pdf.beginForm("outlined-text")
        path = pdf.beginPath()
        for y in range(mask.height):
            start = None
            for x in range(mask.width + 1):
                painted = x < mask.width and mask.getpixel((x, y))
                if painted and start is None:
                    start = x
                elif not painted and start is not None:
                    path.rect(30 + start, 660 - y, x - start, 1)
                    start = None
        pdf.drawPath(path, fill=1, stroke=0)
        pdf.endForm()
        pdf.doForm("outlined-text")
        pdf.save()

    page = PdfReader(data).pages[0]
    assert page.extract_text().strip() == "Ordinary selectable text about the quarterly report"
    assert not page.images
    result = scanner.scan_file("mixed.pdf", data.getvalue())
    assert result.found and result.error is None and result.where == "page 1 (rendered + OCR)"

    monkeypatch.setattr("dlp.config.MAX_PDF_PAGES_RENDERED", 0)
    result = scanner.scan_file("mixed.pdf", data.getvalue())
    assert not result.found and result.error == "The PDF exceeds the rendered-page scan limit."


def test_pdf_wrong_extension_still_detected(scanner):
    assert scanner.scan_file("report.txt", ms.pdf_with_text(ms.SENSITIVE_BODY)).found


def test_corrupt_pdf_does_not_raise(scanner):
    r = scanner.scan_file("bad.pdf", b"%PDF-1.4\nthis is not really a pdf")
    assert not r.found and r.error


def test_pdf_embedded_files_are_blocked_even_when_page_contains_marker(scanner):
    from pypdf import PdfWriter

    pdf = PdfWriter(clone_from=io.BytesIO(ms.pdf_with_text(ms.SENSITIVE_BODY)))
    pdf.add_attachment("extra.txt", b"uninspected attachment")
    data = io.BytesIO()
    pdf.write(data)
    result = scanner.scan_file("attachment.pdf", data.getvalue())
    assert not result.found and result.error == "PDFs with embedded files are blocked."


@pytest.mark.parametrize("inside_archive", [False, True])
def test_encrypted_pdf_is_unscannable(scanner, inside_archive):
    from pypdf import PdfWriter

    pdf = PdfWriter()
    pdf.add_blank_page(width=100, height=100)
    pdf.encrypt("password")
    data = io.BytesIO()
    pdf.write(data)
    if inside_archive:
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("marked.txt", f"already detected {M}")
            zf.writestr("encrypted.pdf", data.getvalue())
        result = scanner.scan_file("files.zip", archive.getvalue())
    else:
        result = scanner.scan_file("encrypted.pdf", data.getvalue())

    assert not result.found and result.error == "Encrypted PDFs are blocked."


# --------------------------------------------------------------------- images
@pytest.mark.parametrize("fmt,name", [("PNG", "s.png"), ("JPEG", "s.jpg")])
def test_image_with_marker(scanner, fmt, name):
    r = scanner.scan_file(name, ms.image_bytes(ms.SENSITIVE_BODY, fmt))
    assert r.found and r.file_type == "image"


def test_image_clean(scanner):
    result = scanner.scan_file("c.png", ms.image_bytes(ms.CLEAN_BODY, "PNG"))
    assert not result.found and result.error is None


def test_ocr_failure_is_an_error(monkeypatch, scanner):
    def fail(_image):
        raise RuntimeError("OCR engine failed")

    monkeypatch.setattr(scanner.ocr, "_initialised", True)
    monkeypatch.setattr(scanner.ocr, "_fn", fail)
    result = scanner.scan_file("x.png", ms.image_bytes(ms.CLEAN_BODY, "PNG"))
    assert not result.found and result.error == "OCR could not scan the image."


def test_ocr_tolerates_space_instead_of_underscore(scanner):
    img = ms.image_bytes("Top secret\nWALLED SENSITIVE data", "PNG")
    assert scanner.scan_file("x.png", img).found


# -------------------------------------------------------------------- archives
def test_docx_like_zip(scanner):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("word/document.xml", f"<p xmlns='http://schemas.openxmlformats.org/wordprocessingml/2006/main'><t>{M}</t></p>")
    r = scanner.scan_file("a.docx", buf.getvalue())
    assert r.found and r.file_type == "archive"


@pytest.mark.parametrize("filename,part,namespace,xml", [
    ("a.docx", "word/document.xml", "wordprocessingml", "<p><r><t>WALLED_</t></r><r><t>SENSITIVE</t></r></p>"),
    ("a.pptx", "ppt/slides/slide1.xml", "drawingml", "<p><r><t>WALLED_</t></r><r><t>SENSITIVE</t></r></p>"),
    ("a.xlsx", "xl/sharedStrings.xml", "spreadsheetml", "<si><r><t>WALLED&#95;</t></r><r><t>SENSITIVE</t></r></si>"),
])
def test_office_text_split_across_runs(scanner, filename, part, namespace, xml):
    document = io.BytesIO()
    with zipfile.ZipFile(document, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(part, f"<root xmlns='http://schemas.openxmlformats.org/{namespace}/2006/main'>{xml}</root>")
    for name, data in ((filename, document.getvalue()), ("nested.zip", _zip(filename, document.getvalue()))):
        result = scanner.scan_file(name, data)
        assert result.found and result.error is None
        assert "Office text" in result.where


def _zip(name, data):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(name, data)
    return out.getvalue()


def test_malformed_office_xml_is_blocked(scanner):
    result = scanner.scan_file("a.docx", _zip("word/document.xml", f"<p>{M}"))
    assert not result.found and result.error


def test_nested_archive_expansion_limit(scanner, monkeypatch):
    from dlp import config

    inner = _zip("report.txt", b"x" * 4096)
    monkeypatch.setattr(config, "MAX_ARCHIVE_EXPANDED_BYTES", 2048)
    result = scanner.scan_file("nested.zip", _zip("inner.zip", inner))
    assert not result.found and "expanded scan limit" in result.error


def test_sniffing():
    assert sniff_type("x", b"%PDF-1.7 ...") == "pdf"
    assert sniff_type("x", b"\x89PNG\r\n\x1a\n....") == "image"
    assert sniff_type("x", b"just text") == "text"
    assert sniff_type("x", b"\x00\x01\x02binary") == "binary"
