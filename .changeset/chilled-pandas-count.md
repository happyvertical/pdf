---
'@happyvertical/pdf': patch
---

Stop probing for `@kreuzberg/node` by importing it, which killed the process
with `SIGILL` (exit 132) on pre-AVX2 x86-64 hosts.

The prebuilt binary emits unguarded AVX2 and is loaded lazily on its first
native call, so the availability check executed an illegal instruction as soon
as it asked the module anything. `SIGILL` is a signal rather than a JavaScript
exception, so the surrounding `try`/`catch` could never run. This was reachable
from the default path — `getPDFReader()` with no explicit provider — and from
importing the package at all, because `initializeProviders()` inspects every
provider on module load. `enableOCR: false` did not prevent it.

The CPU baseline is now checked before anything native is loaded: `/proc/cpuinfo`
is read for the `avx2` flag on Linux x86-64, and automatic selection falls back
to `unpdf` when it is missing. Requesting `provider: 'kreuzberg'` explicitly on
such a host now degrades like any other missing dependency — `checkDependencies()`
reports `available: false` with an error naming AVX2 — instead of terminating the
process. Other platforms and architectures are unaffected.

Also: `enableOCR: false` keeps automatic selection on `unpdf` without probing
the OCR-capable native provider, and the availability probe is cached instead of
rerunning on every `getPDFReader()` call.
