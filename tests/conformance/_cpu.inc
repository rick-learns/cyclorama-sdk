; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Helper routines shared by the CPU conformance ROMs 02-07.
; Include after _harness.inc (uses CHECK, FAIL and the R7 check-number convention).
; Calls, jumps and loads do not affect flags (spec-notes §1), so a helper can
; still see the flags left by the instruction before its CALL.

; CHECKF: the Z N C V flags at the call (I ignored) must equal R1.
; Uses one check number. Clobbers R0 and flags.
CHECKF: GETF R0
        ANDW R0, #$0F
        JMP  CHECK              ; CHECK's RTS returns to CHECKF's caller

; CHECKVF: R0 (value) must equal R1, then the Z N C V flags at the call must
; equal R2. Uses two check numbers. Clobbers R0, R1 and flags.
CHECKVF: PUSH R3
        GETF R3
        CALL CHECK
        MOV  R0, R3
        ANDW R0, #$0F
        MOV  R1, R2
        CALL CHECK
        POP  R3
        RTS

; TIMER1: timer free-running at one count per CPU cycle, TRELOAD = TCOUNT = FFFF,
; so TCOUNT differences are cycle counts modulo 65536 (0 -> FFFF is a normal step).
TIMER1: PUSH R0
        MOVW R0, #$FFFF
        ST   R0, [TRELOAD]
        ST   R0, [TCOUNT]
        MOVQ R0, #1
        ST   R0, [TCTRL]
        POP  R0
        RTS

; CYC: timing window check. The window is opened by LD R5,[TCOUNT] and closed
; by LD R6,[TCOUNT]; both reads happen at their instruction's start, so
; R5 - R6 = 6 (the opening LD [abs16]) + the cycles of the code between them.
; Compares that code's cycles with R1. One check number. Clobbers R0 and flags.
CYC:    MOV  R0, R5
        SUB  R0, R6
        ADDQ R0, #-6
        JMP  CHECK

; DELAY: busy wait. The pair "MOVW R2,#n / CALL DELAY" (n >= 1) takes exactly
; 6n + 16 cycles: MOVW 4, CALL 8, n x DEC 2, (n-1) x BNE taken 4, BNE not
; taken 2, RTS 6. Clobbers R2 and flags. (Verified by 06-cycles.)
DELAY:  DEC  R2
        BNE  DELAY
        RTS
