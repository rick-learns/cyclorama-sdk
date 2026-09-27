; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; CUE SOUND TEST — Cyclorama Development Kit test cartridge (1987).
; Plays the kit's demo theme "Followspot" through the Cue Sound Driver and fires sound
; effects over it from the pad, showing what each Cue voice is doing.
;   A jump   B gem   C boom   LEFT power-up   UP hurry tempo   DOWN normal tempo
;   START fade out (or play again once faded)
; Effects borrow voice 2 (chords) or voice 3 (drums): lead and bass never drop out.
; It starts straight into its own screen: an open demo shows no Curtain Up splash (a brand asset,
; not part of the SDK: TRADEMARKS.md), and the console never checks for one.

        .org $0000
        .word start, vblank, 0, 0, 0
        .header title="CUE SOUND TEST", dev=$0001, date=$19870301, version=$0100

PREV    = $8000         ; last frame's pad
SND_RAM = $8100         ; Cue Sound Driver RAM (SND_RAM_SIZE bytes)
MAP     = $6000         ; BG0 map
ROW     = 128           ; bytes per map row
COL_V   = 8             ; map column of voice 0's readout (voice v at COL_V + 6v)
HURRY   = SONG_theme_RATE * 5 / 4

        .org $0040
start:  MOVW R0, #MAP                   ; display off from reset; VRAM is undefined: clear the BG0 map
        ST   R0, [VADDR]
        MOVQ R0, #0
        MOVW R1, #2048
.map:   ST   R0, [VDATA]
        ADDQ R1, #-1
        BNE  .map
        ST   R0, [DMADST]               ; font: tiles 0-63 = ASCII 32-95, one DMA
        ST   R0, [DMADST]
        MOVW R0, #FONT0
        ST   R0, [DMASRC]
        MOVW R0, #64 * 12
        ST   R0, [DMALEN]
        MOVQ R0, #1
        ST   R0, [DMACTL]
        MOVW R0, #7 * 64                ; light field off: every pixel uses shade plane 7
        ST   R0, [CRAMADDR]
        MOVW R1, #COLOURS
        MOVQ R2, #24
.cram:  LD   R0, [R1]+
        ST   R0, [CRAMDATA]
        ADDQ R2, #-1
        BNE  .cram
        MOVW R1, #TEXTS                 ; static text: records of map address, attribute, string
.text:  LD   R2, [R1]+
        TST  R2, R2
        BEQ  .song
        ST   R2, [VADDR]
        LD   R3, [R1]+
        CALL print
        ADDQ R1, #1                     ; to the next even address
        AND  R1, #$FFFE
        BRA  .text
.song:  MOVW R0, #MAP + 6 * ROW + 8 * 2
        ST   R0, [VADDR]
        MOVW R1, #SONG_theme_TITLE
        MOVW R3, #$0800                 ; palette 2
        CALL print
        CALL SND_INIT
        MOVW R0, #SONG_theme
        CALL SND_PLAY_SONG
        LD   R0, [PAD1]                 ; a button already held at power-on is not a press
        ST   R0, [PREV]
        CALL show
        MOVQ R0, #1|2                   ; display, BG0
        ST   R0, [VCTRL]
        MOVQ R0, #1
        ST   R0, [IF]
        ST   R0, [IE]
        EI
main:   WAI
        BRA  main

; --- VBLANK: sound first (steady timing), then the pad, then the readout ---------------
vblank: PUSHM R0-R7
        CALL SND_TICK
        LD   R0, [PAD1]
        LD   R4, [PREV]
        ST   R0, [PREV]
        NOT  R4
        AND  R4, R0                     ; R4 = newly pressed buttons
        TST  R4, #16
        BEQ  .nb_a
        MOVW R0, #SFX_jump
        CALL SND_SFX
.nb_a:  TST  R4, #32
        BEQ  .nb_b
        MOVW R0, #SFX_gem
        CALL SND_SFX
.nb_b:  TST  R4, #64
        BEQ  .nb_c
        MOVW R0, #SFX_boom
        CALL SND_SFX
.nb_c:  TST  R4, #4
        BEQ  .nb_l
        MOVW R0, #SFX_power
        CALL SND_SFX
.nb_l:  TST  R4, #1
        BEQ  .nb_u
        MOVW R0, #HURRY
        CALL SND_TEMPO
.nb_u:  TST  R4, #2
        BEQ  .nb_d
        MOVQ R0, #0
        CALL SND_TEMPO
.nb_d:  TST  R4, #128
        BEQ  .nb_s
        CALL SND_STATUS
        TST  R0, #15
        BEQ  .again
        MOVQ R0, #3                     ; fade: one volume step every 3 frames
        CALL SND_FADE
        BRA  .nb_s
.again: MOVW R0, #SONG_theme
        CALL SND_PLAY_SONG
.nb_s:  BSR  show
        MOVQ R0, #1
        ST   R0, [IF]
        POPM R0-R7
        RTI

; show: per voice, who has it (MUS / SFX / ---), its volume and FREQ; the tempo; the row.
show:   CALL SND_STATUS
        MOV  R5, R0
        MOVQ R6, #0                     ; voice
