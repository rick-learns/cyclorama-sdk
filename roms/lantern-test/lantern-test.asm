; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; LANTERN TEST — engineering test cartridge for the Avenell Cyclorama.
; The stage cat walks a dark brick room with the D-pad; light 0 follows it.
; Its eyes are a second sprite flagged UNLIT, so they glow at FIXED shade in
; any darkness. Hold A for a wider lantern; pressing A plays A4 on voice 0.

        .org $0000
        .word start, vblank, 0, 0, 0
        .header title="LANTERN TEST", dev=$0001, date=$19870301, version=$0100

PX      = $8000         ; cat x (word)
PY      = $8002         ; cat y
PREV    = $8004         ; last frame's pad

        .org $0040
start:  MOVQ R0, #0
        ST   R0, [VCTRL]            ; display off while loading

        ; --- CRAM: eight shade planes, each a darker copy of BASECOL ---
        ST   R0, [CRAMADDR]
        MOVQ R4, #1                 ; brightness factor 1..8 (x/8)
.shade: MOVW R6, #BASECOL
        MOVW R5, #64
.col:   LD   R0, [R6]+
        MOV  R1, R0
        SHR  R1, #8
        AND  R1, #15
        MUL  R1, R4
        SHR  R1, #3                 ; red
        MOV  R2, R0
        SHR  R2, #4
        AND  R2, #15
        MUL  R2, R4
        SHR  R2, #3                 ; green
        AND  R0, #15
        MUL  R0, R4
        SHR  R0, #3                 ; blue
        SHL  R1, #8
        SHL  R2, #4
        OR   R0, R1
        OR   R0, R2
        ST   R0, [CRAMDATA]
        ADDQ R5, #-1
        BNE  .col
        ADDQ R4, #1
        CMP  R4, #9
        BNE  .shade

        ; --- tiles: brick = 1, cat = 2-5, eyes = 6-9, one DMA from ROM ---
        MOVW R0, #TILE_BRICK
        ST   R0, [DMASRC]
        MOVQ R0, #24
        ST   R0, [DMADST]
        MOVW R0, #108
        ST   R0, [DMALEN]
        MOVQ R0, #1
        ST   R0, [DMACTL]

        ; --- BG0 map at 6000: brick everywhere ---
        MOVW R0, #$6000
        ST   R0, [VADDR]
        MOVQ R1, #1
        MOVW R5, #2048
.map:   ST   R1, [VDATA]
        ADDQ R5, #-1
        BNE  .map

        ; --- hide all 64 sprites (zeroed OAM would stack them at 0,0) ---
        MOVQ R0, #0
        ST   R0, [OAMADDR]
        MOVQ R2, #2
        MOVQ R5, #64
.oam:   ST   R0, [OAMDATA]
        ST   R0, [OAMDATA]
        ST   R0, [OAMDATA]
        ST   R2, [OAMDATA]
        ADDQ R5, #-1
        BNE  .oam

        ; --- state, light field, audio ---
        MOVQ R0, #120
        ST   R0, [PX]
        MOVQ R0, #100
        ST   R0, [PY]
        MOVQ R0, #0
        ST   R0, [PREV]
        MOVQ R0, #1
        ST   R0, [AMBIENT]
        MOVQ R0, #6                 ; AMBIENT 1 + 6 = 7: keep totals below 8 (the adder wraps)
        ST   R0, [L0I]
        MOVQ R0, #$24               ; falloff 4, octagon
        ST   R0, [L0F]
        MOVQ R0, #12
        ST   R0, [MASTERVOL]
        MOVQ R0, #2                 ; pulse 50%
        ST   R0, [V0WAVE]
        MOVQ R0, #12|(2<<5)         ; volume 12, falling every 2 ticks
        ST   R0, [V0ENV]
        MOVQ R0, #1|2|8|16          ; display, BG0, sprites, light field
        ST   R0, [VCTRL]
        MOVQ R0, #1
        ST   R0, [IF]
        ST   R0, [IE]               ; VBLANK
        EI
main:   WAI
        BRA  main

; --- VBLANK: read the pad, move the cat, place sprites and the light -------
vblank: PUSHM R0-R3
        LD   R0, [PAD1]
        LD   R1, [PX]
        LD   R2, [PY]
        TST  R0, #1
        BEQ  .nu
        ADDQ R2, #-1
.nu:    TST  R0, #2
        BEQ  .nd
        ADDQ R2, #1
.nd:    TST  R0, #4
        BEQ  .nl
        ADDQ R1, #-1
.nl:    TST  R0, #8
        BEQ  .nr
        ADDQ R1, #1
.nr:    CMP  R1, #240               ; clamp x to 0..240 (negative = large unsigned)
        BLS  .xok
        TST  R1, #$8000
        BEQ  .xhi
        MOVQ R1, #0
        BRA  .xok
.xhi:   MOVW R1, #240
.xok:   CMP  R2, #208
        BLS  .yok
        TST  R2, #$8000
        BEQ  .yhi
        MOVQ R2, #0
        BRA  .yok
.yhi:   MOVW R2, #208
.yok:   ST   R1, [PX]
        ST   R2, [PY]

        MOVQ R3, #0                 ; sprite 0 = eyes (unlit), sprite 1 = cat body:
        ST   R3, [OAMADDR]          ; the lower OAM index wins, so the eyes go first
        ST   R2, [OAMDATA]
        ST   R1, [OAMDATA]
        MOVW R3, #6|$8000
        ST   R3, [OAMDATA]
        MOVQ R3, #1
        ST   R3, [OAMDATA]
        ST   R2, [OAMDATA]
        ST   R1, [OAMDATA]
        MOVQ R3, #2
        ST   R3, [OAMDATA]
        MOVQ R3, #1
        ST   R3, [OAMDATA]

        MOV  R3, R1                 ; lantern at the cat's centre
        ADDQ R3, #8
        ST   R3, [L0X]
        MOV  R3, R2
        ADDQ R3, #8
        ST   R3, [L0Y]

        LD   R3, [PREV]             ; newly pressed buttons
        ST   R0, [PREV]
        NOT  R3
        AND  R3, R0
        TST  R3, #16
        BEQ  .noa
        MOVW R3, #601               ; A4
        ST   R3, [V0FREQ]
        MOVQ R3, #1
        ST   R3, [V0CTRL]
.noa:   MOVQ R3, #$24
        TST  R0, #16
        BEQ  .small
        MOVQ R3, #$25               ; wider lantern while A is held
.small: ST   R3, [L0F]
        MOVQ R3, #1
        ST   R3, [IF]
        POPM R0-R3
        RTI

; --- data -----------------------------------------------------------------
        .align 2
BASECOL:                            ; 64 base colours (0RGB)
        .word $112, $964, $533, $4A4, 0, 0, 0, 0     ; BG palette 0: floor dark, brick, mortar, moss
        .fill 48, 0                                  ; BG palettes 1-3 unused
        .word 0, $223, $446, $FD3, $210, 0, 0, 0     ; sprite palette 0: cat body, highlight, eye, pupil
        .fill 48, 0                                  ; sprite palettes 1-3 unused
        .align 2
        .include "lantern-test.art.inc"
