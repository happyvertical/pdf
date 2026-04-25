---
"@happyvertical/pdf": patch
---

Fail explicitly when OCR fallback cannot render or recognize text, and cap collected image extraction bytes so large PDFs use the existing batched `onBatch` path instead of retaining unbounded image buffers.
