; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Conformance harness (included by every conformance ROM).
; Convention: R7 holds the current check number. CHECK_EQ-style tests branch
; to FAIL on mismatch. PASS writes $600D to RESULT; FAIL writes R7. Both STOP.
RESULT = $8000

PASS:   MOVW R6, #$600D
        ST   R6, [RESULT]
        STOP
FAIL:   ST   R7, [RESULT]
        STOP

; CHECK: compare R0 (actual) with R1 (expected); on mismatch FAIL with R7,
; otherwise advance R7 to the next check number. Uses flags.
CHECK:  CMP  R0, R1
        BNE  FAIL
        ADDQ R7, #1
        RTS
