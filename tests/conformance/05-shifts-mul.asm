; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Conformance 05: shifts, rotates, MUL, FMUL, GETF/SETF (spec-notes §1 flag
; conventions and group 0-2 semantics, §8.25, §10.57). Z=1 N=2 C=4 V=8.
; Pattern: expected value in R1 and expected flags in R2 are loaded first (MOV
; changes Z/N), then the operand, then the operation, then CALL CHECKVF.
        .org $0000
        .word start, 0, 0, 0, 0
        .header title="CONFORMANCE 05 SHIFT MUL", dev=$0001, date=$19870301, version=$0100
        .org $0040
        .include "_harness.inc"
        .include "_cpu.inc"

start:  MOVQ R7, #1

; ---- shifts by register: n = Rs & 15 ------------------------------------------
        MOVW R1, #$0002         ; SHL 8001 by 1: C = bit 15
        MOVQ R2, #4
        MOVW R0, #$8001
        MOVQ R4, #1
        SHL  R0, R4
        CALL CHECKVF            ; 1-2
        MOVW R1, #$8000         ; SHL 4000 by 1: N, V cleared although the sign changed
        MOVQ R2, #2
        MOVW R0, #$4000
        MOVQ R5, #8
        SETF R5
        SHL  R0, R4
        CALL CHECKVF            ; 3-4
        MOVW R1, #$FF00         ; SHL 00FF by 8: C = old bit 8 = 0
        MOVQ R2, #2
        MOVW R0, #$00FF
        MOVQ R4, #8
        SHL  R0, R4
        CALL CHECKVF            ; 5-6
        MOVW R1, #$8000         ; SHL 0180 by 8: C = old bit 8 = 1
        MOVQ R2, #2|4
        MOVW R0, #$0180
        SHL  R0, R4
        CALL CHECKVF            ; 7-8
        MOVW R1, #$8000         ; SHL 0001 by 15: C = old bit 1 = 0
        MOVQ R2, #2
        MOVQ R0, #1
        MOVQ R4, #15
        SHL  R0, R4
        CALL CHECKVF            ; 9-10
        MOVW R1, #$8000         ; SHL 0003 by 15: C = old bit 1 = 1
        MOVQ R2, #2|4
        MOVQ R0, #3
        SHL  R0, R4
        CALL CHECKVF            ; 11-12
        MOVW R1, #$8002         ; count 17 & 15 = 1
        MOVQ R2, #2
        MOVW R0, #$4001
        MOVQ R4, #17
        SHL  R0, R4
        CALL CHECKVF            ; 13-14
        MOVW R1, #$1234         ; count 16 & 15 = 0: unchanged, C kept, V cleared
        MOVQ R2, #4
        MOVW R0, #$1234
        MOVQ R4, #16
        MOVQ R5, #4|8
        SETF R5
        SHL  R0, R4
        CALL CHECKVF            ; 15-16
        MOVQ R1, #0             ; count 0 of 0000: Z from the value, C kept (0)
        MOVQ R2, #1
        MOVQ R0, #0
        MOVQ R5, #2
        SETF R5
        SHL  R0, R4
        CALL CHECKVF            ; 17-18
        MOVW R1, #$8000         ; count FFF0 & 15 = 0: N from the value, C kept (1)
        MOVQ R2, #2|4
        MOVW R0, #$8000
        MOVW R4, #$FFF0
        MOVQ R5, #4
        SETF R5
        SHL  R0, R4
        CALL CHECKVF            ; 19-20
        MOVW R1, #$4000         ; SHR 8001 by 1: C = bit 0
        MOVQ R2, #4
        MOVW R0, #$8001
        MOVQ R4, #1
        SHR  R0, R4
        CALL CHECKVF            ; 21-22
        MOVQ R1, #1             ; SHR 0180 by 8: C = old bit 7 = 1
        MOVQ R2, #4
        MOVW R0, #$0180
        MOVQ R4, #8
        SHR  R0, R4
        CALL CHECKVF            ; 23-24
        MOVQ R1, #1             ; SHR 8000 by 15: zero fill, C = old bit 14 = 0
        MOVQ R2, #0
        MOVW R0, #$8000
        MOVQ R4, #15
        SHR  R0, R4
        CALL CHECKVF            ; 25-26
        MOVQ R1, #0             ; SHR 0001 by 1: Z C
        MOVQ R2, #1|4
        MOVQ R0, #1
        MOVQ R4, #1
        SHR  R0, R4
        CALL CHECKVF            ; 27-28
        MOVW R1, #$C000         ; ASR 8001 by 1: sign fill, C = 1
        MOVQ R2, #2|4
        MOVW R0, #$8001
        ASR  R0, R4
        CALL CHECKVF            ; 29-30
        MOVW R1, #$FFFF         ; ASR 8000 by 15: C = old bit 14 = 0
        MOVQ R2, #2
        MOVW R0, #$8000
        MOVQ R4, #15
        ASR  R0, R4
        CALL CHECKVF            ; 31-32
        MOVW R1, #$FFFF         ; ASR C000 by 15: C = old bit 14 = 1
        MOVQ R2, #2|4
        MOVW R0, #$C000
        ASR  R0, R4
        CALL CHECKVF            ; 33-34
        MOVQ R1, #1             ; ASR 7FFF by 14: positive, C = old bit 13
        MOVQ R2, #4
        MOVW R0, #$7FFF
        MOVQ R4, #14
        ASR  R0, R4
        CALL CHECKVF            ; 35-36
        MOVW R1, #$9234         ; ASR count 32 & 15 = 0: unchanged, C kept (0), V cleared
        MOVQ R2, #2
        MOVW R0, #$9234
        MOVQ R4, #32
        MOVQ R5, #8
        SETF R5
        ASR  R0, R4
        CALL CHECKVF            ; 37-38
        MOVQ R1, #3             ; ROL 8001 by 1: C = bit 0 of the result
        MOVQ R2, #4
        MOVW R0, #$8001
        MOVQ R4, #1
        ROL  R0, R4
        CALL CHECKVF            ; 39-40
        MOVW R1, #$8000         ; ROL 4000 by 1
        MOVQ R2, #2
        MOVW R0, #$4000
        ROL  R0, R4
        CALL CHECKVF            ; 41-42
        MOVW R1, #$2341         ; ROL 1234 by 4
        MOVQ R2, #4
        MOVW R0, #$1234
        MOVQ R4, #4
        ROL  R0, R4
        CALL CHECKVF            ; 43-44
        MOVW R1, #$4123         ; ROL 1234 by 12
        MOVQ R2, #4
        MOVW R0, #$1234
        MOVQ R4, #12
        ROL  R0, R4
        CALL CHECKVF            ; 45-46
        MOVW R1, #$091A         ; ROL 1234 by 15 = rotate right by 1
        MOVQ R2, #0
        MOVW R0, #$1234
        MOVQ R4, #15
        ROL  R0, R4
        CALL CHECKVF            ; 47-48
        MOVQ R1, #0             ; ROL 0000 by 5: Z, C = 0
        MOVQ R2, #1
        MOVQ R0, #0
        MOVQ R4, #5
        MOVQ R5, #4
        SETF R5
        ROL  R0, R4
        CALL CHECKVF            ; 49-50
        MOVW R1, #$8001         ; ROL count 0: C kept (1)
        MOVQ R2, #2|4
        MOVW R0, #$8001
        MOVQ R4, #0
        MOVQ R5, #4
        SETF R5
        ROL  R0, R4
        CALL CHECKVF            ; 51-52
        MOVQ R4, #3             ; the count register is not modified
        MOVW R0, #$5555
        SHL  R0, R4
        MOV  R0, R4
        MOVQ R1, #3
        CALL CHECK              ; 53

