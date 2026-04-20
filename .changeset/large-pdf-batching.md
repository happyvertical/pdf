---
'@happyvertical/pdf': patch
---

Add transparent batched extraction for large PDFs, propagate configured `maxFileSize` through providers, and fail explicitly on incomplete batch extraction instead of returning partial success.
