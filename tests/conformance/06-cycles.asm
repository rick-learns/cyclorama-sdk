; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Conformance 06: instruction cycle counts, measured in the ROM with the timer
; (prescaler 1: TCOUNT counts down once per CPU cycle; spec-notes §5, manual
; chapter 3 "The programmable timer"). Expected counts are CYCLES in
; src/isa/isa.ts plus the rules of spec-notes §1, §8.25, §10.64.
; Each window is "LD R5,[TCOUNT] / code / LD R6,[TCOUNT]": both reads happen at
; their instruction's start (spec-notes §1 "Timing scheduler"), so R5 - R6 is 6
; (the opening LD [abs16], check 1) plus the cycles of the code; CYC subtracts
; the 6. No video port is touched and no DMA runs, so no wait cycles apply
; wherever the beam is. IE = 0 except in the WAI / interrupt-entry windows.
; Windows whose closing read happens elsewhere (calls, TRAP, interrupts) read
; TCOUNT at the target instead; RTS/RTI windows are R3 -> R4 (CYC34).
        .org $0000
        .word start, vbl_isr, 0, 0, trap_isr
        .header title="CONFORMANCE 06 CYCLES", dev=$0001, date=$19870301, version=$0100
        .org $0040
        .include "_harness.inc"
        .include "_cpu.inc"

; csub: reads TCOUNT on entry (R6: closes a CALL/BSR/CALLR window) and just
; before its RTS (R3: opens the RTS window, closed by the caller into R4).
csub:   LD   R6, [TCOUNT]
        LD   R3, [TCOUNT]
        RTS
