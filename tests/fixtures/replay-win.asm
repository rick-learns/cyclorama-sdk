; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; REPLAY FIXTURE: test cartridge for tools/replay.ts (not a canon release).
; A tiny game with a real ending state: press A, then B, then START, each a fresh press, in
; that order. Any other fresh press sends the player back to the start of the sequence.
; Completing it sets GSTATE to WON ($0002) for good and records, in WONAT, the VBLANK count
; at which it happened (so an input that wins a frame later ends in a different state).

        .org $0000
        .word start, vblank, 0, 0, 0
        .header title="REPLAY FIXTURE", dev=$0001, date=$19870301, version=$0100

GSTATE  = $8000         ; game state: 0 playing, 2 won (the documented ending state)
STEP    = $8002         ; 0 expects A, 1 expects B, 2 expects START
PREV    = $8004         ; last frame's pad
TICKS   = $8006         ; VBLANKs since power-on
WONAT   = $8008         ; TICKS when the sequence was completed

PAD_A     = 16
PAD_B     = 32
PAD_START = 128
WON       = 2

        .org $0040
start:  MOVQ R0, #1
        ST   R0, [IF]
        ST   R0, [IE]               ; VBLANK
        EI
main:   WAI
        BRA  main

vblank: PUSHM R0-R3
        LD   R3, [TICKS]
        ADDQ R3, #1
        ST   R3, [TICKS]
        LD   R0, [GSTATE]
        CMP  R0, #WON
        BEQ  .out                   ; the ending is final
        LD   R0, [PAD1]
        LD   R1, [PREV]
        ST   R0, [PREV]
        NOT  R1
        AND  R1, R0                 ; R1 = newly pressed buttons
        BEQ  .out
        LD   R2, [STEP]
        CMP  R2, #0
        BNE  .s1
        MOVQ R0, #PAD_A
        BRA  .cmp
.s1:    CMP  R2, #1
        BNE  .s2
        MOVQ R0, #PAD_B
        BRA  .cmp
.s2:    MOVW R0, #PAD_START
.cmp:   CMP  R1, R0
        BEQ  .good
        MOVQ R2, #0                 ; wrong button: back to the start
        ST   R2, [STEP]
        BRA  .out
.good:  ADDQ R2, #1
        ST   R2, [STEP]
        CMP  R2, #3
        BNE  .out
        MOVQ R0, #WON
        ST   R0, [GSTATE]
        ST   R3, [WONAT]
.out:   MOVQ R0, #1
        ST   R0, [IF]
        POPM R0-R3
        RTI
