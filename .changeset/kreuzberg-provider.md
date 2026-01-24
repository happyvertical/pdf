---
"@happyvertical/pdf": minor
---

Add Kreuzberg provider for memory-efficient PDF processing

- Add KreuzbergProvider using @kreuzberg/node (Rust-based PDF processing)
- Kreuzberg offers streaming for large PDFs and built-in OCR via Tesseract
- Add 'kreuzberg' as a new provider option alongside 'unpdf' and 'pdfjs'
- Use `HAVE_PDF_PROVIDER=kreuzberg` env var or `{ provider: 'kreuzberg' }` option
