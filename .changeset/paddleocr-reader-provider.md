---
"@happyvertical/pdf": minor
---

Add `provider: 'paddleocr'` to `getPDFReader()`: a complete reader that reads text and OCRs images through a PaddleOCR-VL service and handles metadata, images and page rendering locally. Never selected by `auto`. `PaddleOCRClient` gains `parseImage()` for PNG and JPEG input.
