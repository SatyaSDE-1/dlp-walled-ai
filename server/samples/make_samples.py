"""In-memory sample files for scanner and IPC checks."""

from io import BytesIO

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas

from dlp.config import MARKER

CLEAN_BODY = "This document contains public notes."
SENSITIVE_BODY = f"{MARKER}\nConfidential notes."


def image_bytes(text: str, image_format: str) -> bytes:
    output = BytesIO()
    with Image.new("RGB", (1000, 260), "white") as image:
        font = ImageFont.load_default(size=48)
        ImageDraw.Draw(image).multiline_text((40, 40), text, font=font, fill="black", spacing=16)
        image.save(output, format=image_format)
    return output.getvalue()


def pdf_with_text(text: str) -> bytes:
    output = BytesIO()
    pdf = Canvas(output)
    paragraph = pdf.beginText(48, 750)
    paragraph.setFont("Helvetica", 16)
    paragraph.textLines(text)
    pdf.drawText(paragraph)
    pdf.save()
    return output.getvalue()


def pdf_from_image(text: str) -> bytes:
    output = BytesIO()
    image = ImageReader(BytesIO(image_bytes(text, "PNG")))
    width, height = image.getSize()
    pdf = Canvas(output, pagesize=(width, height))
    pdf.drawImage(image, 0, 0, width=width, height=height)
    pdf.save()
    return output.getvalue()
