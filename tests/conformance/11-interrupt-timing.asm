; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Conformance 11: interrupt timing (spec-notes §1 "Reset and interrupts", §5 timer, §8.9,
; §10.46; manual ch. 3 and 5.13). VBLANK IF at dot 0 of line 224; LINE IF at dot 256 of the line
; where VCOUNT = LINECMP; LINECMP values that no line reaches never fire; TIMER and VBLANK
; coexist; simultaneous requests are taken VBLANK > LINE > TIMER.
        .org $0000
        .word start, VBH, LH, TH, 0
        .header title="CONFORMANCE 11 IRQ TIME", dev=$0001, date=$19870301, version=$0100
        .org $0040
        .include "_harness.inc"
        .include "_hw.inc"

VBCNT  = $8100      ; VBLANK handler entries
VBLINE = $8102      ; VCOUNT read by the VBLANK handler
VBF    = $8104      ; F pushed by the VBLANK interrupt entry
TCNT   = $8106      ; TIMER handler entries
LLPTR  = $8108      ; LINE log pointer (VCOUNT per LINE handler entry)
LNEXT  = $810A      ; if non-zero, the LINE handler moves LINECMP there (once)
ORDPTR = $810C      ; if non-zero, every handler appends its IF bit here
LLOG   = $8120      ; LINE log (8 words)
VBTAB  = $8140      ; TCNT sampled by the VBLANK handler, indexed by VBCNT (8 words)
ORDLOG = $8160      ; order log

; ---- handlers ----
VBH:    PUSH R0
        PUSH R1
        LD   R0, [VCOUNT]
        ST   R0, [VBLINE]
        LD   R0, [SP+4]         ; stack: R1, R0, F, PC
        ST   R0, [VBF]
        LD   R0, [VBCNT]
        ADDQ R0, #1
        ST   R0, [VBCNT]
        ANDW R0, #7
        ADD  R0, R0
        MOVW R1, #VBTAB
        ADD  R1, R0
        LD   R0, [TCNT]
        ST   R0, [R1]
        MOVQ R0, #1
        CALL LOGID
        ST   R0, [IF]
        POP  R1
        POP  R0
        RTI

LH:     PUSH R0
        PUSH R1
        LD   R0, [VCOUNT]
        LD   R1, [LLPTR]
        ST   R0, [R1]
        ADDQ R1, #2
        ST   R1, [LLPTR]
        LD   R0, [LNEXT]
        TST  R0, R0
        BEQ  .same
        ST   R0, [LINECMP]
        MOVQ R0, #0
        ST   R0, [LNEXT]
.same:  MOVQ R0, #2
        CALL LOGID
        ST   R0, [IF]
        POP  R1
        POP  R0
        RTI

TH:     PUSH R0
        LD   R0, [TCNT]
        ADDQ R0, #1
        ST   R0, [TCNT]
        MOVQ R0, #4
        CALL LOGID
        ST   R0, [IF]
        POP  R0
        RTI

; LOGID: append R0 to the order log if ORDPTR != 0. Preserves all registers.
LOGID:  PUSH R1
        LD   R1, [ORDPTR]
        TST  R1, R1
        BEQ  .off
        ST   R0, [R1]
        ADDQ R1, #2
        ST   R1, [ORDPTR]
.off:   POP  R1
        RTS

start:  MOVQ R7, #1
        MOVQ R0, #0
        ST   R0, [VBCNT]
        ST   R0, [TCNT]
        ST   R0, [LNEXT]
        ST   R0, [ORDPTR]
        MOVW R0, #LLOG
        ST   R0, [LLPTR]
        CALL TSTART

        ; ---- VBLANK IF is set at dot 0 of line 224, whether or not enabled (polled, I = 0) ----
        CALL WAITVB                 ; frame 0, line 224; IF bit 0 acknowledged
        MOVW R0, #223
        CALL WAITLN                 ; frame 1, line 223, cycle 183; IE = 2 (VBLANK disabled)
        ; #1 IF bit 0 still clear on line 223
        LD   R0, [IF]
        ANDW R0, #1
        MOVQ R1, #0
        CALL CHECK
        ; #2 timing: poll IF bit 0 from line 223. The poll loop is LD 6 + TSTW 4 + BEQ 4; the
        ; bit becomes visible to a read starting at or after cycle 228 (dot 0 of line 224).
        ; R4 is read at cycle c0 (after the CHECK above); the first poll read that sees the bit
        ; starts in [228, 242), and R5 is read 6 + 4 + 2 cycles later. So R4 - R5 lies in
        ; [240 - c0, 254 - c0). c0 = 183 + LD 6 + ANDW 4 + MOVQ 2 + CALL CHECK (8 + 2 + 2 + 2 + 6)
        ; = 215, giving [25, 39). Set at dot 256 of line 224 instead would give >= 196.
        LD   R4, [TCOUNT]
