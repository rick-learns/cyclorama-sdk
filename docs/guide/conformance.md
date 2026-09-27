# Conformance

The conformance ROMs are the machine's executable definition. Each is a small CYASM program in
[`tests/conformance/`](../../tests/conformance/) that exercises one part of the hardware, checks
the results itself, and reports pass or the number of the first check that failed. The reference
emulator passes all of them in Node and in Chromium with identical machine states; another
implementation of the Cyclorama (an emulator in another language, an FPGA) can run the same ROMs
to show that it behaves the same.

## Run them

<!-- run -->
```sh
npm run conformance
```

Each line names a ROM, its result, the frames it ran and the final state hash. The tool runs
every ROM twice and requires the two final states to be identical.

## What they cover

| ROM | Checks |
|---|---|
| `01-alu-flags` | ALU results and the Z, N, C and V flags |
| `02-memory` | Every addressing form of the loads and stores, byte and word layout, ROM write protection, unmapped space |
| `03-branches` | Branches, jumps and calls |
| `04-stack` | The stack: PUSH, POP, PUSHM and POPM order |
| `05-shifts-mul` | Shifts, rotates, MUL, FMUL, GETF and SETF |
| `06-cycles` | Instruction cycle counts, measured by the ROM itself with the timer |
| `07-interrupts` | TRAP, interrupts, EI and DI, WAI, the timer and STOP |
| `08-banks` | Cartridge ROM banking |
| `08b-cartram` | Cartridge RAM and its write-enable register |
| `09-video-ports` | The Barndoor register file and its ports, with their wait cycles |
| `10-dma` | DMA transfers and the CPU stall they cost, inside and outside active display |
| `11-interrupt-timing` | When VBLANK, LINE and TIMER requests are raised and the order they are taken in |
| `12-light-field` | The light field's shade rule, observed through the probe latch |
| `13-audio` | The Cue registers as the CPU sees them |
| `14-input` | Controller sampling |

The first comment lines of each ROM say exactly what it checks and which rulings of the
[spec notes](../spec-notes.md) and chapters of the [manual](../manual/index.html) it follows.

## How a conformance ROM reports

Every ROM includes the same harness:

<!-- sample: tests/conformance/_harness.inc lines 4-20 -->
```asm
; Conformance harness (included by every conformance ROM).
; Convention: R7 holds the current check number. CHECK_EQ-style tests branch
; to FAIL on mismatch. PASS writes $600D to RESULT; FAIL writes R7. Both STOP.
RESULT = $8000

PASS:   MOVW R6, #$600D
        ST   R6, [RESULT]
        STOP
FAIL:   ST   R7, [RESULT]
        STOP

; CHECK: compare R0 (actual) with R1 (expected); on mismatch FAIL with R7,
; otherwise advance R7 to the next check number. Uses flags.
CHECK:  CMP  R0, R1
        BNE  FAIL
        ADDQ R7, #1
        RTS
```

A ROM runs its checks in order with R7 counting them, and ends in `STOP` with the work-RAM word
at 8000 holding 600D (pass) or the number of the failing check. The runner
([`tools/conformance.ts`](../../tools/conformance.ts)) builds the ROM, runs it from power-on for
at most 600 frames, and passes it only if the CPU stopped, the word is 600D, and a second run ends
in the same machine state.

A ROM that needs the controllers declares their input in a comment, which the runner feeds to
controller 1 (value V from frame N until the next entry):

<!-- sample: tests/conformance/14-input.asm lines 7-7 -->
```asm
; @pads 3:$08 6:$FF10 9:$80 12:0
```

## Using the suite for another implementation

1. Build the ROMs with `npm run build:roms`; they land in `build/roms/conformance/` and their
   SHA-256s are in [`roms/manifest.json`](../../roms/manifest.json).
2. Run each ROM on your implementation from power-on, with the `@pads` input where the source has
   one, until the CPU executes `STOP` (600 frames is the reference limit).
3. It passes when the 16-bit word at work-RAM address 8000 is 600D. Any other value is the number
   of the check that failed; the check is the R7 value's position in the ROM's source.

The state hashes the runner prints are the reference emulator's own serialisation and only say
something about the reference emulator; another implementation is judged by the result word.

## Adding a conformance ROM

Add `tests/conformance/<nn>-<topic>.asm` that includes `_harness.inc` (files starting with `_` are
includes, not ROMs). The runner, the conformance test and the ROM build pick it up by name; run
`npm run build:roms -- --write-manifest` so the manifest lists it. A behaviour change to the
emulator comes with a conformance check that shows it, and both agree with the manual and the
spec notes (see [CONTRIBUTING.md](../../CONTRIBUTING.md)).
