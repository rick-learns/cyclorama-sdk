# Tutorial 1: a lamp on the stage (CYASM)

You will write a Cyclorama cartridge in assembly language, in two steps: first a glowing lamp in
the middle of a dark screen, then a lamp you steer with the D-pad, which changes colour and
plays a note when you press A. Each step is a complete program in
[`examples/tutorial-1/`](../../examples/tutorial-1/). This page quotes every line of step 1 and
every line step 2 adds to it (a test checks that it does, and another test checks that each
program does what the page says).

You need a working checkout: see [Getting started](getting-started.md). The
[hardware manual](../manual/index.html) is the reference for everything used here; each section
below links to the part of the manual it relies on.

## Step 1: something on the screen

### Build it and look at it

<!-- run -->
```sh
npm run asm -- examples/tutorial-1/step1.asm -o .tmp/step1.rom
npm run player -- examples/tutorial-1/step1.asm .tmp/step1.html
```

The first command assembles the program into a 32 KiB cartridge image. The second builds the
same program into one self-contained web page with the reference player: open
`.tmp/step1.html` in a browser (it needs no server and no network).

![Step 1: an amber lamp in the middle of a dark blue-grey screen](images/tutorial-1-step1.png)

### The cartridge header

<!-- sample: examples/tutorial-1/step1.asm lines 6-8 -->
```asm
        .org $0000
        .word start, vblank, 0, 0, 0, 0, 0, 0 ; RESET, VBLANK, LINE, TIMER, TRAP; 000A-000F = 0
        .header title="TUTORIAL 1", dev=$0000, date=$19870918, version=$0100
```

