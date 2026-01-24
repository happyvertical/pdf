---
"@happyvertical/pdf": minor
---

Make kreuzberg the default provider for Node.js

- Kreuzberg is now auto-selected when available (falls back to unpdf)
- Updated tests to handle both provider architectures
- Added benchmark script for comparing provider performance
- Legacy functions (extractImagesFromPDF, performOCROnImages) now default to unpdf for modular workflow compatibility

Kreuzberg benefits:
- 23-33% faster text extraction
- 99.5% less memory usage
- Better suited for large PDFs (40-50MB+)
