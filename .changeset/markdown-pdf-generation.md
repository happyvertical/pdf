---
"@happyvertical/pdf": minor
---

Add `renderMarkdownToPdf` for server-side markdown→PDF generation. Renders a
markdown string (headings, paragraphs with word-wrap, bullet/numbered lists,
horizontal rules, fenced code blocks, blockquotes, inline bold/italic/code) to
PDF bytes. Footprint-safe and pure-JS: builds the document with `pdf-lib` and
tokenizes with `marked` — no headless browser, no native modules, no font
embedding (uses the Standard 14 Helvetica/Courier families). Tracks a y cursor
and paginates so content is never written off-page. Optional `title` renders as
a top heading and sets the PDF metadata title. Also exports
`RenderMarkdownToPdfOptions`, `flattenInlineTokens`, `StyledRun`, and a typed
`PDFGenerationError`.
