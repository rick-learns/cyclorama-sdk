; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Conformance 13: Cue registers as the CPU sees them (spec-notes §4 envelope, §8.11, §8.13,
; §9.39, §9.40, §10.48-50; manual 6.6, 6.7, 6.9; registers.ts V*CTRL, V*WAVE, V*ENV, WAVE0-7,
; MASTERVOL).
; V*CTRL reads bit 0 = keyed and bits 11-8 = current volume, immediately after key-on/off.
; Envelope timing (§9.39): sample k is produced at master cycle 448 (k + 1); global envelope
; ticks fall on samples k = 750j - 1, i.e. at master 448 x 750 j = 336,000 j. A voice counts the
; ticks after its key-on and steps every p ticks (first step on the p-th, §8.11 / §10.49).
; A frame is 358,416 master cycles (about 800.04 samples, 1.0667 ticks).
        .org $0000
        .word start, 0, 0, 0, 0
        .header title="CONFORMANCE 13 AUDIO", dev=$0001, date=$19870301, version=$0100
        .org $0040
        .include "_harness.inc"
        .include "_hw.inc"

; CTRLS: read V0CTRL..V3CTRL and check against 4 expected words at [R3]+ (4 checks).
CTRLS:  LD   R0, [V0CTRL]
        LD   R1, [R3]+
        CALL CHECK
        LD   R0, [V1CTRL]
        LD   R1, [R3]+
        CALL CHECK
        LD   R0, [V2CTRL]
        LD   R1, [R3]+
        CALL CHECK
        LD   R0, [V3CTRL]
        LD   R1, [R3]+
        CALL CHECK
        RTS

; WAITVBS: R4 = number of VBLANK wakes to wait for.
WAITVBS:
        CALL WAITVB
        ADDQ R4, #-1
        BNE  WAITVBS
        RTS

; Expected V0CTRL-V3CTRL after k global ticks since the key-on just after VBLANK wake #1:
; V0 ENV 2F: start 15, falling, p 1 -> 15 - k (floor 0)
; V1 ENV 6A: start 10, falling, p 3 -> 10 - floor(k / 3)
; V2 ENV 53: start 3, rising, p 2  -> 3 + floor(k / 2) (cap 15)
; V3 ENV 09: start 9, p 0 (hold)   -> 9
; Wake #n is at master 306,432 + (n - 1) x 358,416 (line 224 of frame n - 1); the key-on is
; about 300 master cycles after wake #1, before tick 1 (336,000); k = floor(T / 336,000).
EXPECT: .word $0F01, $0A01, $0301, $0901   ; #25-#28 k = 0, at key-on
        .word $0E01, $0A01, $0301, $0901   ; #29-#32 wake 2: 664,848 / 336,000 = 1.98 -> k 1
        .word $0B01, $0901, $0501, $0901   ; #33-#36 wake 4: 1,381,680 -> 4.11 -> k 4
        .word $0801, $0801, $0601, $0901   ; #37-#40 wake 7: 2,456,928 -> 7.31 -> k 7
        .word $0001, $0501, $0B01, $0901   ; #41-#44 wake 16: 5,682,672 -> 16.91 -> k 16
                                           ;   (V0 stopped at 0 but still keyed, §8.13)

WAVES:  .word $0123, $4567, $89AB, $CDEF, $FEDC, $BA98, $7654, $3210

