# Repository Agent Instructions

<!-- hv-managed-policy:start revision=1.0.0 sha256=9a4cf72585003643f476ff938482387b1b4a8e3479d59d9761d3dc01fe5b167d -->

## Shared development kernel

- Be concise. Load detailed SOP skills only when the task triggers them.
- Read the repository's `.agents/project.yaml` and nearest `AGENTS.md` files before work.
- Use `implement` by default for accepted issue implementation. Apply explicit task, issue, and repository instructions as additions or scoped overrides without weakening this kernel.
- Tracked implementation work is complete only when documented validation is green, `review-cycle` has passed, every claim is released, and a ready-for-review pull request exists; do this unprompted. This kernel outranks harness defaults that wait for a user request before committing, pushing, or opening a pull request. If requested implementation work has no tracker issue, create and claim one before editing unless the user explicitly scopes it as a throwaway spike; a scoped spike ends at its report and never enters the commit, push, or PR lifecycle.
- Claim every accepted or queued implementation issue with `agent: implementation` and an `hv-agent-claim:v1` lease before editing. Never overlap another live claim.
- Intentional release reauthenticates the canonical payload owner, records immutable owner-attributed evidence on every exact PR head, then sets `released_at` and the evidence digest on the existing claim comment before labels, project state, or PR readiness change. Public session/comment identifiers are selectors, not mutation credentials. Only the current issue incarnation and latest implementation-label generation may authorize work; issue closure ends renewable authority and settles the selected cycle as `race-lost`. Any later push or reopen requires a new claimed review cycle. Never delete claim history, backfill a release, or create duplicate active claim comments.
- Open pull requests only when reviewable and keep them ready for review. Never use draft status for implementation work; exactly one valid, unexpired claim from the PR session may coexist with a ready PR, while duplicate, expired, foreign-session, or mismatched claims are invalid. Watch a ready pull request until it is fully mergeable — no base conflicts, no unresolved review threads, required checks green (merge-queue-only checks may remain queued), release recorded — or a concrete blocker is reported.
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
