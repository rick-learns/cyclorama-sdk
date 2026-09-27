; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Conformance 04: the stack (spec-notes §1: PUSH/POP, PUSHM/POPM order,
; ADDSP, MOVFS/MOVTS with bit 0 forced to 0, CALL/RTS frames, reset SP = C000,
; 16-bit wrap; manual chapter 3 "Stack overflow or underflow").
        .org $0000
        .word start, 0, 0, 0, 0
        .header title="CONFORMANCE 04 STACK", dev=$0001, date=$19870301, version=$0100
        .org $0040
        .include "_harness.inc"
        .include "_cpu.inc"

STK = $9000                     ; test stack top

start:  MOV  R0, SP             ; before anything touches SP: reset value
        MOVQ R7, #1
        MOVW R1, #$C000
        CALL CHECK              ; 1
        LD   R0, [$BFFE]        ; the CALL above pushed its return address at BFFE
        MOVW R1, #start+12      ; MOV 2 + MOVQ 2 + MOVW 4 + CALL 4: the word after the CALL
        CALL CHECK              ; 2

        MOVW R4, #STK
        MOV  SP, R4

; ---- PUSH / POP ----------------------------------------------------------------
        MOVW R2, #$1234
        PUSH R2                 ; SP = 8FFE, [8FFE] = 1234
        MOV  R0, SP
        MOVW R1, #STK-2
        CALL CHECK              ; 3
        LD   R0, [STK-2]
        MOVW R1, #$1234
        CALL CHECK              ; 4
        MOVW R2, #$5678
        PUSH R2                 ; SP = 8FFC
        POP  R3                 ; last in, first out
        MOV  R0, R3
        MOVW R1, #$5678
        CALL CHECK              ; 5
        POP  R3
        MOV  R0, R3
        MOVW R1, #$1234
        CALL CHECK              ; 6
        MOV  R0, SP
        MOVW R1, #STK
        CALL CHECK              ; 7
        ; PUSH / POP do not affect flags (POP of 0 must not set Z)
        MOVQ R2, #0
        PUSH R2
        MOVQ R1, #2|4|8
        MOVQ R0, #2|4|8
        SETF R0
        PUSH R0
        POP  R0
        POP  R2
        CALL CHECKF             ; 8

; ---- PUSHM / POPM order and layout -------------------------------------------
        MOVW R0, #$A000
        MOVW R1, #$A001
        MOVW R2, #$A002
        MOVW R3, #$A003
        MOVW R4, #$A004
        MOVW R5, #$A005
        MOVW R6, #$A006
        PUSHM R0, R2, R5        ; R5 first (highest address), R0 last (lowest)
        MOV  R6, SP
        MOV  R0, R6
        MOVW R1, #STK-6
        CALL CHECK              ; 9
        LD   R0, [STK-6]
        MOVW R1, #$A000
        CALL CHECK              ; 10
        LD   R0, [STK-4]
        MOVW R1, #$A002
        CALL CHECK              ; 11
        LD   R0, [STK-2]
        MOVW R1, #$A005
        CALL CHECK              ; 12
        ; POPM pops R0 upward: a different mask takes the words in order
        POPM R1, R3-R4          ; R1 <- A000, R3 <- A002, R4 <- A005
        MOV  R0, R1
        MOVW R1, #$A000
        CALL CHECK              ; 13
        MOV  R0, R3
        MOVW R1, #$A002
        CALL CHECK              ; 14
        MOV  R0, R4
        MOVW R1, #$A005
        CALL CHECK              ; 15
        MOV  R0, SP
        MOVW R1, #STK
        CALL CHECK              ; 16
        ; all eight registers
        ST   R7, [$8100]        ; the check number, kept safe in RAM
        MOVW R0, #$B000
        MOVW R1, #$B001
        MOVW R2, #$B002
        MOVW R3, #$B003
        MOVW R4, #$B004
        MOVW R5, #$B005
        MOVW R6, #$B006
        MOVW R7, #$B007
        PUSHM R0-R7
        MOV  R6, SP
        LD   R7, [$8100]
        MOV  R0, R6
        MOVW R1, #STK-16
        CALL CHECK              ; 17
        LD   R0, [STK-16]       ; R0 lowest
        MOVW R1, #$B000
        CALL CHECK              ; 18
        LD   R0, [STK-6]        ; R5
        MOVW R1, #$B005
        CALL CHECK              ; 19
        LD   R0, [STK-2]        ; R7 highest
        MOVW R1, #$B007
        CALL CHECK              ; 20
        ; POPM R0-R7 into cleared registers, then verify
        ST   R7, [$8100]
        MOVQ R0, #0
        MOVQ R1, #0
        MOVQ R2, #0
        MOVQ R3, #0
        MOVQ R4, #0
        MOVQ R5, #0
        MOVQ R6, #0
        POPM R0-R7
        ST   R6, [$8102]
        ST   R7, [$8104]
        LD   R7, [$8100]
        MOVW R6, #$B000         ; each popped register must be B000 + n
        CMP  R0, R6
        BNE  .bad
        INC  R6
        CMP  R1, R6
        BNE  .bad
        INC  R6
        CMP  R2, R6
        BNE  .bad
        INC  R6
        CMP  R3, R6
        BNE  .bad
        INC  R6
        CMP  R4, R6
        BNE  .bad
        INC  R6
        CMP  R5, R6
        BNE  .bad
        LD   R0, [$8102]
        MOVW R1, #$B006
        CALL CHECK              ; 21
        LD   R0, [$8104]
        MOVW R1, #$B007
        CALL CHECK              ; 22
        MOV  R0, SP
        MOVW R1, #STK
        CALL CHECK              ; 23
        BRA  .ok
