; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Conformance 07: TRAP, interrupts, EI/DI, WAI, the timer and STOP
; (spec-notes §1 "Reset and interrupts", §5 timer, §8.9, §8.26, §8.30, §9.40,
; §10.46, §10.61-64; manual chapter 3). The handlers record what they see in
; RAM (V_*) and log their source number (1 VBLANK, 2 LINE, 3 TIMER, 4 TRAP).
        .org $0000
        .word start, vbl_isr, line_isr, tim_isr, trap_isr
        .header title="CONFORMANCE 07 IRQ", dev=$0001, date=$19870301, version=$0100
        .org $0040
        .include "_harness.inc"
        .include "_cpu.inc"

V_CNT   = $8100                 ; handler entries since RESETLOG
V_LOGP  = $8102                 ; log pointer
V_PC    = $8104                 ; return address pushed for the last entry
V_F     = $8106                 ; F pushed for the last entry
V_HF    = $8108                 ; F inside the handler
V_R3    = $810A                 ; R3 at entry
V_IF    = $810C                 ; IF at entry
V_SP    = $810E                 ; SP after the entry pushes
V_NOACK = $8110                 ; > 0: this many entries return without acknowledging
V_TRAPN = $8112                 ; TRAP number read by the TRAP handler
V_AFTER = $8114                 ; set just before the final STOP: no handler may run then
LOG     = $8120                 ; source numbers, one byte per entry
LOGPC   = $8140                 ; pushed return addresses, one word per entry

; ---- handlers -----------------------------------------------------------------------
vbl_isr: PUSHM R0-R2
        GETF R0
        MOVQ R2, #1
        BRA  isr_common
line_isr: PUSHM R0-R2
        GETF R0
        MOVQ R2, #2
        BRA  isr_common
tim_isr: PUSHM R0-R2
        GETF R0
        MOVQ R2, #3
        BRA  isr_common
trap_isr: PUSHM R0-R2
        GETF R0
        MOVQ R2, #4
        LD   R1, [SP+8]         ; return address; the TRAP word is just before it
        ADDQ R1, #-2
        LD   R1, [R1]
        AND  R1, #15
        ST   R1, [V_TRAPN]
isr_common:                     ; stack: R0 R1 R2 at SP+0..4, F at SP+6, PC at SP+8
        ST   R0, [V_HF]
        LD   R0, [V_AFTER]
        TST  R0, R0
        BEQ  .live
        ST   R7, [RESULT]       ; the CPU woke after STOP: fail
        STOP
.live:  LD   R0, [SP+6]
        ST   R0, [V_F]
        LD   R0, [SP+8]
        ST   R0, [V_PC]
        MOV  R0, SP
        ADDQ R0, #6
        ST   R0, [V_SP]
        ST   R3, [V_R3]
        LD   R0, [IF]
        ST   R0, [V_IF]
        LD   R0, [V_CNT]
        INC  R0
        ST   R0, [V_CNT]
        MOV  R1, R0             ; LOGPC[count - 1] = pushed PC
        ADD  R1, R0
        ADDW R1, #LOGPC-2
        LD   R0, [SP+8]
        ST   R0, [R1]
        LD   R1, [V_LOGP]
        STB  R2, [R1]+
        ST   R1, [V_LOGP]
        CMP  R2, #4
        BEQ  .out               ; TRAP has no IF bit
        CMP  R2, #3
        BNE  .noack
        MOVQ R0, #0             ; TIMER is used one-shot: stop it
        ST   R0, [TCTRL]
.noack: LD   R0, [V_NOACK]
        TST  R0, R0
        BEQ  .ack
        DEC  R0
        ST   R0, [V_NOACK]
        BRA  .out
.ack:   MOVQ R0, #1             ; write 1 to this source's IF bit
        MOV  R1, R2
        ADDQ R1, #-1
        SHL  R0, R1
        ST   R0, [IF]
.out:   POPM R0-R2
        RTI

; ---- helpers ------------------------------------------------------------------------
RESETLOG: MOVQ R0, #0
        ST   R0, [V_CNT]
        ST   R0, [V_NOACK]
        ST   R0, [LOG]
        ST   R0, [LOG+2]
        MOVW R0, #LOG
        ST   R0, [V_LOGP]
        RTS

