; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Conformance 03: branches, jumps and calls (spec-notes §1 group A and B,
; §8.27, §10.61). All 16 conditions are evaluated against all 16 Z N C V
; combinations set with SETF; displacement extremes; BSR/RTS; JMP abs;
; JMPR/CALLR; JMPT; PC bit 0 cleared on every PC load.
        .org $0000
        .word start, 0, 0, 0, 0
        .header title="CONFORMANCE 03 BRANCHES", dev=$0001, date=$19870301, version=$0100
        .org $0040
        .include "_harness.inc"
        .include "_cpu.inc"

; Condition stubs: entered by CALL [R6] with the flags under test; return R0 = 1
; if the branch was taken, 0 if it fell through. Neither CALL nor the branch
; changes the flags.
TAKEN:  MOVQ R0, #1
        RTS
NOTT:   MOVQ R0, #0
        RTS
t_ra:   BRA  TAKEN
        BRA  NOTT
t_eq:   BEQ  TAKEN
        BRA  NOTT
t_ne:   BNE  TAKEN
        BRA  NOTT
t_lo:   BLO  TAKEN
        BRA  NOTT
t_hs:   BHS  TAKEN
        BRA  NOTT
t_mi:   BMI  TAKEN
        BRA  NOTT
t_pl:   BPL  TAKEN
        BRA  NOTT
t_vs:   BVS  TAKEN
        BRA  NOTT
t_vc:   BVC  TAKEN
        BRA  NOTT
t_hi:   BHI  TAKEN
        BRA  NOTT
t_ls:   BLS  TAKEN
        BRA  NOTT
t_lt:   BLT  TAKEN
        BRA  NOTT
t_ge:   BGE  TAKEN
        BRA  NOTT
t_gt:   BGT  TAKEN
        BRA  NOTT
t_le:   BLE  TAKEN
        BRA  NOTT
t_cs:   BCS  TAKEN
        BRA  NOTT
t_cc:   BCC  TAKEN
        BRA  NOTT

; EVAL: R6 = stub. Returns R0 = mask with bit f set when the stub's branch is
; taken with F = f (f = 0..15: Z=1 N=2 C=4 V=8). Then the same with I = 1
; (IE = 0, so no interrupt can be taken): the mask must not change, else FAIL.
EVAL:   MOVQ R5, #0
        MOVQ R4, #15
.loop:  SETF R4
        CALL [R6]
        SHL  R0, R4
        OR   R5, R0
        DEC  R4
        BPL  .loop
        MOVQ R3, #0             ; again with I = 1
        MOVQ R4, #15
.loopi: MOV  R0, R4
        ORW  R0, #$10
        SETF R0
        CALL [R6]
        DI
        SHL  R0, R4
        OR   R3, R0
        DEC  R4
        BPL  .loopi
        CMP  R3, R5
        BNE  .bad
        MOV  R0, R5
        RTS
.bad:   JMP  FAIL

start:  MOVQ R7, #1

; ---- every condition against every flag combination ---------------------------
        MOVW R6, #t_ra
        CALL EVAL
        MOVW R1, #$FFFF
        CALL CHECK              ; 1 RA
        MOVW R6, #t_eq
        CALL EVAL
        MOVW R1, #$AAAA
        CALL CHECK              ; 2 EQ: Z
        MOVW R6, #t_ne
        CALL EVAL
        MOVW R1, #$5555
        CALL CHECK              ; 3 NE: !Z
        MOVW R6, #t_lo
        CALL EVAL
        MOVW R1, #$F0F0
        CALL CHECK              ; 4 LO: C
        MOVW R6, #t_hs
        CALL EVAL
        MOVW R1, #$0F0F
        CALL CHECK              ; 5 HS: !C
        MOVW R6, #t_mi
        CALL EVAL
        MOVW R1, #$CCCC
        CALL CHECK              ; 6 MI: N
        MOVW R6, #t_pl
        CALL EVAL
        MOVW R1, #$3333
        CALL CHECK              ; 7 PL: !N
        MOVW R6, #t_vs
        CALL EVAL
        MOVW R1, #$FF00
        CALL CHECK              ; 8 VS: V
        MOVW R6, #t_vc
        CALL EVAL
        MOVW R1, #$00FF
        CALL CHECK              ; 9 VC: !V
        MOVW R6, #t_hi
        CALL EVAL
        MOVW R1, #$0505
        CALL CHECK              ; 10 HI: !C && !Z
        MOVW R6, #t_ls
        CALL EVAL
        MOVW R1, #$FAFA
        CALL CHECK              ; 11 LS: C || Z
        MOVW R6, #t_lt
        CALL EVAL
        MOVW R1, #$33CC
        CALL CHECK              ; 12 LT: N != V
        MOVW R6, #t_ge
        CALL EVAL
        MOVW R1, #$CC33
        CALL CHECK              ; 13 GE: N == V
        MOVW R6, #t_gt
        CALL EVAL
        MOVW R1, #$4411
        CALL CHECK              ; 14 GT: !Z && N == V
        MOVW R6, #t_le
        CALL EVAL
        MOVW R1, #$BBEE
        CALL CHECK              ; 15 LE: Z || N != V
        MOVW R6, #t_cs
        CALL EVAL
        MOVW R1, #$F0F0
        CALL CHECK              ; 16 BCS = BLO
        MOVW R6, #t_cc
        CALL EVAL
        MOVW R1, #$0F0F
        CALL CHECK              ; 17 BCC = BHS
        LD   R0, [t_cs]         ; alias encodings: BCS is condition 3, BCC 4
        ANDW R0, #$FF00
        MOVW R1, #$A300
        CALL CHECK              ; 18
        LD   R0, [t_cc]
        ANDW R0, #$FF00
        MOVW R1, #$A400
        CALL CHECK              ; 19

