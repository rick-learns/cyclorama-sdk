; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; SDK library reference (docs/guide/sdk-library.md): the Cue Sound Driver's assembly entry
; points. Plays the song from power-on; A fires an effect, B plays the jingle, START fades the
; music out. tests/example-sdk-library.test.ts checks each.
        .org $0000
        .word start, vblank, 0, 0, 0    ; RESET, VBLANK, LINE, TIMER, TRAP vectors
        .header title="SDK DRIVER", dev=$0000, date=$19870918, version=$0100

SND_RAM = $8100                         ; the driver's RAM: SND_RAM_SIZE (272) bytes, even
PREV    = $8000                         ; last frame's pad

        .org $0040
start:  MOVQ R0, #0
        ST   R0, [PREV]
        CALL SND_INIT                   ; voices off, driver RAM cleared, MASTERVOL 15
        MOVW R0, #SONG_tune
        CALL SND_PLAY_SONG              ; the first row plays on the next SND_TICK
        MOVQ R0, #1
        ST   R0, [IF]
        ST   R0, [IE]
        EI
main:   WAI
        BRA  main

vblank: PUSHM R0-R2                     ; the entries change R0 only; R1 and R2 are ours
        CALL SND_TICK                   ; first thing in VBLANK: steady timing
        LD   R1, [PAD1]
        LD   R2, [PREV]
        ST   R1, [PREV]
        NOT  R2
        AND  R2, R1                     ; R2 = buttons newly pressed
        TST  R2, #16                    ; A: an effect on voice 2
        BEQ  .noa
        MOVW R0, #SFX_blip
        CALL SND_SFX
.noa:   TST  R2, #32                    ; B: the jingle replaces the song
        BEQ  .nob
        MOVW R0, #SONG_jingle
        CALL SND_PLAY_SONG
.nob:   TST  R2, #128                   ; START: one volume step every 4 frames, then stop
        BEQ  .nos
        MOVQ R0, #4
        CALL SND_FADE
.nos:   MOVQ R0, #1
        ST   R0, [IF]                   ; acknowledge the VBLANK
        POPM R0-R2
        RTI

        .include "../../roms/lib/cuesound.inc"
        .include "sdk-library.song.inc"
