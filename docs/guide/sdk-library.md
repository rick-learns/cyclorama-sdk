# SDK library reference

This page lists every routine a program can call from the SDK runtime: the SCRIM runtime library
([`src/scrim/runtime.inc`](../../src/scrim/runtime.inc)), which the compiler links into a program
that uses it, and the Cue Sound Driver ([`roms/lib/cuesound.inc`](../../roms/lib/cuesound.inc)),
which a program includes or links. For each routine it gives the call, the inputs and outputs, the
registers and flags it changes, the stack and RAM it uses, and its cost in CPU cycles.

Every number on this page was measured on the reference emulator.
[`tests/example-sdk-library.test.ts`](../../tests/example-sdk-library.test.ts) measures them
again and fails if the page and the emulator disagree. The calling examples are quoted from two
programs in [`examples/sdk-library/`](../../examples/sdk-library/), which that test also runs.

This page does not repeat how to use the driver or write its music: that is the
[driver's README](../../roms/lib/README.md#1-cue-sound-driver-cuesoundinc), with the `.song`
format. The SCRIM calling convention is in the
[language specification, §4](../scrim-spec.md#4-procedures-and-functions), and linking the
driver into a SCRIM program in [§10](../scrim-spec.md#10-linking-assembly-and-assets).

## How the numbers were measured

- **Cycles** are CPU cycles (a frame is 59,736). A count runs from the routine's first
  instruction to the end of its `RTS`, and includes DMA stalls and video-port wait cycles. It
  leaves out the caller's side: the `CALL` (8 cycles), pushing arguments (`PUSH` is 4 each) and
  removing them (`ADD SP, #n` is 2). Instruction costs are in the manual's
  [cycle table](../manual/index.html#cpu-cycles).
- The test calls each routine directly in the ROM compiled from
  [`runtime.scr`](../../examples/sdk-library/runtime.scr), so the code measured is the code the
  compiler links. Interrupts are off. Each case runs under three different register and flag
  patterns.
- Where the cost depends on the input, the page gives a formula, and the test checks it at
  several inputs. Where it depends on the beam (`VRAM_COPY`, `WAIT_VBLANK`), the page says where
  the beam was. A *CPU cycle c of the frame* counts from the first cycle of line 0; a line is 228
  cycles, so line 224 begins at c = 51,072.
- **Stack** is the deepest point the routine reaches, in bytes below the caller's SP, with the
  2-byte return address included. For a stack-convention call, the caller's SP is the one after
  the arguments were pushed.
- **Preserves** lists the registers and flags (Z N C V I) that come back unchanged whatever the
  input. **Changes** lists the rest: they come back with no defined value unless **Returns** says
  otherwise. For the SCRIM runtime, *Preserves* is more than the convention promises (R4-R6).
  Rely on the convention: a program that relies on more depends on this version of the runtime.

## Summary

| Routine | Convention | What it does |
|---|---|---|
| [`__divu`](#__divu) | registers | unsigned `/` and `MOD` |
| [`__divs`](#__divs) | registers | signed `/` and `MOD` |
| [`MEMCPY`](#memcpy) | SCRIM | copy bytes |
| [`MEMSET`](#memset) | SCRIM | fill bytes |
| [`VRAM_COPY`](#vram_copy) | SCRIM | DMA words to VRAM |
| [`RANDOM`](#random) | SCRIM | next pseudo-random word |
| [`SEED_RANDOM`](#seed_random) | SCRIM | restart the sequence |
| [`WAIT_VBLANK`](#wait_vblank) | SCRIM | wait for line 224 |
| [`SND_INIT`](#snd_init) | assembly | silence the Cue, clear the driver |
| [`SND_PLAY_SONG`](#snd_play_song) | assembly | start a song |
| [`SND_STOP`](#snd_stop) | assembly | stop the music |
| [`SND_SFX`](#snd_sfx) | assembly | start a sound effect |
| [`SND_TICK`](#snd_tick) | assembly | play one frame of music and effects |
| [`SND_TEMPO`](#snd_tempo) | assembly | override the tempo |
| [`SND_FADE`](#snd_fade) | assembly | fade the music out |
| [`SND_STATUS`](#snd_status) | assembly | what is playing |
| [`SndInit` … `SndStatus`](#stack-convention-entries) | SCRIM | the driver entries for SCRIM |
| [`SND_FREQS`](#snd_freqs) | table | FREQ of every note |

## SCRIM runtime

The compiler links a runtime routine only when the program uses it
([§6](../scrim-spec.md#6-program-structure-and-startup), rulings 3, 17 and 18 of
[§9](../scrim-spec.md#9-implementation-rulings)). The routines named in capitals follow the SCRIM
convention: arguments are pushed right to left as words, the caller removes them, and a result
comes back in R0. `__divu` and `__divs` are the compiler's helpers for `/` and `MOD`, with
arguments in registers; a SCRIM program cannot call them by name, because names beginning `__`
are reserved.

The example program calls each routine once. Its division, copies and random numbers:

<!-- sample: examples/sdk-library/runtime.scr lines 37-50 -->
```scrim
BEGIN
  a := 1000; b := 7;
  q := a / b;                              -- WORD: __divu, 142
  r := a MOD b;                            -- 6
  s := -1000; t := 7;
  sq := s / t;                             -- INT: __divs, -142
  sr := s MOD t;                           -- -6: the dividend's sign
  MEMCPY(@copy[0], @source[0], 16);        -- 16 bytes, all even: the word path
  MEMSET(@fill[0], $A5, 5);                -- fill[0..4] = A5, fill[5] stays 0
  VRAM_COPY($0000, @source[0], 8);         -- 8 words to VRAM 0000
  SEED_RANDOM(1987);
  rnd[0] := RANDOM();
  rnd[1] := RANDOM();
  rnd[2] := RANDOM();
```

### `__divu`

Unsigned 16-bit division, for `/` and `MOD` on WORD and BYTE operands. A constant divisor that is
a power of two compiles to a shift or an `AND` instead, and costs no call.

- **Call:** R0 = dividend, R1 = divisor, then `CALL __divu`.
- **Returns:** R0 = quotient, R1 = remainder. Division by zero returns quotient 0 and
  remainder = the dividend.
- **Preserves:** R2-R6 and flag I.
- **Changes:** R0, R1, R7 and flags Z N C V.
- **Stack:** 4 bytes (2 when the divisor is 0).
- **RAM:** none.

| Case | Cycles |
|---|---|
| divisor 0 | 14 |
| divisor 1-65,535 (b = the number of 1 bits in the quotient) | 312 + 2 × b |

A division costs 312 to 344 cycles. 1000 / 7 = 142 (binary 10001110, four 1 bits) takes 320.

### `__divs`

Signed 16-bit division, for `/` and `MOD` on INT operands. The quotient is truncated toward zero
and the remainder takes the dividend's sign: −7 / 2 = −3 remainder −1, and 7 / −2 = −3
remainder 1. −32768 / −1 wraps to −32768, remainder 0.

- **Call:** R0 = dividend, R1 = divisor, then `CALL __divs`.
- **Returns:** R0 = quotient, R1 = remainder. Division by zero returns quotient 0 and
  remainder = the dividend.
- **Preserves:** R2-R6 and flag I.
- **Changes:** R0, R1, R7 and flags Z N C V.
- **Stack:** 10 bytes (8 when the divisor is 0).
- **RAM:** none.

| Case | Cycles |
|---|---|
| divisor 0 | 74 |
| divisor not 0 (b = the number of 1 bits in the quotient's magnitude) | 372 + 2 × b |

It costs 60 cycles more than `__divu`, which it calls. −1000 / 7 = −142 takes 380 cycles, and
−32768 / −1 takes 374.

### `MEMCPY`

`MEMCPY(dst, src, n)` copies n bytes upward from src to dst. It moves words when dst, src and n
are all even, and bytes otherwise. Overlapping blocks are copied correctly only when dst < src.
The compiler also calls it to assign a whole array or record.

- **Call:** SCRIM `MEMCPY(dst, src, n)`, which pushes n, src and dst in that order, calls
  `MEMCPY` and removes the 6 bytes.
- **Returns:** nothing.
- **Preserves:** R4-R7 and flag I.
- **Changes:** R0-R3 and flags Z N C V.
- **Stack:** 2 bytes.
- **RAM:** writes dst to dst + n − 1, nothing else.

| Case | Cycles |
|---|---|
| n = 0 | 24 |
| dst, src and n even, n = 2 × w: word moves | 35 + 14 × w |
| otherwise: byte moves | 34 + 14 × n |

A word move copies two bytes in the time a byte move copies one: 16 bytes cost 147 cycles when
all three are even, 258 when one is odd.

### `MEMSET`

`MEMSET(dst, value, n)` stores the low byte of value into n bytes from dst.

- **Call:** SCRIM `MEMSET(dst, value, n)`, which pushes n, value and dst, calls `MEMSET` and
  removes the 6 bytes.
- **Returns:** nothing.
- **Preserves:** R3-R7 and flag I.
- **Changes:** R0-R2 and flags Z N C V.
- **Stack:** 2 bytes.
- **RAM:** writes dst to dst + n − 1, nothing else.

| Case | Cycles |
|---|---|
| n = 0 | 24 |
| n ≥ 1 | 20 + 10 × n |

### `VRAM_COPY`

`VRAM_COPY(vramAddr, src, words)` copies `words` words from CPU address src (0000-DFFF) to VRAM
at vramAddr with the DMA channel. The CPU is stopped until the transfer ends
([manual 5.12.2](../manual/index.html#vid-dma-transfer)).

- **Call:** SCRIM `VRAM_COPY(vramAddr, src, words)`, which pushes words, src and vramAddr,
  calls `VRAM_COPY` and removes the 6 bytes.
- **Returns:** nothing.
- **Preserves:** R1-R7 and flags C V I.
- **Changes:** R0 and flags Z N.
- **Stack:** 2 bytes.
- **RAM:** none (it writes VRAM and the DMA registers).

| Case | Cycles |
|---|---|
| DMACTL written outside active display | 48 + 2 × w |
| DMACTL written during active display | 48 + 4 × w |

w is the number of words. The routine writes DMACTL 32 cycles after it starts, and the beam at
that moment sets the rate: active display is dots 0-255 of lines 0-223, that is, cycles 0-170 of
each of those lines. Only the beam counts, not whether the display is on: the test measured the
active-display rate with the display switched off. Eight words cost 64 cycles in vertical blank
and 80 during active display.

### `RANDOM`

`RANDOM()` returns the next state of a 16-bit Galois LFSR (taps B400, period 65,535). The state
is the work-RAM word `__rnd`, which the compiler places after the program's VARs and the startup
code sets to ACE1.

- **Call:** SCRIM `x := RANDOM()`. No argument.
- **Returns:** R0 = the new state, which is also stored in `__rnd`.
- **Preserves:** R1-R7 and flag I.
- **Changes:** R0 and flags Z N C V.
- **Stack:** 2 bytes.
- **RAM:** writes `__rnd`, nothing else.

| Case | Cycles |
|---|---|
| state bit 0 = 0 | 25 |
| state bit 0 = 1 | 27 |

The sequence depends only on the seed. After `SEED_RANDOM(1987)` (07C3) the first three values are
B7E1, EFF0, 77F8.

### `SEED_RANDOM`

`SEED_RANDOM(seed)` restarts the `RANDOM` sequence from seed. Seed 0 would stop the LFSR, so it
becomes ACE1.

- **Call:** SCRIM `SEED_RANDOM(seed)`, which pushes seed, calls `SEED_RANDOM` and removes the
  2 bytes.
- **Returns:** R0 = the state stored.
- **Preserves:** R1-R7 and flag I.
- **Changes:** R0 and flags Z N C V.
- **Stack:** 2 bytes.
- **RAM:** writes `__rnd`, nothing else.

| Case | Cycles |
|---|---|
| seed not 0 | 22 |
| seed 0 | 24 |

### `WAIT_VBLANK`

`WAIT_VBLANK` returns at the start of the next vertical blank: it reads VCOUNT until the line is
224. Called during vertical blank (lines 224-261), it first waits for that blank to end, so it
returns at line 224 of the next frame. Reading VCOUNT has no side effects, and the routine leaves
the interrupt state alone. Its loop reads VCOUNT every 14 cycles, so it returns 18 to 31 cycles
after line 224 begins.

- **Call:** SCRIM `WAIT_VBLANK;`. No argument.
- **Returns:** R0 = 224, the VCOUNT it read.
- **Preserves:** R1-R7 and flag I.
- **Changes:** R0 and flags Z N C V.
- **Stack:** 2 bytes.
- **RAM:** none.

| Case | Cycles |
|---|---|
| called at CPU cycle c of the frame, c < 51,072 (k = ⌈(51,060 − c) / 14⌉, at least 0) | 30 + 14 × k |
| called at the first cycle of line 224 (c = 51,072) | 59,754 |
| called at the last cycle of the frame (c = 59,735) | 51,102 |

Called at the first cycle of line 0, it takes 51,102 cycles (k = 3,648). These counts are with
interrupts off; an interrupt handler that runs during the wait adds its own time. The example
uses it once, to start its
frame loop at the top of vertical blank:

<!-- sample: examples/sdk-library/runtime.scr lines 55-58 -->
```scrim
  WAIT_VBLANK;                             -- the top of vertical blank
  IE := 1;                                 -- the VBLANK raised at line 224 is pending:
  ASM EI END;                              -- onVblank runs at once
  WHILE TRUE DO WAIT END
```

## Cue Sound Driver

A CYASM program defines `SND_RAM` (272 bytes of work RAM, even address) and includes
`cuesound.inc`; a SCRIM program declares `SND_RAM` as a VAR and links it
([README](../../roms/lib/README.md#using-it)). The entries in capitals use the assembly
convention: the argument, if any, in R0. The README's
[entry table](../../roms/lib/README.md#entry-points) says what each one does. `SND_INIT`,
`SND_PLAY_SONG`, `SND_STOP`, `SND_SFX` and `SND_FADE` mask interrupts while they change the
driver's state, then restore the caller's flags with `SETF`: all five flags come back as they
were. That is measured, not promised: the driver's documented contract is that flags are not
preserved, so rely on the convention (R1-R7 kept, R0 and the flags not) and not on this version's
behaviour. The lower-case labels of `cuesound.inc` (`snd_halt`, `snd_music`, `snd_row` and others)
are internal; their cost is part of the entries that call them.

The example program in assembly starts the song at power-on and calls `SND_TICK` first thing in
each VBLANK:

<!-- sample: examples/sdk-library/driver.asm lines 11-25 -->
```asm
SND_RAM = $8100                         ; the driver's RAM: SND_RAM_SIZE (272) bytes, even
PREV    = $8000                         ; last frame's pad

        .org $0040
start:  MOVQ R0, #0
        ST   R0, [PREV]
        CALL SND_INIT                   ; voices off, driver RAM cleared, MASTERVOL 15
        MOVW R0, #SONG_tune
        CALL SND_PLAY_SONG              ; the first row plays on the next SND_TICK
        MOVQ R0, #1
        ST   R0, [IF]
        ST   R0, [IE]
        EI
main:   WAI
        BRA  main
```

<!-- sample: examples/sdk-library/driver.asm lines 27-49 -->
```asm
vblank: PUSHM R0-R2                     ; the entries change R0 only; R1 and R2 are ours
        CALL SND_TICK                   ; first thing in VBLANK: steady timing
        LD   R1, [PAD1]
        LD   R2, [PREV]
        ST   R1, [PREV]
        NOT  R2
        AND  R2, R1                     ; R2 = buttons newly pressed
        TST  R2, #16                    ; A: an effect on voice 2
        BEQ  .noa
        MOVW R0, #SFX_blip
        CALL SND_SFX
.noa:   TST  R2, #32                    ; B: the jingle replaces the song
        BEQ  .nob
        MOVW R0, #SONG_jingle
        CALL SND_PLAY_SONG
.nob:   TST  R2, #128                   ; START: one volume step every 4 frames, then stop
        BEQ  .nos
        MOVQ R0, #4
        CALL SND_FADE
.nos:   MOVQ R0, #1
        ST   R0, [IF]                   ; acknowledge the VBLANK
        POPM R0-R2
        RTI
```

The cycle counts below use the example's music
([`sdk-library.song`](../../examples/sdk-library/sdk-library.song)): `SONG_tune` plays on all
four voices and has a wavetable, `SONG_jingle` plays on voice 0 only, `SFX_blip` is an effect on
voice 2 (priority 1) and `SFX_thud` one on voice 3 (priority 2). What each entry does is tested
in [`tests/cuesound.test.ts`](../../tests/cuesound.test.ts).

### `SND_INIT`

Keys off all four voices, clears the driver's RAM, gives each track its voice and sets MASTERVOL
to 15. Call it once before any other entry.

- **Call:** `CALL SND_INIT`. No argument.
- **Returns:** nothing.
- **Preserves:** R1-R7 and flags Z N C V I.
- **Changes:** R0.
- **Stack:** 8 bytes.
- **RAM:** writes the 272 bytes at `SND_RAM`, nothing else.

| Case | Cycles |
|---|---|
| any state | 1,638 |

### `SND_PLAY_SONG`

Starts a song from its first row. It first stops the song playing, as `SND_STOP` does, then loads
the song's wavetable into WAVE0-7 if it has one, sets the master volume to 15 and cancels a fade.
The first row plays on the next `SND_TICK`.

- **Call:** R0 = `SONG_name`, then `CALL SND_PLAY_SONG`.
- **Returns:** nothing.
- **Preserves:** R1-R7 and flags Z N C V I.
- **Changes:** R0.
- **Stack:** 18 bytes.
- **RAM:** writes inside `SND_RAM`, nothing else.

| Case | Cycles |
|---|---|
| v = voices the song uses, t = 1 if it has a wavetable, a and m as for SND_STOP | 302 + 28 × v + 114 × t + 28 × a + 22 × m |

From silence, `SONG_tune` costs 528 cycles and `SONG_jingle` 330.

### `SND_STOP`

Stops the music and keys off the voices it holds. A playing effect plays on.

- **Call:** `CALL SND_STOP`. No argument.
- **Returns:** nothing.
- **Preserves:** R1-R7 and flags Z N C V I.
- **Changes:** R0.
- **Stack:** 18 bytes.
- **RAM:** writes inside `SND_RAM`, nothing else.

| Case | Cycles |
|---|---|
| a = music tracks playing on a voice of their own, m = music tracks whose voice an effect has | 140 + 28 × a + 22 × m |

### `SND_SFX`

Starts an effect on the voice its header names. The music on that voice goes quiet until the
effect ends ([voice borrowing](../../roms/lib/README.md#voice-borrowing-effects-over-music)).

- **Call:** R0 = `SFX_name`, then `CALL SND_SFX`.
- **Returns:** nothing.
- **Preserves:** R1-R7 and flags Z N C V I.
- **Changes:** R0.
- **Stack:** 16 bytes.
- **RAM:** writes inside `SND_RAM`, nothing else.

| Case | Cycles |
|---|---|
| no effect on its voice | 137 |
| an effect of the same or lower priority on its voice: replaced | 147 |
| an effect of higher priority on its voice: ignored | 85 |

### `SND_TICK`

Plays one frame: the fade, the tempo, the music rows that fall due, the effect rows and the
per-frame pitch effects. Call it once per frame, first thing in the VBLANK handler, so the
timing is steady.

- **Call:** `CALL SND_TICK`. No argument.
- **Returns:** nothing.
- **Preserves:** R0-R7 and flag I.
- **Changes:** flags Z N C V.
- **Stack:** 24 bytes.
- **RAM:** writes inside `SND_RAM`, nothing else.

| Case | Cycles |
|---|---|
| nothing playing | 166 |
| the first tick after SND_PLAY_SONG with SONG_tune: four notes key on | 1,444 |
| the Sound Test measurement of the README: worst tick of the first 1,200 frames | 2,166 |
| the same input: worst tick of 3,600 frames | 2,206 |

The cost depends on the music, so the last two rows repeat the README's own measurement: the Sound
Test cartridge ([`roms/sound-test`](../../roms/sound-test/sound-test.asm)) from frame 17, with
controller 1 pressing A, B, C and Left in turn, one on every other frame (the input of
[`tests/sound-test.test.ts`](../../tests/sound-test.test.ts)). Over its first 1,200 frames (20
seconds) the worst tick is 2,166 cycles, the README's figure. Run on to 3,600 frames, the same
input reaches 2,206 cycles, 3.7 % of the frame. To budget for your own music, measure it:
`tickCycles` in [`tools/song-wav.ts`](../../tools/song-wav.ts) meters every call of `SND_TICK`
in a running cartridge. The deepest stack measured, in the first tick of `SONG_tune` and in
the Sound Test run, is 24 bytes; the README allows 26.

### `SND_TEMPO`

Overrides the song's tempo with a rate: rows per frame × 55,440
([tempo](../../roms/lib/README.md#tempo)). Rate 0 goes back to the song's own tempo.

- **Call:** R0 = rate, then `CALL SND_TEMPO`.
- **Returns:** nothing.
- **Preserves:** R1-R7 and flag I.
- **Changes:** R0 and flags Z N C V.
- **Stack:** 2 bytes.
- **RAM:** writes `SND_RATE`, nothing else.

| Case | Cycles |
|---|---|
| rate 0 (the song's own) | 30 |
| rate 1-55,440 | 26 |
| rate above 55,440 (55,440 is used) | 28 |

### `SND_FADE`

Fades the music out: the master volume goes down one step every n frames, and when it reaches 0
the music stops and the volume returns to 15. n = 0 cancels a fade and restores full volume.

- **Call:** R0 = n, then `CALL SND_FADE`.
- **Returns:** nothing.
- **Preserves:** R1-R7 and flags Z N C V I.
- **Changes:** R0.
- **Stack:** 4 bytes.
- **RAM:** writes three bytes of `SND_RAM` (the master volume and the fade count), nothing else.

| Case | Cycles |
|---|---|
| n = 0 (cancel) | 58 |
| n = 1-255 | 46 |
| n above 255 (255 is used) | 48 |

### `SND_STATUS`

Says what is playing.

- **Call:** `CALL SND_STATUS`. No argument.
- **Returns:** R0: bits 0-3 are set while a music track plays on voice 0-3, bits 4-7 while an
  effect plays on voice 0-3.
- **Preserves:** R1-R7 and flag I.
- **Changes:** R0 and flags Z N C V.
- **Stack:** 8 bytes.
- **RAM:** none (it only reads).

| Case | Cycles |
|---|---|
| any state | 204 |

### Stack-convention entries

A SCRIM program calls the driver through these entries, declared with `EXTERN`
([§10](../scrim-spec.md#10-linking-assembly-and-assets)). Each one loads its argument, if it has
one, from `[SP+2]` into R0 and jumps to its entry. So it costs the entry's cycles plus the extra
below, uses the same stack, and has the same effect.

- **Preserves:** R1-R7, and the flags its entry preserves. This is more than the SCRIM
  convention asks (R4-R6), so R7 is safe too.

| Entry | Jumps to | Extra cycles |
|---|---|---|
| `SndInit` | `SND_INIT` | 6 |
| `SndPlaySong` | `SND_PLAY_SONG` | 10 |
| `SndStop` | `SND_STOP` | 6 |
| `SndSfx` | `SND_SFX` | 10 |
| `SndTick` | `SND_TICK` | 6 |
| `SndTempo` | `SND_TEMPO` | 10 |
| `SndFade` | `SND_FADE` | 10 |
| `SndStatus` | `SND_STATUS` | 6 |

The SCRIM example declares the entries it uses, links the driver and its music, and calls
`SndTick` from its VBLANK handler:

<!-- sample: examples/sdk-library/runtime.scr lines 10-18 -->
```scrim
VAR SND_RAM: ARRAY [136] OF WORD;          -- the driver's RAM (272 bytes)
LINK "../../roms/lib/cuesound.inc";
ASSET "sdk-library.song";
EXTERN PROC SndInit;
EXTERN PROC SndPlaySong(song: WORD);
EXTERN PROC SndSfx(sfx: WORD);
EXTERN PROC SndTick;
EXTERN FUNC SndStatus: WORD;
EXTERN CONST SONG_tune: WORD; SFX_blip: WORD;
```

<!-- sample: examples/sdk-library/runtime.scr lines 29-35 -->
```scrim
INTERRUPT PROC onVblank;
BEGIN
  SndTick;                                 -- once per frame, first thing in VBLANK
  frames := frames + 1;
  IF_PORT := 1
END;
VECTOR VBLANK := onVblank;
```

<!-- sample: examples/sdk-library/runtime.scr lines 51-54 -->
```scrim
  SndInit;
  SndPlaySong(SONG_tune);
  SndSfx(SFX_blip);
  status := SndStatus();                   -- 4F: music on voices 0-3, the effect on voice 2
```

### `SND_FREQS`

A table, not a routine: 108 words (216 bytes) in ROM, the FREQ value of each note from C-0 to
B-8, in note-number order (C-0 = 0, A-4 = 57, whose FREQ is 601). The word for note n is at
`SND_FREQS + 2 × n`. The README gives how the values are computed
([note table](../../roms/lib/README.md#note-table)).