.bad:   JMP  FAIL
.ok:
        ; single-register masks
        MOVW R5, #$C005
        PUSHM R5
        MOV  R0, SP
        MOVW R1, #STK-2
        CALL CHECK              ; 24
        POPM R2
        MOV  R0, R2
        MOVW R1, #$C005
        CALL CHECK              ; 25
        ; PUSHM / POPM do not affect flags
        MOVQ R1, #1|8
        MOVQ R0, #1|8
        SETF R0
        PUSHM R0-R3
        POPM R0-R3
        CALL CHECKF             ; 26

; ---- ADD SP,#n (ADDSP) -------------------------------------------------------
        ADD  SP, #-4
        MOV  R0, SP
        MOVW R1, #STK-4
        CALL CHECK              ; 27
        ADD  SP, #4
        ADD  SP, #-256          ; most negative
        MOV  R0, SP
        MOVW R1, #STK-256
        CALL CHECK              ; 28
        ADD  SP, #254           ; most positive
        MOV  R0, SP
        MOVW R1, #STK-2
        CALL CHECK              ; 29
        ADD  SP, #2
        MOVQ R1, #2|4           ; ADDSP does not affect flags
        MOVQ R0, #2|4
        SETF R0
        ADD  SP, #0
        ADD  SP, #-2
        ADD  SP, #2
        CALL CHECKF             ; 30
        LD   R0, [addsp_i]      ; encoding B4 with s8 = -128
        MOVW R1, #$B480
        CALL CHECK              ; 31

; ---- MOV Rd,SP / MOV SP,Rd -----------------------------------------------------
        MOVW R2, #$9001         ; bit 0 forced to 0
        MOV  SP, R2
        MOV  R0, SP
        MOVW R1, #$9000
        CALL CHECK              ; 32
        MOVW R2, #$A0FF
        MOV  SP, R2
        MOV  R0, SP
        MOVW R1, #$A0FE
        CALL CHECK              ; 33
        PUSH R2                 ; the push goes to A0FC
        LD   R0, [$A0FC]
        MOVW R1, #$A0FF
        CALL CHECK              ; 34
        POP  R2
        MOVQ R1, #1|2|4|8       ; MOVFS / MOVTS do not affect flags
        MOVQ R0, #1|2|4|8
        SETF R0
        MOV  R3, SP
        MOV  SP, R3
        CALL CHECKF             ; 35
        MOVW R4, #STK
        MOV  SP, R4

; ---- 16-bit wrap -------------------------------------------------------------
        MOV  R6, SP
        MOVQ R2, #0
        MOV  SP, R2
        ADD  SP, #-2            ; 0000 - 2 = FFFE
        MOV  R3, SP
        MOV  SP, R2
        POP  R4                 ; reads 0000 (the RESET vector), SP = 0002
        MOV  R5, SP
        MOVW R2, #$FFFE
        MOV  SP, R2
        POP  R2                 ; reads FFFE (unmapped, 0), SP wraps to 0000
        MOV  R2, SP
        MOV  SP, R6
        MOV  R0, R3
        MOVW R1, #$FFFE
        CALL CHECK              ; 36
        MOV  R0, R4
        MOVW R1, #start
        CALL CHECK              ; 37
        MOV  R0, R5
        MOVQ R1, #2
        CALL CHECK              ; 38
        MOV  R0, R2
        MOVQ R1, #0
        CALL CHECK              ; 39

; ---- CALL / RTS frames, nesting ------------------------------------------------
        MOV  R4, SP
        CALL sub1
ret1:   MOV  R0, SP             ; balanced
        MOV  R1, R4
        CALL CHECK              ; 44 (sub1/sub2 make 40-43)
        ; [SP+d] inside a callee reads the caller's pushed arguments
        MOVW R2, #$ABBA
        PUSH R2
        CALL sub3
        ADD  SP, #2
        MOVW R1, #$ABBA
        CALL CHECK              ; 45
        ; recursion: SUM(n) = n + SUM(n-1), 12 levels deep
        MOVQ R2, #12
        CALL SUM
        MOVQ R1, #78
        CALL CHECK              ; 46
        MOV  R0, SP
        MOV  R1, R4
        CALL CHECK              ; 47
        ; CALL / RTS do not affect flags
        MOVQ R1, #2|8
        MOVQ R0, #2|8
        SETF R0
        CALL nop_sub
        CALL CHECKF             ; 48

        JMP  PASS

addsp_i: ADD SP, #-256

sub1:   LD   R0, [SP]
        MOVW R1, #ret1
        CALL CHECK              ; 40
        MOV  R0, SP
        MOV  R1, R4
        ADDQ R1, #-2
        CALL CHECK              ; 41
        CALL sub2
ret2:   RTS
sub2:   LD   R0, [SP]           ; innermost return address
        MOVW R1, #ret2
        CALL CHECK              ; 42
        LD   R0, [SP+2]         ; outer return address below it
        MOVW R1, #ret1
        CALL CHECK              ; 43
        RTS
sub3:   LD   R0, [SP+2]         ; the argument pushed before the CALL
        RTS
SUM:    TST  R2, R2
        BNE  .rec
        MOVQ R0, #0
        RTS
.rec:   PUSH R2
        DEC  R2
        CALL SUM
        POP  R2
        ADD  R0, R2
        RTS
nop_sub: RTS
