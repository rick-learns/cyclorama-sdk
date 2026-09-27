; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Conformance 10: DMA (spec-notes §3 DMA, §8.7, §8.28, §9.37-38, §9.40, §10.52; manual 5.12;
; registers.ts DMASRC/DMADST/DMALEN/DMACTL).
; Costs are measured with the timer at prescaler 1: R4 - R5 = 6 (LD [TCOUNT]) + 6 (ST [DMACTL])
; + the DMA stall, which is 4 + 2n if the transfer starts outside active display and 4 + 4n if it
; starts during active display (dot < 256 of lines 0-223), n = DMALEN.
        .rom 2
        .org $0000
        .word start, 0, 0, 0, 0
        .header title="CONFORMANCE 10 DMA", dev=$0001, date=$19870301, version=$0100
        .org $0040
        .include "_harness.inc"
        .include "_hw.inc"

DATA:   .word $1111, $2222, $3333, $4444

; MEASURE_DMA: R0 = DMACTL value. Returns R0 = R4 - R5 = 12 + stall.
MEASDMA:
        LD   R4, [TCOUNT]
        ST   R0, [DMACTL]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        RTS

; VREAD: R0 = VRAM address -> R0 = word there (VINC must be 2).
VREAD:  ST   R0, [VADDR]
        LD   R0, [VDATA]
        RTS
; OREAD: R0 = OAM address -> R0 = word.  CREAD: R0 = CRAM index -> R0 = entry.
OREAD:  ST   R0, [OAMADDR]
        LD   R0, [OAMDATA]
        RTS
CREAD:  ST   R0, [CRAMADDR]
        LD   R0, [CRAMDATA]
        RTS

; SETDMA: R0 = source, R1 = destination, R2 = length.
SETDMA: ST   R0, [DMASRC]
        ST   R1, [DMADST]
        ST   R2, [DMALEN]
        RTS

