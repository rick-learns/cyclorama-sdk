; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Example 2: a VBLANK handler that counts frames, keeps the pad state,
; loads scroll from a shadow copy and acknowledges IF bit 0.
FrameCount = $8000              ; work RAM variables
Pad1Now    = $8002
ScrollX    = $8004

        .org    $0002
        .word   VBlank          ; VBLANK vector

        .org    $0200
VBlank: PUSHM   R0-R1
        LD      R0, [FrameCount]
        INC     R0
        ST      R0, [FrameCount]
        LD      R0, [PAD1]      ; sampled at dot 0 of line 224
        ST      R0, [Pad1Now]
        LD      R0, [ScrollX]
        ST      R0, [BG0SCX]    ; latched at dot 0 of line 0 of the next frame
        MOV     R1, #1
        ST      R1, [IF]        ; acknowledge VBLANK (bit 0)
        POPM    R0-R1
        RTI