; PEND_TIMER: make TIMER pending (IF bit 2) and stop the timer. Call with I = 0.
PEND_TIMER: PUSH R0
        MOVQ R0, #0
        ST   R0, [TCTRL]
        ST   R0, [TCOUNT]
        MOVQ R0, #4
        ST   R0, [IF]
        MOVQ R0, #1
        ST   R0, [TCTRL]        ; decrements from 0 after one cycle: reload, IF bit 2
.w:     LD   R0, [IF]
        TST  R0, #4
        BEQ  .w
        MOVQ R0, #0
        ST   R0, [TCTRL]
        POP  R0
        RTS

; PEND_ALL: IE = 0 and wait until VBLANK, LINE and TIMER are all pending (IF = 7);
; the timer is then stopped and LINECMP set back to 511 (never).
PEND_ALL: MOVQ R0, #0
        ST   R0, [IE]
        MOVQ R0, #7
        ST   R0, [IF]
        MOVW R0, #230
        ST   R0, [LINECMP]
        MOVW R0, #100
        ST   R0, [TRELOAD]
        MOVQ R0, #1
        ST   R0, [TCTRL]
.w:     LD   R0, [IF]
        CMP  R0, #7
        BNE  .w
        MOVQ R0, #0
        ST   R0, [TCTRL]
        MOVW R0, #511
        ST   R0, [LINECMP]
        RTS

eirts:  EI
        RTS

start:  MOVQ R7, #1
        MOVQ R0, #7
        ST   R0, [IF]
        CALL RESETLOG
        MOV  R4, SP

; ---- TRAP: vector 0008, frame PC then F, I cleared, RTI restores ---------------------
        MOVQ R3, #$55
        MOVQ R0, #1|4
        SETF R0
        TRAP #5
tr1:    GETF R6
        MOV  R0, R6             ; RTI restored F
        MOVQ R1, #1|4
        CALL CHECK              ; 1
        LD   R0, [V_PC]         ; pushed PC = the next instruction
        MOVW R1, #tr1
        CALL CHECK              ; 2
        LD   R0, [V_F]          ; F pushed after PC (at the lower address)
        MOVQ R1, #1|4
        CALL CHECK              ; 3
        LD   R0, [V_HF]         ; in the handler: flags kept, I = 0
        MOVQ R1, #1|4
        CALL CHECK              ; 4
        LD   R0, [V_SP]         ; exactly two words pushed
        MOV  R1, R4
        ADDQ R1, #-4
        CALL CHECK              ; 5
        LD   R0, [V_TRAPN]
        MOVQ R1, #5
        CALL CHECK              ; 6
        MOV  R0, SP
        MOV  R1, R4
        CALL CHECK              ; 7
        LD   R0, [V_CNT]
        MOVQ R1, #1
        CALL CHECK              ; 8
        LD   R0, [V_R3]
        MOVQ R1, #$55
        CALL CHECK              ; 9
        ; TRAP with I = 1 (IE = 0): taken regardless, I cleared inside, restored by RTI
        MOVQ R0, #$1F
        SETF R0
        TRAP #15
tr2:    GETF R6
        DI
        MOV  R0, R6
        MOVQ R1, #$1F
        CALL CHECK              ; 10
        LD   R0, [V_F]
        MOVQ R1, #$1F
        CALL CHECK              ; 11
        LD   R0, [V_HF]
        MOVQ R1, #$0F
        CALL CHECK              ; 12
        LD   R0, [V_TRAPN]
        MOVQ R1, #15
        CALL CHECK              ; 13
        LD   R0, [V_PC]
        MOVW R1, #tr2
        CALL CHECK              ; 14

; ---- RTI pops F then PC; F bits 15-5 ignored; PC bit 0 cleared ---------------------
        MOVW R0, #rt1+1
        PUSH R0
        MOVW R0, #$FFE7
        PUSH R0
        RTI
        JMP  FAIL
rt1:    GETF R6
        BSR  .x
.x:     POP  R5
        MOV  R0, R6
        MOVQ R1, #7
        CALL CHECK              ; 15
        MOV  R0, R5
        MOVW R1, #rt1.x
        CALL CHECK              ; 16
        MOV  R0, SP
        MOV  R1, R4
        CALL CHECK              ; 17