.pv:    LD   R0, [IF]
        TSTW R0, #1
        BEQ  .pv
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #25
        MOVQ R2, #38
        CALL CHECKR
        ; #3 now VCOUNT = 224
        LD   R0, [VCOUNT]
        MOVW R1, #224
        CALL CHECK
        ; #4 and VSTAT bit 0 = 1
        LD   R0, [VSTAT]
        ANDW R0, #1
        MOVQ R1, #1
        CALL CHECK

        ; ---- VBLANK interrupt: handler runs on line 224 with I pushed as 1 ----
        MOVQ R0, #7
        ST   R0, [IF]
        MOVQ R0, #1
        ST   R0, [IE]
        LD   R3, [VBCNT]
        EI
.w1:    LD   R0, [VBCNT]
        CMP  R0, R3
        BEQ  .w1
        ; #5 one entry
        MOV  R0, R3
        ADDQ R0, #1
        MOV  R1, R0
        LD   R0, [VBCNT]
        CALL CHECK
        ; #6 VCOUNT in the handler = 224
        LD   R0, [VBLINE]
        MOVW R1, #224
        CALL CHECK
        ; #7 F pushed by the entry has I = 1 (bit 4)
        LD   R0, [VBF]
        ANDW R0, #$10
        MOVQ R1, #$10
        CALL CHECK
        ; #8 one frame later: exactly one more entry, again on line 224
        LD   R3, [VBCNT]
.w2:    LD   R0, [VBCNT]
        CMP  R0, R3
        BEQ  .w2
        LD   R0, [VBLINE]
        MOVW R1, #224
        CALL CHECK
        ; #9 IF bit 0 is clear again (the handler acknowledged it; RTI restored I = 1)
        LD   R0, [IF]
        ANDW R0, #1
        MOVQ R1, #0
        CALL CHECK
        DI

        ; ---- LINE IF at dot 256 of the LINECMP line (polled, I = 0) ----
        MOVQ R0, #100
        CALL LINESTART              ; line 100, cycle 15; LINECMP = 99, IE = 2
        LD   R4, [TCOUNT]           ; cycle 15
        MOVQ R0, #100
        ST   R0, [LINECMP]          ; cycle 23
        ; #10 not yet set early in line 100 (LINECMP now matches VCOUNT, but dot < 256)
        LD   R0, [IF]               ; cycle 29
        ANDW R0, #2
        MOVQ R1, #0
        CALL CHECK
        ; #11 poll until set: the bit is visible to a read starting at or after cycle 171 of the
        ; line (dot 256 = 170.67 cycles). The first read that sees it starts in [171, 185); R5 is
        ; read 12 cycles after it starts. R4 was read at cycle 15, so R4 - R5 in [168, 182).
        ; (Polls start at cycle 61 + 14k after the CHECK above: 173 sees it, giving 170.)
        ; (Set at dot 0 of line 101 instead: >= 225.)