; ---- group 0 immediate forms, n = imm4 + 1 = 1..16 -----------------------------
        ; SHL Rd,#n for n = 1..16 on $0001
        MOVW R0, #$0001
        SHL  R0, #1
        MOVW R1, #$0002
        CALL CHECK              ; 54 SHL 1
        MOVW R0, #$0001
        SHL  R0, #2
        MOVW R1, #$0004
        CALL CHECK              ; 55 SHL 2
        MOVW R0, #$0001
        SHL  R0, #3
        MOVW R1, #$0008
        CALL CHECK              ; 56 SHL 3
        MOVW R0, #$0001
        SHL  R0, #4
        MOVW R1, #$0010
        CALL CHECK              ; 57 SHL 4
        MOVW R0, #$0001
        SHL  R0, #5
        MOVW R1, #$0020
        CALL CHECK              ; 58 SHL 5
        MOVW R0, #$0001
        SHL  R0, #6
        MOVW R1, #$0040
        CALL CHECK              ; 59 SHL 6
        MOVW R0, #$0001
        SHL  R0, #7
        MOVW R1, #$0080
        CALL CHECK              ; 60 SHL 7
        MOVW R0, #$0001
        SHL  R0, #8
        MOVW R1, #$0100
        CALL CHECK              ; 61 SHL 8
        MOVW R0, #$0001
        SHL  R0, #9
        MOVW R1, #$0200
        CALL CHECK              ; 62 SHL 9
        MOVW R0, #$0001
        SHL  R0, #10
        MOVW R1, #$0400
        CALL CHECK              ; 63 SHL 10
        MOVW R0, #$0001
        SHL  R0, #11
        MOVW R1, #$0800
        CALL CHECK              ; 64 SHL 11
        MOVW R0, #$0001
        SHL  R0, #12
        MOVW R1, #$1000
        CALL CHECK              ; 65 SHL 12
        MOVW R0, #$0001
        SHL  R0, #13
        MOVW R1, #$2000
        CALL CHECK              ; 66 SHL 13
        MOVW R0, #$0001
        SHL  R0, #14
        MOVW R1, #$4000
        CALL CHECK              ; 67 SHL 14
        MOVW R0, #$0001
        SHL  R0, #15
        MOVW R1, #$8000
        CALL CHECK              ; 68 SHL 15
        MOVW R0, #$0001
        SHL  R0, #16
        MOVW R1, #$0000
        CALL CHECK              ; 69 SHL 16
        ; SHR Rd,#n for n = 1..16 on $8000
        MOVW R0, #$8000
        SHR  R0, #1
        MOVW R1, #$4000
        CALL CHECK              ; 70 SHR 1
        MOVW R0, #$8000
        SHR  R0, #2
        MOVW R1, #$2000
        CALL CHECK              ; 71 SHR 2
        MOVW R0, #$8000
        SHR  R0, #3
        MOVW R1, #$1000
        CALL CHECK              ; 72 SHR 3
        MOVW R0, #$8000
        SHR  R0, #4
        MOVW R1, #$0800
        CALL CHECK              ; 73 SHR 4
        MOVW R0, #$8000
        SHR  R0, #5
        MOVW R1, #$0400
        CALL CHECK              ; 74 SHR 5
        MOVW R0, #$8000
        SHR  R0, #6
        MOVW R1, #$0200
        CALL CHECK              ; 75 SHR 6
        MOVW R0, #$8000
        SHR  R0, #7
        MOVW R1, #$0100
        CALL CHECK              ; 76 SHR 7
        MOVW R0, #$8000
        SHR  R0, #8
        MOVW R1, #$0080
        CALL CHECK              ; 77 SHR 8
        MOVW R0, #$8000
        SHR  R0, #9
        MOVW R1, #$0040
        CALL CHECK              ; 78 SHR 9
        MOVW R0, #$8000
        SHR  R0, #10
        MOVW R1, #$0020
        CALL CHECK              ; 79 SHR 10
        MOVW R0, #$8000
        SHR  R0, #11
        MOVW R1, #$0010
        CALL CHECK              ; 80 SHR 11
        MOVW R0, #$8000
        SHR  R0, #12
        MOVW R1, #$0008
        CALL CHECK              ; 81 SHR 12
        MOVW R0, #$8000
        SHR  R0, #13
        MOVW R1, #$0004
        CALL CHECK              ; 82 SHR 13
        MOVW R0, #$8000
        SHR  R0, #14
        MOVW R1, #$0002
        CALL CHECK              ; 83 SHR 14
        MOVW R0, #$8000
        SHR  R0, #15
        MOVW R1, #$0001
        CALL CHECK              ; 84 SHR 15
        MOVW R0, #$8000
        SHR  R0, #16
        MOVW R1, #$0000
        CALL CHECK              ; 85 SHR 16
        ; ASR Rd,#n for n = 1..16 on $8000
        MOVW R0, #$8000
        ASR  R0, #1
        MOVW R1, #$C000
        CALL CHECK              ; 86 ASR 1
        MOVW R0, #$8000
        ASR  R0, #2
        MOVW R1, #$E000
        CALL CHECK              ; 87 ASR 2
        MOVW R0, #$8000
        ASR  R0, #3
        MOVW R1, #$F000
        CALL CHECK              ; 88 ASR 3
        MOVW R0, #$8000
        ASR  R0, #4
        MOVW R1, #$F800
        CALL CHECK              ; 89 ASR 4
        MOVW R0, #$8000
        ASR  R0, #5
        MOVW R1, #$FC00
        CALL CHECK              ; 90 ASR 5
        MOVW R0, #$8000
        ASR  R0, #6
        MOVW R1, #$FE00
        CALL CHECK              ; 91 ASR 6
        MOVW R0, #$8000
        ASR  R0, #7
        MOVW R1, #$FF00
        CALL CHECK              ; 92 ASR 7
        MOVW R0, #$8000
        ASR  R0, #8
        MOVW R1, #$FF80
        CALL CHECK              ; 93 ASR 8
        MOVW R0, #$8000
        ASR  R0, #9
        MOVW R1, #$FFC0
        CALL CHECK              ; 94 ASR 9
        MOVW R0, #$8000
        ASR  R0, #10
        MOVW R1, #$FFE0
        CALL CHECK              ; 95 ASR 10
        MOVW R0, #$8000
        ASR  R0, #11
        MOVW R1, #$FFF0
        CALL CHECK              ; 96 ASR 11
        MOVW R0, #$8000
        ASR  R0, #12
        MOVW R1, #$FFF8
        CALL CHECK              ; 97 ASR 12
        MOVW R0, #$8000
        ASR  R0, #13
        MOVW R1, #$FFFC
        CALL CHECK              ; 98 ASR 13
        MOVW R0, #$8000
        ASR  R0, #14
        MOVW R1, #$FFFE
        CALL CHECK              ; 99 ASR 14
        MOVW R0, #$8000
        ASR  R0, #15
        MOVW R1, #$FFFF
        CALL CHECK              ; 100 ASR 15
        MOVW R0, #$8000
        ASR  R0, #16
        MOVW R1, #$FFFF
        CALL CHECK              ; 101 ASR 16
        ; ROL Rd,#n for n = 1..16 on $0001
        MOVW R0, #$0001
        ROL  R0, #1
        MOVW R1, #$0002
        CALL CHECK              ; 102 ROL 1
        MOVW R0, #$0001
        ROL  R0, #2
        MOVW R1, #$0004
        CALL CHECK              ; 103 ROL 2
        MOVW R0, #$0001
        ROL  R0, #3
        MOVW R1, #$0008
        CALL CHECK              ; 104 ROL 3
        MOVW R0, #$0001
        ROL  R0, #4
        MOVW R1, #$0010
        CALL CHECK              ; 105 ROL 4
        MOVW R0, #$0001
        ROL  R0, #5
        MOVW R1, #$0020
        CALL CHECK              ; 106 ROL 5
        MOVW R0, #$0001
        ROL  R0, #6
        MOVW R1, #$0040
        CALL CHECK              ; 107 ROL 6
        MOVW R0, #$0001
        ROL  R0, #7
        MOVW R1, #$0080
        CALL CHECK              ; 108 ROL 7
        MOVW R0, #$0001
        ROL  R0, #8
        MOVW R1, #$0100
        CALL CHECK              ; 109 ROL 8
        MOVW R0, #$0001
        ROL  R0, #9
        MOVW R1, #$0200
        CALL CHECK              ; 110 ROL 9
        MOVW R0, #$0001
        ROL  R0, #10
        MOVW R1, #$0400
        CALL CHECK              ; 111 ROL 10
        MOVW R0, #$0001
        ROL  R0, #11
        MOVW R1, #$0800
        CALL CHECK              ; 112 ROL 11
        MOVW R0, #$0001
        ROL  R0, #12
        MOVW R1, #$1000
        CALL CHECK              ; 113 ROL 12
        MOVW R0, #$0001
        ROL  R0, #13
        MOVW R1, #$2000
        CALL CHECK              ; 114 ROL 13
        MOVW R0, #$0001
        ROL  R0, #14
        MOVW R1, #$4000
        CALL CHECK              ; 115 ROL 14
        MOVW R0, #$0001
        ROL  R0, #15
        MOVW R1, #$8000
        CALL CHECK              ; 116 ROL 15
        MOVW R0, #$0001
        ROL  R0, #16
        MOVW R1, #$0001
        CALL CHECK              ; 117 ROL 16
        ; flags at n = 16
        MOVQ R1, #0             ; SHL 0001 by 16: 0, Z, C = old bit 0
        MOVQ R2, #1|4
        MOVQ R0, #1
        SHL  R0, #16
        CALL CHECKVF            ; 118-119
        MOVQ R1, #0             ; SHR 8000 by 16: 0, Z, C = old bit 15
        MOVQ R2, #1|4
        MOVW R0, #$8000
        SHR  R0, #16
        CALL CHECKVF            ; 120-121
        MOVW R1, #$FFFF         ; ASR 8000 by 16: FFFF, N, C = old bit 15
        MOVQ R2, #2|4
        MOVW R0, #$8000
        ASR  R0, #16
        CALL CHECKVF            ; 122-123
        MOVQ R1, #0             ; ASR 4000 by 16: 0, Z, C = 0
        MOVQ R2, #1
        MOVW R0, #$4000
        ASR  R0, #16
        CALL CHECKVF            ; 124-125
        MOVW R1, #$8001         ; ROL 8001 by 16: unchanged, C = bit 0 = 1, N
        MOVQ R2, #2|4
        MOVW R0, #$8001
        ROL  R0, #16
        CALL CHECKVF            ; 126-127
        MOVW R1, #$1234         ; ROL 1234 by 16: unchanged, C = 0, V cleared
        MOVQ R2, #0
        MOVW R0, #$1234
        MOVQ R5, #4|8
        SETF R5
        ROL  R0, #16
        CALL CHECKVF            ; 128-129
        MOVW R1, #$0006         ; SHR 000D by 1: C = 1
        MOVQ R2, #4
        MOVQ R0, #13
        SHR  R0, #1
        CALL CHECKVF            ; 130-131
        LD   R0, [shl16_i]      ; encoding: op 15 (SHLI), d = 3, imm4 = 15
        MOVW R1, #$07BF
        CALL CHECK              ; 132
        LD   R0, [rol1_i]       ; op 18 (ROLI), d = 2, imm4 = 0
        MOVW R1, #$0920
        CALL CHECK              ; 133