start:  MOVQ R7, #1
        CALL TSTART
        ; ---- ROM -> VRAM, 4 words, started in vertical blank ----
        MOVW R0, #128               ; VINC = 128: DMA must ignore it (§8.7)
        ST   R0, [VINC]
        MOVW R0, #$0555             ; VADDR must not be used or changed by DMA
        ST   R0, [VADDR]
        MOVW R0, #DATA
        MOVW R1, #$1000
        MOVQ R2, #4
        CALL SETDMA
        CALL WAITVB                 ; cycle 12 of line 224
        ; #1 cost: 12 + 4 + 2 x 4 = 24
        MOVQ R0, #1
        CALL MEASDMA
        MOVQ R1, #24
        CALL CHECK
        ; #2 DMASRC advanced by 2 per word: DATA + 8
        LD   R0, [DMASRC]
        MOVW R1, #DATA+8
        CALL CHECK
        ; #3 DMADST advanced by 2 per word: 1008
        LD   R0, [DMADST]
        MOVW R1, #$1008
        CALL CHECK
        ; #4 DMALEN counted down to 0
        LD   R0, [DMALEN]
        MOVQ R1, #0
        CALL CHECK
        ; #5 VADDR untouched
        LD   R0, [VADDR]
        MOVW R1, #$0555
        CALL CHECK
        ; #6-#9 the data, contiguous in VRAM (VINC 128 ignored)
        MOVQ R0, #2
        ST   R0, [VINC]
        MOVW R0, #$1000
        CALL VREAD
        MOVW R1, #$1111
        CALL CHECK
        MOVW R0, #$1002
        CALL VREAD
        MOVW R1, #$2222
        CALL CHECK
        MOVW R0, #$1004
        CALL VREAD
        MOVW R1, #$3333
        CALL CHECK
        MOVW R0, #$1006
        CALL VREAD
        MOVW R1, #$4444
        CALL CHECK

        ; ---- work RAM -> OAM, 3 words ----
        MOVW R0, #$A001
        ST   R0, [$8100]
        MOVW R0, #$A002
        ST   R0, [$8102]
        MOVW R0, #$A003
        ST   R0, [$8104]
        MOVW R0, #$8100
        MOVQ R1, #$10
        MOVQ R2, #3
        CALL SETDMA
        CALL WAITVB
        ; #10 cost 12 + 4 + 6 = 22
        MOVQ R0, #2
        CALL MEASDMA
        MOVQ R1, #22
        CALL CHECK
        ; #11-#13 OAM 0010, 0012, 0014
        MOVQ R0, #$10
        CALL OREAD
        MOVW R1, #$A001
        CALL CHECK
        MOVQ R0, #$12
        CALL OREAD
        MOVW R1, #$A002
        CALL CHECK
        MOVQ R0, #$14
        CALL OREAD
        MOVW R1, #$A003
        CALL CHECK
        ; #14 DMADST = 0016 (OAM advances by 2)
        LD   R0, [DMADST]
        MOVQ R1, #$16
        CALL CHECK
        ; #15 DMASRC = 8106
        LD   R0, [DMASRC]
        MOVW R1, #$8106
        CALL CHECK

        ; ---- bank window -> CRAM, 3 words: bits 15-12 dropped, DMADST advances by 1 ----
        MOVQ R0, #1
        ST   R0, [BANK]
        MOVW R0, #$4000
        MOVQ R1, #5
        MOVQ R2, #3
        CALL SETDMA
        MOVQ R0, #3
        ST   R0, [DMACTL]
        ; #16-#18 CRAM 5, 6, 7 = 0123, 0ABC, 0FFF (bank 1 holds F123, FABC, 0FFF at 4000)
        MOVQ R0, #5
        CALL CREAD
        MOVW R1, #$0123
        CALL CHECK
        MOVQ R0, #6
        CALL CREAD
        MOVW R1, #$0ABC
        CALL CHECK
        MOVQ R0, #7
        CALL CREAD
        MOVW R1, #$0FFF
        CALL CHECK
        ; #19 DMADST = 0008
        LD   R0, [DMADST]
        MOVQ R1, #8
        CALL CHECK
        ; #20 DMASRC = 4006
        LD   R0, [DMASRC]
        MOVW R1, #$4006
        CALL CHECK

        ; ---- DMALEN = 0 costs 4 and moves nothing (§8.7) ----
        MOVW R0, #$0020             ; VRAM 0020 = 7777 beforehand
        ST   R0, [VADDR]
        MOVW R0, #$7777
        ST   R0, [VDATA]
        MOVW R0, #DATA
        MOVQ R1, #$20
        MOVQ R2, #0
        CALL SETDMA
        CALL WAITVB
        ; #21 cost 12 + 4 = 16
        MOVQ R0, #1
        CALL MEASDMA
        MOVQ R1, #16
        CALL CHECK
        ; #22 VRAM 0020 unchanged
        MOVQ R0, #$20
        CALL VREAD
        MOVW R1, #$7777
        CALL CHECK
        ; #23-#24 pointers unchanged
        LD   R0, [DMASRC]
        MOVW R1, #DATA
        CALL CHECK
        LD   R0, [DMADST]
        MOVQ R1, #$20
        CALL CHECK

        ; ---- cost in active display: 4 + 4n ----
        MOVW R0, #DATA
        MOVW R1, #$1010
        MOVQ R2, #4
        CALL SETDMA
        MOVQ R0, #100
        CALL LINESTART              ; cycle 15 of line 100; MOVQ 2 + CALL 8 + LD 6: DMACTL written at cycle 31 (dot 46.5)
        ; #25 cost 12 + 4 + 16 = 32
        MOVQ R0, #1
        CALL MEASDMA
        MOVQ R1, #32
        CALL CHECK
        ; #26 the data arrived (1016 = 4444)
        MOVW R0, #$1016
        CALL VREAD
        MOVW R1, #$4444
        CALL CHECK
        ; #27 DMALEN = 0 in active display also costs just 4 (no words): 12 + 4 = 16
        MOVQ R0, #0
        ST   R0, [DMALEN]
        MOVQ R0, #101
        CALL LINESTART
        MOVQ R0, #1
        CALL MEASDMA
        MOVQ R1, #16
        CALL CHECK
        ; #28 horizontal blank of a visible line is outside active display: WAITLN returns at cycle
        ; 183, + MOVQ 2 + CALL 8 + LD 6: 4 words started at cycle 199 of line 50 (dot 298.5): 12 + 4 + 8 = 24
        MOVW R0, #DATA
        MOVW R1, #$1020
        MOVQ R2, #4
        CALL SETDMA
        MOVQ R0, #50
        CALL WAITLN
        MOVQ R0, #1
        CALL MEASDMA
        MOVQ R1, #24
        CALL CHECK
        ; #29 a transfer that starts in vertical blank and runs into line 0 keeps the cheap rate
        ; (§9.37): 100 words started at cycle 199 of line 261; the instruction (6) + stall (4 + 200)
        ; ends at cycle 199 + 210 - 228 = 181 of line 0 of the next frame. Cost 12 + 204 = 216 (not 12 + 404).
        MOVQ R0, #0
        MOVW R1, #$2000
        MOVQ R2, #100
        CALL SETDMA
        MOVW R0, #261
        CALL WAITLN
        MOVQ R0, #1
        CALL MEASDMA
        MOVW R1, #216
        CALL CHECK
        ; #30 ...and the CPU really was stopped into line 0: now VCOUNT = 0
        LD   R0, [VCOUNT]
        MOVQ R1, #0
        CALL CHECK
        ; #31 VRAM 2000 + 2 x 99 = 20C6 holds ROM word 00C6 (last word copied)
        MOVW R0, #$20C6
        CALL VREAD
        LD   R1, [$00C6]
        CALL CHECK

        ; ---- source E000-FFFF reads 0 with no side effects (§9.38) ----
        MOVQ R0, #$10               ; CRAM 10, 11 = 0FFF beforehand
        ST   R0, [CRAMADDR]
        MOVW R0, #$0FFF
        ST   R0, [CRAMDATA]
        ST   R0, [CRAMDATA]
        MOVW R0, #$0300
        ST   R0, [VADDR]
        MOVW R0, #VDATA             ; source F002 = VDATA: a CPU read would advance VADDR
        MOVQ R1, #$10
        MOVQ R2, #2
        CALL SETDMA
        MOVQ R0, #3
        ST   R0, [DMACTL]
        ; #32-#33 CRAM 10, 11 = 0
        MOVQ R0, #$10
        CALL CREAD
        MOVQ R1, #0
        CALL CHECK
        MOVQ R0, #$11
        CALL CREAD
        MOVQ R1, #0
        CALL CHECK
        ; #34 VADDR not advanced (no VDATA read side effect)
        LD   R0, [VADDR]
        MOVW R1, #$0300
        CALL CHECK
        ; #35 DMASRC advanced anyway: F006
        LD   R0, [DMASRC]
        MOVW R1, #$F006
        CALL CHECK
        ; #36 source E000+ adds no port wait: 2 words from F002 (VDATA) in vblank cost 12 + 4 + 4 = 20
        MOVW R0, #VDATA
        MOVQ R1, #$10
        MOVQ R2, #2
        CALL SETDMA
        CALL WAITVB
        MOVQ R0, #3
        CALL MEASDMA
        MOVQ R1, #20
        CALL CHECK

        ; ---- source wraps FFFE -> 0000 (§9.38) ----
        MOVW R0, #$FFFE
        MOVQ R1, #$20
        MOVQ R2, #2
        CALL SETDMA
        MOVQ R0, #3
        ST   R0, [DMACTL]
        ; #37 CRAM 20 = 0 (from FFFE)
        MOVQ R0, #$20
        CALL CREAD
        MOVQ R1, #0
        CALL CHECK
        ; #38 CRAM 21 = ROM word 0000 (the RESET vector) & 0FFF
        MOVQ R0, #$21
        CALL CREAD
        MOVW R1, #start & $0FFF
        CALL CHECK
        ; #39 DMASRC = 0002
        LD   R0, [DMASRC]
        MOVQ R1, #2
        CALL CHECK

        ; ---- destination wrap (§10.52) ----
        ; OAM: DMADST 01FE + 2 words: writes OAM 01FE and 0000, DMADST = 0202
        MOVW R0, #DATA
        MOVW R1, #$01FE
        MOVQ R2, #2
        CALL SETDMA
        MOVQ R0, #2
        ST   R0, [DMACTL]
        ; #40 DMADST
        LD   R0, [DMADST]
        MOVW R1, #$0202
        CALL CHECK
        ; #41-#42 OAM 01FE = 1111, 0000 = 2222
        MOVW R0, #$01FE
        CALL OREAD
        MOVW R1, #$1111
        CALL CHECK
        MOVQ R0, #0
        CALL OREAD
        MOVW R1, #$2222
        CALL CHECK
        ; VRAM: DMADST 7FFE + 2 words: VRAM 7FFE and 0000, DMADST = 8002
        MOVW R0, #DATA
        MOVW R1, #$7FFE
        MOVQ R2, #2
        CALL SETDMA
        MOVQ R0, #1
        ST   R0, [DMACTL]
        ; #43 DMADST
        LD   R0, [DMADST]
        MOVW R1, #$8002
        CALL CHECK
        ; #44-#45
        MOVW R0, #$7FFE
        CALL VREAD
        MOVW R1, #$1111
        CALL CHECK
        MOVQ R0, #0
        CALL VREAD
        MOVW R1, #$2222
        CALL CHECK
        ; VRAM, odd DMADST 1101: target 1101 & 7FFE = 1100; DMADST advances by 2 to 1103
        MOVW R0, #DATA+4
        MOVW R1, #$1101
        MOVQ R2, #1
        CALL SETDMA
        MOVQ R0, #1
        ST   R0, [DMACTL]
        ; #46
        LD   R0, [DMADST]
        MOVW R1, #$1103
        CALL CHECK
        ; #47
        MOVW R0, #$1100
        CALL VREAD
        MOVW R1, #$3333
        CALL CHECK
        ; CRAM: DMADST 01FF + 2 words: CRAM 1FF and 000, DMADST = 0201
        MOVW R0, #DATA
        MOVW R1, #$01FF
        MOVQ R2, #2
        CALL SETDMA
        MOVQ R0, #3
        ST   R0, [DMACTL]
        ; #48
        LD   R0, [DMADST]
        MOVW R1, #$0201
        CALL CHECK
        ; #49-#50 CRAM 1FF = 0111, 000 = 0222
        MOVW R0, #$01FF
        CALL CREAD
        MOVW R1, #$0111
        CALL CHECK
        MOVQ R0, #0
        CALL CREAD
        MOVW R1, #$0222
        CALL CHECK

        ; ---- DMACTL: a byte write to the high byte is ignored (§9.40) ----
        MOVQ R0, #$30               ; CRAM 30 = 0555 beforehand
        ST   R0, [CRAMADDR]
        MOVW R0, #$0555
        ST   R0, [CRAMDATA]
        MOVW R0, #DATA
        MOVQ R1, #$30
        MOVQ R2, #2
        CALL SETDMA
        CALL WAITVB
        ; #51 STB 03 to F0E7: no transfer, no stall: 6 + 6 = 12
        MOVQ R0, #3
        LD   R4, [TCOUNT]
        STB  R0, [DMACTL+1]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #12
        CALL CHECK
        ; #52 DMALEN still 2
        LD   R0, [DMALEN]
        MOVQ R1, #2
        CALL CHECK
        ; #53 CRAM 30 unchanged
        MOVQ R0, #$30
        CALL CREAD
        MOVW R1, #$0555
        CALL CHECK
        ; #54 STB 03 to F0E6 (low byte) starts it: 6 + 6 + 4 + 4 = 20
        MOVQ R0, #3
        LD   R4, [TCOUNT]
        STB  R0, [DMACTL]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #20
        CALL CHECK
        ; #55 CRAM 30 = 1111 & 0FFF
        MOVQ R0, #$30
        CALL CREAD
        MOVW R1, #$0111
        CALL CHECK
        ; #56 DMALEN = 0
        LD   R0, [DMALEN]
        MOVQ R1, #0
        CALL CHECK
        ; ---- DMACTL target is bits 1-0 only; target 0 moves nothing ----
        ; #57 DMACTL = 0005 selects VRAM (bits 1-0 = 1): VRAM 1200 = 1111
        MOVW R0, #DATA
        MOVW R1, #$1200
        MOVQ R2, #1
        CALL SETDMA
        MOVQ R0, #5
        ST   R0, [DMACTL]
        MOVW R0, #$1200
        CALL VREAD
        MOVW R1, #$1111
        CALL CHECK
        ; #58-#60 DMACTL = 0004 (target 0) with DMALEN 3: nothing moves, pointers unchanged
        MOVW R0, #DATA
        MOVW R1, #$1300
        MOVQ R2, #3
        CALL SETDMA
        MOVQ R0, #4
        ST   R0, [DMACTL]
        LD   R0, [DMALEN]
        MOVQ R1, #3
        CALL CHECK
        LD   R0, [DMASRC]
        MOVW R1, #DATA
        CALL CHECK
        LD   R0, [DMADST]
        MOVW R1, #$1300
        CALL CHECK
        ; #61 DMACTL reads 0 (write-only, §8.29)
        LD   R0, [DMACTL]
        MOVQ R1, #0
        CALL CHECK
        MOVQ R0, #0
        ST   R0, [TCTRL]
        ST   R0, [IE]
        JMP  PASS

        .bank 1
        .org $4000
        .word $F123, $FABC, $0FFF
