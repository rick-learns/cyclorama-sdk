; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Tutorial 1, step 1: a lamp on a dark stage. Colours, one 16x16 sprite, display on.

        .org $0000
        .word start, vblank, 0, 0, 0, 0, 0, 0 ; RESET, VBLANK, LINE, TIMER, TRAP; 000A-000F = 0
        .header title="TUTORIAL 1", dev=$0000, date=$19870918, version=$0100

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
        ST   R0, [OAMADDR]
        MOVQ R0, #104                   ; +0 Y (224 lines: 104 + 8 = the middle)
        ST   R0, [OAMDATA]
        MOVQ R0, #120                   ; +2 X (256 columns)
        ST   R0, [OAMDATA]
        MOVQ R0, #1                     ; +4 tile 1, palette 0
        ST   R0, [OAMDATA]
        MOVQ R0, #1                     ; +6 size 16x16, shown
        ST   R0, [OAMDATA]

        MOVQ R0, #1|8                   ; display on, sprites on (light field off: shade = FIXED = 7)
        ST   R0, [VCTRL]
main:   WAI                             ; nothing else to do: sleep until the next interrupt
        BRA  main

vblank: RTI                             ; no interrupt is enabled in step 1

        .align 2
        .include "tutorial-1.art.inc"   ; LAMP, LAMP_TILES
