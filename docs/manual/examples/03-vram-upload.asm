; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Example 3: upload one tile (24 bytes = 12 words) to tile 1, first with
; the CPU through VADDR/VDATA, then with the DMA channel.
TileAddr = 1 * 24               ; tile n lives at VRAM n x 24

        .org    $0300
UploadCPU:
        MOV     R0, #TileAddr
        ST      R0, [VADDR]
        MOV     R1, #Tile       ; source in ROM
        MOV     R2, #VDATA
        MOV     R3, #12         ; words
.next:  LD      R0, [R1]+
        ST      R0, [R2]        ; VADDR advances by VINC (2)
        DEC     R3
        BNE     .next
        RTS

UploadDMA:
        MOV     R0, #Tile
        ST      R0, [DMASRC]
        MOV     R0, #TileAddr
        ST      R0, [DMADST]
        MOV     R0, #12
        ST      R0, [DMALEN]
        MOV     R0, #1          ; target 1 = VRAM
        ST      R0, [DMACTL]    ; CPU stopped 4 + 2 x 12 = 28 cycles in blanking
        RTS

Tile:   .byte   $3C, $42, $81, $81, $81, $81, $42, $3C  ; plane 0
        .byte   $00, $3C, $7E, $7E, $7E, $7E, $3C, $00  ; plane 1
        .byte   $00, $00, $18, $3C, $3C, $18, $00, $00  ; plane 2
