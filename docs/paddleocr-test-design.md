# Behavior-to-test matrix

All rows: data executor/transaction N/A (read-only parsing, no database); tests use local HTTP fakes or rendered manifest contracts. GPU end-to-end validation is a post-merge deployment gate, not asserted by static tests.

| Behavior | Trigger | Positive | Failure | Actor | Runtime | External contract | Test level / command |
|---|---|---|---|---|---|---|---|
| PDF input | parse(path/ArrayBuffer/Uint8Array) | preserves byte views, base64 fileType=0 | invalid PDF / oversize / unreadable path reject before HTTP | Node caller | Node >=24 | PaddleOCR full pipeline | unit + local HTTP / pnpm exec vitest run src/node/paddleocr.test.ts |
| response normalization | multi-page result | Markdown order, 1-based pages, raw layout retained | malformed envelope/page reject; unknown fields retained | Node caller | Node >=24 | JSON envelope errorCode/layoutParsingResults | unit + local HTTP / pnpm exec vitest run src/node/paddleocr.test.ts |
| HTTP lifecycle | on-demand request | config endpoint, optional bearer, cold-start timeout | HTTP/API/network failures, redirects, cancellation and timeout reject | trusted endpoint configured by caller | Node fetch | no automatic retries | unit + local HTTP / pnpm exec vitest run src/node/paddleocr.test.ts |
| compatibility | package import and existing getPDFReader | explicit client export; reader behavior unchanged | missing endpoint fails early | existing consumers | Node >=24 | additive API | unit + local HTTP / pnpm exec vitest run src/node/paddleocr.test.ts |
