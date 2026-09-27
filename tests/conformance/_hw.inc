; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Hardware-test helpers for conformance ROMs 08-14 (include after _harness.inc).
; Every helper expects I = 0 (interrupts disabled) and clobbers only R6 unless noted.
; Timing facts used by the ROMs (spec-notes §1 "Timing scheduler", §10.46):
;   line = 228 CPU cycles, frame = 262 lines = 59,736 CPU cycles; one CPU cycle = 6 master.
;   VBLANK IF is set at dot 0 of line 224 (master 0 of the line, a CPU-cycle boundary), so a
;   WAI woken by it resumes exactly at cycle 0 of line 224.
;   LINE IF is set at dot 256 = master 1024 of the line; the first CPU-cycle boundary at or
;   after it is master 1026 = cycle 171, so a WAI woken by it resumes at cycle 171 of the line
;   (hblank runs from cycle 170.67 to 228).
;   LD/ST [abs16] cost 6 cycles (CYCLES.memExt); WAI 2; ST/RTS 6; CALL 8.

; CHECKR: range check, R1 <= R0 <= R2 (unsigned). Same contract as CHECK.
CHECKR: CMP  R0, R1
        BLO  FAIL
        CMP  R2, R0
        BLO  FAIL
        ADDQ R7, #1
        RTS

; WAITVB: sleep until dot 0 of line 224 (start of vertical blank). Leaves IE = 1, IF bit 0 clear.
; Returns 12 cycles after the wake (ST 6 + RTS 6), i.e. at cycle 12 of line 224.
WAITVB: MOVQ R6, #1
        ST   R6, [IE]
        ST   R6, [IF]
        WAI
        ST   R6, [IF]
        RTS

; WAITLN: R0 = line (0-261). Sleep until dot 256 of that line. Leaves LINECMP = R0, IE = 2,
; IF bit 1 clear. Returns at cycle 171 + 12 = 183 of the line (horizontal blank).
WAITLN: ST   R0, [LINECMP]
        MOVQ R6, #2
        ST   R6, [IE]
        ST   R6, [IF]
        WAI
        ST   R6, [IF]
        RTS

; WAITVC: R0 = line. Poll until VCOUNT = R0 (loop of 14 cycles).
WAITVC: LD   R6, [VCOUNT]
        CMP  R6, R0
        BNE  WAITVC
        RTS

; LINESTART: R0 = line (1-261). Return early in that line's active part: waits for dot 256 of
; line R0 - 1, then polls VCOUNT. The first poll that sees the new line starts at most 14 cycles
; after its dot 0, so this returns before cycle 14 + 6 + 4 + 2 + 6 = 32 of the line (dot < 48).
LINESTART:
        ADDQ R0, #-1
        CALL WAITLN
        ADDQ R0, #1
        BRA  WAITVC

; TSTART: run the timer at prescaler 1 (one count per CPU cycle) from FFFF, reload FFFF.
; A measurement "LD R4,[TCOUNT] / op / LD R5,[TCOUNT]" then gives R4 - R5 = 6 + cycles(op),
; because every register read happens at its instruction's start (spec-notes §1).
TSTART: MOVW R6, #$FFFF
        ST   R6, [TRELOAD]
        ST   R6, [TCOUNT]
        MOVQ R6, #1
        ST   R6, [TCTRL]
        RTS
