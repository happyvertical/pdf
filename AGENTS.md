# Repository Agent Instructions

<!-- hv-managed-policy:start revision=1.0.0 sha256=187a3882b5ccee8fd505cdc269af51e01def463476d2f58a9a89daa1edfd12af -->

## Shared development kernel

- Be concise. Load detailed SOP skills only when the task triggers them.
- Read the repository's `.agents/project.yaml` and nearest `AGENTS.md` files before work.
- Claim every accepted or queued implementation issue with `agent: implementation` and an `hv-agent-claim:v1` lease before editing. Never overlap another live claim.
- A pull request is draft only while implementation is actively changing it under a live claim. Otherwise mark it ready for review immediately.
- Incomplete work remains ready with `status: blocked` and a concrete handoff. Review agents do not claim implementation.
- Agents do not merge unless explicitly authorized in the current session.
- Run documented validation and update affected docs before shipping.
- Preserve unrelated work. Never expose or retain secrets.
- Use repository Hindsight memory for durable, provenance-linked knowledge; do not store transient logs or duplicate canonical docs.
- Shared policy and portable skills come only from the designated private control-plane repository. Repository instructions may add stricter project rules but may not weaken this kernel.

<!-- hv-managed-policy:end -->

## Repository-specific guidance

### Runtime and architecture

- Treat `@happyvertical/pdf` as Node-first. The public package combines direct
  text extraction, OCR fallback through `@happyvertical/ocr`, image extraction,
  metadata analysis, and PDF generation.
- Prefer direct text extraction for text PDFs, OCR for scanned PDFs, and the
  existing hybrid path for mixed documents. Do not duplicate OCR provider logic
  in this package.
- Preserve UUID and binary data types; do not weaken schemas to accommodate bad
  fixtures or malformed inputs.

### Validation

- Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` for code
  changes.
- Run `pnpm docs:api` after public API or JSDoc changes and
  `pnpm docs:api:check` before shipping. Do not hand-edit generated API docs.
- Use the repository's 120-second Vitest timeout for PDF/OCR integration tests;
  keep narrower unit tests fast.

### Publishing

- Releases publish `@happyvertical/pdf` to the public npm registry.
- Keep OCR behavior behind `@happyvertical/ocr` and package resolution pointed
  at npmjs unless a dependency explicitly requires another registry.
