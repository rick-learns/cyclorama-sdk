; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
;
; ===========================================================================
; CUE SOUND DRIVER            Cyclorama Development Kit, 1987 (roms/lib/cuesound.inc)
; Music and sound effects for the Cue (AV-3105): songs and effects are written as
; .song text and converted by the kit (tools/song.ts); see roms/lib/README.md.
;
; Before including this file the game defines where the driver's RAM lives:
;         SND_RAM = $8100           ; SND_RAM_SIZE (272) bytes of work RAM, even address
;         .include "../lib/cuesound.inc"
;
; Entry points (assembly convention): argument in R0; R1-R7 are preserved, R0 is not
; (SND_TICK preserves R0 too). Flags are not preserved. Each entry that changes shared
; state runs with interrupts masked and restores the caller's interrupt enable.
;   SND_INIT               silence all four voices, clear the driver RAM, MASTERVOL 15
;   SND_PLAY_SONG  R0=song start a song (SONG_name) from its first row
;   SND_STOP               stop the music (sound effects play on)
;   SND_SFX        R0=sfx  start an effect (SFX_name) on the voice it names; the music on
;                          that voice goes quiet until the effect ends, the others play on
;   SND_TICK               call once per frame (VBLANK): advances music, effects, fades
;   SND_TEMPO      R0=rate override the tempo (rows per frame x 55440; 0 = the song's own)
;   SND_FADE       R0=n    fade out: master volume down one step every n frames, then stop
;                          (0 = cancel and restore full volume)
;   SND_STATUS     -> R0   bits 0-3: music playing on voice 0-3; bits 4-7: effect on voice 0-3
; Footprint: SND_RAM_SIZE = 272 bytes of RAM, at most 26 bytes of stack. SND_TICK costs at most
; about 2,200 CPU cycles (measured worst case 2,166 = 3.6% of the 59,736-cycle frame).
; SCRIM / stack convention entries (argument pushed as a word, caller pops, result in R0,
; R1-R7 preserved): SndInit SndPlaySong SndStop SndSfx SndTick SndTempo SndFade SndStatus.
; ===========================================================================

        .align 2

SND_RAM_SIZE    = 16 + 8 * 32       ; globals + 4 music tracks + 4 effect tracks
SND_TEMPO_ONE   = 55440             ; a row falls due each time the accumulator passes this
SND_FULL_VOLUME = 15

; ---- globals
SND_ACC     = SND_RAM + 0           ; tempo accumulator
SND_RATE    = SND_RAM + 2           ; tempo in use
SND_SRATE   = SND_RAM + 4           ; the song's own tempo
SND_SONG    = SND_RAM + 6           ; song header address (0 = none yet)
SND_ROWS    = SND_RAM + 8           ; rows played since SND_PLAY_SONG (wraps)
SND_MVOL    = SND_RAM + 10          ; byte: master volume the driver keeps in MASTERVOL
SND_FADE_N  = SND_RAM + 11          ; byte: frames per fade step (0 = not fading)
SND_FADE_C  = SND_RAM + 12          ; byte: fade countdown
SND_PLAYING = SND_RAM + 13          ; byte: 1 while a song is running
SND_TRACKS  = SND_RAM + 16          ; tracks 0-3: music on voices 0-3
SND_SFXTRACKS = SND_TRACKS + 4 * 32 ; tracks 4-7: effects on voices 0-3
SND_TRACK_SIZE = 32

; ---- track fields (offsets from a track's address)
SND_T_PTR   = 0                     ; word: next pattern byte (0 = track idle)
SND_T_ORD   = 2                     ; word: next order-list entry (music only)
SND_T_INST  = 4                     ; word: current instrument record
SND_T_IBASE = 6                     ; word: instrument table of the song or effect
SND_T_VREG  = 8                     ; word: the voice's registers (V0FREQ + 8 x voice)
SND_T_FREQ  = 10                    ; word: FREQ of the current note
SND_T_SLIDE = 12                    ; word: pitch slide accumulated since the note began
SND_T_OUT   = 14                    ; word: FREQ last computed (written unless muted)
SND_T_WAIT  = 16                    ; byte: empty rows still to wait
SND_T_NOTE  = 17                    ; byte: note number 0-107
SND_T_KEY   = 18                    ; byte: 1 while the note is keyed on
SND_T_MUTE  = 19                    ; byte: 1 while an effect has the voice (music tracks)
SND_T_AGE   = 20                    ; byte: frames since note-on (stops at 255)
SND_T_VPH   = 21                    ; byte: vibrato phase
SND_T_ARP   = 22                    ; byte: arpeggio step
SND_T_PRIO  = 23                    ; byte: effect priority
SND_T_SPD   = 24                    ; byte: effect frames per row
SND_T_CNT   = 25                    ; byte: effect frame countdown

; ---- instrument record (16 bytes, emitted by tools/song.ts)
SND_I_WAVE   = 0                    ; byte: VxWAVE value
SND_I_ENV    = 1                    ; byte: VxENV value
SND_I_FIXED  = 2                    ; word: fixed FREQ (0 = the note's pitch)
SND_I_SLIDE  = 4                    ; word: signed FREQ change per frame
SND_I_VDEPTH = 6                    ; byte: vibrato depth (x 1/1024 of the pitch), 0 = none
SND_I_VSPEED = 7                    ; byte: vibrato phase step per frame
SND_I_VDELAY = 8                    ; byte: frames before vibrato starts
SND_I_ARPLEN = 9                    ; byte: arpeggio length (0 = none)
SND_I_ARP    = 10                   ; word: arpeggio offsets (signed bytes)

; ---------------------------------------------------------------- SND_INIT
SND_INIT:
        PUSHM R1-R3
        GETF R3
        DI
        MOVW R1, #SND_RAM
        MOVW R2, #SND_RAM_SIZE / 2
        MOVQ R0, #0
.clear: ST   R0, [R1]+
        ADDQ R2, #-1
        BNE  .clear
        MOVW R1, #SND_TRACKS + SND_T_VREG
        MOVW R0, #V0FREQ
        MOVQ R2, #8
.vreg:  ST   R0, [R1]
        ADDQ R0, #8
        ADDQ R1, #SND_TRACK_SIZE
        ADDQ R2, #-1
        CMP  R2, #4
        BNE  .same
        MOVW R0, #V0FREQ                ; effect tracks 4-7 drive voices 0-3 again
.same:  TST  R2, R2
        BNE  .vreg
        MOVQ R0, #0
        ST   R0, [V0CTRL]
        ST   R0, [V1CTRL]
        ST   R0, [V2CTRL]
        ST   R0, [V3CTRL]
        MOVQ R0, #SND_FULL_VOLUME
        STB  R0, [SND_MVOL]
        ST   R0, [MASTERVOL]
        SETF R3
        POPM R1-R3
        RTS

; ---------------------------------------------------------------- SND_PLAY_SONG
; Song header: .word rate, instruments, wavetable (0 = none), order list for voice 0..3 (0 = unused).
SND_PLAY_SONG:
        PUSHM R1-R7
        GETF R7
        DI
        MOV  R3, R0
        BSR  snd_halt
        ST   R3, [SND_SONG]
        LD   R0, [R3]
        ST   R0, [SND_SRATE]
        ST   R0, [SND_RATE]
        MOVW R0, #SND_TEMPO_ONE - 1     ; the first row falls due on the next tick
        ST   R0, [SND_ACC]
        MOVQ R0, #0
        ST   R0, [SND_ROWS]
        STB  R0, [SND_FADE_N]
        MOVQ R0, #SND_FULL_VOLUME
        STB  R0, [SND_MVOL]
        ST   R0, [MASTERVOL]
        LD   R1, [R3+4]
        TST  R1, R1
        BEQ  .nowave
        MOVW R2, #WAVE0
        MOVQ R4, #8
.wave:  LD   R0, [R1]+
        ST   R0, [R2]+
        ADDQ R4, #-1
        BNE  .wave
.nowave:
        LD   R5, [R3+2]
        ADDQ R3, #6
        MOVW R6, #SND_TRACKS
        MOVQ R4, #4
.voice: LD   R1, [R3]+
        TST  R1, R1
        BEQ  .next
        LD   R0, [R1]+
        ST   R0, [R6+SND_T_PTR]
        ST   R1, [R6+SND_T_ORD]
        ST   R5, [R6+SND_T_IBASE]
        ST   R5, [R6+SND_T_INST]
        MOVQ R0, #0
        STB  R0, [R6+SND_T_WAIT]
        STB  R0, [R6+SND_T_KEY]
.next:  ADDQ R6, #SND_TRACK_SIZE
        ADDQ R4, #-1
        BNE  .voice
        MOVQ R0, #1
        STB  R0, [SND_PLAYING]
        SETF R7
        POPM R1-R7
        RTS

; ---------------------------------------------------------------- SND_STOP
SND_STOP:
        PUSHM R1-R7
        GETF R7
        DI
        BSR  snd_halt
        SETF R7
        POPM R1-R7
        RTS

; snd_halt: end every music track; key off the voices the music holds. Uses R0-R2, R6.
snd_halt:
        MOVW R6, #SND_TRACKS
        MOVQ R2, #4
.track: LD   R0, [R6+SND_T_PTR]
        TST  R0, R0
        BEQ  .next
        MOVQ R0, #0
        ST   R0, [R6+SND_T_PTR]
        ST   R0, [R6+SND_T_ORD]
        STB  R0, [R6+SND_T_KEY]
        LDB  R1, [R6+SND_T_MUTE]
        TST  R1, R1
        BNE  .next
        LD   R1, [R6+SND_T_VREG]
        ST   R0, [R1+6]
.next:  ADDQ R6, #SND_TRACK_SIZE
        ADDQ R2, #-1
        BNE  .track
        MOVQ R0, #0
        STB  R0, [SND_PLAYING]
        RTS

; ---------------------------------------------------------------- SND_SFX
; Effect header: .byte voice, priority, frames per row, 0; .word instruments; pattern bytes.
; An effect replaces one already playing on its voice unless that one has a higher priority.
SND_SFX:
        PUSHM R1-R7
        GETF R7
        DI
        LDB  R6, [R0]
        AND  R6, #3
        SHL  R6, #5
        ADD  R6, #SND_SFXTRACKS
        LD   R1, [R6+SND_T_PTR]
        TST  R1, R1
        BEQ  .take
        LDB  R1, [R6+SND_T_PRIO]
        LDB  R2, [R0+1]
        CMP  R2, R1
        BLO  .done
.take:  LDB  R1, [R0+1]
        STB  R1, [R6+SND_T_PRIO]
        LDB  R1, [R0+2]
        STB  R1, [R6+SND_T_SPD]
        MOVQ R1, #1
        STB  R1, [R6+SND_T_CNT]         ; first row on the next tick
        LD   R1, [R0+4]
        ST   R1, [R6+SND_T_IBASE]
        ST   R1, [R6+SND_T_INST]
        MOV  R1, R0
        ADDQ R1, #6
        ST   R1, [R6+SND_T_PTR]
        MOVQ R1, #0
        ST   R1, [R6+SND_T_ORD]
        STB  R1, [R6+SND_T_WAIT]
        STB  R1, [R6+SND_T_KEY]
        MOVQ R1, #1
        STB  R1, [R6+SND_T_MUTE-4*SND_TRACK_SIZE]   ; the music track of this voice goes quiet
.done:  SETF R7
        POPM R1-R7
        RTS

; ---------------------------------------------------------------- SND_TEMPO
SND_TEMPO:
        TST  R0, R0
        BNE  .use
        LD   R0, [SND_SRATE]
.use:   CMP  R0, #SND_TEMPO_ONE
        BLS  .ok
        MOVW R0, #SND_TEMPO_ONE         ; at most one row per frame
.ok:    ST   R0, [SND_RATE]
        RTS

; ---------------------------------------------------------------- SND_FADE
SND_FADE:
        PUSH R1
        GETF R1
        DI
        CMP  R0, #255
        BLS  .ok
        MOVW R0, #255
.ok:    STB  R0, [SND_FADE_N]
        STB  R0, [SND_FADE_C]
        TST  R0, R0
        BNE  .go
        MOVQ R0, #SND_FULL_VOLUME
        STB  R0, [SND_MVOL]
        ST   R0, [MASTERVOL]
.go:    SETF R1
        POP  R1
        RTS

; ---------------------------------------------------------------- SND_STATUS
SND_STATUS:
        PUSHM R1-R3
        MOVQ R0, #0
        MOVQ R1, #1
        MOVW R2, #SND_TRACKS
.track: LD   R3, [R2+SND_T_PTR]
        TST  R3, R3
        BEQ  .next
        OR   R0, R1
.next:  ADD  R1, R1
        ADDQ R2, #SND_TRACK_SIZE
        CMP  R1, #256
        BNE  .track
        POPM R1-R3
        RTS

; ---------------------------------------------------------------- SND_TICK
SND_TICK:
        PUSHM R0-R7
        LDB  R0, [SND_FADE_N]
        TST  R0, R0
        BEQ  .tempo
        LDB  R1, [SND_FADE_C]
        ADDQ R1, #-1
        STB  R1, [SND_FADE_C]
        BNE  .tempo
        STB  R0, [SND_FADE_C]
        LDB  R1, [SND_MVOL]
        ADDQ R1, #-1
        BEQ  .faded
        STB  R1, [SND_MVOL]
        ST   R1, [MASTERVOL]
        BRA  .tempo
.faded: CALL snd_halt                  ; faded out: the music stops, full volume returns
        MOVQ R0, #0
        STB  R0, [SND_FADE_N]
        MOVQ R0, #SND_FULL_VOLUME
        STB  R0, [SND_MVOL]
        ST   R0, [MASTERVOL]
.tempo: MOVQ R7, #0                     ; R7 = 1 when a music row falls due this frame
        LDB  R0, [SND_PLAYING]
        TST  R0, R0
        BEQ  .sfx
        LD   R0, [SND_ACC]
        LD   R1, [SND_RATE]
        ADD  R0, R1
        BCS  .carry
        CMP  R0, #SND_TEMPO_ONE
        BLO  .norow
        SUB  R0, #SND_TEMPO_ONE
        BRA  .row
.carry: ADD  R0, #65536 - SND_TEMPO_ONE
.row:   MOVQ R7, #1
        LD   R1, [SND_ROWS]
        ADDQ R1, #1
        ST   R1, [SND_ROWS]
.norow: ST   R0, [SND_ACC]
        MOVW R6, #SND_TRACKS
        BSR  snd_music
        ADDQ R6, #SND_TRACK_SIZE
        BSR  snd_music
        ADDQ R6, #SND_TRACK_SIZE
        BSR  snd_music
        ADDQ R6, #SND_TRACK_SIZE
        BSR  snd_music
.sfx:   MOVW R6, #SND_SFXTRACKS
        BSR  snd_effect
        ADDQ R6, #SND_TRACK_SIZE
        BSR  snd_effect
        ADDQ R6, #SND_TRACK_SIZE
        BSR  snd_effect
        ADDQ R6, #SND_TRACK_SIZE
        BSR  snd_effect
        POPM R0-R7
        RTS

; snd_music: R6 = music track, R7 = row flag.
snd_music:
        LD   R0, [R6+SND_T_PTR]
        TST  R0, R0
        BEQ  .idle
        TST  R7, R7
        BEQ  .fx
        BSR  snd_row
.fx:    BRA  snd_fx
.idle:  RTS

; snd_effect: R6 = effect track; one row every SPD frames.
snd_effect:
        LD   R0, [R6+SND_T_PTR]
        TST  R0, R0
        BEQ  .idle
        LDB  R0, [R6+SND_T_CNT]
        ADDQ R0, #-1
        STB  R0, [R6+SND_T_CNT]
        BNE  .fx
        LDB  R0, [R6+SND_T_SPD]
        STB  R0, [R6+SND_T_CNT]
        BSR  snd_row
.fx:    BRA  snd_fx
.idle:  RTS

; snd_row: play one row of track R6. Pattern bytes: 00-6B note, 80-BF (n-1) empty rows,
; C0 key off, C1 i select instrument i, FF end of pattern. Uses R0-R5.
snd_row:
        LDB  R0, [R6+SND_T_WAIT]
        TST  R0, R0
        BEQ  .read
        ADDQ R0, #-1
        STB  R0, [R6+SND_T_WAIT]
        RTS
.read:  LD   R1, [R6+SND_T_PTR]
.next:  LDB  R0, [R1]+
        CMP  R0, #$80
        BLO  .note
        CMP  R0, #$C0
        BLO  .wait
        BEQ  .keyoff
        CMP  R0, #$C1
        BEQ  .inst
        LD   R2, [R6+SND_T_ORD]         ; FF: end of pattern
        TST  R2, R2
        BEQ  .sfxend
        LD   R1, [R2]+
        TST  R1, R1
        BNE  .pat
        LD   R2, [R2]                   ; end of the order list: its loop entry
        TST  R2, R2
        BEQ  .end
        LD   R1, [R2]+
.pat:   ST   R2, [R6+SND_T_ORD]
        BRA  .next
.inst:  LDB  R0, [R1]+
        SHL  R0, #4
        LD   R2, [R6+SND_T_IBASE]
        ADD  R0, R2
        ST   R0, [R6+SND_T_INST]
        BRA  .next
.wait:  AND  R0, #$3F
        STB  R0, [R6+SND_T_WAIT]
        BRA  .done
.keyoff:
        MOVQ R0, #0
        STB  R0, [R6+SND_T_KEY]
        LDB  R2, [R6+SND_T_MUTE]
        TST  R2, R2
        BNE  .done
        LD   R2, [R6+SND_T_VREG]
        ST   R0, [R2+6]
        BRA  .done
.note:  BSR  snd_note
.done:  ST   R1, [R6+SND_T_PTR]
        RTS
.sfxend:                                ; effect over: the voice goes back to the music
        MOVQ R0, #0
        ST   R0, [R6+SND_T_PTR]
        STB  R0, [R6+SND_T_KEY]
        LD   R2, [R6+SND_T_VREG]
        ST   R0, [R2+6]
        STB  R0, [R6+SND_T_MUTE-4*SND_TRACK_SIZE]
        RTS
.end:   MOVQ R0, #0                     ; a song without a loop: this voice is finished
        ST   R0, [R6+SND_T_PTR]
        ST   R0, [R6+SND_T_ORD]
        STB  R0, [R6+SND_T_KEY]
        LDB  R2, [R6+SND_T_MUTE]
        TST  R2, R2
        BNE  .quiet
        LD   R2, [R6+SND_T_VREG]
        ST   R0, [R2+6]
.quiet: RTS

; snd_note: key on note R0 on track R6 with its current instrument. Keeps R1.
snd_note:
        STB  R0, [R6+SND_T_NOTE]
        LD   R5, [R6+SND_T_INST]
        LD   R2, [R5+SND_I_FIXED]
        TST  R2, R2
        BNE  .fixed
        ADD  R0, R0
        LD   R2, [R0+SND_FREQS]
.fixed: ST   R2, [R6+SND_T_FREQ]
        MOVQ R0, #0
        ST   R0, [R6+SND_T_SLIDE]
        STB  R0, [R6+SND_T_AGE]
        STB  R0, [R6+SND_T_ARP]
        MOVQ R0, #64                    ; vibrato starts at the centre of its swing
        STB  R0, [R6+SND_T_VPH]
        MOVQ R0, #1
        STB  R0, [R6+SND_T_KEY]
        LDB  R0, [R6+SND_T_MUTE]
        TST  R0, R0
        BNE  .muted
        LD   R4, [R6+SND_T_VREG]
        LDB  R0, [R5+SND_I_WAVE]
        ST   R0, [R4+2]
        LDB  R0, [R5+SND_I_ENV]
        ST   R0, [R4+4]
        ST   R2, [R4]
        MOVQ R0, #1
        ST   R0, [R4+6]
.muted: RTS

; snd_fx: per-frame pitch of track R6: arpeggio, slide, vibrato; writes FREQ unless muted.
snd_fx:
        LDB  R0, [R6+SND_T_KEY]
        TST  R0, R0
        BEQ  .ret
        LD   R5, [R6+SND_T_INST]
        LD   R2, [R6+SND_T_FREQ]
        LDB  R0, [R5+SND_I_ARPLEN]
        TST  R0, R0
        BEQ  .slide
        LD   R3, [R5+SND_I_FIXED]
        TST  R3, R3
        BNE  .slide
        LDB  R3, [R6+SND_T_ARP]
        LD   R4, [R5+SND_I_ARP]
        ADD  R4, R3
        LDB  R4, [R4]
        SXB  R4
        ADDQ R3, #1
        CMP  R3, R0
        BLO  .step
        MOVQ R3, #0
.step:  STB  R3, [R6+SND_T_ARP]
        LDB  R2, [R6+SND_T_NOTE]
        ADD  R2, R4
        ADD  R2, R2
        LD   R2, [R2+SND_FREQS]
.slide: LD   R0, [R5+SND_I_SLIDE]
        TST  R0, R0
        BEQ  .vib
        LD   R3, [R6+SND_T_SLIDE]
        MOV  R4, R3
        ADD  R3, R0
        BVC  .keep
        MOV  R3, R4                     ; the slide stops at +-32767
.keep:  ST   R3, [R6+SND_T_SLIDE]
        TST  R3, R3
        BMI  .down
        ADD  R2, R3
        BCC  .vib
        MOVQ R2, #-1                    ; FREQ stops at FFFF
        BRA  .vib
.down:  ADD  R2, R3
        BCS  .vib
        MOVQ R2, #0                     ; FREQ stops at 0
.vib:   LDB  R0, [R5+SND_I_VDEPTH]
        TST  R0, R0
        BEQ  .age
        LDB  R3, [R6+SND_T_AGE]
        LDB  R4, [R5+SND_I_VDELAY]
        CMP  R3, R4
        BLO  .age
        LDB  R3, [R6+SND_T_VPH]
        LDB  R4, [R5+SND_I_VSPEED]
        ADD  R3, R4
        AND  R3, #255
        STB  R3, [R6+SND_T_VPH]
        CMP  R3, #128
        BLO  .rise
        XOR  R3, #255
.rise:  SHR  R3, #1
        ADDQ R3, #-32                   ; triangle -32..31
        MOV  R4, R2
        SHR  R4, #4
        MUL  R4, R0
        SHR  R4, #6                     ; swing = pitch x depth / 1024
        MUL  R4, R3
        ASR  R4, #5
        ADD  R2, R4
.age:   LDB  R3, [R6+SND_T_AGE]
        ADDQ R3, #1
        CMP  R3, #256
        BEQ  .out
        STB  R3, [R6+SND_T_AGE]
.out:   ST   R2, [R6+SND_T_OUT]
        LDB  R0, [R6+SND_T_MUTE]
        TST  R0, R0
        BNE  .ret
        LD   R4, [R6+SND_T_VREG]
        ST   R2, [R4]
.ret:   RTS

; ---------------------------------------------------------------- SCRIM / stack convention
SndInit:     JMP  SND_INIT
SndPlaySong: LD   R0, [SP+2]
             JMP  SND_PLAY_SONG
SndStop:     JMP  SND_STOP
SndSfx:      LD   R0, [SP+2]
             JMP  SND_SFX
SndTick:     JMP  SND_TICK
SndTempo:    LD   R0, [SP+2]
             JMP  SND_TEMPO
SndFade:     LD   R0, [SP+2]
             JMP  SND_FADE
SndStatus:   JMP  SND_STATUS

; ---------------------------------------------------------------- note table
; FREQ of C-0 .. B-8, equal temperament, A4 = 440 Hz: round(f x 65536 / 47,940.34) (manual 6.8).
SND_FREQS:
        .word    22,   24,   25,   27,   28,   30,   32,   33,   35,   38,   40,   42   ; octave 0
        .word    45,   47,   50,   53,   56,   60,   63,   67,   71,   75,   80,   84   ; octave 1
        .word    89,   95,  100,  106,  113,  119,  126,  134,  142,  150,  159,  169   ; octave 2
        .word   179,  189,  201,  213,  225,  239,  253,  268,  284,  301,  319,  338   ; octave 3
        .word   358,  379,  401,  425,  451,  477,  506,  536,  568,  601,  637,  675   ; octave 4
        .word   715,  758,  803,  851,  901,  955, 1012, 1072, 1135, 1203, 1275, 1350   ; octave 5
        .word  1431, 1516, 1606, 1701, 1802, 1910, 2023, 2143, 2271, 2406, 2549, 2701   ; octave 6
        .word  2861, 3031, 3212, 3403, 3605, 3819, 4046, 4287, 4542, 4812, 5098, 5401   ; octave 7
        .word  5722, 6063, 6423, 6805, 7210, 7639, 8093, 8574, 9084, 9624,10196,10802   ; octave 8
