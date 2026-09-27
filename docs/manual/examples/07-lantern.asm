; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Example 7: Lantern. Light 0 follows a 16x16 sprite through an ambient
; dark. OAM entry 0 is kept in work RAM and copied to OAM each frame.
ShadowOAM = $8100               ; +0 Y, +2 X of sprite 0 (signed 9-bit)

        .org    $0700
LanternInit:
        MOV     R0, #7
        ST      R0, [L0I]       ; brightest positive intensity
        MOV     R0, #(0 << 4) | 3
        ST      R0, [L0F]       ; diamond shape, distance >> 3
        MOV     R0, #0
        ST      R0, [AMBIENT]   ; unlit areas fall to shade 0
        MOV     R0, #%11011     ; display, BG0, sprites, light field
        ST      R0, [VCTRL]
        RTS

LanternUpdate:                  ; call once per frame during vertical blank
        MOV     R1, #ShadowOAM
        LD      R0, [R1+2]      ; sprite X
        SHL     R0, #7
        ASR     R0, #7          ; sign-extend from bit 8
        ADD     R0, #8          ; centre of the 16x16 sprite
        ST      R0, [L0X]
        LD      R0, [R1]        ; sprite Y
        SHL     R0, #7
        ASR     R0, #7
        ADD     R0, #8
        ST      R0, [L0Y]
        RTS
