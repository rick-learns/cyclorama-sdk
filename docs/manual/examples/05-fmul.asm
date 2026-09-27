; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Example 5: 8.8 fixed-point motion. Each frame: VY += gravity,
; VX *= friction, X += VX, Y += VY. The object record is in work RAM.
Obj      = $8030                ; +0 X, +2 Y, +4 VX, +6 VY, all signed 8.8
Gravity  = $0040                ; 0.25 pixel per frame per frame
Friction = $00E0                ; 0.875

        .org    $0500
Physics:
        MOV     R3, #Obj
        LD      R0, [R3+6]      ; VY
        ADD     R0, #Gravity    ; fits -128..127: one-word ADDQ
        ST      R0, [R3+6]
        LD      R1, [R3+2]      ; Y += VY
        ADD     R1, R0
        ST      R1, [R3+2]
        LD      R0, [R3+4]      ; VX
        FMUL    R0, #Friction   ; VX = VX x 0.875
        ST      R0, [R3+4]
        LD      R1, [R3]        ; X += VX
        ADD     R1, R0
        ST      R1, [R3]
        RTS