; ---- EI: one-instruction delay ------------------------------------------------------
        CALL PEND_TIMER
        MOVQ R0, #4             ; TIMER enabled and pending, I = 0
        ST   R0, [IE]
        CALL RESETLOG
        MOVQ R3, #0
        EI
        MOVQ R3, #1             ; runs before the interrupt
ei2:    MOVQ R3, #2             ; the interrupt is taken before this
        DI
        LD   R0, [V_R3]
        MOVQ R1, #1
        CALL CHECK              ; 18
        LD   R0, [V_PC]
        MOVW R1, #ei2
        CALL CHECK              ; 19
        LD   R0, [V_CNT]
        MOVQ R1, #1
        CALL CHECK              ; 20
        LD   R0, [V_IF]         ; IF not cleared by taking the interrupt
        AND  R0, #4
        MOVQ R1, #4
        CALL CHECK              ; 21
        LD   R0, [IF]           ; cleared by the handler's write
        AND  R0, #4
        MOVQ R1, #0
        CALL CHECK              ; 22
        LD   R0, [V_F]          ; pushed F has I = 1
        AND  R0, #$10
        MOVQ R1, #$10
        CALL CHECK              ; 23
        LD   R0, [V_HF]
        AND  R0, #$10
        MOVQ R1, #0
        CALL CHECK              ; 24
        MOV  R0, R3             ; RTI resumed at ei2
        MOVQ R1, #2
        CALL CHECK              ; 25
        LD   R0, [V_SP]         ; interrupt entry pushes two words
        MOV  R1, R4
        ADDQ R1, #-4
        CALL CHECK              ; 26
        ; GETF right after EI reads I = 1 (§8.26)
        MOVQ R0, #0
        ST   R0, [IE]
        EI
        GETF R0
        DI
        AND  R0, #$10
        MOVQ R1, #$10
        CALL CHECK              ; 27
        ; EI; RTS returns before the pending interrupt is taken
        MOVQ R0, #4
        ST   R0, [IE]
        CALL PEND_TIMER
        CALL RESETLOG
        CALL eirts
eir1:   NOP
        DI
        LD   R0, [V_PC]
        MOVW R1, #eir1
        CALL CHECK              ; 28
        LD   R0, [V_CNT]
        MOVQ R1, #1
        CALL CHECK              ; 29

; ---- DI takes effect at once; SETF / RTI loading I = 1 take effect at once ----------
        CALL PEND_TIMER
        CALL RESETLOG
        EI
        DI                      ; boundary after EI: skipped; after DI: I = 0
        NOP
        NOP
        LD   R0, [V_CNT]
        MOVQ R1, #0
        CALL CHECK              ; 30
        LD   R0, [IF]           ; still pending
        AND  R0, #4
        MOVQ R1, #4
        CALL CHECK              ; 31
        CALL RESETLOG
        MOVQ R3, #0
        MOVQ R0, #$10
        SETF R0                 ; I = 1 with TIMER pending: taken at the next boundary
sf1:    MOVQ R3, #1
        DI
        LD   R0, [V_R3]
        MOVQ R1, #0
        CALL CHECK              ; 32
        LD   R0, [V_PC]
        MOVW R1, #sf1
        CALL CHECK              ; 33
        LD   R0, [V_CNT]
        MOVQ R1, #1
        CALL CHECK              ; 34
        ; a handler that returns without acknowledging is entered again at once
        CALL PEND_TIMER
        CALL RESETLOG
        MOVQ R0, #1
        ST   R0, [V_NOACK]
        MOVQ R3, #0
        EI
        NOP
ri1:    MOVQ R3, #1
        DI
        LD   R0, [V_CNT]
        MOVQ R1, #2
        CALL CHECK              ; 35
        LD   R0, [V_R3]         ; ri1 did not run between the two entries
        MOVQ R1, #0
        CALL CHECK              ; 36
        LD   R0, [V_PC]
        MOVW R1, #ri1
        CALL CHECK              ; 37
        LD   R0, [V_F]          ; second entry: F restored by the first RTI (I = 1)
        AND  R0, #$10
        MOVQ R1, #$10
        CALL CHECK              ; 38
        LD   R0, [IF]
        AND  R0, #4
        MOVQ R1, #0
        CALL CHECK              ; 39
        MOV  R0, R3
        MOVQ R1, #1
        CALL CHECK              ; 40