.pl:    LD   R0, [IF]
        TSTW R0, #2
        BEQ  .pl
        LD   R5, [TCOUNT]
        LD   R3, [VCOUNT]           ; (used by check 12: read at once, about cycle 190 of the line)
        MOV  R0, R4
        SUB  R0, R5
        MOVW R1, #168
        MOVW R2, #181
        CALL CHECKR
        ; #12 the request came while VCOUNT = 100 (read right after detection)
        MOV  R0, R3
        MOVQ R1, #100
        CALL CHECK
        ; #13 WAI (I = 0) on LINE: from the wake (cycle 171) to the start of line 101 is 57 cycles.
        ; Poll VCOUNT from the wake: R4 at cycle 171, polls start at 177, 191, 205, 219, 233;
        ; 233 sees 101 (228 = dot 0 of line 101); R5 at 233 + 12 = 245: R4 - R5 = 74.
        ; Accept [57, 57 + 14 + 12 + 6] = [57, 89]; a LINE IF at dot 0 would give about 228 + 57.
        MOVQ R0, #120
        ST   R0, [LINECMP]
        MOVQ R0, #2
        ST   R0, [IF]
        WAI
        LD   R4, [TCOUNT]
.pv2:   LD   R0, [VCOUNT]
        CMPW R0, #121
        BNE  .pv2
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #57
        MOVW R2, #89
        CALL CHECKR

        ; ---- LINE interrupts: VCOUNT inside the handler = LINECMP; handler re-arms LINECMP ----
        CALL WAITVB
        MOVW R0, #LLOG
        ST   R0, [LLPTR]
        MOVQ R0, #37
        ST   R0, [LINECMP]
        MOVW R0, #150
        ST   R0, [LNEXT]
        MOVQ R0, #2
        ST   R0, [IE]
        ST   R0, [IF]
        EI
.w3:    LD   R0, [LLPTR]
        CMPW R0, #LLOG+4
        BNE  .w3
        DI
        ; #14 first entry on line 37
        LD   R0, [LLOG]
        MOVQ R1, #37
        CALL CHECK
        ; #15 second entry on line 150, same frame (re-armed by the handler)
        LD   R0, [LLOG+2]
        MOVW R1, #150
        CALL CHECK
        ; #16 and it was the same frame: VBLANK has not happened since (VSTAT bit 0 = 0 and
        ; VCOUNT still in 150..223)
        LD   R0, [VCOUNT]
        MOVW R1, #150
        MOVW R2, #223
        CALL CHECKR
        ; #17 LINE on a vertical-blank line: LINECMP = 250, handler sees VCOUNT = 250
        MOVW R0, #250
        ST   R0, [LINECMP]
        MOVQ R0, #2
        ST   R0, [IF]
        EI
.w4:    LD   R0, [LLPTR]
        CMPW R0, #LLOG+6
        BNE  .w4
        DI
        LD   R0, [LLOG+4]
        MOVW R1, #250
        CALL CHECK
        ; #18 LINECMP = 0 fires on line 0
        MOVQ R0, #0
        ST   R0, [LINECMP]
        MOVQ R0, #2
        ST   R0, [IF]
        EI
.w5:    LD   R0, [LLPTR]
        CMPW R0, #LLOG+8
        BNE  .w5
        DI
        LD   R0, [LLOG+6]
        MOVQ R1, #0
        CALL CHECK

        ; ---- LINECMP values no line reaches never fire ----
        ; #19 LINECMP = 511 (reset value): two whole frames, IF bit 1 stays 0
        MOVW R0, #511
        ST   R0, [LINECMP]
        MOVQ R0, #2
        ST   R0, [IF]
        CALL WAITVB
        CALL WAITVB
        LD   R0, [IF]
        ANDW R0, #2
        MOVQ R1, #0
        CALL CHECK
        ; #20 LINECMP = 262 (one past the last line)
        MOVW R0, #262
        ST   R0, [LINECMP]
        MOVQ R0, #2
        ST   R0, [IF]
        CALL WAITVB
        CALL WAITVB
        LD   R0, [IF]
        ANDW R0, #2
        MOVQ R1, #0
        CALL CHECK
        ; #21 control: LINECMP = 261 does fire within the same two frames
        MOVW R0, #261
        ST   R0, [LINECMP]
        MOVQ R0, #2
        ST   R0, [IF]
        CALL WAITVB
        CALL WAITVB
        LD   R0, [IF]
        ANDW R0, #2
        MOVQ R1, #2
        CALL CHECK

        ; ---- TIMER + VBLANK together ----
        ; Timer at prescaler 1 with TRELOAD 227: one request every 228 cycles = one per line, and
        ; a frame is 262 x 228 cycles, so exactly 262 TIMER entries between VBLANK entries. The
        ; timer is started early in line 224 with TCOUNT 69, so its requests fall near cycle 100
        ; of every line, far from the VBLANK request at cycle 0 of line 224.
        MOVW R0, #511
        ST   R0, [LINECMP]
        MOVQ R0, #0
        ST   R0, [TCTRL]
        CALL WAITVB
        MOVW R0, #227
        ST   R0, [TRELOAD]
        MOVQ R0, #69
        ST   R0, [TCOUNT]
        MOVQ R0, #1
        ST   R0, [TCTRL]
        MOVQ R0, #0
        ST   R0, [TCNT]
        ST   R0, [VBCNT]
        MOVQ R0, #7
        ST   R0, [IF]
        MOVQ R0, #5
        ST   R0, [IE]
        EI
