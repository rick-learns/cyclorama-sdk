# Cyclorama Development Kit libraries (`roms/lib`)

Shared CYASM code that cartridges `.include`:

| File | What | Terms |
|---|---|---|
| `cuesound.inc` | **Cue Sound Driver**: music + sound effects for the Cue (AV-3105) | open: `Apache-2.0 WITH LLVM-exception` (the runtime is compiled into ROMs) |

The driver is shared; the music is not. Every game writes its own `.song` file (its own theme,
jingles and effects); `roms/sound-test/sound-test.song` is only the Sound Test cartridge's own
music.

The official start-up splash and chime (Curtain Up) is a brand asset, not part of the SDK and not
licensed for unofficial cartridges (TRADEMARKS.md). Open cartridges never need it, and the
emulator never checks for a splash. (Its own description ships only with the brand files, not
with the SDK.)

---

## 1. Cue Sound Driver (`cuesound.inc`)

Canon: shipped in the 1987 Cyclorama Development Kit. Plays a looping song on up to four voices
and lets sound effects borrow one voice at a time, so the music never cuts out.

### Using it

```
SND_RAM = $8100                     ; SND_RAM_SIZE (272) bytes of work RAM, even address
        ...
start:  CALL SND_INIT
        MOVW R0, #SONG_theme
        CALL SND_PLAY_SONG
        ...
vblank: PUSHM R0-R7
        CALL SND_TICK               ; once per frame, first thing in VBLANK (steady timing)
        ...
        MOVW R0, #SFX_jump          ; whenever something happens
        CALL SND_SFX
        ...
        .include "../lib/cuesound.inc"
        .include "mygame.song.inc"  ; generated on demand from mygame.song
```

`SND_RAM` must be defined before the include. A SCRIM program lets the VAR allocator reserve the
block by naming a module VAR `SND_RAM` (every SCRIM module name is an assembler symbol):
`VAR SND_RAM: ARRAY [136] OF WORD;` (272 bytes, word aligned, zeroed at startup, never overlapped
by other VARs; docs/scrim-spec.md §10.7).

### Entry points

Assembly convention: the argument (if any) in **R0**; **R1-R7 are preserved**; R0 is not
(SND_TICK preserves R0 as well). Flags are not preserved. Every entry that changes shared state
masks interrupts while it does so and then restores the caller's interrupt enable, so they may be
called from the main loop while SND_TICK runs in VBLANK.

| Entry | Argument | Effect |
|---|---|---|
| `SND_INIT` | — | all four voices off, driver RAM cleared, MASTERVOL 15 |
| `SND_PLAY_SONG` | R0 = `SONG_name` | starts the song from its first row (stops any song playing; loads its wavetable if it has one); the first row plays on the next SND_TICK |
| `SND_STOP` | — | stops the music and keys off its voices; effects play on |
| `SND_SFX` | R0 = `SFX_name` | starts an effect on the voice it names (see *Voice borrowing*) |
| `SND_TICK` | — | call once per frame: fade, tempo, music rows, effect rows, per-frame pitch |
| `SND_TEMPO` | R0 = rate | overrides the tempo (units below); 0 restores the song's own; values above 55440 act as 55440 |
| `SND_FADE` | R0 = n | master volume down one step every n frames; at 0 the music stops and MASTERVOL returns to 15. 0 cancels (volume back to 15) |
| `SND_STATUS` | → R0 | bits 0-3: a music track is active on voice 0-3; bits 4-7: an effect is playing on voice 0-3 |

**SCRIM / stack convention** (docs/scrim-spec.md §4: arguments pushed right to left as words,
caller pops, result in R0, R4-R6 callee-saved, R7 reserved): `SndInit`, `SndPlaySong`, `SndStop`,
`SndSfx`, `SndTick`, `SndTempo`, `SndFade`, `SndStatus`. Each takes its one argument from
`[SP+2]` and preserves R1-R7 (so R7 is safe). A SCRIM program links the driver and its music and
declares the entry points with `EXTERN` (docs/scrim-spec.md §10):

```
VAR SND_RAM: ARRAY [136] OF WORD;          -- the driver's RAM (272 bytes)
LINK "../lib/cuesound.inc";
ASSET "mygame.song";                       -- converted by the kit, then linked
EXTERN PROC SndInit;
EXTERN PROC SndPlaySong(song: WORD);
EXTERN PROC SndStop;
EXTERN PROC SndSfx(sfx: WORD);
EXTERN PROC SndTick;
EXTERN PROC SndTempo(rate: WORD);
EXTERN PROC SndFade(frames: WORD);
EXTERN FUNC SndStatus: WORD;
EXTERN CONST SONG_theme: WORD; SFX_jump: WORD;
EXTERN VAR SND_ROWS: WORD;                 -- readable globals, if the game wants them
...
  SndInit;
  SndPlaySong(SONG_theme);
  ...
  SndSfx(SFX_jump);
```