; ---- IF / IE register behaviour --------------------------------------------------
        CALL PEND_ALL           ; IE = 0, IF = 7
        LD   R0, [IF]
        MOVQ R1, #7
        CALL CHECK              ; 41
        MOVQ R0, #2             ; writing 1 clears
        ST   R0, [IF]
        LD   R0, [IF]
        MOVQ R1, #5
        CALL CHECK              ; 42
        MOVQ R0, #0             ; writing 0 leaves bits alone
        ST   R0, [IF]
        LD   R0, [IF]
        MOVQ R1, #5
        CALL CHECK              ; 43
        MOVW R0, #$FFFF         ; byte write to the high byte: ignored (§9.40)
        STB  R0, [IF+1]
        LD   R0, [IF]
        MOVQ R1, #5
        CALL CHECK              ; 44
        MOVW R0, #$FF00         ; word write: acts on the low byte (00)
        ST   R0, [IF]
        LD   R0, [IF]
        MOVQ R1, #5
        CALL CHECK              ; 45
        MOVQ R0, #1             ; byte write to the low byte clears bit 0
        STB  R0, [IF]
        LD   R0, [IF]
        MOVQ R1, #4
        CALL CHECK              ; 46
        LDB  R0, [IF+1]         ; bits 15-8 read 0
        MOVQ R1, #0
        CALL CHECK              ; 47
        MOVW R0, #$FFFF
        ST   R0, [IF]
        LD   R0, [IF]
        MOVQ R1, #0
        CALL CHECK              ; 48
        MOVW R0, #$FFFF         ; IE keeps bits 2-0 (I = 0: nothing is taken)
        ST   R0, [IE]
        LD   R0, [IE]
        MOVQ R1, #7
        CALL CHECK              ; 49
        MOVQ R0, #0
        ST   R0, [IE]

; ---- priority: VBLANK > LINE > TIMER ---------------------------------------------
        CALL PEND_ALL
        CALL RESETLOG
        MOVQ R0, #7
        ST   R0, [IE]
        EI
        NOP                     ; all three are taken, one per boundary, before...
        NOP                     ; ...this NOP (each RTI sets I = 1 again)
        DI
        LD   R0, [LOG]
        MOVW R1, #$0201
        CALL CHECK              ; 50
        LD   R0, [LOG+2]
        MOVQ R1, #3
        CALL CHECK              ; 51
        LD   R0, [V_IF]         ; the TIMER handler saw only its own bit left
        MOVQ R1, #4
        CALL CHECK              ; 52
        LD   R0, [V_CNT]
        MOVQ R1, #3
        CALL CHECK              ; 53
        CALL PEND_ALL           ; LINE > TIMER
        MOVQ R0, #1
        ST   R0, [IF]
        CALL RESETLOG
        MOVQ R0, #7
        ST   R0, [IE]
        EI
        NOP
        NOP
        DI
        LD   R0, [LOG]
        MOVW R1, #$0302
        CALL CHECK              ; 54
        CALL PEND_ALL           ; VBLANK > TIMER
        MOVQ R0, #2
        ST   R0, [IF]
        CALL RESETLOG
        MOVQ R0, #7
        ST   R0, [IE]
        EI
        NOP
        NOP
        DI
        LD   R0, [LOG]
        MOVW R1, #$0301
        CALL CHECK              ; 55
        CALL PEND_ALL           ; IE masks: only TIMER enabled
        CALL RESETLOG
        MOVQ R0, #4
        ST   R0, [IE]
        EI
        NOP
        NOP
        DI
        LD   R0, [LOG]
        MOVQ R1, #3
        CALL CHECK              ; 56
        LD   R0, [IF]           ; VBLANK and LINE still pending
        MOVQ R1, #3
        CALL CHECK              ; 57
        MOVQ R0, #7
        ST   R0, [IF]

; ---- WAI -------------------------------------------------------------------------
        ; I = 1: WAI sleeps until the timer fires, the handler runs, RTI returns after WAI
        MOVQ R0, #0
        ST   R0, [TCTRL]
        MOVQ R0, #4
        ST   R0, [IE]
        CALL RESETLOG
        MOVW R0, #200
        ST   R0, [TCOUNT]
        MOVQ R0, #1
        ST   R0, [TCTRL]
        EI
        WAI