; ---- group 2 immediate forms: n = imm16 & 15 ----------------------------------
        MOVQ R1, #1             ; SHLW #0: count 0, C kept, V cleared
        MOVQ R2, #4
        MOVQ R0, #1
        MOVQ R5, #4|8
        SETF R5
        SHLW R0, #0
        CALL CHECKVF            ; 134-135
        MOVW R1, #$8000         ; SHLW #15
        MOVQ R2, #2
        MOVQ R0, #1
        SHLW R0, #15
        CALL CHECKVF            ; 136-137
        MOVQ R1, #1             ; SHRW #15: C = old bit 14 = 0
        MOVQ R2, #0
        MOVW R0, #$8000
        SHRW R0, #15
        CALL CHECKVF            ; 138-139
        MOVW R1, #$F800         ; ASRW #4: C = old bit 3 = 0
        MOVQ R2, #2
        MOVW R0, #$8000
        ASRW R0, #4
        CALL CHECKVF            ; 140-141
        MOVW R1, #$FFF8         ; ASRW #1 of FFF1: C = 1
        MOVQ R2, #2|4
        MOVW R0, #$FFF1
        ASRW R0, #1
        CALL CHECKVF            ; 142-143
        MOVW R1, #$4218         ; ROLW 8421 by 4
        MOVQ R2, #0
        MOVW R0, #$8421
        ROLW R0, #4
        CALL CHECKVF            ; 144-145
        MOVW R1, #$3412         ; ROLW 1234 by 8
        MOVQ R2, #0
        MOVW R0, #$1234
        ROLW R0, #8
        CALL CHECKVF            ; 146-147
        ; immediates above 15 (hand-encoded: CYASM rejects them, the CPU uses imm & 15)
        MOVW R1, #$8002         ; SHL R0,#17 -> count 1
        MOVQ R2, #2
        MOVW R0, #$4001
        .word $2A00, 17
        CALL CHECKVF            ; 148-149
        MOVQ R1, #1             ; SHR R0,#FFFF -> count 15: C = old bit 14 = 1
        MOVQ R2, #4
        MOVW R0, #$FFFF
        .word $2B00, $FFFF
        CALL CHECKVF            ; 150-151
        MOVW R1, #$FFFF         ; ASR R0,#FFF4 -> count 4: FFF4 >> 4, C = old bit 3 = 0
        MOVQ R2, #2
        MOVW R0, #$FFF4
        .word $2C00, $FFF4
        CALL CHECKVF            ; 152-153
        MOVW R1, #$0010         ; ROL R0,#0010 -> count 0: unchanged, C kept
        MOVQ R2, #4
        MOVQ R0, #$10
        MOVQ R5, #4
        SETF R5
        .word $2D00, $0010
        CALL CHECKVF            ; 154-155