From a SCRIM `INTERRUPT PROC` (which saves R0-R7) call `SndTick` once per VBLANK. Tested in
`tests/scrim-link.test.ts` (music audible, an effect layered over it).

Readable globals (words): `SND_ROWS` rows played since SND_PLAY_SONG (games can sync to the
beat), `SND_RATE` tempo in use, `SND_SONG` current song header.

### Cost, footprint, determinism

- **RAM:** `SND_RAM_SIZE` = 272 bytes: 16 bytes of globals + 8 tracks × 32 bytes (tracks 0-3:
  music on voices 0-3; tracks 4-7: effects on voices 0-3). Nothing else is written. Stack: at most
  26 bytes below the caller's SP.
- **ROM:** 1,046 bytes of code plus the 216-byte note table.
- **CPU per SND_TICK** (measured on the emulator from outside the machine, `tickCycles` in
  `tools/song-wav.ts`, tests `tests/cuesound.test.ts` and `tests/sound-test.test.ts`):
  - worst case measured: **2,166 cycles = 3.6 % of the 59,736-cycle frame** (Sound Test theme,
    all four voices playing, an effect fired every other frame from the pad);
  - driver harness worst cases: 2,004 (theme + all four effects rotating), 2,028 (arpeggio,
    vibrato, slide and noise on all voices plus an effect); typical mean 800-1,150 cycles;
  - the test limit is 3,000 cycles (5 %).
- **Deterministic:** integer-only, no timers read; the same calls on the same frames give the same
  register writes (machine hash tests).

### Voice borrowing (effects over music)

An effect names the voice it plays on (`sfx NAME voice V`). While it plays, the music track of
that voice keeps its place in the song (rows, notes, pitch effects all advance) but stops writing
to the voice; every other voice is untouched, exactly as if no effect had played (tested
register-for-register). When the effect ends its voice is keyed off and returned: the music
sounds on it again from that track's next note.

Only one effect plays per voice: a new effect replaces the one playing unless the old one has a
higher `priority`. Recommended: tonal effects on the least essential tone voice (the Sound Test
uses voice 2, the chords) and noise effects on voice 3 (the drums), so lead and bass never drop.

### Tempo

A row falls due each time a 16-bit accumulator, increased by the tempo *rate* every frame,
passes **55,440** (lcm(1..12) × 2). `speed N` (N frames per row) gives rate 55440 / N, exact for
N = 1-12, 14, 15, 16, so such songs loop with every frame identical. `tempo BPM [beat R]` gives
rate = round(BPM × R / 60 / F × 55440), where F is the exact frame rate
(945/44 MHz ÷ 358,416 = 59.92275… Hz; R rows per beat, 4 by default). Compute F as that quotient,
not a rounded decimal, or a result near .5 can round the other way. Each song exports `SONG_name_RATE`, so a game can compute an override:
`MOVW R0, #SONG_theme_RATE * 5 / 4` / `CALL SND_TEMPO` (25 % faster when time runs short).

### Per-frame pitch effects

Applied every frame to the note's FREQ (`f`), in this order, and written unless the voice is
borrowed:
- **arpeggio** (`arp`): f = FREQ of (note + offset[k]), k advancing one step per frame, cycling;
  skipped for fixed-pitch instruments;
- **slide** (`slide s`): an accumulator starts at 0 at note-on and gains s every frame
  (stopping at ±32767); f += accumulator, clamped to 0..FFFF;
- **vibrato** (`vibrato depth speed delay d`): from frame d after note-on, phase += speed
  (mod 256, starting at 64); t = (phase < 128 ? phase : 255 − phase) / 2 − 32 (−32..31);
  swing = ((f >> 4) × depth) >> 6; f += (swing × t) >> 5 (arithmetic shift). So depth is in
  units of 1/1024 of the pitch (16 ≈ ±27 cents) and speed 32 is one cycle every 8 frames.

Volume shaping is the Cue's own envelope (ENV, set at key-on); the driver does not rewrite
volume during a note.

### Note table

`SND_FREQS`: FREQ for C-0..B-8 (note numbers 0-107), equal temperament, A4 = 440 Hz,
FREQ = round(f × 65536 / 47,940.34) — the values of manual 6.8 (A-4 = 601, C-4 = 358). The same
table is `FREQ_TABLE` in `tools/song.ts`.