wai1:   NOP
        DI
        LD   R0, [V_PC]
        MOVW R1, #wai1
        CALL CHECK              ; 58
        LD   R0, [V_CNT]
        MOVQ R1, #1
        CALL CHECK              ; 59
        ; EI; WAI with the interrupt already pending: WAI completes, then it is taken
        CALL PEND_TIMER
        CALL RESETLOG
        EI
        WAI
wai2:   NOP
        DI
        LD   R0, [V_PC]
        MOVW R1, #wai2
        CALL CHECK              ; 60
        LD   R0, [V_CNT]
        MOVQ R1, #1
        CALL CHECK              ; 61
        ; I = 1 already in force and TIMER pending when WAI is reached: the interrupt
        ; is taken before WAI (pushed PC = the WAI, §10.63); after RTI the WAI then
        ; sleeps until the next VBLANK, whose entry pushes the address after WAI.
        MOVQ R0, #0
        ST   R0, [IE]
        CALL PEND_TIMER
        MOVQ R0, #1
        ST   R0, [IF]
        CALL RESETLOG
        MOVQ R0, #1|4
        EI
        NOP                     ; I = 1, nothing enabled yet
        ST   R0, [IE]           ; TIMER now pending: taken at the boundary after this
wai3:   WAI
wai3r:  NOP
        DI
        LD   R0, [LOG]          ; TIMER, then VBLANK
        MOVW R1, #$0103
        CALL CHECK              ; 62
        LD   R0, [LOGPC]
        MOVW R1, #wai3
        CALL CHECK              ; 63
        LD   R0, [LOGPC+2]
        MOVW R1, #wai3r
        CALL CHECK              ; 64
        MOVQ R0, #4
        ST   R0, [IE]
        ; I = 0: WAI wakes at the first cycle boundary with IE & IF != 0 and execution
        ; continues; the prescaler keeps counting while it waits (§8.30, §10.46, §10.62)
        CALL RESETLOG
        MOVW R0, #$1000
        ST   R0, [TRELOAD]
        MOVW R0, #200
        ST   R0, [TCOUNT]
        MOVQ R0, #1
        ST   R0, [TCTRL]        ; t; IF bit 2 is set at t + 201
        WAI                     ; t + 6
        NOP                     ; t + 201
        LD   R0, [TCOUNT]       ; t + 203: reloaded at t + 201, two counts since
        MOVW R1, #$0FFE
        CALL CHECK              ; 65
        LD   R0, [V_CNT]        ; no handler ran
        MOVQ R1, #0
        CALL CHECK              ; 66
        LD   R0, [IF]           ; the bit stays set for software
        AND  R0, #4
        MOVQ R1, #4
        CALL CHECK              ; 67
        MOVQ R0, #0
        ST   R0, [TCTRL]
        ST   R0, [IE]
        MOVQ R0, #7
        ST   R0, [IF]