; ---- MUL: low 16 bits of the unsigned product; C = product > FFFF; V = 0 --------
        MOVQ R1, #1             ; FFFF x FFFF = FFFE0001
        MOVQ R2, #4
        MOVW R0, #$FFFF
        MOVW R3, #$FFFF
        MUL  R0, R3
        CALL CHECKVF            ; 156-157
        MOVQ R1, #0             ; 0100 x 0100 = 10000: Z C
        MOVQ R2, #1|4
        MOVW R0, #$0100
        MOVW R3, #$0100
        MUL  R0, R3
        CALL CHECKVF            ; 158-159
        MOVW R1, #$FFFF         ; 00FF x 0101 = FFFF exactly: no carry
        MOVQ R2, #2
        MOVW R0, #$00FF
        MOVW R3, #$0101
        MUL  R0, R3
        CALL CHECKVF            ; 160-161
        MOVQ R1, #0             ; 0 x 1234: Z, C and V cleared
        MOVQ R2, #1
        MOVQ R0, #0
        MOVW R3, #$1234
        MOVQ R5, #4|8
        SETF R5
        MUL  R0, R3
        CALL CHECKVF            ; 162-163
        MOVQ R1, #0             ; 8000 x 2 (unsigned: 10000)
        MOVQ R2, #1|4
        MOVW R0, #$8000
        MOVQ R3, #2
        MUL  R0, R3
        CALL CHECKVF            ; 164-165
        MOVW R1, #$FFFE         ; 7FFF x 2 = FFFE: no V even though the sign changed
        MOVQ R2, #2
        MOVW R0, #$7FFF
        MOVQ R3, #2
        MOVQ R5, #8
        SETF R5
        MUL  R0, R3
        CALL CHECKVF            ; 166-167
        MOVW R1, #$0201         ; 0101 x 0101 = 10201
        MOVQ R2, #4
        MOVW R0, #$0101
        MOV  R3, R0
        MUL  R0, R3
        CALL CHECKVF            ; 168-169
        MOVW R1, #$FFFF         ; FFFF x 1 = FFFF: no carry
        MOVQ R2, #2
        MOVW R0, #$FFFF
        MOVQ R3, #1
        MUL  R0, R3
        CALL CHECKVF            ; 170-171
        MOVW R1, #$FFFF         ; MULW: 3 x 5555 = FFFF
        MOVQ R2, #2
        MOVQ R0, #3
        MULW R0, #$5555
        CALL CHECKVF            ; 172-173
        MOVQ R1, #0             ; MULW: 1000 x 0010 = 10000
        MOVQ R2, #1|4
        MOVW R0, #$1000
        MULW R0, #$0010
        CALL CHECKVF            ; 174-175
        MOVW R0, #$0100         ; MUL Rd,Rd squares
        MUL  R0, R0
        MOVQ R1, #0
        CALL CHECK              ; 176

