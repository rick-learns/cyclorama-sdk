# Licensing

The Avenell Cyclorama SDK is open. The machine's specification, instruction set, ROM format,
reference emulator, toolchain, SDK runtime and conformance suite are free for anyone to
implement, use and build on. The names and logos are not: they are trademarks, and
[TRADEMARKS.md](TRADEMARKS.md) says what you may do with them.

This file says which licence applies to which path of this repository. Every source file also
names its licence in an SPDX header (see "SPDX headers" below).

## Tiers

| Tier | Licence | What it covers |
|---|---|---|
| **OPEN-CODE** | [Apache-2.0](LICENSE) | ISA tables, the CYASM assembler, the SCRIM compiler, the emulator core, the reference player and debugger logic, build and test tooling, conformance ROMs, demo cartridges, tests |
| **SDK runtime** | Apache-2.0 WITH LLVM-exception | Code the toolchain copies into the ROMs you build: the `roms/lib/` includes and the SCRIM runtime |
| **OPEN-SPEC** | [CC BY 4.0](LICENSES/CC-BY-4.0.txt) | Specification prose: the HED-0041 manual, the spec notes, the SCRIM language specification, the hardware facts file, this repository's documentation |

Rules that hold across the tiers:

- **Trademarks are never licensed by a copyright licence.** Apache-2.0 section 6 and CC BY 4.0
  section 2(b)(2) both exclude trademark rights. CC BY lets anyone copy and adapt the manual's
  *text*; it does not let anyone present a product as Avenell or Cyclorama, use the logos, or
  call anything official. The fictional company and product names appear in the open text as
  part of the fiction and remain marks.
- **Compiled output belongs to its author.** ROMs you assemble or compile with this toolchain are
  yours. See "SDK runtime code" below for the code the toolchain copies into your ROM.
- **Contributions** are inbound = outbound: a change to a file is licensed under that file's
  licence (Apache-2.0 or CC BY 4.0).

## Path map

The longest matching path decides: a file beats a `*` pattern, which beats a folder.

### Top level

| Path | Tier | Notes |
|---|---|---|
| `LICENSE`, `LICENSES/`, `NOTICE` | OPEN-CODE | Licence texts keep their own terms |
| `README.md`, `LICENSING.md`, `TRADEMARKS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md` | OPEN-SPEC | The front page and the policy text |
| `package.json`, `package-lock.json`, `tsconfig.json`, `.nvmrc`, `.gitattributes`, `.gitignore`, `.editorconfig`, `.github/`, `EXPORT.json` | OPEN-CODE | Build and CI configuration; `EXPORT.json` records the release this tree is |

### Specification and hardware facts

| Path | Tier | Notes |
|---|---|---|
| `docs/manual/src/`, `docs/manual/index.html` | OPEN-SPEC | HED-0041, the hardware and programmer's reference (`index.html` is built from `src/`) |
| `docs/manual/examples/` | OPEN-CODE | The manual's worked `.asm` examples are code, so they can be pasted into programs (Apache-2.0: see "SDK runtime code") |
| `docs/spec-notes.md`, `docs/scrim-spec.md` | OPEN-SPEC | Spec rulings and the SCRIM language specification |
| `canon/canon-public.json` | OPEN-SPEC | The hardware facts the manual states, as data (the manual tests check the manual against it) |
| `docs/guide/` | OPEN-SPEC | The SDK guides and tutorials |

### Code

| Path | Tier | Notes |
|---|---|---|
| `src/` | OPEN-CODE | ISA tables, register map, assembler and disassembler, emulator core, asset converters, SCRIM compiler, reference player, browser conformance harness, debugger logic |
| `src/scrim/runtime.inc` | SDK runtime | The runtime routines the SCRIM compiler links into every SCRIM ROM |
| `tools/` | OPEN-CODE | Command-line tools: build, conformance, budgets, replays, manual build, test tiers, doctor, verify |
| `tests/` | OPEN-CODE | Tests, conformance ROM sources (`tests/conformance/`), fixtures and golden frames |

### Cartridges

| Path | Tier | Notes |
|---|---|---|
| `roms/lib/` | SDK runtime | The Cue Sound Driver and its documentation |
| `roms/lantern-test/`, `roms/lantern-scrim/`, `roms/sound-test/`, `roms/slice-test/` | OPEN-CODE | Demo and test cartridges |
| `roms/manifest.json` | OPEN-CODE | Size and SHA-256 of every ROM the build makes |
| `replays/` | OPEN-CODE | Completion replays of the open cartridges |
| `examples/` | OPEN-CODE | The example programs the guides quote (Apache-2.0: see "SDK runtime code" for reusing their code in a ROM) |

## SPDX headers

Every source file opens with two comment lines in its own comment syntax (`//` TypeScript,
`<!-- -->` HTML, `;` CYASM `.asm`/`.inc` and `.art`/`.song`, `--` SCRIM, `#` YAML and
dotfiles). The first two lines of `tools/asm.ts`:

<!-- sample: tools/asm.ts lines 1-2 -->
```ts
// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
```

The identifier is `Apache-2.0` (OPEN-CODE), `Apache-2.0 WITH LLVM-exception` (SDK runtime) or
`CC-BY-4.0` (OPEN-SPEC). Formats without a comment syntax (JSON, Markdown, save states, images),
the licence texts, `.nvmrc` and the generated `docs/manual/index.html` carry no header; the path
map above licenses them. Comment lines never change ROM bytes, and the manual build drops the
header lines of the fragments it publishes.

## The manual (HED-0041)

The manual's text is CC BY 4.0. Its front matter contains an **in-world** notice ("Licensed
developers only … confidential …"). That notice is part of the fiction: the console never
existed, the document is written in the voice of a 1987 engineering reference, and its technical
content is exact and normative for the emulator and tools here.

Attribution for reuse: "HED-0041 Cyclorama Hardware & Programmer's Reference, by rick-learns,
CC BY 4.0". Adapters may say what they changed; they may not imply endorsement (CC BY 4.0 section
2(a)(6), and TRADEMARKS.md).

## SDK runtime code

The assembler and compiler themselves are Apache-2.0. Some SDK code is **copied into the ROMs
people build**: the `roms/lib/*.inc` includes such as the Cue Sound Driver, and the runtime
routines the SCRIM compiler links (`src/scrim/runtime.inc`). Apache-2.0 section 4 would require
distributors of such ROMs to carry the licence and NOTICE, which a cartridge has no place for. So
this code is licensed `Apache-2.0 WITH LLVM-exception`: the exception waives the attribution
requirement when the library code is embedded in compiled output. It is compatible with
Apache-2.0 and only adds a permission.

The example programs (`examples/`, `docs/manual/examples/`) are plain Apache-2.0, without the
exception. Code you write yourself after reading them is yours; a ROM that contains code copied
from them is a distribution of that code, and Apache-2.0 section 4 then asks you to carry the
licence and NOTICE with it (for a cartridge, alongside it: in its documentation or download).
