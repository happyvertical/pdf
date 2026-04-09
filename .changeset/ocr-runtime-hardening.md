---
'@happyvertical/pdf': patch
---

Improve Node OCR runtime handling for scanned PDFs by auto-detecting Tesseract
`tessdata`, surfacing actionable OCR dependency errors, routing explicit
external OCR providers like `onnx` through the `unpdf` pipeline, and rendering
OCR pages directly with `pdfjs-dist` to avoid worker-version mismatches.
