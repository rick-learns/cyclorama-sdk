; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Conformance 01: ALU results and Z N C V flags (spec-notes §1 flag conventions).
        .org $0000
        .word start, 0, 0, 0, 0
        .header title="CONFORMANCE 01 ALU", dev=$0001, date=$19870301, version=$0100
        .org $0040
        .include "_harness.inc"

; Z=1 N=2 C=4 V=8
start:  MOVQ R7, #1
        ; ADD overflow into sign: 7FFF + 1 = 8000, N V
        MOVW R0, #$7FFF
        ADDW R0, #1
        GETF R2
        MOVW R1, #$8000
        CALL CHECK
        MOV  R0, R2
        MOVQ R1, #2|8
        CALL CHECK
        ; ADD carry and zero: FFFF + 1 = 0, Z C
        MOVW R0, #$FFFF
        ADDW R0, #1
        GETF R0
        MOVQ R1, #1|4
        CALL CHECK
        ; 8000 + 8000 = 0, Z C V
        MOVW R0, #$8000
        MOVW R3, #$8000
        ADD  R0, R3
        GETF R0
        MOVQ R1, #1|4|8
        CALL CHECK
        ; ADC uses carry: set C via SETF, 1 + 1 + C = 3
        MOVQ R0, #4
        SETF R0
        MOVQ R0, #1
        MOVQ R3, #1
        ADC  R0, R3
        MOVQ R1, #3
        CALL CHECK
        ; SUB borrow: 1 - 2 = FFFF, N C (C = borrow)
        MOVQ R0, #1
        MOVQ R3, #2
        SUB  R0, R3
        GETF R2
        MOVW R1, #$FFFF
        CALL CHECK
        MOV  R0, R2
        MOVQ R1, #2|4
        CALL CHECK
        ; SUB signed overflow: 8000 - 1 = 7FFF, V
        MOVW R0, #$8000
        SUBW R0, #1
        GETF R0
        MOVQ R1, #8
        CALL CHECK
        ; SBC: 5 - 2 - C(1) = 2
        MOVQ R0, #4
        SETF R0
        MOVQ R0, #5
        MOVQ R3, #2
        SBC  R0, R3
        MOVQ R1, #2
        CALL CHECK
        ; CMP does not write Rd; 3 < 5 unsigned -> C, N
        MOVQ R0, #3
        CMPW R0, #5
        GETF R2
        MOVQ R1, #3
        CALL CHECK
        MOV  R0, R2
        MOVQ R1, #2|4
        CALL CHECK
        ; AND/OR/XOR/TST clear C and V
        MOVQ R0, #4|8
        SETF R0
        MOVW R0, #$F0F0
        ANDW R0, #$0FF0
        GETF R2
        MOVW R1, #$00F0
        CALL CHECK
        MOV  R0, R2
        MOVQ R1, #0
        CALL CHECK
        MOVW R0, #$F000
        ORW  R0, #$000F
        MOVW R1, #$F00F
        CALL CHECK
        MOVW R0, #$FFFF
        XORW R0, #$FFFF
        GETF R0
        MOVQ R1, #1
        CALL CHECK
        MOVW R0, #$1234
        TSTW R0, #$8000
        GETF R2
        MOVW R1, #$1234
        CALL CHECK
        MOV  R0, R2
        MOVQ R1, #1
        CALL CHECK
        ; NEG 0 = 0 (no borrow), NEG 8000 = 8000 with V
        MOVQ R0, #0
        NEG  R0
        GETF R0
        MOVQ R1, #1
        CALL CHECK
        MOVW R0, #$8000
        NEG  R0
        GETF R2
        MOVW R1, #$8000
        CALL CHECK
        MOV  R0, R2
        MOVQ R1, #2|4|8
        CALL CHECK
        ; NOT clears C V
        MOVQ R0, #4|8
        SETF R0
        MOVW R0, #$00FF
        NOT  R0
        GETF R2
        MOVW R1, #$FF00
        CALL CHECK
        MOV  R0, R2
        MOVQ R1, #2
        CALL CHECK
        ; INC FFFF -> 0 Z C ; DEC 0 -> FFFF N C
        MOVW R0, #$FFFF
        INC  R0
        GETF R0
        MOVQ R1, #1|4
        CALL CHECK
        MOVQ R0, #0
        DEC  R0
        GETF R0
        MOVQ R1, #2|4
        CALL CHECK
        ; SXB / ZXB / SWPB
        MOVW R0, #$1280
        SXB  R0
        MOVW R1, #$FF80
        CALL CHECK
        MOVW R0, #$12F0
        ZXB  R0
        MOVW R1, #$00F0
        CALL CHECK
        MOVW R0, #$1234
        SWPB R0
        MOVW R1, #$3412
        CALL CHECK
        ; MOV sets Z N, leaves C V
        MOVQ R0, #4|8
        SETF R0
        MOVQ R3, #0
        MOV  R0, R3
        GETF R0
        MOVQ R1, #1|4|8
        CALL CHECK
        ; MOVQ sign-extends
        MOVQ R0, #-2
        MOVW R1, #$FFFE
        CALL CHECK
        ; ADDQ negative
        MOVQ R0, #10
        ADDQ R0, #-3
        MOVQ R1, #7
        CALL CHECK
        ; MUL: 300 * 300 = 90000 = 15F90 -> 5F90 with C
        MOVW R0, #300
        MOVW R3, #300
        MUL  R0, R3
        GETF R2
        MOVW R1, #$5F90
        CALL CHECK
        MOV  R0, R2
        MOVQ R1, #4
        CALL CHECK
        ; FMUL 8.8: 1.5 * -2.0 = -3.0 (FD00); 0x7F00 * 0x0200 overflows (V)
        MOVW R0, #$0180
        MOVW R3, #$FE00
        FMUL R0, R3
        MOVW R1, #$FD00
        CALL CHECK
        MOVW R0, #$7F00
        MOVW R3, #$0200
        FMUL R0, R3
        GETF R0
        ANDW R0, #8
        MOVQ R1, #8
        CALL CHECK
        JMP  PASS
