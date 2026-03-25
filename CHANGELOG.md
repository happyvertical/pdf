# @happyvertical/pdf

## 0.62.20

### Patch Changes

- ### Dependencies

  - update pnpm to v10.33.0 (#54)

## 0.62.19

### Patch Changes

- ### Dependencies

  - update actions/cache digest to 6682284 (#52)

## 0.62.18

### Patch Changes

- ### Dependencies

  - update pnpm/action-setup action to v5 (#51)

## 0.62.17

### Patch Changes

- ### Dependencies

  - update actions/create-github-app-token action to v3 (#50)

## 0.62.16

### Patch Changes

- ### Dependencies

  - update all dependencies (#49)

## 0.62.15

### Patch Changes

- ### Dependencies

  - update all dependencies (#48)

## 0.62.14

### Patch Changes

- ### Dependencies

  - update pnpm to v10.32.0 (#46)

## 0.62.13

### Patch Changes

- ### Dependencies

  - update pnpm to v10.31.0 (#45)

## 0.62.12

### Patch Changes

- ### Dependencies

  - update @types/node to v24.12.0 (#44)

## 0.62.11

### Patch Changes

- ### Dependencies

  - update @happyvertical/utils to ^0.71.0 (#43)

## 0.62.10

### Patch Changes

- ### Dependencies

  - update @types/node to v24.11.0 (#42)

## 0.62.9

### Patch Changes

- ### Dependencies

  - update @happyvertical/utils to ^0.70.0 (#41)

## 0.62.8

### Patch Changes

- ### Dependencies

  - update all dependencies (#40)

## 0.62.7

### Patch Changes

- ### Dependencies

  - update pnpm to v10.30.2 (#39)

## 0.62.6

### Patch Changes

- ### Dependencies

  - update pnpm to v10.30.1 (#38)

## 0.62.5

### Patch Changes

- ### Dependencies

  - update @happyvertical/utils to ^0.69.0 (#37)

## 0.62.4

### Patch Changes

- ### Dependencies

  - update pnpm to v10.30.0 (#36)

## 0.62.3

### Patch Changes

- ### Dependencies

  - update all dependencies (#35)

## 0.62.2

### Patch Changes

- ### Bug Fixes

  - handle multi-line commit bodies in auto-changeset (#34) (ci)

## 0.62.1

### Patch Changes

- ### Bug Fixes

  - treat dependency updates as patch bumps in auto-changeset

  ### Dependencies

  - update all dependencies (#32)
  - update @types/node to v24.10.11 (#31)
  - update @happyvertical/utils to ^0.68.0 (#30)
  - update @types/node to v24.10.10 (#29)

## 0.62.0

### Minor Changes

- e601df2: Make kreuzberg the default provider for Node.js

  - Kreuzberg is now auto-selected when available (falls back to unpdf)
  - Updated tests to handle both provider architectures
  - Added benchmark script for comparing provider performance
  - Legacy functions (extractImagesFromPDF, performOCROnImages) now default to unpdf for modular workflow compatibility

  Kreuzberg benefits:

  - 23-33% faster text extraction
  - 99.5% less memory usage
  - Better suited for large PDFs (40-50MB+)

## 0.61.0

### Minor Changes

- 2da7220: Add Kreuzberg provider for memory-efficient PDF processing

  - Add KreuzbergProvider using @kreuzberg/node (Rust-based PDF processing)
  - Kreuzberg offers streaming for large PDFs and built-in OCR via Tesseract
  - Add 'kreuzberg' as a new provider option alongside 'unpdf' and 'pdfjs'
  - Use `HAVE_PDF_PROVIDER=kreuzberg` env var or `{ provider: 'kreuzberg' }` option

## 0.60.4

### Patch Changes

- ### Bug Fixes

  - resolve pdfjs-dist version mismatch breaking OCR fallback (deps)

## 0.60.3

### Patch Changes

- ### Features

  - add auto-changeset and direct publish workflow (ci)
  - graduate @happyvertical/pdf to standalone repository

  ### Bug Fixes

  - remove explicit path from biome lint script (release)
  - update @happyvertical/ocr to ^0.60.4 (deps)
  - add workflow_dispatch trigger to publish workflow (release)
  - use GH_TOKEN org secret for npm publish (release)
  - include root package in pnpm workspace for changesets (release)
  - remove useParseIntRadix rule (biome 2.x only) (pdf)
  - align biome.json with biome 1.9.4 (include, schema) (pdf)
  - remove pnpm version conflict with packageManager (deps)
  - add packages:read permission for GitHub Packages auth (deps)

## 0.60.2

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.60.2
  - @happyvertical/ocr@0.60.2

## 0.60.1

### Patch Changes

- @happyvertical/ocr@0.60.1
- @happyvertical/utils@0.60.1

## 0.60.0

### Patch Changes

- @happyvertical/ocr@0.60.0
- @happyvertical/utils@0.60.0

## 0.59.6

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.59.6
  - @happyvertical/ocr@0.59.6

## 0.59.5

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.59.5
  - @happyvertical/ocr@0.59.5

## 0.59.4

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.59.4
  - @happyvertical/ocr@0.59.4

## 0.59.3

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.59.3
  - @happyvertical/ocr@0.59.3

## 0.59.2

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.59.2
  - @happyvertical/ocr@0.59.2

## 0.59.1

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.59.1
  - @happyvertical/ocr@0.59.1

## 0.59.0

### Patch Changes

- @happyvertical/ocr@0.59.0
- @happyvertical/utils@0.59.0

## 0.57.1

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.57.1
  - @happyvertical/ocr@0.57.1

## 0.57.0

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.57.0
  - @happyvertical/ocr@0.57.0

## 0.56.18

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.56.18
  - @happyvertical/ocr@0.56.18

## 0.56.17

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.56.17
  - @happyvertical/ocr@0.56.17

## 0.56.16

### Patch Changes

- @happyvertical/ocr@0.56.16
- @happyvertical/utils@0.56.16

## 0.56.15

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.56.15
  - @happyvertical/ocr@0.56.15

## 0.56.14

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.56.14
  - @happyvertical/ocr@0.56.14

## 0.56.13

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.56.13
  - @happyvertical/ocr@0.56.13

## 0.56.12

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.56.12
  - @happyvertical/ocr@0.56.12

## 0.56.11

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.56.11
  - @happyvertical/ocr@0.56.11

## 0.56.10

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.56.10
  - @happyvertical/ocr@0.56.10

## 0.56.9

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.56.9
  - @happyvertical/ocr@0.56.9

## 0.56.8

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.56.8
  - @happyvertical/ocr@0.56.8

## 0.56.7

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.56.7
  - @happyvertical/ocr@0.56.7

## 0.56.6

### Patch Changes

- Updated dependencies
  - @happyvertical/utils@0.56.6
  - @happyvertical/ocr@0.56.6

## 0.56.5

### Patch Changes

- @happyvertical/ocr@0.56.5
- @happyvertical/utils@0.56.5

## 0.56.4

### Patch Changes

- @happyvertical/ocr@0.56.4
- @happyvertical/utils@0.56.4

## 0.56.3

### Patch Changes

- @happyvertical/ocr@0.56.3
- @happyvertical/utils@0.56.3

## 0.56.2

### Patch Changes

- @happyvertical/ocr@0.56.2
- @happyvertical/utils@0.56.2

## 0.56.1

### Patch Changes

- @happyvertical/ocr@0.56.1
- @happyvertical/utils@0.56.1

## 0.56.0

### Patch Changes

- c1b1111: Enable fixed versioning for all @happyvertical packages

  All packages in the SDK monorepo now share the same version number. This simplifies version management and makes it easier to understand which packages work together.

  **Changes:**

  - Updated `.changeset/config.json` to enable fixed versioning for all `@happyvertical/*` packages
  - All packages will now be bumped together to the same version
  - Future changesets will automatically synchronize versions across all packages

  **Migration:**

  - All packages will be synchronized to the same version on the next release
  - The root `package.json` version will be kept in sync with all packages

- Updated dependencies [c1b1111]
  - @happyvertical/ocr@0.56.0
  - @happyvertical/utils@0.56.0

## 0.55.4

### Patch Changes

- dc9c86d: chore: update all dependencies to latest versions

  Updated all dependencies across the monorepo to their latest versions:

  - vite: 5.4.x/6.x/7.1.x → 7.2.2
  - vitest: 2.1.9/3.2.4 → 4.0.8
  - happy-dom: 18.0.1 → 20.0.10 (fixes CVE-2025-61927, CVE-2025-62410)
  - vite-plugin-dts: 3.9.x/4.3.x → 4.5.4
  - @biomejs/biome: 1.9.4/2.3.3 → 2.3.4
  - turbo: 2.3.3/2.5.x → 2.6.0
  - typescript: 5.7.x → 5.9.3
  - And 30+ other dependencies

  Also fixed test and typecheck failures in logger package:

  - Added `vi.clearAllMocks()` to clear mock spy history between tests
  - Added `skipLibCheck: true` to prevent checking problematic node_modules types

  Also skipped browser-based integration tests in spider package when running in CI:

  - CrawleeAdapter tests (Playwright browser automation)
  - TreeScraper tests (browser-based web scraping)
  - Tests pass locally but fail in CI environment

  Closes #387, #396, #397

- Updated dependencies [dc9c86d]
  - @happyvertical/ocr@0.55.4
  - @happyvertical/utils@0.55.4

## 0.55.3

### Patch Changes

- Updated dependencies [849eb94]
  - @happyvertical/utils@0.55.3
  - @happyvertical/ocr@0.55.3

## 0.55.0

### Minor Changes

- 5ef824c: Auto-generated changeset from conventional commits:

  fix: simplify auto-changeset workflow - remove dependency installation
  fix: remove pnpm version from workflow to use packageManager field
  Merge pull request #346 from happyvertical/claude-auto-fix-fix/add-package-tagformat-18985806972
  Merge pull request #345 from happyvertical/claude-auto-fix-fix/add-package-tagformat-18985694712
  fix(deps): update pnpm-lock.yaml to remove semantic-release dependencies
  fix(deps): update pnpm-lock.yaml to remove semantic-release dependencies
  feat: add auto-changeset workflow for automatic version bumps
  fix: replace semantic-release with changesets for predictable versioning

### Patch Changes

- Updated dependencies [5ef824c]
  - @happyvertical/ocr@0.55.0
  - @happyvertical/utils@0.55.0
