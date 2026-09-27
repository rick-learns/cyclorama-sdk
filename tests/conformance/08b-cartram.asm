; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Conformance 08b: cartridge RAM (header ram=1): C000-DFFF, RAMCTL write-enable gating
; (spec-notes §2 memory map; manual ch. 4 "Cartridge RAM"; registers.ts RAMCTL).
; The initial contents of cartridge RAM are not assumed (battery-backed, undefined when new).
        .org $0000
        .word start, 0, 0, 0, 0
        .header title="CONFORMANCE 08B CARTRAM", dev=$0001, date=$19870301, version=$0100, ram=1
        .org $0040
        .include "_harness.inc"

start:  MOVQ R7, #1
        ; #1 RAMCTL resets to 0 (write-protected)
        LD   R0, [RAMCTL]
        MOVQ R1, #0
        CALL CHECK
        ; #2 RAMCTL keeps bit 0 only: write FFFF -> reads 0001
        MOVW R0, #$FFFF
        ST   R0, [RAMCTL]
        LD   R0, [RAMCTL]
        MOVQ R1, #1
        CALL CHECK
        ; #3 with writes enabled, a word written to C000 reads back
        MOVW R0, #$A55A
        ST   R0, [$C000]
        LD   R0, [$C000]
        MOVW R1, #$A55A
        CALL CHECK
        ; #4 last word DFFE
        MOVW R0, #$1357
        ST   R0, [$DFFE]
        LD   R0, [$DFFE]
        MOVW R1, #$1357
        CALL CHECK
        ; #5 byte store to the odd byte C001 changes one byte: A55A -> 7E5A
        MOVQ R0, #$7E
        STB  R0, [$C001]
        LD   R0, [$C000]
        MOVW R1, #$7E5A
        CALL CHECK
        ; #6 byte load zero-extends: LDB [DFFF] = 13
        LDB  R0, [$DFFF]
        MOVQ R1, #$13
        CALL CHECK
        ; #7 a block of 16 words through post-increment addressing, then verified
        MOVQ R0, #0                     ; (work RAM 9000 = 0, used by check 8)
        ST   R0, [$9000]
        MOVW R2, #$D000
        MOVW R0, #$0100
.fill:  ST   R0, [R2]+
        ADDW R0, #$0101
        CMPW R2, #$D020
        BNE  .fill
        MOVW R2, #$D000
        MOVW R3, #$0100
        MOVQ R4, #0
.ver:   LD   R0, [R2]+
        CMP  R0, R3
        BEQ  .ok
        ADDQ R4, #1                     ; count mismatches
.ok:    ADDW R3, #$0101
        CMPW R2, #$D020
        BNE  .ver
        MOV  R0, R4
        MOVQ R1, #0
        CALL CHECK
        ; #8 cartridge RAM does not alias work RAM: 9000 (same offset as D000) is still 0
        LD   R0, [$9000]
        MOVQ R1, #0
        CALL CHECK
        ; ---- write protection ----
        ; #9 RAMCTL = 0 reads 0
        MOVQ R0, #0
        ST   R0, [RAMCTL]
        LD   R0, [RAMCTL]
        MOVQ R1, #0
        CALL CHECK
        ; #10 word write ignored while protected; reads still work
        MOVW R0, #$FFFF
        ST   R0, [$C000]
        LD   R0, [$C000]
        MOVW R1, #$7E5A
        CALL CHECK
        ; #11 byte write ignored while protected
        MOVQ R0, #0
        STB  R0, [$DFFF]
        LD   R0, [$DFFE]
        MOVW R1, #$1357
        CALL CHECK
        ; #12 RAMCTL = 2 (bit 0 clear) also protects, and reads 0 (bit 1 undefined)
        MOVQ R0, #2
        ST   R0, [RAMCTL]
        LD   R0, [RAMCTL]
        MOVQ R1, #0
        CALL CHECK
        MOVW R0, #$4444
        ST   R0, [$C000]
        ; #13
        LD   R0, [$C000]
        MOVW R1, #$7E5A
        CALL CHECK
        ; #14 a byte write of 01 to RAMCTL's low half enables writes again
        MOVQ R0, #1
        STB  R0, [$E002]
        LD   R0, [RAMCTL]
        MOVQ R1, #1
        CALL CHECK
        ; #15 and the next write is stored
        MOVW R0, #$2468
        ST   R0, [$C000]
        LD   R0, [$C000]
        MOVW R1, #$2468
        CALL CHECK
        ; #16 a byte write of 00 to RAMCTL's high half changes nothing: still enabled
        MOVQ R0, #0
        STB  R0, [$E003]
        LD   R0, [RAMCTL]
        MOVQ R1, #1
        CALL CHECK
        ; #17 the block written in #7 survived the protected period
        MOVW R2, #$D000
        MOVW R3, #$0100
        MOVQ R4, #0
.ver2:  LD   R0, [R2]+
        CMP  R0, R3
        BEQ  .ok2
        ADDQ R4, #1
.ok2:   ADDW R3, #$0101
        CMPW R2, #$D020
        BNE  .ver2
        MOV  R0, R4
        MOVQ R1, #0
        CALL CHECK
        MOVQ R0, #0
        ST   R0, [RAMCTL]
        JMP  PASS
