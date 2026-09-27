; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Tutorial 1, step 2: move the lamp with the D-pad; A switches its colour and plays a note.
; Step 1 plus a VBLANK handler that reads the pad once per frame.

        .org $0000
        .word start, vblank, 0, 0, 0, 0, 0, 0 ; RESET, VBLANK, LINE, TIMER, TRAP; 000A-000F = 0
        .header title="TUTORIAL 1", dev=$0000, date=$19870918, version=$0100

LX      = $8000                         ; work RAM: the lamp's x (word)
LY      = $8002                         ; the lamp's y
LPREV   = $8004                         ; last frame's pad, to see new presses
LPAL    = $8006                         ; sprite palette in use, 0 or 1

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
        MOVW R0, #7*64+5*8+1            ; sprite palette 1 (CRAM palette 5): a cool lamp
        ST   R0, [CRAMADDR]
        MOVW R0, #$058
        ST   R0, [CRAMDATA]
        MOVW R0, #$4CF
        ST   R0, [CRAMDATA]
        MOVW R0, #$EFF
        ST   R0, [CRAMDATA]

        ; --- the lamp's four tiles to tile 1 (VRAM 24), one DMA ---
        MOVW R0, #LAMP
        ST   R0, [DMASRC]
        MOVQ R0, #24                    ; tile n lives at VRAM n x 24
        ST   R0, [DMADST]
        MOVW R0, #LAMP_TILES*12         ; 12 words per tile
        ST   R0, [DMALEN]
        MOVQ R0, #1                     ; target 1 = VRAM
        ST   R0, [DMACTL]

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
        MOVQ R0, #120                   ; the lamp starts in the middle
        ST   R0, [LX]
        MOVQ R0, #104
        ST   R0, [LY]
        MOVQ R0, #0
        ST   R0, [LPREV]
        ST   R0, [LPAL]

        ; --- sound: voice 0 plays a short pulse note when A is pressed ---
        MOVQ R0, #12
        ST   R0, [MASTERVOL]
        MOVQ R0, #2                     ; pulse, 50% duty
        ST   R0, [V0WAVE]
        MOVQ R0, #12|(2<<5)             ; volume 12, falling one step every 2 ticks
        ST   R0, [V0ENV]

        MOVQ R0, #1|8                   ; display on, sprites on
        ST   R0, [VCTRL]
        MOVQ R0, #1
        ST   R0, [IF]                   ; forget a VBLANK that is already pending
        ST   R0, [IE]                   ; enable the VBLANK interrupt
        EI
main:   WAI                             ; sleep; the work happens in vblank
        BRA  main

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

        .align 2
        .include "tutorial-1.art.inc"   ; LAMP, LAMP_TILES
