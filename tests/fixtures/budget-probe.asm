; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; BUDGET PROBE: test cartridge for tools/budget.ts (not a canon release).
; Deliberately breaks the rules so the budget report can be checked against known values:
;   - one 256-word DMA to VRAM as the very first thing (during line 0's active display:
;     the CPU is stopped for 4 + 4 x 256 = 1028 cycles);
;   - 20 visible 8 x 8 sprites on lines 50-57 (the limit is 16 per line), the rest hidden;
;   - three lights on (L0 +3, L1 +2, L3 -1), light field enabled;
;   - voices 0 and 3 keyed on, voice 1 only has its frequency written;
;   - after the 20th VBLANK the main loop burns ~2 frames of cycles without WAI (overrun).

        .org $0000
        .word start, vblank, 0, 0, 0
        .header title="BUDGET PROBE", dev=$0001, date=$19870301, version=$0100

TICKS   = $8000

        .org $0040
start:  MOVQ R0, #0
        ST   R0, [DMASRC]
        ST   R0, [DMADST]
        MOVW R0, #256
        ST   R0, [DMALEN]
        MOVQ R0, #1
        ST   R0, [DMACTL]

        ; --- OAM: sprites 0-19 at y = 50, x = 10 * i; sprites 20-63 hidden ---
        MOVQ R0, #0
        ST   R0, [OAMADDR]
        MOVQ R1, #0                 ; x
        MOVQ R2, #1                 ; tile
        MOVQ R3, #0                 ; size 8 x 8, visible
        MOVQ R4, #50                ; y
        MOVQ R5, #20
.vis:   ST   R4, [OAMDATA]
        ST   R1, [OAMDATA]
        ST   R2, [OAMDATA]
        ST   R3, [OAMDATA]
        ADDQ R1, #10
        ADDQ R5, #-1
        BNE  .vis
        MOVQ R3, #2                 ; hide
        MOVQ R5, #44
.hid:   ST   R0, [OAMDATA]
        ST   R0, [OAMDATA]
        ST   R0, [OAMDATA]
        ST   R3, [OAMDATA]
        ADDQ R5, #-1
        BNE  .hid

        ; --- three lights ---
        MOVQ R0, #3
        ST   R0, [L0I]
        MOVQ R0, #2
        ST   R0, [L1I]
        MOVQ R0, #15                ; -1
        ST   R0, [L3I]

        ; --- audio: voices 0 and 3 keyed on, voice 1 frequency only ---
        MOVQ R0, #8
        ST   R0, [MASTERVOL]
        MOVW R0, #300
        ST   R0, [V1FREQ]
        MOVW R0, #601
        ST   R0, [V0FREQ]
        MOVW R0, #2000
        ST   R0, [V3FREQ]
        MOVQ R0, #1
        ST   R0, [V0CTRL]
        ST   R0, [V3CTRL]

        MOVQ R0, #1|8|16            ; display, sprites, light field
        ST   R0, [VCTRL]
        MOVQ R0, #1
        ST   R0, [IF]
        ST   R0, [IE]               ; VBLANK
        EI
main:   WAI
        LD   R0, [TICKS]
        CMP  R0, #20
        BNE  main
        MOVW R5, #30000             ; overrun: about two frames without WAI
.burn:  ADDQ R5, #-1
        BNE  .burn
        BRA  main

vblank: PUSH R0
        LD   R0, [TICKS]
        ADDQ R0, #1
        ST   R0, [TICKS]
        MOVQ R0, #1
        ST   R0, [IF]
        POP  R0
        RTI