; ---- conditions after real comparisons ----------------------------------------
        MOVQ R0, #0
        MOVW R2, #$8000
        CMPW R2, #1             ; unsigned 8000 > 1, signed -32768 < 1
        BLS  .f1
        BGE  .f1
        BHI  .ok1
.f1:    JMP  FAIL
.ok1:   BLT  .ok2
        JMP  FAIL
.ok2:   MOVQ R0, #1
        MOVQ R1, #1
        CALL CHECK              ; 20
        MOVQ R2, #5
        CMP  R2, R2             ; equal: Z, no borrow
        BNE  .f2
        BLO  .f2
        BGT  .f2
        BLS  .ok3
.f2:    JMP  FAIL
.ok3:   BLE  .ok4
        JMP  FAIL
.ok4:   BHS  .ok5
        JMP  FAIL
.ok5:   MOVQ R0, #1
        MOVQ R1, #1
        CALL CHECK              ; 21

; ---- branches do not change the flags ----------------------------------------
        MOVQ R1, #$0F
        MOVQ R0, #$0F
        SETF R0
        BRA  .b1
.b1:    BEQ  .b2
.b2:    BNE  .b3                ; not taken
.b3:    CALL CHECKF             ; 22
        MOVQ R1, #0
        MOVQ R0, #0
        SETF R0
        BVS  .b4                ; not taken
.b4:    BHI  .b5
        JMP  FAIL
.b5:    CALL CHECKF             ; 23

; ---- displacement extremes -----------------------------------------------------
        ; BRA +127 words
f127:   BRA  f127t
        JMP  FAIL
        .fill 250, 0
f127t:  LD   R0, [f127]
        MOVW R1, #$A07F
        CALL CHECK              ; 24
        ; BRA -128 words
        JMP  b128go
b128t:  JMP  b128ok
        JMP  FAIL
        .fill 246, 0
b128go: BRA  b128t
        JMP  FAIL
b128ok: LD   R0, [b128go]
        MOVW R1, #$A080
        CALL CHECK              ; 25
        ; BEQ -127 words, taken
        MOVQ R0, #1
        SETF R0
        JMP  e127go
e127t:  JMP  e127ok
        .fill 248, 0
e127go: BEQ  e127t
        JMP  FAIL
e127ok: LD   R0, [e127go]
        MOVW R1, #$A181
        CALL CHECK              ; 26
        ; BNE +127 words, not taken (Z = 1)
        MOVQ R0, #1
        SETF R0
n127:   BNE  n127t
        JMP  n127ok
        .fill 250, 0
n127t:  JMP  FAIL
n127ok: LD   R0, [n127]
        MOVW R1, #$A27F
        CALL CHECK              ; 27
        ; BLO +127 words, taken (C = 1)
        MOVQ R0, #4
        SETF R0
l127:   BLO  l127t
        JMP  FAIL
        .fill 250, 0
l127t:  LD   R0, [l127]
        MOVW R1, #$A37F
        CALL CHECK              ; 28
        ; BGE -128 words, not taken (N = 1, V = 0)
        JMP  g128go
g128t:  JMP  FAIL
        .fill 246, 0
g128go: MOVQ R0, #2
        SETF R0
g128:   BGE  g128t
        LD   R0, [g128]
        MOVW R1, #$AC80
        CALL CHECK              ; 29

; ---- BSR / RTS ---------------------------------------------------------------
        JMP  bsr_go
bsub2:  LD   R0, [SP]
        MOVW R1, #bret2
        CALL CHECK              ; 33
        MOVQ R0, #1
        RTS