; ---- timer: first request (c + 1) x P cycles after the TCTRL write -----------------
; Each probe: TCOUNT = c, then ST R0,[TCTRL] at time t (6 cycles), a delay of D
; cycles, then a read at t + 6 + D. "MOVW R2,#n / CALL DELAY" = 6n + 16 cycles.
        MOVW R0, #1000
        ST   R0, [TRELOAD]
        MOVQ R3, #4
        ; P = 1, c = 5: request at t + 6, seen by a read at t + 6
        MOVQ R0, #5
        ST   R0, [TCOUNT]
        ST   R3, [IF]
        MOVQ R0, #1
        ST   R0, [TCTRL]
        LD   R0, [IF]
        AND  R0, #4
        MOVQ R1, #4
        CALL CHECK              ; 68
        MOVQ R0, #0
        ST   R0, [TCTRL]
        ; P = 1, c = 6: request at t + 7, not yet at t + 6
        MOVQ R0, #6
        ST   R0, [TCOUNT]
        ST   R3, [IF]
        MOVQ R0, #1
        ST   R0, [TCTRL]
        LD   R0, [IF]
        AND  R0, #4
        MOVQ R1, #0
        CALL CHECK              ; 69
        MOVQ R0, #0
        ST   R0, [TCTRL]
        ; P = 16, c = 3: request at t + 64; read at t + 62
        MOVQ R0, #3
        ST   R0, [TCOUNT]
        ST   R3, [IF]
        MOVQ R0, #1<<1|1
        ST   R0, [TCTRL]
        MOVW R2, #6             ; 52
        CALL DELAY
        NOP
        NOP
        LD   R0, [IF]
        AND  R0, #4
        MOVQ R1, #0
        CALL CHECK              ; 70
        MOVQ R0, #0
        ST   R0, [TCTRL]
        ; ... read at t + 64
        MOVQ R0, #3
        ST   R0, [TCOUNT]
        ST   R3, [IF]
        MOVQ R0, #1<<1|1
        ST   R0, [TCTRL]
        MOVW R2, #7             ; 58
        CALL DELAY
        LD   R0, [IF]
        AND  R0, #4
        MOVQ R1, #4
        CALL CHECK              ; 71
        MOVQ R0, #0
        ST   R0, [TCTRL]
        ; P = 64, c = 2: request at t + 192; read at t + 190
        MOVQ R0, #2
        ST   R0, [TCOUNT]
        ST   R3, [IF]
        MOVQ R0, #2<<1|1
        ST   R0, [TCTRL]
        MOVW R2, #28            ; 184
        CALL DELAY
        LD   R0, [IF]
        AND  R0, #4
        MOVQ R1, #0
        CALL CHECK              ; 72
        MOVQ R0, #0
        ST   R0, [TCTRL]
        ; ... read at t + 192
        MOVQ R0, #2
        ST   R0, [TCOUNT]
        ST   R3, [IF]
        MOVQ R0, #2<<1|1
        ST   R0, [TCTRL]
        MOVW R2, #28            ; 184
        CALL DELAY
        NOP
        LD   R0, [IF]
        AND  R0, #4
        MOVQ R1, #4
        CALL CHECK              ; 73
        MOVQ R0, #0
        ST   R0, [TCTRL]
        ; P = 256, c = 1: request at t + 512; read at t + 510
        MOVQ R0, #1
        ST   R0, [TCOUNT]
        ST   R3, [IF]
        MOVQ R0, #3<<1|1
        ST   R0, [TCTRL]
        MOVW R2, #81            ; 502
        CALL DELAY
        NOP
        LD   R0, [IF]
        AND  R0, #4
        MOVQ R1, #0
        CALL CHECK              ; 74
        MOVQ R0, #0
        ST   R0, [TCTRL]
        ; ... read at t + 512
        MOVQ R0, #1
        ST   R0, [TCOUNT]
        ST   R3, [IF]
        MOVQ R0, #3<<1|1
        ST   R0, [TCTRL]
        MOVW R2, #81            ; 502
        CALL DELAY
        NOP
        NOP
        LD   R0, [IF]
        AND  R0, #4
        MOVQ R1, #4
        CALL CHECK              ; 75
        MOVQ R0, #0
        ST   R0, [TCTRL]

; ---- timer: TCOUNT decrements every P cycles --------------------------------------
        ; P = 16, TCOUNT = 100: still 100 at t + 15, 99 at t + 16
        MOVQ R0, #100
        ST   R0, [TCOUNT]
        MOVQ R0, #1<<1|1
        ST   R0, [TCTRL]
        NOP
        NOP
        NOP
        SHL  R0, #1             ; 3
        LD   R0, [TCOUNT]
        MOVQ R1, #100
        CALL CHECK              ; 76
        MOVQ R0, #0
        ST   R0, [TCTRL]
        MOVQ R0, #100
        ST   R0, [TCOUNT]
        MOVQ R0, #1<<1|1
        ST   R0, [TCTRL]
        NOP
        NOP
        NOP
        NOP
        NOP
        LD   R0, [TCOUNT]
        MOVQ R1, #99
        CALL CHECK              ; 77
        MOVQ R0, #0
        ST   R0, [TCTRL]
        ; P = 256, TCOUNT = 100: 100 at t + 255, 99 at t + 256
        MOVQ R0, #100
        ST   R0, [TCOUNT]
        MOVQ R0, #3<<1|1
        ST   R0, [TCTRL]
        MOVW R2, #38            ; 244
        CALL DELAY
        NOP
        SHL  R0, #1             ; 3
        LD   R0, [TCOUNT]
        MOVQ R1, #100
        CALL CHECK              ; 78
        MOVQ R0, #0
        ST   R0, [TCTRL]
        MOVQ R0, #100
        ST   R0, [TCOUNT]
        MOVQ R0, #3<<1|1
        ST   R0, [TCTRL]
        MOVW R2, #39            ; 250
        CALL DELAY
        LD   R0, [TCOUNT]
        MOVQ R1, #99
        CALL CHECK              ; 79
        MOVQ R0, #0
        ST   R0, [TCTRL]

