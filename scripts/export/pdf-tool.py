# Lane L5: a PDF through MuPDF (PyMuPDF): page sizes, each page rasterised at the given dpi into DIR/page-<n>.png,
# extracted text, and every warning MuPDF printed while opening, drawing and reading it. Prints JSON.
#   python3 -I scripts/export/pdf-tool.py file.pdf 144 out-dir
import json
import os
import sys

import pymupdf

path, dpi, out = sys.argv[1], int(float(sys.argv[2])), sys.argv[3]
os.makedirs(out, exist_ok=True)
pymupdf.TOOLS.mupdf_display_warnings(False)
pymupdf.TOOLS.reset_mupdf_warnings()
result = {"pages": [], "warnings": ""}
try:
    doc = pymupdf.open(path)
    for i, page in enumerate(doc):
        pix = page.get_pixmap(dpi=dpi, alpha=False)
        png = os.path.join(out, f"page-{i}.png")
        pix.save(png)
        result["pages"].append({"width": page.rect.width, "height": page.rect.height, "png": png, "text": page.get_text("text")})
except Exception as error:  # noqa: BLE001 - reported to the caller
    result["error"] = str(error)
result["warnings"] = pymupdf.TOOLS.mupdf_warnings()
print(json.dumps(result))
