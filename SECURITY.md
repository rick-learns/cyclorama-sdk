# Security policy

## Supported versions

Security fixes go into the next release. Only the latest release is supported.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use **Report a vulnerability** on
this repository's Security tab (GitHub private vulnerability reporting).

Examples: a crash, hang or unbounded memory use in the emulator, assembler, compiler or tools
triggered by a crafted ROM or source file; a code-execution path; a compromised dependency or CI
action.

Include what you found, how to reproduce it (a minimal ROM or source file is ideal) and the
release you tested. The maintainer aims to acknowledge a report within 7 days. Please allow a
reasonable time for a fix before you disclose it.

## Scope notes

- The emulator core is deterministic and never reads host time or randomness. A ROM that makes
  two runs of the same input diverge is a bug worth reporting.
- ROM images and `.asm`, `.scr`, `.art` and `.song` files are untrusted input to the toolchain:
  any hang, unbounded memory use or crash they cause in [`tools/`](tools/) or [`src/`](src/) is in
  scope.
- The CI workflow installs dependencies with `npm ci --ignore-scripts` from the lockfile and pins
  every action to a commit.
- Trademark and licence questions are not security issues; see [TRADEMARKS.md](TRADEMARKS.md)
  and [LICENSING.md](LICENSING.md).