; ---- timer: reload period (TRELOAD + 1) x P ---------------------------------------
        ; P = 16, TCOUNT = 0, TRELOAD = 4: requests at t + 16, 96, 176
        MOVQ R0, #4
        ST   R0, [TRELOAD]
        MOVQ R0, #0
        ST   R0, [TCOUNT]
        ST   R3, [IF]
        MOVQ R0, #1<<1|1
        ST   R0, [TCTRL]        ; t
        MOVW R2, #3             ; 34
        CALL DELAY
        LD   R0, [TCOUNT]       ; t + 40: reloaded to 4 at 16, 3 at 32
        MOVQ R1, #3
        CALL CHECK              ; 80
        MOVQ R0, #0
        ST   R0, [TCTRL]
        MOVQ R0, #0             ; same start; acknowledge at t + 40, read IF at t + 94
        ST   R0, [TCOUNT]
        ST   R3, [IF]
        MOVQ R0, #1<<1|1
        ST   R0, [TCTRL]        ; t
        MOVW R2, #3             ; 34
        CALL DELAY
        ST   R3, [IF]           ; t + 40
        MOVW R2, #5             ; 46
        CALL DELAY
        NOP                     ; t + 94
        LD   R0, [IF]
        AND  R0, #4
        MOVQ R1, #0
        CALL CHECK              ; 81
        MOVQ R0, #0
        ST   R0, [TCTRL]
        MOVQ R0, #0             ; ... read IF at t + 96
        ST   R0, [TCOUNT]
        ST   R3, [IF]
        MOVQ R0, #1<<1|1
        ST   R0, [TCTRL]        ; t
        MOVW R2, #3             ; 34
        CALL DELAY
        ST   R3, [IF]           ; t + 40
        MOVW R2, #5             ; 46
        CALL DELAY
        NOP
        NOP                     ; t + 96
        LD   R0, [IF]
        AND  R0, #4
        MOVQ R1, #4
        CALL CHECK              ; 82
        MOVQ R0, #0
        ST   R0, [TCTRL]

; ---- timer: writing TCTRL restarts the prescaler -----------------------------------
        ; P = 16, TCOUNT = 3. At t + 40 (counts at 16, 32: TCOUNT = 1) TCTRL is
        ; written again at t'. The next count comes at t' + 16, not at t + 48.
        MOVW R0, #1000
        ST   R0, [TRELOAD]
        MOVQ R0, #3
        ST   R0, [TCOUNT]
        MOVQ R0, #1<<1|1
        ST   R0, [TCTRL]        ; t
        MOVW R2, #3             ; 34
        CALL DELAY
        ST   R0, [TCTRL]        ; t' = t + 40
        NOP
        NOP
        NOP
        SHL  R2, #1             ; 3: t' + 15
        LD   R0, [TCOUNT]
        MOVQ R1, #1
        CALL CHECK              ; 83
        MOVQ R0, #0
        ST   R0, [TCTRL]
        MOVQ R0, #3
        ST   R0, [TCOUNT]
        MOVQ R0, #1<<1|1
        ST   R0, [TCTRL]        ; t
        MOVW R2, #3
        CALL DELAY
        ST   R0, [TCTRL]        ; t'
        NOP
        NOP
        NOP
        NOP
        NOP                     ; t' + 16
        LD   R0, [TCOUNT]
        MOVQ R1, #0
        CALL CHECK              ; 84
        MOVQ R0, #0
        ST   R0, [TCTRL]

; ---- STOP: nothing restarts the CPU, not even an enabled interrupt ------------------
; STOP is reached early in a frame with VBLANK enabled and I = 1. VBLANK arrives
; later in the same frame; a handler running after STOP would overwrite RESULT.
.w:     LD   R0, [VCOUNT]
        TST  R0, R0
        BNE  .w
        MOVQ R0, #7
        ST   R0, [IF]
        MOVQ R0, #1
        ST   R0, [IE]
        ST   R0, [V_AFTER]
        EI
        NOP
        JMP  PASS
