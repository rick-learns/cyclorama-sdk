; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Conformance 14: controller sampling (spec-notes §5, §8.29; manual ch. 7; registers.ts PAD1/PAD2).
; PAD1 is sampled at dot 0 of line 224 and held for the frame; bits 15-8 read 0; PAD2 (no
; controller) reads 0. The host supplies one controller-1 value per frame (runner pad script):
; @pads 3:$08 6:$FF10 9:$80 12:0
; i.e. frames 0-2: 0, frames 3-5: 0008 (Right), frames 6-8: FF10 (A, plus bits 15-8 that the
; console must drop), frames 9-11: 0080 (START), frame 12 on: 0.
; Frame n's value is sampled at line 224 of frame n. The ROM tracks frames by counting VBLANK
; wakes (it starts at line 0 of frame 0, spec-notes §8.31).
        .org $0000
        .word start, VBH, 0, 0, 0
        .header title="CONFORMANCE 14 INPUT", dev=$0001, date=$19870301, version=$0100
        .org $0040
        .include "_harness.inc"
        .include "_hw.inc"

PADV   = $8100
VBLINE = $8102

VBH:    PUSH R0
        LD   R0, [PAD1]
        ST   R0, [PADV]
        LD   R0, [VCOUNT]
        ST   R0, [VBLINE]
        MOVQ R0, #1
        ST   R0, [IF]
        POP  R0
        RTI

; PADIS: check PAD1 = R1.
PADIS:  LD   R0, [PAD1]
        BRA  CHECK

start:  MOVQ R7, #1
        ; #1 frame 0, line 0: PAD1 = 0 (reset)
        MOVQ R1, #0
        CALL PADIS
        ; #2 frame 0, line 224: sample of frame 0 = 0
        CALL WAITVB
        MOVQ R1, #0
        CALL PADIS
        ; #3 frame 2, line 224: 0
        CALL WAITVB
        CALL WAITVB
        MOVQ R1, #0
        CALL PADIS
        ; #4 frame 3, line 0: the host's frame-3 value (0008) is not sampled yet
        MOVQ R0, #0
        CALL WAITVC
        MOVQ R1, #0
        CALL PADIS
        ; #5 frame 3, line 223 (horizontal blank, the last moment before the sample): still 0
        MOVW R0, #223
        CALL WAITLN
        MOVQ R1, #0
        CALL PADIS
        ; #6 frame 3, line 224: 0008. (Poll VCOUNT: WAITVB here would acknowledge the VBLANK
        ; request raised while the check above ran and sleep a whole frame.)
        MOVW R0, #224
        CALL WAITVC
        MOVQ R1, #8
        CALL PADIS
        ; #7 held through frame 4, line 100
        MOVQ R0, #100
        CALL WAITVC
        MOVQ R1, #8
        CALL PADIS
        ; #8-#9 frames 4 and 5 sample 0008 again
        CALL WAITVB
        MOVQ R1, #8
        CALL PADIS
        CALL WAITVB
        MOVQ R1, #8
        CALL PADIS
        ; #10 frame 6, line 223: the host now gives FF10 but PAD1 still holds 0008
        MOVW R0, #223
        CALL WAITLN
        MOVQ R1, #8
        CALL PADIS
        ; #11 frame 6, line 224: FF10 sampled; bits 15-8 read 0 -> 0010
        MOVW R0, #224
        CALL WAITVC
        MOVQ R1, #$10
        CALL PADIS
        ; #12 byte read of the high half: 00
        LDB  R0, [PAD1+1]
        MOVQ R1, #0
        CALL CHECK
        ; #13 byte read of the low half: 10
        LDB  R0, [PAD1]
        MOVQ R1, #$10
        CALL CHECK
        ; #14 PAD2: no controller, 0
        LD   R0, [PAD2]
        MOVQ R1, #0
        CALL CHECK
        ; #15-#17 every read in frame 7 returns the same value (lines 0, 111, 223)
        MOVQ R0, #0
        CALL WAITVC
        MOVQ R1, #$10
        CALL PADIS
        MOVQ R0, #111
        CALL WAITVC
        MOVQ R1, #$10
        CALL PADIS
        MOVW R0, #223
        CALL WAITVC
        MOVQ R1, #$10
        CALL PADIS
        ; #18-#19 frames 7 and 8 sample FF10 -> 0010
        CALL WAITVB
        MOVQ R1, #$10
        CALL PADIS
        CALL WAITVB
        MOVQ R1, #$10
        CALL PADIS
        ; #20 frame 9 through the VBLANK interrupt: the handler already sees 0080
        MOVQ R0, #1
        ST   R0, [IE]
        ST   R0, [IF]
        EI
        WAI
        DI
        LD   R0, [PADV]
        MOVW R1, #$80
        CALL CHECK
        ; #21 ...and it ran on line 224
        LD   R0, [VBLINE]
        MOVW R1, #224
        CALL CHECK
        ; #22-#23 frames 10 and 11: 0080
        CALL WAITVB
        MOVW R1, #$80
        CALL PADIS
        CALL WAITVB
        MOVW R1, #$80
        CALL PADIS
        ; #24 frame 12: released, 0
        CALL WAITVB
        MOVQ R1, #0
        CALL PADIS
        ; #25 writes to PAD1 are ignored (read-only)
        MOVW R0, #$00FF
        ST   R0, [PAD1]
        MOVQ R1, #0
        CALL PADIS
        MOVQ R0, #0
        ST   R0, [IE]
        JMP  PASS