; TRAP handler: the same idea for TRAP (R6) and RTI (R3 -> caller's R4).
trap_isr: LD R6, [TCOUNT]
        LD   R3, [TCOUNT]
        RTI
; VBLANK handler: closes an interrupt-entry window, acknowledges VBLANK.
vbl_isr: LD  R6, [TCOUNT]
        PUSH R0
        MOVQ R0, #1
        ST   R0, [IF]
        POP  R0
        RTI
; RTS / RTI windows: R3 - R4 - 6.
CYC34:  MOV  R5, R3
        MOV  R6, R4
        JMP  CYC

start:  MOVQ R7, #1
        CALL TIMER1
        LD   R5, [TCOUNT]       ; empty window: just the opening LD [abs16]
        LD   R6, [TCOUNT]
        MOV  R0, R5
        SUB  R0, R6
        MOVQ R1, #6
        CALL CHECK              ; 1 LD Rd,[abs16] = 6 (calibration)

; ---- calls and returns (near csub, for BSR's range) ------------------------------
        LD   R5, [TCOUNT]
        BSR  csub               ; csub reads R6 first thing
        LD   R4, [TCOUNT]
        MOVQ R1, #6
        CALL CYC                ; 2 BSR
        MOVQ R1, #6
        CALL CYC34              ; 3 RTS
        LD   R5, [TCOUNT]
        CALL csub
        LD   R4, [TCOUNT]
        MOVQ R1, #8
        CALL CYC                ; 4 CALL abs16
        MOVW R2, #csub
        LD   R5, [TCOUNT]
        CALL [R2]
        LD   R4, [TCOUNT]
        MOVQ R1, #6
        CALL CYC                ; 5 CALLR
        LD   R5, [TCOUNT]
        TRAP #3
        LD   R4, [TCOUNT]
        MOVQ R1, #10
        CALL CYC                ; 6 TRAP entry
        MOVQ R1, #8
        CALL CYC34              ; 7 RTI

; ---- group 0 ----------------------------------------------------------------------
        LD   R5, [TCOUNT]
        NOP
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 8 NOP
        LD   R5, [TCOUNT]
        DI
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 9 DI
        LD   R5, [TCOUNT]
        EI
        LD   R6, [TCOUNT]
        DI
        MOVQ R1, #2
        CALL CYC                ; 10 EI
        LD   R5, [TCOUNT]
        .word $0D80
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 11 reserved group 0 op 27
        LD   R5, [TCOUNT]
        .word $0FF7
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 12 reserved group 0 op 31
        LD   R5, [TCOUNT]
        NOT  R0
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 13 NOT
        LD   R5, [TCOUNT]
        NEG  R0
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 14 NEG
        LD   R5, [TCOUNT]
        INC  R0
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 15 INC
        LD   R5, [TCOUNT]
        DEC  R0
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 16 DEC
        LD   R5, [TCOUNT]
        SXB  R0
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 17 SXB
        LD   R5, [TCOUNT]
        ZXB  R0
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 18 ZXB
        LD   R5, [TCOUNT]
        SWPB  R0
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 19 SWPB
        LD   R5, [TCOUNT]
        SHL  R0, #1
        LD   R6, [TCOUNT]
        MOVQ R1, #3
        CALL CYC                ; 20 SHL Rd,#1 (group 0: 2 + n)
        LD   R5, [TCOUNT]
        SHL  R0, #8
        LD   R6, [TCOUNT]
        MOVQ R1, #10
        CALL CYC                ; 21 SHL Rd,#8 (group 0: 2 + n)
        LD   R5, [TCOUNT]
        SHL  R0, #16
        LD   R6, [TCOUNT]
        MOVQ R1, #18
        CALL CYC                ; 22 SHL Rd,#16 (group 0: 2 + n)
        LD   R5, [TCOUNT]
        SHR  R0, #4
        LD   R6, [TCOUNT]
        MOVQ R1, #6
        CALL CYC                ; 23 SHR Rd,#4 (group 0: 2 + n)
        LD   R5, [TCOUNT]
        SHR  R0, #16
        LD   R6, [TCOUNT]
        MOVQ R1, #18
        CALL CYC                ; 24 SHR Rd,#16 (group 0: 2 + n)
        LD   R5, [TCOUNT]
        ASR  R0, #16
        LD   R6, [TCOUNT]
        MOVQ R1, #18
        CALL CYC                ; 25 ASR Rd,#16 (group 0: 2 + n)
        LD   R5, [TCOUNT]
        ASR  R0, #2
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 26 ASR Rd,#2 (group 0: 2 + n)
        LD   R5, [TCOUNT]
        ROL  R0, #3
        LD   R6, [TCOUNT]
        MOVQ R1, #5
        CALL CYC                ; 27 ROL Rd,#3 (group 0: 2 + n)
        LD   R5, [TCOUNT]
        ROL  R0, #15
        LD   R6, [TCOUNT]
        MOVQ R1, #17
        CALL CYC                ; 28 ROL Rd,#15 (group 0: 2 + n)
        MOVW R2, #jr_t
        LD   R5, [TCOUNT]
        JMP  [R2]
        JMP  FAIL
jr_t:   NOP
        LD   R6, [TCOUNT]
        MOVQ R1, #6
        CALL CYC                ; 29 JMPR + NOP at the target
        LD   R5, [TCOUNT]
        PUSH R0
        LD   R6, [TCOUNT]
        POP  R0
        MOVQ R1, #4
        CALL CYC                ; 30 PUSH
        PUSH R0
        LD   R5, [TCOUNT]
        POP  R0
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 31 POP
        LD   R5, [TCOUNT]
        MOV  R0, SP
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 32 MOVFS
        MOV  R0, SP
        LD   R5, [TCOUNT]
        MOV  SP, R0
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 33 MOVTS
        LD   R5, [TCOUNT]
        GETF R0
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 34 GETF
        MOVQ R0, #0
        LD   R5, [TCOUNT]
        SETF R0
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 35 SETF

; ---- group 1: register ALU (2; shifts + n with n = Rs & 15; MUL/FMUL + 8) ---------
        MOVQ R4, #3
        LD   R5, [TCOUNT]
        MOV  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 36 MOV Rd,Rs
        MOVQ R4, #3
        LD   R5, [TCOUNT]
        ADD  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 37 ADD Rd,Rs
        MOVQ R4, #3
        LD   R5, [TCOUNT]
        ADC  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 38 ADC Rd,Rs
        MOVQ R4, #3
        LD   R5, [TCOUNT]
        SUB  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 39 SUB Rd,Rs
        MOVQ R4, #3
        LD   R5, [TCOUNT]
        SBC  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 40 SBC Rd,Rs
        MOVQ R4, #3
        LD   R5, [TCOUNT]
        CMP  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 41 CMP Rd,Rs
        MOVQ R4, #3
        LD   R5, [TCOUNT]
        AND  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 42 AND Rd,Rs
        MOVQ R4, #3
        LD   R5, [TCOUNT]
        OR   R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 43 OR Rd,Rs
        MOVQ R4, #3
        LD   R5, [TCOUNT]
        XOR  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 44 XOR Rd,Rs
        MOVQ R4, #3
        LD   R5, [TCOUNT]
        TST  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 45 TST Rd,Rs
        MOVQ R4, #0
        LD   R5, [TCOUNT]
        SHL  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 46 SHL Rd,Rs with Rs = 0
        MOVQ R4, #5
        LD   R5, [TCOUNT]
        SHL  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #7
        CALL CYC                ; 47 SHL Rd,Rs with Rs = 5
        MOVQ R4, #15
        LD   R5, [TCOUNT]
        SHL  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #17
        CALL CYC                ; 48 SHL Rd,Rs with Rs = 15
        MOVQ R4, #16
        LD   R5, [TCOUNT]
        SHL  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 49 SHL Rd,Rs with Rs = 16
        MOVQ R4, #33
        LD   R5, [TCOUNT]
        SHL  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #3
        CALL CYC                ; 50 SHL Rd,Rs with Rs = 33
        MOVQ R4, #9
        LD   R5, [TCOUNT]
        SHR  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #11
        CALL CYC                ; 51 SHR Rd,Rs with Rs = 9
        MOVQ R4, #9
        LD   R5, [TCOUNT]
        ASR  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #11
        CALL CYC                ; 52 ASR Rd,Rs with Rs = 9
        MOVQ R4, #9
        LD   R5, [TCOUNT]
        ROL  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #11
        CALL CYC                ; 53 ROL Rd,Rs with Rs = 9
        MOVQ R4, #0
        LD   R5, [TCOUNT]
        ROL  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 54 ROL Rd,Rs with Rs = 0
        MOVW R4, #$1234
        LD   R5, [TCOUNT]
        MUL  R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #10
        CALL CYC                ; 55 MUL Rd,Rs
        MOVW R4, #$1234
        LD   R5, [TCOUNT]
        FMUL R0, R4
        LD   R6, [TCOUNT]
        MOVQ R1, #10
        CALL CYC                ; 56 FMUL Rd,Rs
        LD   R5, [TCOUNT]
        .word $1003
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 57 MOV R0,R0 with must-be-zero bits set

; ---- group 2: immediate ALU (4; shifts + imm & 15; MULW/FMULW + 8) -----------------
        LD   R5, [TCOUNT]
        MOVW R0, #$1234
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 58 MOVW
        LD   R5, [TCOUNT]
        ADDW R0, #$1234
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 59 ADDW
        LD   R5, [TCOUNT]
        ADCW R0, #$1234
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 60 ADCW
        LD   R5, [TCOUNT]
        SUBW R0, #$1234
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 61 SUBW
        LD   R5, [TCOUNT]
        SBCW R0, #$1234
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 62 SBCW
        LD   R5, [TCOUNT]
        CMPW R0, #$1234
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 63 CMPW
        LD   R5, [TCOUNT]
        ANDW R0, #$1234
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 64 ANDW
        LD   R5, [TCOUNT]
        ORW  R0, #$1234
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 65 ORW
        LD   R5, [TCOUNT]
        XORW R0, #$1234
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 66 XORW
        LD   R5, [TCOUNT]
        TSTW R0, #$1234
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 67 TSTW
        LD   R5, [TCOUNT]
        SHLW R0, #0
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 68 SHLW #0
        LD   R5, [TCOUNT]
        SHLW R0, #15
        LD   R6, [TCOUNT]
        MOVQ R1, #19
        CALL CYC                ; 69 SHLW #15
        LD   R5, [TCOUNT]
        SHRW R0, #7
        LD   R6, [TCOUNT]
        MOVQ R1, #11
        CALL CYC                ; 70 SHRW #7
        LD   R5, [TCOUNT]
        ASRW R0, #1
        LD   R6, [TCOUNT]
        MOVQ R1, #5
        CALL CYC                ; 71 ASRW #1
        LD   R5, [TCOUNT]
        ROLW R0, #12
        LD   R6, [TCOUNT]
        MOVQ R1, #16
        CALL CYC                ; 72 ROLW #12
        LD   R5, [TCOUNT]
        .word $2A00, 17
        LD   R6, [TCOUNT]
        MOVQ R1, #5
        CALL CYC                ; 73 SHL R0,#17 (group 2, count 17 & 15 = 1)
        LD   R5, [TCOUNT]
        .word $2D00, $FFF0
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 74 ROL R0,#FFF0 (group 2, count 0)
        LD   R5, [TCOUNT]
        MULW R0, #$0101
        LD   R6, [TCOUNT]
        MOVQ R1, #12
        CALL CYC                ; 75 MULW
        LD   R5, [TCOUNT]
        FMULW R0, #$0101
        LD   R6, [TCOUNT]
        MOVQ R1, #12
        CALL CYC                ; 76 FMULW

; ---- group 3 ---------------------------------------------------------------------
        LD   R5, [TCOUNT]
        MOVQ R0, #-5
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 77 MOVQ
        LD   R5, [TCOUNT]
        ADDQ R0, #100
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 78 ADDQ

; ---- groups 4-7: short [Rs+d] ----------------------------------------------------
        MOVW R3, #$8100
        LD   R5, [TCOUNT]
        LD   R0, [R3+126]
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 79 LD [Rs+d]
        MOVW R3, #$8100
        LD   R5, [TCOUNT]
        ST   R0, [R3+2]
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 80 ST [Rs+d]
        MOVW R3, #$8100
        LD   R5, [TCOUNT]
        LDB  R0, [R3+63]
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 81 LDB [Rs+d]
        MOVW R3, #$8100
        LD   R5, [TCOUNT]
        STB  R0, [R3+1]
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 82 STB [Rs+d]

; ---- group 8 ---------------------------------------------------------------------
        MOVW R3, #$8100
        LD   R5, [TCOUNT]
        LD   R0, [R3+200]
        LD   R6, [TCOUNT]
        MOVQ R1, #6
        CALL CYC                ; 83 LD [Rs+d16]
        MOVW R3, #$8100
        LD   R5, [TCOUNT]
        ST   R0, [R3+200]
        LD   R6, [TCOUNT]
        MOVQ R1, #6
        CALL CYC                ; 84 ST [Rs+d16]
        MOVW R3, #$8100
        LD   R5, [TCOUNT]
        LDB  R0, [R3+201]
        LD   R6, [TCOUNT]
        MOVQ R1, #6
        CALL CYC                ; 85 LDB [Rs+d16]
        MOVW R3, #$8100
        LD   R5, [TCOUNT]
        STBX R0, [R3+1]
        LD   R6, [TCOUNT]
        MOVQ R1, #6
        CALL CYC                ; 86 STB [Rs+d16]
        LD   R5, [TCOUNT]
        ST   R0, [$8104]
        LD   R6, [TCOUNT]
        MOVQ R1, #6
        CALL CYC                ; 87 ST [abs16]
        LD   R5, [TCOUNT]
        LDB  R0, [$8105]
        LD   R6, [TCOUNT]
        MOVQ R1, #6
        CALL CYC                ; 88 LDB [abs16]
        LD   R5, [TCOUNT]
        STB  R0, [$8105]
        LD   R6, [TCOUNT]
        MOVQ R1, #6
        CALL CYC                ; 89 STB [abs16]
        MOVW R3, #$8100
        LD   R5, [TCOUNT]
        LD   R0, [R3]+
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 90 LD [Rs]+
        MOVW R3, #$8100
        LD   R5, [TCOUNT]
        ST   R0, [R3]+
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 91 ST [Rs]+
        MOVW R3, #$8100
        LD   R5, [TCOUNT]
        LDB  R0, [R3]+
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 92 LDB [Rs]+
        MOVW R3, #$8100
        LD   R5, [TCOUNT]
        STB  R0, [R3]+
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 93 STB [Rs]+
        MOVW R3, #$8100
        LD   R5, [TCOUNT]
        LD   R0, -[R3]
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 94 LD -[Rs]
        MOVW R3, #$8100
        LD   R5, [TCOUNT]
        ST   R0, -[R3]
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 95 ST -[Rs]
        MOVW R3, #$8100
        LD   R5, [TCOUNT]
        LDB  R0, -[R3]
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 96 LDB -[Rs]
        MOVW R3, #$8100
        LD   R5, [TCOUNT]
        STB  R0, -[R3]
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 97 STB -[Rs]

; ---- group 9 ---------------------------------------------------------------------
        LD   R5, [TCOUNT]
        LD   R0, [SP+2]
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 98 LD [SP+d]
        LD   R0, [SP+510]
        LD   R5, [TCOUNT]
        ST   R0, [SP+510]
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 99 ST [SP+d]

; ---- group A: taken 4, not taken 2 -----------------------------------------------
        MOVQ R0, #0
        SETF R0
        LD   R5, [TCOUNT]
        BRA  br1
br1:
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 100 BRA taken
        MOVQ R0, #1
        SETF R0
        LD   R5, [TCOUNT]
        BEQ  br2
br2:
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 101 BEQ taken
        MOVQ R0, #0
        SETF R0
        LD   R5, [TCOUNT]
        BEQ  br3
br3:
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 102 BEQ not taken
        MOVQ R0, #0
        SETF R0
        LD   R5, [TCOUNT]
        BNE  br4
br4:
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 103 BNE taken
        MOVQ R0, #1
        SETF R0
        LD   R5, [TCOUNT]
        BNE  br5
br5:
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 104 BNE not taken
        MOVQ R0, #4
        SETF R0
        LD   R5, [TCOUNT]
        BLO  br6
br6:
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 105 BLO taken
        MOVQ R0, #0
        SETF R0
        LD   R5, [TCOUNT]
        BLO  br7
br7:
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 106 BLO not taken
        MOVQ R0, #0
        SETF R0
        LD   R5, [TCOUNT]
        BHS  br8
br8:
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 107 BHS taken
        MOVQ R0, #4
        SETF R0
        LD   R5, [TCOUNT]
        BHS  br9
br9:
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 108 BHS not taken
        MOVQ R0, #2
        SETF R0
        LD   R5, [TCOUNT]
        BMI  br10
br10:
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 109 BMI taken
        MOVQ R0, #0
        SETF R0
        LD   R5, [TCOUNT]
        BMI  br11
br11:
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 110 BMI not taken
        MOVQ R0, #0
        SETF R0
        LD   R5, [TCOUNT]
        BPL  br12
br12:
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 111 BPL taken
        MOVQ R0, #2
        SETF R0
        LD   R5, [TCOUNT]
        BPL  br13
br13:
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 112 BPL not taken
        MOVQ R0, #8
        SETF R0
        LD   R5, [TCOUNT]
        BVS  br14
br14:
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 113 BVS taken
        MOVQ R0, #0
        SETF R0
        LD   R5, [TCOUNT]
        BVS  br15
br15:
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 114 BVS not taken
        MOVQ R0, #0
        SETF R0
        LD   R5, [TCOUNT]
        BVC  br16
br16:
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 115 BVC taken
        MOVQ R0, #8
        SETF R0
        LD   R5, [TCOUNT]
        BVC  br17
br17:
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 116 BVC not taken
        MOVQ R0, #0
        SETF R0
        LD   R5, [TCOUNT]
        BHI  br18
br18:
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 117 BHI taken
        MOVQ R0, #4
        SETF R0
        LD   R5, [TCOUNT]
        BHI  br19
br19:
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 118 BHI not taken
        MOVQ R0, #1
        SETF R0
        LD   R5, [TCOUNT]
        BLS  br20
br20:
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 119 BLS taken
        MOVQ R0, #0
        SETF R0
        LD   R5, [TCOUNT]
        BLS  br21
br21:
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 120 BLS not taken
        MOVQ R0, #2
        SETF R0
        LD   R5, [TCOUNT]
        BLT  br22
br22:
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 121 BLT taken
        MOVQ R0, #0
        SETF R0
        LD   R5, [TCOUNT]
        BLT  br23
br23:
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 122 BLT not taken
        MOVQ R0, #0
        SETF R0
        LD   R5, [TCOUNT]
        BGE  br24
br24:
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 123 BGE taken
        MOVQ R0, #8
        SETF R0
        LD   R5, [TCOUNT]
        BGE  br25
br25:
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 124 BGE not taken
        MOVQ R0, #0
        SETF R0
        LD   R5, [TCOUNT]
        BGT  br26
br26:
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 125 BGT taken
        MOVQ R0, #1
        SETF R0
        LD   R5, [TCOUNT]
        BGT  br27
br27:
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 126 BGT not taken
        MOVQ R0, #1
        SETF R0
        LD   R5, [TCOUNT]
        BLE  br28
br28:
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 127 BLE taken
        MOVQ R0, #0
        SETF R0
        LD   R5, [TCOUNT]
        BLE  br29
br29:
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 128 BLE not taken
        JMP  bb_go
bb_t:   LD   R6, [TCOUNT]
        JMP  bb_done
bb_go:  LD   R5, [TCOUNT]
        BRA  bb_t
bb_done: MOVQ R1, #4
        CALL CYC                ; 129 BRA backward

; ---- group B -----------------------------------------------------------------------
        LD   R5, [TCOUNT]
        JMP  jmp_t
        JMP  FAIL
jmp_t:  NOP
        LD   R6, [TCOUNT]
        MOVQ R1, #8
        CALL CYC                ; 130 JMP abs16 + NOP at the target
        MOVQ R2, #1
        LD   R5, [TCOUNT]
        JMPT R2, jtab
        JMP  FAIL
jmpt_t: NOP
        LD   R6, [TCOUNT]
        MOVQ R1, #10
        CALL CYC                ; 131 JMPT + NOP at the target
        LD   R5, [TCOUNT]
        PUSHM R0
        LD   R6, [TCOUNT]
        ADD  SP, #2
        MOVQ R1, #4
        CALL CYC                ; 132 PUSHM 1 register
        LD   R5, [TCOUNT]
        PUSHM R0-R2
        LD   R6, [TCOUNT]
        ADD  SP, #6
        MOVQ R1, #8
        CALL CYC                ; 133 PUSHM 3 registers
        LD   R5, [TCOUNT]
        PUSHM R0-R7
        LD   R6, [TCOUNT]
        ADD  SP, #16
        MOVQ R1, #18
        CALL CYC                ; 134 PUSHM 8 registers
        PUSHM R0
        LD   R5, [TCOUNT]
        POPM R0
        LD   R6, [TCOUNT]
        MOVQ R1, #4
        CALL CYC                ; 135 POPM 1 register
        PUSHM R0-R2
        LD   R5, [TCOUNT]
        POPM R0-R2
        LD   R6, [TCOUNT]
        MOVQ R1, #8
        CALL CYC                ; 136 POPM 3 registers
        LD   R5, [TCOUNT]
        PUSHM R0-R7
        POPM R0-R7
        LD   R6, [TCOUNT]
        MOVQ R1, #36
        CALL CYC                ; 137 PUSHM + POPM 8 registers (R5 restored)
        LD   R5, [TCOUNT]
        ADD  SP, #-8
        LD   R6, [TCOUNT]
        ADD  SP, #8
        MOVQ R1, #2
        CALL CYC                ; 138 ADDSP
        LD   R5, [TCOUNT]
        .word $B600
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 139 reserved group B op 6
        LD   R5, [TCOUNT]
        .word $BFFF
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 140 reserved group B op 15
        LD   R5, [TCOUNT]
        .word $C000
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 141 reserved major C
        LD   R5, [TCOUNT]
        .word $D5A5
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 142 reserved major D
        LD   R5, [TCOUNT]
        .word $E000
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 143 reserved major E
        LD   R5, [TCOUNT]
        .word $FFFF
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 144 reserved major F

; ---- the DELAY helper used by 07-interrupts: 6n + 16 --------------------------------
        LD   R5, [TCOUNT]
        MOVW R2, #1
        CALL DELAY
        LD   R6, [TCOUNT]
        MOVQ R1, #22
        CALL CYC                ; 145 DELAY n = 1
        LD   R5, [TCOUNT]
        MOVW R2, #5
        CALL DELAY
        LD   R6, [TCOUNT]
        MOVQ R1, #46
        CALL CYC                ; 146 DELAY n = 5
        LD   R5, [TCOUNT]
        MOVW R2, #100
        CALL DELAY
        LD   R6, [TCOUNT]
        MOVW R1, #616
        CALL CYC                ; 147 DELAY n = 100

; ---- WAI and interrupt entry ---------------------------------------------------------
        MOVQ R0, #7
        ST   R0, [IF]
        MOVQ R0, #1             ; VBLANK enabled, I = 0: nothing is taken
        ST   R0, [IE]
wv1:    LD   R0, [IF]           ; wait until VBLANK is pending
        TST  R0, #1
        BEQ  wv1
        LD   R5, [TCOUNT]
        WAI
        LD   R6, [TCOUNT]
        MOVQ R1, #2
        CALL CYC                ; 148 WAI with an enabled interrupt already pending (I = 0)
        MOVQ R0, #16
        LD   R5, [TCOUNT]
        SETF R0                 ; I = 1: taken at the very next boundary (§8.26)
        DI                      ; RTI returns here
        MOVQ R1, #2+12
        CALL CYC                ; 149 SETF + interrupt entry (12)
wv2:    LD   R0, [IF]           ; next VBLANK
        TST  R0, #1
        BEQ  wv2
        LD   R5, [TCOUNT]
        EI
        NOP                     ; EI delay: the interrupt is taken after this
        DI                      ; RTI returns here
        MOVQ R1, #2+2+12
        CALL CYC                ; 150 EI + NOP + interrupt entry (12)
        MOVQ R0, #0
        ST   R0, [IE]

        JMP  PASS

jtab:   .word FAIL, jmpt_t