bsr_go: MOV  R4, SP
        BSR  bsub
bret:   MOV  R0, SP             ; SP restored by RTS
        MOV  R1, R4
        CALL CHECK              ; 32 (bsub makes 30, 31)
        BSR  bsub2              ; backward BSR
bret2:  MOVQ R1, #1
        CALL CHECK              ; 34 (bsub2 makes 33)
        JMP  bsr_done
bsub:   LD   R0, [SP]           ; pushed address of the next instruction
        MOVW R1, #bret
        CALL CHECK              ; 30
        MOV  R0, SP
        MOV  R1, R4
        ADDQ R1, #-2
        CALL CHECK              ; 31
        RTS
bsr_done:
        LD   R0, [bsr_i]        ; BSR is condition 15
        ANDW R0, #$FF00
        MOVW R1, #$AF00
        CALL CHECK              ; 35
        MOVQ R0, #0
        SETF R0                 ; BSR with every flag clear still branches
bsr_i:  BSR  bsub3
        MOVQ R1, #1
        CALL CHECK              ; 36
        JMP  bsr3_done
bsub3:  MOVQ R0, #1
        RTS
bsr3_done:

; ---- JMP abs, JMPR, CALLR ----------------------------------------------------
        MOVQ R0, #0
        JMP  jm1
        JMP  FAIL
jm1:    MOVQ R0, #1
        MOVQ R1, #1
        CALL CHECK              ; 37
        JMP  jodd+1             ; odd target: PC bit 0 cleared
        JMP  FAIL
jodd:   BSR  .x                 ; pushes the (even) address of .x
.x:     POP  R0
        MOVW R1, #jodd.x
        CALL CHECK              ; 38
        MOVW R2, #jr1
        JMP  [R2]
        JMP  FAIL
jr1:    MOVW R2, #jr2+1         ; JMPR to an odd address
        JMP  [R2]
        JMP  FAIL
jr2:    BSR  .x
.x:     POP  R0
        MOVW R1, #jr2.x
        CALL CHECK              ; 39
        MOV  R4, SP
        MOVW R2, #csub
        CALL [R2]
cr1:    MOVW R1, #cr1
        CALL CHECK              ; 40 (R0 = return address seen by csub)
        MOVW R2, #csub+1        ; CALLR to an odd address
        CALL [R2]
cr2:    MOVW R1, #cr2
        CALL CHECK              ; 41
        MOV  R0, SP
        MOV  R1, R4
        CALL CHECK              ; 42
        JMP  cr_done
csub:   BSR  .x                 ; check that PC is even inside csub
.x:     POP  R0
        MOVW R1, #csub.x
        CMP  R0, R1
        BNE  .bad
        LD   R0, [SP]
        RTS
.bad:   JMP  FAIL
cr_done:
        ; CALL abs pushes the address after its extension word
        CALL csub
ca1:    MOVW R1, #ca1
        CALL CHECK              ; 43
        CALL csub+1             ; odd CALL target
ca2:    MOVW R1, #ca2
        CALL CHECK              ; 44
        ; RTS to an odd address: bit 0 cleared
        MOVW R0, #rodd+1
        PUSH R0
        RTS
        JMP  FAIL
rodd:   BSR  .x
.x:     POP  R0
        MOVW R1, #rodd.x
        CALL CHECK              ; 45

; ---- JMPT --------------------------------------------------------------------
        MOVQ R2, #0
        CALL JT
        MOVW R1, #$0A00
        CALL CHECK              ; 46
        MOVQ R2, #1
        CALL JT
        MOVW R1, #$0A01
        CALL CHECK              ; 47
        MOVQ R2, #2
        CALL JT
        MOVW R1, #$0A02
        CALL CHECK              ; 48
        MOVQ R2, #3             ; odd table entry: bit 0 cleared
        CALL JT
        MOVW R1, #jt3.x
        CALL CHECK              ; 49
        MOVW R2, #$8001         ; table + 8001 x 2 wraps to table + 2
        CALL JT
        MOVW R1, #$0A01
        CALL CHECK              ; 50
        MOVQ R2, #0             ; JMPT does not affect flags
        MOVQ R1, #2|8
        MOVQ R0, #2|8
        SETF R0
        JMPT R2, jtabf
        JMP  FAIL
jf0:    CALL CHECKF             ; 51

        JMP  PASS

jtabf:  .word jf0

JT:     JMPT R2, jtab
        JMP  FAIL
jt0:    MOVW R0, #$0A00
        RTS
jt1:    MOVW R0, #$0A01
        RTS
jt2:    MOVW R0, #$0A02
        RTS
jt3:    BSR  .x
.x:     POP  R0
        RTS
jtab:   .word jt0, jt1, jt2, jt3+1