start:  MOVQ R7, #1
        ; ---- register read-back and masks (all before VBLANK wake #1: under 5 lines) ----
        ; #1 MASTERVOL resets to 0
        LD   R0, [MASTERVOL]
        MOVQ R1, #0
        CALL CHECK
        ; #2 MASTERVOL keeps bits 3-0
        MOVW R0, #$FFFF
        ST   R0, [MASTERVOL]
        LD   R0, [MASTERVOL]
        MOVQ R1, #15
        CALL CHECK
        ; #3 V0FREQ is 16 bits
        MOVW R0, #$FFFF
        ST   R0, [V0FREQ]
        LD   R0, [V0FREQ]
        MOVW R1, #$FFFF
        CALL CHECK
        ; #4 a byte write to V0FREQ's high half: 1234 -> AB34
        MOVW R0, #$1234
        ST   R0, [V0FREQ]
        MOVW R0, #$AB
        STB  R0, [V0FREQ+1]
        LD   R0, [V0FREQ]
        MOVW R1, #$AB34
        CALL CHECK
        ; #5 V0WAVE keeps bits 2-0
        MOVW R0, #$FFFF
        ST   R0, [V0WAVE]
        LD   R0, [V0WAVE]
        MOVQ R1, #7
        CALL CHECK
        ; #6 V2WAVE likewise
        MOVW R0, #$FFFC
        ST   R0, [V2WAVE]
        LD   R0, [V2WAVE]
        MOVQ R1, #4
        CALL CHECK
        ; #7 V3WAVE (noise mode) keeps bit 0 only: FFFF -> 1
        MOVW R0, #$FFFF
        ST   R0, [V3WAVE]
        LD   R0, [V3WAVE]
        MOVQ R1, #1
        CALL CHECK
        ; #8 ...and 0002 -> 0
        MOVQ R0, #2
        ST   R0, [V3WAVE]
        LD   R0, [V3WAVE]
        MOVQ R1, #0
        CALL CHECK
        ; #9 V0ENV keeps bits 7-0
        MOVW R0, #$FFFF
        ST   R0, [V0ENV]
        LD   R0, [V0ENV]
        MOVW R1, #$00FF
        CALL CHECK
        ; #10-#17 WAVE0-WAVE7 are 16-bit storage
        MOVW R3, #WAVES
        MOVW R4, #WAVE0
.ww:    LD   R0, [R3]+
        ST   R0, [R4]+
        CMPW R4, #WAVE7+2
        BNE  .ww
        MOVW R3, #WAVES
        MOVW R4, #WAVE0
.wr:    LD   R0, [R4]+
        LD   R1, [R3]+
        CALL CHECK
        CMPW R4, #WAVE7+2
        BNE  .wr
        ; ---- V*CTRL: key-on / key-off, command byte rules (§9.40, §10.50) ----
        ; #18 keyed-off voice reads 0
        LD   R0, [V1CTRL]
        MOVQ R1, #0
        CALL CHECK
        ; #19 a byte write of 01 to V1CTRL's high byte (F08F) is ignored: still 0
        MOVQ R0, #$0C
        ST   R0, [V1ENV]            ; start volume 12, hold
        MOVQ R0, #1
        STB  R0, [V1CTRL+1]
        LD   R0, [V1CTRL]
        MOVQ R1, #0
        CALL CHECK
        ; #20 a byte write of 01 to the low byte keys on: keyed, volume 12 at once -> 0C01
        MOVQ R0, #1
        STB  R0, [V1CTRL]
        LD   R0, [V1CTRL]
        MOVW R1, #$0C01
        CALL CHECK
        ; #21 a byte write of 00 to the high byte does not key off
        MOVQ R0, #0
        STB  R0, [V1CTRL+1]
        LD   R0, [V1CTRL]
        MOVW R1, #$0C01
        CALL CHECK
        ; #22 word write 0100: low byte 00 -> key-off; volume 0 at once
        MOVW R0, #$0100
        ST   R0, [V1CTRL]
        LD   R0, [V1CTRL]
        MOVQ R1, #0
        CALL CHECK
        ; #23 word write FF03: bit 0 = 1 -> key-on (other bits ignored)
        MOVW R0, #$FF03
        ST   R0, [V1CTRL]
        LD   R0, [V1CTRL]
        MOVW R1, #$0C01
        CALL CHECK
        ; #24 noise voice: ENV 07, key-on -> 0701
        MOVQ R0, #7
        ST   R0, [V3ENV]
        MOVQ R0, #1
        ST   R0, [V3CTRL]
        LD   R0, [V3CTRL]
        MOVW R1, #$0701
        CALL CHECK
        MOVQ R0, #0
        ST   R0, [V3CTRL]
        ST   R0, [V1CTRL]
        ; audible set-up (not observable by the CPU, but a real program's): tones and noise
        MOVW R0, #601
        ST   R0, [V0FREQ]
        ST   R0, [V1FREQ]
        ST   R0, [V2FREQ]
        MOVQ R0, #2
        ST   R0, [V0WAVE]
        MOVQ R0, #4
        ST   R0, [V1WAVE]
        MOVQ R0, #6
        ST   R0, [V2WAVE]
        MOVW R0, #$1000
        ST   R0, [V3FREQ]

        ; ---- envelopes over whole frames ----
        MOVQ R0, #$2F
        ST   R0, [V0ENV]
        MOVQ R0, #$6A
        ST   R0, [V1ENV]
        MOVQ R0, #$53
        ST   R0, [V2ENV]
        MOVQ R0, #$09
        ST   R0, [V3ENV]
        CALL WAITVB                 ; wake #1 (frame 0, line 224: master 306,432)
        MOVQ R0, #1
        ST   R0, [V0CTRL]
        ST   R0, [V1CTRL]
        ST   R0, [V2CTRL]
        ST   R0, [V3CTRL]
        MOVW R3, #EXPECT
        CALL CTRLS                  ; #25-#28
        MOVQ R4, #1
        CALL WAITVBS                ; wake #2
        CALL CTRLS                  ; #29-#32
        MOVQ R4, #2
        CALL WAITVBS                ; wake #4
        CALL CTRLS                  ; #33-#36
        MOVQ R0, #$0F               ; ENV is read at key-on only: V1 keeps stepping (p 3)
        ST   R0, [V1ENV]
        MOVQ R4, #3
        CALL WAITVBS                ; wake #7
        CALL CTRLS                  ; #37-#40
        MOVQ R4, #9
        CALL WAITVBS                ; wake #16
        CALL CTRLS                  ; #41-#44
        ; #45 key-off: keyed bit and volume drop at once (V2 was 0B01)
        MOVQ R0, #0
        ST   R0, [V2CTRL]
        LD   R0, [V2CTRL]
        MOVQ R1, #0
        CALL CHECK
        ; #46 key-on again reloads ENV 53: start volume 3
        MOVQ R0, #1
        ST   R0, [V2CTRL]
        LD   R0, [V2CTRL]
        MOVW R1, #$0301
        CALL CHECK
        ; #47 V1 keyed again picks up the new ENV 0F: volume 15
        ST   R0, [V1CTRL]
        LD   R0, [V1CTRL]
        MOVW R1, #$0F01
        CALL CHECK

        ; ---- envelope phase: first step on the p-th tick after key-on (§8.11, §10.49) ----
        ; V0 (ENV 2F, p 1) is a tick detector: its volume drops by one on every tick.
        ; Right after a tick, key V2 on with ENV 6F (15, falling, p 3); then after detected ticks
        ; 1, 2, 3 V2 reads 15, 15, 14. (A step aligned to the global counter mod p, or counted
        ; from before the key-on, would differ for some key-on phase; p 3 after tick 0 checks it.)
        MOVQ R0, #1
        ST   R0, [V0CTRL]           ; restart V0 at 15
        MOVQ R0, #$6F
        ST   R0, [V2ENV]
        CALL TICK                   ; wait for a tick
        MOVQ R0, #1
        ST   R0, [V2CTRL]           ; key-on just after it
        ; #48 immediately 0F01
        LD   R0, [V2CTRL]
        MOVW R1, #$0F01
        CALL CHECK
        ; #49-#51 after ticks 1, 2, 3
        CALL TICK
        LD   R0, [V2CTRL]
        MOVW R1, #$0F01
        CALL CHECK
        CALL TICK
        LD   R0, [V2CTRL]
        MOVW R1, #$0F01
        CALL CHECK
        CALL TICK
        LD   R0, [V2CTRL]
        MOVW R1, #$0E01
        CALL CHECK
        ; #52-#53 after ticks 4 and 5 still 14; #54 after tick 6: 13
        CALL TICK
        LD   R0, [V2CTRL]
        MOVW R1, #$0E01
        CALL CHECK
        CALL TICK
        LD   R0, [V2CTRL]
        MOVW R1, #$0E01
        CALL CHECK
        CALL TICK
        LD   R0, [V2CTRL]
        MOVW R1, #$0D01
        CALL CHECK
        ; #55 re-key restarts the count: wait for tick 7 (V2 counted 1 tick since its step at tick
        ; 6), key on again, then 2 ticks: still 15. Had the count continued, tick 9 (the 2nd tick
        ; after the re-key) would step it to 14.
        CALL TICK
        MOVQ R0, #1
        ST   R0, [V2CTRL]
        CALL TICK
        CALL TICK
        LD   R0, [V2CTRL]
        MOVW R1, #$0F01
        CALL CHECK
        ; #56 third tick after the re-key: 14
        CALL TICK
        LD   R0, [V2CTRL]
        MOVW R1, #$0E01
        CALL CHECK
        ; #57 a rising envelope stops at 15: V1 ENV 3E (14, rising, p 1): 1 tick -> 15, 2 -> 15
        MOVQ R0, #$3E
        ST   R0, [V1ENV]
        MOVQ R0, #1
        ST   R0, [V1CTRL]
        CALL TICK
        CALL TICK
        LD   R0, [V1CTRL]
        MOVW R1, #$0F01
        CALL CHECK
        MOVQ R0, #0
        ST   R0, [V0CTRL]
        ST   R0, [V1CTRL]
        ST   R0, [V2CTRL]
        ST   R0, [V3CTRL]
        JMP  PASS

; TICK: wait until V0's volume (falling, p 1) changes, i.e. one envelope tick. Restarts V0 at 15
; when it gets low so it keeps counting. Clobbers R0, R5, R6.
TICK:   LD   R5, [V0CTRL]
.t:     LD   R0, [V0CTRL]
        CMP  R0, R5
        BEQ  .t
        CMPW R0, #$0301
        BHS  .ok
        MOVQ R6, #1                 ; low: restart (key-on is not a tick, it only reloads)
        ST   R6, [V0CTRL]
.ok:    RTS
