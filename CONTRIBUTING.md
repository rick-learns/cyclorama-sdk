# Contributing

Thanks for helping build the Cyclorama SDK. Bug reports, fixes, tests, documentation and new
tools are all welcome. [LICENSING.md](LICENSING.md) says which licence each part of the
repository carries; your contribution is licensed the same way.

## How changes reach a release

This repository is published as one snapshot per release. Open an issue or a pull request here
as usual. A maintainer reviews it, applies accepted changes to the project's main tree with your
authorship and your `Signed-off-by:` line kept, and the next release carries them. Because each
release is a fresh snapshot, your commit will appear in the release rather than being merged
here directly.

## Ground rules

1. **Test first.** Every change starts with a failing test, then the smallest change that makes
   it pass. Hardware behaviour is pinned by the conformance ROMs in
   [`tests/conformance/`](tests/conformance/), written in CYASM: if you change how the machine
   behaves, a conformance test must show it, and it must agree with the
   [manual](docs/manual/index.html) (HED-0041) and the [spec notes](docs/spec-notes.md).
2. **The specification is the authority.** When the emulator and the manual disagree, open an
   issue; do not quietly change either. The hardware itself does not change: new capabilities
   come from new techniques on the same machine.
3. **Determinism is not negotiable.** The emulated clock alone decides machine timing: no wall
   clock, randomness or host-dependent behaviour in the core. ROM builds stay byte-identical to
   [`roms/manifest.json`](roms/manifest.json).
4. **Docs are code.** A code block in the guides is an exact excerpt of a file the tests build or
   run, and every link resolves (`node tools/doc-check.ts`; see
   [the guides](docs/guide/README.md)). Change the example program, then the excerpt.

## Running the checks

```sh
npm ci
npx playwright install chromium
npm run verify
```

`npm run verify` runs the doctor, the type check, the ROM build, the cartridge budgets and
completion replays, the conformance ROMs and every test tier; it passes on a clean checkout.
While you work, `npm run test:fast` runs the fast tier (most Node tests) in well under a minute,
`npm run test:slow` the slow Node tier, and
`node tools/verify.ts --part static` (or `emulation`, `browser`) runs one part of the gate.
Before you submit, run the full `npm run verify` on a clean tree. CI runs the same gate on every
pull request ([`.github/workflows/verify.yml`](.github/workflows/verify.yml)).

## Commit messages

Please follow [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/):
`type(scope): summary`, where type is one of `feat`, `fix`, `test`, `docs`, `ci`, `build`,
`perf`, `refactor` or `chore`; the summary is imperative ("add", not "added"), has no trailing
period, and the header is at most 100 characters. Say in the body what you observed, for example
a test count or a replay hash, not only what you ran.

## Licensing of contributions: the Developer Certificate of Origin

- Code is accepted under the **Apache License 2.0**, specification and documentation text under
  **CC BY 4.0**, and SDK runtime code under **Apache-2.0 WITH LLVM-exception**: inbound =
  outbound, the licence the file already carries.
- Sign off every commit (`git commit -s`), which adds a `Signed-off-by: Your Name <you@example>`
  line. It certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
  that you wrote the change or otherwise have the right to submit it under the file's licence.
  Pull requests with unsigned commits cannot be applied.
- New source files start with the two SPDX lines of their tier (see
  [LICENSING.md](LICENSING.md#spdx-headers)).
- Do not add third-party code or assets unless their licence is compatible; record them in
  [`LICENSES/`](LICENSES/) and [NOTICE](NOTICE).

## The fiction has rules too

The Cyclorama belongs to an invented 1987–1994. Text that speaks in-universe (the manual, example
comments written in the period voice, demo cartridges) follows two rules:

- **No real-world brands, companies, products, people or trademarks** inside the fiction: no real
  consoles, CPUs, magazines, retailers or game series. The denylist in
  [`canon/canon-public.json`](canon/canon-public.json) catches many of them, not all.
- **No new facts about the fictional company or the console's history.** The hardware facts are
  fixed by the manual; the history is not part of this repository.

Engineering documentation outside the fiction, like this file, may name real tools.

## Trademarks

Contributing grants no trademark rights. Read [TRADEMARKS.md](TRADEMARKS.md) before naming a
fork, tool or game: say "for the Cyclorama" in plain text, never call anything "official", and do
not use the logos or the official start-up splash.

## Conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