The console has no boot ROM: at power-on the CPU reads the word at address 0000 of the
cartridge and jumps there. The first five words are the [vectors](../manual/index.html#sys-vectors),
in the order RESET, VBLANK, LINE, TIMER, TRAP; the three words after them (000A-000F) are not used
by the hardware, and the manual asks for zeros there (the assembler would otherwise leave FF).
Some older programs in this repository (Lantern Test, the Sound Test) write only the five vectors;
the hardware ignores those words either way. `.header` writes
the [cartridge header](../manual/index.html#cart-header) at 0010-003F: the title the budget report
and the player show, a developer code (Avenell assigned these to its licensees; a homebrew
cartridge has none, so this one uses 0000), a release date and a version. The assembler also fills
in the checksum.

### Colours

<!-- sample: examples/tutorial-1/step1.asm lines 10-26 -->
```asm
        .org $0040
start:  MOVQ R0, #0
        ST   R0, [VCTRL]                ; display off while we load

        ; --- colours: shade 7 (FIXED), backdrop and sprite palette 0 ---
        MOVW R0, #7*64                  ; CRAM entry 448: the backdrop at shade 7
        ST   R0, [CRAMADDR]
        MOVW R0, #$113                  ; dark blue-grey (0RGB)
        ST   R0, [CRAMDATA]
        MOVW R0, #7*64+4*8+1            ; sprite palette 0 is CRAM palette 4; colours 1-3
        ST   R0, [CRAMADDR]
        MOVW R0, #$A50                  ; 1: amber rim
        ST   R0, [CRAMDATA]
        MOVW R0, #$FC4                  ; 2: warm yellow
        ST   R0, [CRAMDATA]
        MOVW R0, #$FFE                  ; 3: white-hot centre
        ST   R0, [CRAMDATA]
```

Writing 0 to `VCTRL` turns the display off, so nothing half-loaded is ever shown. Colour RAM
(CRAM, [manual 5.7](../manual/index.html#vid-cram)) holds 512 colours of 12 bits (`$RGB`). They
are grouped by **shade** ([shade planes](../manual/index.html#vid-shade-planes)): the Cyclorama's
video chip draws every pixel at one of eight shade levels, and each shade has its own 64
colours, 8 palettes of 8. The shade normally comes from the *light field* (the machine's
signature feature, which [Tutorial 2](tutorial-2-scrim.md) uses); with the light field off every
pixel uses the shade in the `FIXED` register, which is 7 after reset. So this program only
needs the colours of shade 7: entry 7 × 64 = 448 is the backdrop, and the sprite palettes are
palettes 4-7, so sprite palette 0 starts at entry 448 + 4 × 8 = 480. Colour 0 of a sprite
palette is transparent, so the lamp uses colours 1-3.

`CRAMADDR` selects an entry and every write to `CRAMDATA` stores one colour and moves to the next
entry, which is why three writes in a row fill colours 1, 2 and 3.

### The lamp's picture

<!-- sample: examples/tutorial-1/tutorial-1.art lines 6-22 -->
```text
@sprite16 LAMP
......1111......
....11222211....
...1223333221...
..122333333221..
.12233333333221.
.12333333333321.
122333333333322.
123333333333332.
123333333333332.
122333333333322.
.12333333333321.
.12233333333221.
..122333333221..
...1223333221...
....11222211....
......1111......
```

Pictures are text files (`.art`): each character is a pixel's colour number, `.` for 0. The ROM
build converts `tutorial-1.art` when the program asks for `tutorial-1.art.inc`
(the last line of `step1.asm`), so the art stays readable source:

<!-- sample: examples/tutorial-1/step1.asm lines 66-67 -->
```asm
        .align 2
        .include "tutorial-1.art.inc"   ; LAMP, LAMP_TILES
```

`@sprite16 LAMP` makes one 16 × 16 sprite: four 8 × 8 [tiles](../manual/index.html#vid-tiles) of
24 bytes each (three bit planes), in the order the video chip draws them, and the symbols `LAMP`
(where the data is in ROM) and `LAMP_TILES` (4). `.align 2` puts the data on an even address,
which the DMA channel needs because it copies whole words.

### Copying it to video memory

<!-- sample: examples/tutorial-1/step1.asm lines 28-36 -->
```asm
        ; --- the lamp's four tiles to tile 1 (VRAM 24), one DMA ---
        MOVW R0, #LAMP
        ST   R0, [DMASRC]
        MOVQ R0, #24                    ; tile n lives at VRAM n x 24
        ST   R0, [DMADST]
        MOVW R0, #LAMP_TILES*12         ; 12 words per tile
        ST   R0, [DMALEN]
        MOVQ R0, #1                     ; target 1 = VRAM
        ST   R0, [DMACTL]
```

Tiles live in the video chip's own 32 KiB (VRAM), which the CPU cannot address directly. The
[DMA channel](../manual/index.html#vid-dma) copies words from ROM or RAM into it: source, destination, length in words, then a
write to `DMACTL` starts the copy and stops the CPU until it is done. Tile *n* sits at VRAM byte
*n* × 24; the lamp goes to tiles 1-4. Tile 0 is never written, so its contents are undefined,
but no visible sprite uses it.

### One sprite

<!-- sample: examples/tutorial-1/step1.asm lines 38-57 -->
```asm
        ; --- hide all 64 sprites, then show sprite 0 in the middle ---
        MOVQ R0, #0
        ST   R0, [OAMADDR]
        MOVQ R2, #2                     ; word +6: hide
        MOVQ R5, #64
.hide:  ST   R0, [OAMDATA]
        ST   R0, [OAMDATA]
        ST   R0, [OAMDATA]
        ST   R2, [OAMDATA]
        ADDQ R5, #-1
        BNE  .hide
        ST   R0, [OAMADDR]
        MOVQ R0, #104                   ; +0 Y (224 lines: 104 + 8 = the middle)
        ST   R0, [OAMDATA]
        MOVQ R0, #120                   ; +2 X (256 columns)
        ST   R0, [OAMDATA]
        MOVQ R0, #1                     ; +4 tile 1, palette 0
        ST   R0, [OAMDATA]
        MOVQ R0, #1                     ; +6 size 16x16, shown
        ST   R0, [OAMDATA]
```

The chip draws up to 64 sprites from object attribute memory
([OAM](../manual/index.html#vid-oam-entry)): four words each, Y, X, tile
and palette, then size and a *hide* bit. Like all memory, OAM holds undefined values at
power-on (the emulator starts it at zero; a real console would not, and 64 zeroed entries would
still draw tile 0 at the top-left corner), so the loop hides every sprite first. `OAMADDR` and `OAMDATA` work like the CRAM pair: set an address, then each write stores a
word and moves on. The screen is 256 × 224 pixels, so a 16 × 16 sprite at X 120, Y 104 is
centred.

### Switch on and sleep

<!-- sample: examples/tutorial-1/step1.asm lines 59-64 -->
```asm
        MOVQ R0, #1|8                   ; display on, sprites on (light field off: shade = FIXED = 7)
        ST   R0, [VCTRL]
main:   WAI                             ; nothing else to do: sleep until the next interrupt
        BRA  main

vblank: RTI                             ; no interrupt is enabled in step 1
```

[`VCTRL`](../manual/index.html#reg-VCTRL) bit 0 turns the display on and bit 3 the sprites. The picture is now drawn about 60
times a second (59.92) without the CPU's help, so the program has nothing left to do: `WAI` stops the CPU until
an interrupt arrives (none will in step 1; [WAI](../manual/index.html#sys-wai)). A program that stops in `WAI` costs nothing, and the
budget report counts that as idle time.

## Step 2: answer the pad

Step 2 is step 1 plus four words of work RAM, a second palette, a sound and a VBLANK handler,
with two changes to step 1's code: `start` no longer writes sprite 0 after hiding the sprites
(step 1's lines 49-57), because the VBLANK handler now draws it every frame, and step 1's last
lines (`main` and the one-line `vblank`, lines 59-64) are replaced by the new versions below.
Everything else is step 1 unchanged.

<!-- run -->
```sh
npm run asm -- examples/tutorial-1/step2.asm -o .tmp/step2.rom
npm run player -- examples/tutorial-1/step2.asm .tmp/step2.html
```

In the player the arrow keys are the D-pad and Z is A (a gamepad works too).

### Work RAM

<!-- sample: examples/tutorial-1/step2.asm lines 11-14 -->
```asm
LX      = $8000                         ; work RAM: the lamp's x (word)
LY      = $8002                         ; the lamp's y
LPREV   = $8004                         ; last frame's pad, to see new presses
LPAL    = $8006                         ; sprite palette in use, 0 or 1
```

Work RAM is 16 KiB at 8000-BFFF ([memory map](../manual/index.html#cpu-memory)). These are plain
names for four words of it. Its contents are
undefined at power-on, so `start` sets all four, after hiding the sprites and before the first
VBLANK can read them:

<!-- sample: examples/tutorial-1/step2.asm lines 63-69 -->
```asm
        MOVQ R0, #120                   ; the lamp starts in the middle
        ST   R0, [LX]
        MOVQ R0, #104
        ST   R0, [LY]
        MOVQ R0, #0
        ST   R0, [LPREV]
        ST   R0, [LPAL]
```

### A second palette

Right after the first palette, step 2 fills sprite palette 1 (CRAM palette 5,
[CRAM layout](../manual/index.html#vid-cram-map)) with a cool version of the lamp, for the A
button to switch to:

<!-- sample: examples/tutorial-1/step2.asm lines 33-40 -->
```asm
        MOVW R0, #7*64+5*8+1            ; sprite palette 1 (CRAM palette 5): a cool lamp
        ST   R0, [CRAMADDR]
        MOVW R0, #$058
        ST   R0, [CRAMDATA]
        MOVW R0, #$4CF
        ST   R0, [CRAMDATA]
        MOVW R0, #$EFF
        ST   R0, [CRAMDATA]
```

The manual recommends that a RESET routine clear all of work RAM, VRAM, OAM and CRAM
([example 1](../../docs/manual/examples/01-reset.asm) is such a routine). This tutorial sets
exactly the memory the picture uses instead, to stay short: the backdrop and the lamp's colours,
its tiles, and every OAM entry. A real game should clear everything.

### Interrupts every frame

<!-- sample: examples/tutorial-1/step2.asm lines 79-86 -->
```asm
        MOVQ R0, #1|8                   ; display on, sprites on
        ST   R0, [VCTRL]
        MOVQ R0, #1
        ST   R0, [IF]                   ; forget a VBLANK that is already pending
        ST   R0, [IE]                   ; enable the VBLANK interrupt
        EI
main:   WAI                             ; sleep; the work happens in vblank
        BRA  main
```

When the beam finishes line 223 the chip raises VBLANK, once per frame
([interrupts](../manual/index.html#sys-interrupts)). `IE` bit 0 lets it
interrupt the CPU, `EI` enables interrupts, and each VBLANK now wakes the CPU from `WAI` and
runs the handler at the VBLANK vector. Writing 1 to `IF` first throws away a VBLANK that may
have happened while the program was loading.

### Read the pad, move, clamp

<!-- sample: examples/tutorial-1/step2.asm lines 88-120 -->
```asm
; --- VBLANK, once per frame: read the pad, move the lamp, redraw sprite 0 ---
vblank: PUSHM R0-R3
        LD   R0, [PAD1]                 ; bit 0 Up, 1 Down, 2 Left, 3 Right, 4 A
        LD   R1, [LX]
        LD   R2, [LY]
        TST  R0, #1
        BEQ  .nu
        ADDQ R2, #-2
.nu:    TST  R0, #2
        BEQ  .nd
        ADDQ R2, #2
.nd:    TST  R0, #4
        BEQ  .nl
        ADDQ R1, #-2
.nl:    TST  R0, #8
        BEQ  .nr
        ADDQ R1, #2
.nr:    CMP  R1, #240                   ; keep x in 0..240: unsigned, so a step below 0
        BLS  .xok                       ; wraps to a large value and counts as "too far"
        TST  R1, #$8000
        BEQ  .xhi
        MOVQ R1, #0
        BRA  .xok
.xhi:   MOVW R1, #240
.xok:   CMP  R2, #208                   ; and y in 0..208
        BLS  .yok
        TST  R2, #$8000
        BEQ  .yhi
        MOVQ R2, #0
        BRA  .yok
.yhi:   MOVW R2, #208
.yok:   ST   R1, [LX]
        ST   R2, [LY]
```

An interrupt handler must leave the registers as it found them, so it saves the four it uses
with `PUSHM`. [`PAD1`](../manual/index.html#reg-PAD1) holds controller 1's buttons, one bit each, 1 = pressed; the chip samples
the pads at the start of VBLANK, so the value is fresh. Each held direction moves the lamp 2
pixels. The clamp uses one unsigned compare for both edges: 0 − 2 is FFFE, which is "higher"
than 240, and bit 15 then tells a step past 0 from a step past 240.

### A button press, not a held button

<!-- sample: examples/tutorial-1/step2.asm lines 122-134 -->
```asm
        LD   R3, [LPREV]                ; newly pressed = pressed now and not last frame
        ST   R0, [LPREV]
        NOT  R3
        AND  R3, R0
        TST  R3, #16                    ; A just pressed?
        BEQ  .noa
        LD   R3, [LPAL]
        XOR  R3, #1                     ; swap palette 0 <-> 1
        ST   R3, [LPAL]
        MOVW R3, #601                   ; A4
        ST   R3, [V0FREQ]
        MOVQ R3, #1                     ; key on
        ST   R3, [V0CTRL]
```

`PAD1` says which buttons are *down*. To act once per press, compare with last frame's value:
pressed now AND NOT pressed before. On a new press of A the lamp swaps palettes and the Cue
sound chip's voice 0 plays A4: `V0FREQ` sets the pitch, and writing 1 to `V0CTRL` keys the note
on. The waveform and the [volume envelope](../manual/index.html#aud-env) were set once at start-up:

<!-- sample: examples/tutorial-1/step2.asm lines 71-77 -->
```asm
        ; --- sound: voice 0 plays a short pulse note when A is pressed ---
        MOVQ R0, #12
        ST   R0, [MASTERVOL]
        MOVQ R0, #2                     ; pulse, 50% duty
        ST   R0, [V0WAVE]
        MOVQ R0, #12|(2<<5)             ; volume 12, falling one step every 2 ticks
        ST   R0, [V0ENV]
```

### Redraw the sprite, acknowledge, return

<!-- sample: examples/tutorial-1/step2.asm lines 136-150 -->
```asm
.noa:   MOVQ R3, #0                     ; sprite 0: Y, X, tile + palette, size
        ST   R3, [OAMADDR]
        ST   R2, [OAMDATA]
        ST   R1, [OAMDATA]
        LD   R3, [LPAL]
        SHL  R3, #10                    ; palette in bits 11-10 of word +4
        OR   R3, #1                     ; tile 1
        ST   R3, [OAMDATA]
        MOVQ R3, #1                     ; 16x16, shown
        ST   R3, [OAMDATA]

        MOVQ R3, #1
        ST   R3, [IF]                   ; acknowledge the VBLANK
        POPM R0-R3
        RTI
```

Sprite 0 is rewritten with the new position and palette. VBLANK is the right time for it: the
beam is not drawing, so the picture never tears. Writing 1 to [`IF`](../manual/index.html#reg-IF) bit 0 acknowledges the
interrupt (otherwise it would fire again at once), and `RTI` returns to the `WAI` loop.

## What to try next

- Turn the light field on (`VCTRL` bit 4) and put light 0 on the lamp. With the light field on,
  each pixel's shade comes from `AMBIENT` plus the lights, so the program must fill all eight
  shade planes of CRAM (usually as darker copies of the colours), not only plane 7, or the screen
  shows colours it never set. The demo cartridge
  [`roms/lantern-test/lantern-test.asm`](../../roms/lantern-test/lantern-test.asm) does exactly
  that: it builds the eight planes, then lights a brick room with the lamp the cat carries.
- [Tutorial 2](tutorial-2-scrim.md) writes a small game in SCRIM, the Cyclorama's compiled
  language: a dark room lit by the light field, music and sound effects from the Cue Sound
  Driver, and a way to win.