---

## 2. The `.song` format (`tools/song.ts`)

Human-readable, tracker-like text. A cartridge `.include`s `name.song.inc`; the build
(`tools/art.ts` `sourceReader`, used by every ROM build) generates it from `name.song` on demand,
so ROMs stay a pure function of the sources. Every error names `file:line`.

```
; comments start with ';'
instrument lead
  wave pulse25              ; pulse12 pulse25 pulse50 pulse75 triangle saw wavetable silent
                            ; noise (long LFSR) / buzz (short, pitched) for voice 3
  env 12 down 4             ; start volume 0-15, down|up|hold, one step every 1-7 ticks (15.6 ms)
  vibrato 10 24 delay 18    ; depth 1-31, speed 1-127, optional delay in frames
  arp 0 4 7                 ; semitone offsets, one per frame (up to 16)
  slide -1200               ; FREQ change per frame (signed)
  fixed 16000               ; fixed FREQ, the note's pitch is ignored (drums)

pattern A1 inst lead        ; one row per token
  G-5:2 E-5:2 C-6:4 | B-5:2 C-6:2 G-5:4
pattern beat                ; an instrument with a fixed pitch can be written by name
  kick --- hat --- snare --- hat kick | --- kick hat --- snare --- hat hat

song theme
  title "FOLLOWSPOT"        ; optional: SONG_theme_TITLE (.asciz)
  speed 6                   ; frames per row, or: tempo 150 [beat 4]
  voices 0 1 2 3            ; Cue voices used, in column order
  wavetable 89ACDEEFFFEEDCA98653211000112356   ; optional, 32 samples, loaded at play
  order -  bassC arpC intro ; one pattern per voice, '-' = rest; equal lengths per line
  loop                      ; the next order line is the loop point (omit: play once, then stop)
  order A1 bassC arpC beat

sfx jump voice 2 priority 2 speed 1 inst jumpy
  C-5:10
```

Tokens: notes `C-4 C#4 Db4` (octaves 0-8), `---` or `...` (nothing new: the note rings on),
`off` or `===` (key off), an instrument name (fixed-pitch trigger), `|` (ignored bar line).
Suffixes: `@inst` (another instrument for this note only), `:n` (the event plus n−1 empty rows).

Checked at conversion: unknown names, bad notes, duplicate names, empty patterns, order lines
with the wrong number of entries or unequal pattern lengths, a `loop` with no order after it,
missing tempo, a noise instrument on a tone voice (or the reverse), arpeggios that leave
C-0..B-8, out-of-range values.

**Emitted symbols** (P = the file's base name as a symbol, `sound-test.song` → `sound_test`):
`SONG_name` (header), `SONG_name_RATE`, `SONG_name_ROWS` (rows in the whole order),
`SONG_name_LOOP_ROWS` (rows from the loop point, 0 if none), `SONG_name_TITLE`, `SFX_name`,
`SNDI_P` (instrument table), `SNDP_P_pattern`; internal `SNDO_`, `SNDR_`, `SNDA_`, `SNDW_`.
Song and effect names therefore must be unique within a ROM.

### Data formats (what the driver reads)

- **Song header** (word aligned): `.word rate, instruments, wavetable-or-0, order0, order1,
  order2, order3` (order list per voice, 0 = voice unused).
- **Order list:** `.word pattern, pattern, ..., 0, loop-entry-or-0`.
- **Effect header** (word aligned): `.byte voice, priority, frames-per-row, 0`,
  `.word instruments`, then pattern bytes.
- **Instrument record** (16 bytes): `wave, env, .word fixed, .word slide, vib-depth, vib-speed,
  vib-delay, arp-length, .word arp-table, 4 bytes reserved`.
- **Pattern bytes:** `00-6B` note (key on with the current instrument; one row), `80+n` n+1 empty
  rows (n = 0-63), `C0` key off (one row), `C1 i` select instrument i (no row), `FF` end of
  pattern (music: next order entry; effect: the effect ends).

### Rendering a song to WAV

`node tools/song-wav.ts [cart.asm] [--song SONG_name] [--seconds 20] [--out .tmp/sound-test.wav]
[--skip-frame 40]` runs the cartridge on the emulator (no input by default; `--skip-frame 40`
presses START on frame 40, for a cartridge that waits for START before its music),
waits until the driver has played the first row of the song, and writes that many seconds of Cue
output as a 16-bit mono WAV at 47,940 Hz. It also prints the measured SND_TICK cost.
