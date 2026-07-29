---
'@happyvertical/pdf': patch
---

Stop a Kreuzberg "unavailable" verdict from sticking for the lifetime of the
process.

Automatic provider selection caches its availability answer so it does not
reload the native module and rerun `checkDependencies()` on every
`getPDFReader()` call. It cached negative answers too, and those are not always
permanent: `checkDependencies()` reads `TESSDATA_PREFIX` and probes the
filesystem, so a process whose first call ran before tessdata was installed kept
reporting kreuzberg unusable even once the dependency was repaired.

Affirmative verdicts are now kept for the life of the process and negative ones
expire after 30 seconds. The delay is deliberate rather than an immediate retry:
with tessdata missing, `ensureTessdataPrefix()` does not cache the miss and
shells out to `tesseract --list-langs`, so retrying on every call would fork a
subprocess per `getPDFReader()`. Concurrent callers continue to share a single
in-flight probe.
