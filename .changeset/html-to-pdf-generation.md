---
"@happyvertical/pdf": minor
---

Add HTML-to-PDF generation: `renderHtmlToPdf(html, options)` and
`resolveChromiumExecutablePath()`. The engine is `puppeteer-core` against a
system Chromium (no browser download, no cosmiconfig/typescript dependency
chain), imported lazily so consumers never load browser automation code until
they actually render. Also bumps `@happyvertical/utils` to the current 0.74
line.