.w6:    LD   R0, [VBCNT]
        CMPW R0, #4
        BNE  .w6
        DI
        ; #22 TIMER entries between VBLANK entries 1 and 2
        LD   R0, [VBTAB+4]
        LD   R1, [VBTAB+2]
        SUB  R0, R1
        MOVW R1, #262
        CALL CHECK
        ; #23 ...between 2 and 3
        LD   R0, [VBTAB+6]
        LD   R1, [VBTAB+4]
        SUB  R0, R1
        MOVW R1, #262
        CALL CHECK
        ; #24 ...between 3 and 4
        LD   R0, [VBTAB+8]
        LD   R1, [VBTAB+6]
        SUB  R0, R1
        MOVW R1, #262
        CALL CHECK
        ; #25 the VBLANK handler still runs on line 224
        LD   R0, [VBLINE]
        MOVW R1, #224
        CALL CHECK
        ; #26 the first frame: 262 minus the lines before the timer's first request... the
        ; count from the start (TCNT 0 at line 224 of frame A) to the first VBLANK entry (line 224
        ; of frame A+1) is also 262: requests at ~cycle 100 of lines 224..261 and 0..223.
        LD   R0, [VBTAB+2]
        MOVW R1, #262
        CALL CHECK

        ; ---- priority: all three pending at once -> VBLANK, LINE, TIMER ----
        MOVQ R0, #0
        ST   R0, [TCTRL]
        ST   R0, [IE]
        MOVQ R0, #100
        CALL WAITLN                 ; line 100
        MOVQ R0, #0
        ST   R0, [IE]
        MOVQ R0, #7
        ST   R0, [IF]
        MOVW R0, #223
        ST   R0, [LINECMP]          ; LINE request at dot 256 of line 223
        MOVW R0, #$FFFF
        ST   R0, [TRELOAD]
        MOVQ R0, #0
        ST   R0, [TCOUNT]
        MOVQ R0, #1
        ST   R0, [TCTRL]            ; TIMER request within a cycle (0 -> reload)
        MOVW R0, #225
        CALL WAITVC                 ; line 225: VBLANK requested at line 224
        ; #27 IF = 7 (all three set while IE = 0)
        LD   R0, [IF]
        MOVQ R1, #7
        CALL CHECK
        MOVW R0, #ORDLOG
        ST   R0, [ORDPTR]
        MOVQ R0, #7
        ST   R0, [IE]
        EI
        NOP
        NOP
        NOP
        DI
        MOVQ R0, #0
        ST   R0, [ORDPTR]
        ST   R0, [IE]
        ST   R0, [TCTRL]
        ; #28-#30 order: VBLANK (1), LINE (2), TIMER (4)
        LD   R0, [ORDLOG]
        MOVQ R1, #1
        CALL CHECK
        LD   R0, [ORDLOG+2]
        MOVQ R1, #2
        CALL CHECK
        LD   R0, [ORDLOG+4]
        MOVQ R1, #4
        CALL CHECK
        ; #31 IF = 0: each handler acknowledged its own bit
        LD   R0, [IF]
        MOVQ R1, #0
        CALL CHECK
        JMP  PASS
