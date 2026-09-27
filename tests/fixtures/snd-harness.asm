; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Cue Sound Driver test harness (tests/cuesound.test.ts). Not a cartridge.
; Mailbox: the test writes CMD (1-based command number) and ARG before a frame; the VBLANK
; handler first calls SND_TICK, then runs the command and clears CMD. Commands 7-14 call one
; driver entry with R1-R7 set to $1111 x n and R0 = ARG, then store R0-R7 at REGS.

        .org $0000
        .word start, vblank, 0, 0, 0
        .header title="SND HARNESS", dev=$0001, date=$19870301, version=$0100

CMD     = $8000
ARG     = $8002
RES     = $8004
SPB     = $8006         ; SP before a stack-convention call
SPA     = $8008         ; SP after it
REGS    = $8010         ; R0-R7 after a register check
SND_RAM = $8100

        .org $0040
start:  CALL SND_INIT
        MOVQ R0, #1
        ST   R0, [IF]
        ST   R0, [IE]
        EI
main:   WAI
        BRA  main

vblank: PUSHM R0-R7
        CALL SND_TICK
        LD   R1, [CMD]
        TST  R1, R1
        BEQ  vbout
        LD   R0, [ARG]
        ADDQ R1, #-1
        CMP  R1, #NCMD
        BHS  back
        ADD  R1, R1
        LD   R1, [R1+cmds]
        JMP  [R1]
back:   MOVQ R1, #0
        ST   R1, [CMD]
vbout:  MOVQ R0, #1
        ST   R0, [IF]
        POPM R0-R7
        RTI

        .align 2
cmds:   .word c_play, c_sfx, c_stop, c_tempo, c_fade, c_status
        .word r_init, r_play, r_stop, r_sfx, r_tick, r_tempo, r_fade, r_status
        .word s_play, s_sfx, s_status, s_tick
NCMD    = (* - cmds) / 2

c_play:   CALL SND_PLAY_SONG
          JMP  back
c_sfx:    CALL SND_SFX
          JMP  back
c_stop:   CALL SND_STOP
          JMP  back
c_tempo:  CALL SND_TEMPO
          JMP  back
c_fade:   CALL SND_FADE
          JMP  back
c_status: CALL SND_STATUS
          ST   R0, [RES]
          JMP  back

r_init:   BSR  setregs
          CALL SND_INIT
          BSR  saveregs
          JMP  back
r_play:   BSR  setregs
          CALL SND_PLAY_SONG
          BSR  saveregs
          JMP  back
r_stop:   BSR  setregs
          CALL SND_STOP
          BSR  saveregs
          JMP  back
r_sfx:    BSR  setregs
          CALL SND_SFX
          BSR  saveregs
          JMP  back
r_tick:   BSR  setregs
          CALL SND_TICK
          BSR  saveregs
          JMP  back
r_tempo:  BSR  setregs
          CALL SND_TEMPO
          BSR  saveregs
          JMP  back
r_fade:   BSR  setregs
          CALL SND_FADE
          BSR  saveregs
          JMP  back
r_status: BSR  setregs
          CALL SND_STATUS
          BSR  saveregs
          JMP  back

s_play:   MOV  R1, SP
          ST   R1, [SPB]
          BSR  setregs
          PUSH R0
          CALL SndPlaySong
          ADD  SP, #2
          BSR  saveregs
          MOV  R1, SP
          ST   R1, [SPA]
          JMP  back
s_sfx:    MOV  R1, SP
          ST   R1, [SPB]
          BSR  setregs
          PUSH R0
          CALL SndSfx
          ADD  SP, #2
          BSR  saveregs
          MOV  R1, SP
          ST   R1, [SPA]
          JMP  back
s_status: MOV  R1, SP
          ST   R1, [SPB]
          BSR  setregs
          CALL SndStatus
          BSR  saveregs
          MOV  R1, SP
          ST   R1, [SPA]
          JMP  back
s_tick:   MOV  R1, SP
          ST   R1, [SPB]
          BSR  setregs
          CALL SndTick
          BSR  saveregs
          MOV  R1, SP
          ST   R1, [SPA]
          JMP  back

setregs:  MOVW R1, #$1111
          MOVW R2, #$2222
          MOVW R3, #$3333
          MOVW R4, #$4444
          MOVW R5, #$5555
          MOVW R6, #$6666
          MOVW R7, #$7777
          RTS
saveregs: ST   R0, [REGS]
          ST   R1, [REGS+2]
          ST   R2, [REGS+4]
          ST   R3, [REGS+6]
          ST   R4, [REGS+8]
          ST   R5, [REGS+10]
          ST   R6, [REGS+12]
          ST   R7, [REGS+14]
          RTS

        .include "../../roms/lib/cuesound.inc"
        .include "snd-harness.song.inc"
        .include "../../roms/sound-test/sound-test.song.inc"