.voice: MOV  R1, R6                     ; map address of this voice's column, row 11
        ADD  R1, R1
        ADD  R1, R6
        ADD  R1, R1
        ADD  R1, R1                     ; x 12 = 6 columns x 2 bytes
        ADD  R1, #MAP + 11 * ROW + COL_V * 2
        ST   R1, [VADDR]
        MOVW R2, #USE_MUS
        MOVQ R3, #16
        SHL  R3, R6
        TST  R5, R3
        BNE  .sfx
        MOVQ R3, #1
        SHL  R3, R6
        TST  R5, R3
        BNE  .put
        MOVW R2, #USE_NONE
        BRA  .put
.sfx:   MOVW R2, #USE_SFX
.put:   MOV  R7, R1
        MOV  R1, R2
        MOVW R3, #$0800
        CALL print
        MOV  R1, R7
        ADD  R1, #ROW                   ; row 12: volume, CTRL bits 11-8
        ST   R1, [VADDR]
        MOV  R2, R6
        SHL  R2, #3
        ADD  R2, #V0CTRL
        LD   R0, [R2]
        SHR  R0, #8
        BSR  hexdigit
        ADD  R1, #ROW                   ; row 13: FREQ
        ST   R1, [VADDR]
        LD   R0, [R2-6]
        BSR  hexword
        ADDQ R6, #1
        CMP  R6, #4
        BNE  .voice
        MOVW R0, #MAP + 7 * ROW + 8 * 2 ; tempo
        ST   R0, [VADDR]
        LD   R0, [SND_RATE]
        MOVW R1, #TXT_NORMAL
        CMP  R0, #HURRY
        BNE  .t
        MOVW R1, #TXT_HURRY
.t:     MOVW R3, #$0800
        CALL print
        MOVW R0, #MAP + 22 * ROW + 8 * 2 ; row counter
        ST   R0, [VADDR]
        LD   R0, [SND_ROWS]
        BRA  hexword

; print: write the string at R1 (zero-terminated) at VADDR with attribute bits R3. R1 ends past the 0.
print:  LDB  R0, [R1]+
        TST  R0, R0
        BEQ  .end
        ADDQ R0, #-32
        OR   R0, R3
        ST   R0, [VDATA]
        BRA  print
.end:   RTS

; hexword: four hex digits of R0 at VADDR (palette 2). hexdigit: the low digit of R0. Keep R1-R7.
hexword:
        PUSH R0
        SHR  R0, #12
        BSR  hexdigit
        LD   R0, [SP]
        SHR  R0, #8
        BSR  hexdigit
        LD   R0, [SP]
        SHR  R0, #4
        BSR  hexdigit
        POP  R0
hexdigit:
        AND  R0, #15
        CMP  R0, #10
        BLO  .num
        ADDQ R0, #'A' - '0' - 10
.num:   ADD  R0, #'0' - 32 + $0800
        ST   R0, [VDATA]
        RTS

; --- data ------------------------------------------------------------------------------
        .align 2
COLOURS:                                ; shade plane 7, palettes 0-2 (ink 1, shadow 2)
        .word $102, $FE8, $213, 0, 0, 0, 0, 0
        .word 0, $6CF, $213, 0, 0, 0, 0, 0
        .word 0, $F96, $213, 0, 0, 0, 0, 0
TEXTS:  .word MAP + 2 * ROW + 9 * 2, $0400
        .asciz "CUE SOUND TEST"
        .align 2
        .word MAP + 3 * ROW + 3 * 2, 0
        .asciz "CYCLORAMA DEVELOPMENT KIT"
        .align 2
        .word MAP + 6 * ROW + 2 * 2, 0
        .asciz "SONG"
        .align 2
        .word MAP + 7 * ROW + 2 * 2, 0
        .asciz "TEMPO"
        .align 2
        .word MAP + 9 * ROW + 2 * 2, $0400
        .asciz "VOICE   0     1     2     3"
        .align 2
        .word MAP + 10 * ROW + 2 * 2, 0
        .asciz "PART  LEAD  BASS  CHRD  DRUM"
        .align 2
        .word MAP + 11 * ROW + 2 * 2, 0
        .asciz "USE"
        .align 2
        .word MAP + 12 * ROW + 2 * 2, 0
        .asciz "VOL"
        .align 2
        .word MAP + 13 * ROW + 2 * 2, 0
        .asciz "FREQ"
        .align 2
        .word MAP + 16 * ROW + 2 * 2, $0400
        .asciz "A JUMP   B GEM   C BOOM"
        .align 2
        .word MAP + 17 * ROW + 2 * 2, $0400
        .asciz "LEFT POWER-UP"
        .align 2
        .word MAP + 18 * ROW + 2 * 2, $0400
        .asciz "UP HURRY   DOWN NORMAL"
        .align 2
        .word MAP + 19 * ROW + 2 * 2, $0400
        .asciz "START FADE OUT / PLAY"
        .align 2
        .word MAP + 22 * ROW + 2 * 2, 0
        .asciz "ROW"
        .align 2
        .word 0
USE_MUS:    .asciz "MUS"
USE_SFX:    .asciz "SFX"
USE_NONE:   .asciz "---"
TXT_NORMAL: .asciz "NORMAL"
TXT_HURRY:  .asciz "HURRY "

        .align 2
        .include "sound-test.art.inc"
        .include "../lib/cuesound.inc"
        .include "sound-test.song.inc"
