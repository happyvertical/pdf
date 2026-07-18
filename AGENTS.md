# Repository Agent Instructions

<!-- hv-managed-policy:start revision=1.0.0 sha256=dc892d3db6b886d9a74b70e555b0017605d9ab88a5ea06540f5d2f45388f804b -->

## Shared development kernel

- Be concise. Load detailed SOP skills only when the task triggers them.
- Read the repository's `.agents/project.yaml` and nearest `AGENTS.md` files before work.
- Use `implement` by default for accepted issue implementation. Apply explicit task, issue, and repository instructions as additions or scoped overrides without weakening this kernel.
- Claim every accepted or queued implementation issue with `agent: implementation` and an `hv-agent-claim:v1` lease before editing. Never overlap another live claim.
- Intentional release reauthenticates the canonical payload owner, records immutable owner-attributed evidence on every exact PR head, then sets `released_at` and the evidence digest on the existing claim comment before labels, project state, or PR readiness change. Public session/comment identifiers are selectors, not mutation credentials. Only the current issue incarnation and latest implementation-label generation may authorize work; issue closure ends renewable authority and settles the selected cycle as `race-lost`. Any later push or reopen requires a new claimed review cycle. Never delete claim history, backfill a release, or create duplicate active claim comments.
- Open pull requests only when reviewable and keep them ready for review. Never use draft status for implementation work; exactly one valid, unexpired claim from the PR session may coexist with a ready PR, while duplicate, expired, foreign-session, or mismatched claims are invalid.
- Lifecycle-protected pull requests merge only through the managed merge queue so the synthetic merge commit rechecks current claim state. Merge-time validation requires a `review` release from the exact implementation cycle bound to the current PR head; never merge with a live, blocked, abandoned, expired, unbound, or stale release, or direct-merge using an earlier pull-request check.
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