; ---- FMUL: signed 8.8, (a x b) >> 8 arithmetic, truncated; V = overflow; C = 0 ---
        MOVW R1, #$0300         ; -1.5 x -2.0 = 3.0
        MOVQ R2, #0
        MOVW R0, #$FE80
        MOVW R3, #$FE00
        FMUL R0, R3
        CALL CHECKVF            ; 177-178
        MOVW R1, #$0600         ; 2.0 x 3.0 = 6.0
        MOVQ R2, #0
        MOVW R0, #$0200
        MOVW R3, #$0300
        FMUL R0, R3
        CALL CHECKVF            ; 179-180
        MOVW R1, #$FD00         ; 1.5 x -2.0 = -3.0
        MOVQ R2, #2
        MOVW R0, #$0180
        MOVW R3, #$FE00
        FMUL R0, R3
        CALL CHECKVF            ; 181-182
        MOVW R1, #$0040         ; 0.5 x 0.5 = 0.25
        MOVQ R2, #0
        MOVW R0, #$0080
        MOV  R3, R0
        FMUL R0, R3
        CALL CHECKVF            ; 183-184
        MOVW R1, #$00FE         ; 00FF x 00FF = FE01 >> 8 = FE (truncated)
        MOVQ R2, #0
        MOVW R0, #$00FF
        MOV  R3, R0
        FMUL R0, R3
        CALL CHECKVF            ; 185-186
        MOVW R1, #$FFFF         ; 0001 x FFFF = -1 >> 8 = -1 (arithmetic: floor)
        MOVQ R2, #2
        MOVQ R0, #1
        MOVW R3, #$FFFF
        FMUL R0, R3
        CALL CHECKVF            ; 187-188
        MOVQ R1, #0             ; 0001 x 0001 = 1 >> 8 = 0: Z
        MOVQ R2, #1
        MOVQ R0, #1
        MOVQ R3, #1
        FMUL R0, R3
        CALL CHECKVF            ; 189-190
        MOVW R1, #$FF01         ; FF01 x 00FF = -65025 >> 8 = -255 (floor, not -254)
        MOVQ R2, #2
        MOVW R0, #$FF01
        MOVW R3, #$00FF
        FMUL R0, R3
        CALL CHECKVF            ; 191-192
        MOVW R1, #$FE00         ; 127.0 x 2.0 = 254.0: V, truncated to FE00 (N)
        MOVQ R2, #2|8
        MOVW R0, #$7F00
        MOVW R3, #$0200
        FMUL R0, R3
        CALL CHECKVF            ; 193-194
        MOVQ R1, #0             ; -128.0 x -128.0 = 16384.0: V, low 16 bits 0 (Z)
        MOVQ R2, #1|8
        MOVW R0, #$8000
        MOV  R3, R0
        FMUL R0, R3
        CALL CHECKVF            ; 195-196
        MOVW R1, #$8000         ; -128.0 x 1.0 = -128.0 = -32768: fits, no V
        MOVQ R2, #2
        MOVW R0, #$8000
        MOVW R3, #$0100
        FMUL R0, R3
        CALL CHECKVF            ; 197-198
        MOVW R1, #$8000         ; -128.0 x -1.0 = +128.0 = 32768: V
        MOVQ R2, #2|8
        MOVW R0, #$8000
        MOVW R3, #$FF00
        FMUL R0, R3
        CALL CHECKVF            ; 199-200
        MOVW R1, #$0100         ; 1.0 x 1.0: C and V cleared
        MOVQ R2, #0
        MOVW R0, #$0100
        MOV  R3, R0
        MOVQ R5, #4|8
        SETF R5
        FMUL R0, R3
        CALL CHECKVF            ; 201-202
        MOVW R1, #$F600         ; FMULW: 2.5 x -4.0 = -10.0
        MOVQ R2, #2
        MOVW R0, #$0280
        FMULW R0, #$FC00
        CALL CHECKVF            ; 203-204
        MOVW R1, #$7FFF         ; largest positive result without V: 7FFF.FF x 1.0
        MOVQ R2, #0
        MOVW R0, #$7FFF
        FMULW R0, #$0100
        CALL CHECKVF            ; 205-206

; ---- GETF / SETF ------------------------------------------------------------------
        MOVW R0, #$FFFF         ; SETF loads bits 4-0 only; bits 15-5 read 0
        SETF R0
        GETF R0
        DI                      ; (I was set; IE = 0 so nothing can be taken)
        MOVQ R1, #$1F
        CALL CHECK              ; 207
        MOVW R0, #$FFE0
        SETF R0
        GETF R0
        MOVQ R1, #0
        CALL CHECK              ; 208
        MOVQ R0, #$15           ; Z C I
        SETF R0
        GETF R3
        DI
        MOV  R0, R3
        MOVQ R1, #$15
        CALL CHECK              ; 209
        MOVQ R1, #$0A           ; GETF does not affect flags; SETF leaves its register
        MOVQ R4, #$0A
        SETF R4
        GETF R0
        GETF R0
        CALL CHECKF             ; 210
        MOV  R0, R4
        MOVQ R1, #$0A
        CALL CHECK              ; 211
        MOVQ R1, #0             ; GETF of F = 0 does not set Z
        MOVQ R0, #0
        SETF R0
        GETF R3
        CALL CHECKF             ; 212

        JMP  PASS

shl16_i: SHL R3, #16
rol1_i:  ROL R2, #1
