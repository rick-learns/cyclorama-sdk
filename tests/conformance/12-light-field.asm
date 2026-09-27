; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Conformance 12: the light field (canon.json core.signatureBehavior.rule; spec-notes §3 "Shade",
; "Probe", "Line pipeline", §8.8, §10.59; manual 5.8-5.11), observed through the PROBE latch.
;
; The rule (canon):  diamond d = dx + dy   square d = max(dx, dy)
;                    octagon d = max(dx, dy) + (min(dx, dy) >> 1)   band d = dy
;                    level = sign(I) * max(0, |I| - (d >> F))      (I = 0 contributes 0)
;                    shade = (AMBIENT + level0 + level1 + level2 + level3) mod 8
;                    unlit pixels, and all pixels while VCTRL bit 4 = 0: shade = FIXED
; PROBE = 8000 (ready) | shade << 8 | base index (palette x 8 + pixel; sprites 32-63).
;
; Scene: BG0 map at 6000 all tile 0 (transparent, so the backdrop, base 0, shows) except
;   (tx 2, ty 2) tile 1 palette 2          -> pixels 16-23 x 16-23, base 2*8+5 = 21 (15h)
;   (tx 4, ty 2) tile 1 palette 3, unlit   -> pixels 32-39 x 16-23, base 3*8+5 = 29 (1Dh)
;   (tx 6, ty 2) tile 2 palette 1          -> pixels 48-55 x 16-23, base 1*8+3 = 11 (0Bh)
; tile 1 = every pixel 5, tile 2 = every pixel 3.
; Sprite 0 at (100,100) tile 1 palette 1 -> pixels 100-107 x 100-107, base (4+1)*8+5 = 45 (2Dh)
; Sprite 1 at (120,100) tile 1 palette 3 unlit -> 120-127 x 100-107, base (4+3)*8+5 = 61 (3Dh)
; Sprites 2-63 hidden. VCTRL = 1B (display, BG0, sprites, light field) unless a row says otherwise.
        .org $0000
        .word start, 0, LH, 0, 0
        .header title="CONFORMANCE 12 LIGHT", dev=$0001, date=$19870301, version=$0100
        .org $0040
        .include "_harness.inc"
        .include "_hw.inc"

SQ  = $10           ; shape codes in LiF bits 5-4
OCT = $20
BAND = $30

; ---- probe table: .word n, (register, value) x n, x, y, expected PROBE ----
; Registers keep their values from row to row. Check number = row number.
PTAB:
        ; -- one light, shapes (L0 at (100,60), I = 7, F = 0, AMBIENT 0) --
        .word 4, L0X,100, L0Y,60, L0I,7, L0F,0
        .word 100, 60, $8700        ; #1 diamond d = 0: level 7, shade 7
        .word 0
        .word 103, 58, $8200        ; #2 diamond dx 3 dy 2: d = 5, 7 - 5 = 2
        .word 1, L0F,SQ
        .word 103, 58, $8400        ; #3 square: d = max(3,2) = 3, 7 - 3 = 4
        .word 1, L0F,OCT
        .word 103, 58, $8300        ; #4 octagon: d = 3 + (2 >> 1) = 4, 7 - 4 = 3
        .word 0
        .word 104, 56, $8100        ; #5 octagon dx 4 dy 4: d = 4 + 2 = 6, 7 - 6 = 1
        .word 0
        .word 95, 59, $8200         ; #6 octagon dx 5 dy 1: d = 5 + (1 >> 1) = 5 + 0 = 5, level 2
        .word 1, L0F,BAND
        .word 5, 58, $8500          ; #7 band: d = dy = 2 (dx 95 ignored), level 5
        .word 0
        .word 250, 60, $8700        ; #8 band dy 0 at the far right: level 7
        ; -- falloff --
        .word 1, L0F,2
        .word 110, 60, $8500        ; #9 diamond F 2: d = 10, 10 >> 2 = 2, 7 - 2 = 5
        .word 0
        .word 100, 75, $8400        ; #10 d = 15, 15 >> 2 = 3, level 4
        .word 0
        .word 100, 63, $8700        ; #11 d = 3, 3 >> 2 = 0 (remainder discarded), level 7
        .word 1, L0F,7
        .word 0, 0, $8600           ; #12 F 7: d = 100 + 60 = 160, 160 >> 7 = 1, level 6
        .word 1, L0F,0
        .word 120, 60, $8000        ; #13 F 0: d = 20, max(0, 7 - 20) = 0, shade 0
        .word 0
        .word 107, 60, $8000        ; #14 d = 7: 7 - 7 = 0
        .word 0
        .word 106, 60, $8100        ; #15 d = 6: 7 - 6 = 1
        ; -- signed intensity --
        .word 2, L0I,$D, AMBIENT,5
        .word 100, 60, $8200        ; #16 I = -3 (D): 5 + (-3) = 2
        .word 0
        .word 101, 60, $8300        ; #17 d = 1: -(3 - 1) = -2, 5 - 2 = 3
        .word 0
        .word 104, 60, $8500        ; #18 d = 4: -max(0, 3 - 4) = 0, 5 + 0 = 5
        .word 2, L0I,8, AMBIENT,0
        .word 100, 60, $8000        ; #19 I = -8: level -8, (0 - 8) mod 8 = 0
        .word 0
        .word 101, 60, $8100        ; #20 d = 1: -(8 - 1) = -7, -7 mod 8 = 1
        .word 1, AMBIENT,3
        .word 100, 60, $8300        ; #21 3 - 8 = -5, -5 mod 8 = 3
        .word 2, L0I,$FFF9, AMBIENT,0
        .word 100, 60, $8100        ; #22 L0I keeps bits 3-0: 9 = -7; -7 mod 8 = 1
        ; -- positions: signed 10-bit, off screen --
        .word 4, L0X,$FFEC, L0Y,60, L0I,7, L0F,2
        .word 0, 60, $8200          ; #23 LX = 3EC = -20: dx = 20, 20 >> 2 = 5, 7 - 5 = 2
        .word 2, L0X,$040A, L0F,0
        .word 10, 60, $8700         ; #24 L0X = 040A keeps bits 9-0 = 00A = 10: dx = 0, level 7
        .word 3, L0X,100, L0Y,$03E8, L0F,2
        .word 100, 0, $8100         ; #25 LY = 3E8 = 1000 - 1024 = -24: dy = 24, >> 2 = 6, 7 - 6 = 1
        .word 3, L0X,$01FF, L0Y,$0200, L0F,SQ|7
        .word 255, 0, $8300         ; #26 LX 511, LY -512, square F 7: dx 256, dy 512,
                                    ;     d = 512, 512 >> 7 = 4, 7 - 4 = 3
        .word 3, L0X,$0200, L0Y,$01FF, L0F,7
        .word 0, 223, $8100         ; #27 LX -512, LY 511, diamond F 7: dx 512, dy 288,
                                    ;     d = 800, 800 >> 7 = 6, 7 - 6 = 1
        .word 1, L0F,OCT|7
        .word 0, 223, $8200         ; #28 octagon: 512 + (288 >> 1) = 656, >> 7 = 5, 7 - 5 = 2
        ; -- AMBIENT --
        .word 2, L0I,0, AMBIENT,5
        .word 200, 200, $8500       ; #29 no lights: shade = AMBIENT = 5
        .word 1, AMBIENT,$FFFF
        .word 200, 200, $8700       ; #30 AMBIENT keeps bits 2-0: 7
        ; -- several lights; the 3-bit adder wraps --
        .word 9, AMBIENT,2, L0X,50, L0Y,150, L0I,7, L0F,0, L1X,50, L1Y,150, L1I,5, L1F,SQ
        .word 50, 150, $8600        ; #31 2 + 7 + 5 = 14, 14 mod 8 = 6
        .word 0
        .word 51, 150, $8400        ; #32 L0 d 1 -> 6, L1 d 1 -> 4: 2 + 6 + 4 = 12 -> 4
        .word 0
        .word 51, 151, $8300        ; #33 L0 d 2 -> 5, L1 d max(1,1) = 1 -> 4: 11 -> 3
        .word 8, L2X,60, L2Y,150, L2I,$C, L2F,1, L3X,0, L3Y,152, L3I,3, L3F,BAND
        .word 50, 150, $8700        ; #34 L2 (I -4, F 1): d 10, 10 >> 1 = 5 -> 0; L3 band dy 2 -> 1:
                                    ;     2 + 7 + 5 + 0 + 1 = 15 -> 7
        .word 0
        .word 58, 150, $8000        ; #35 L0 d 8 -> 0, L1 d 8 -> 0, L2 d 2 >> 1 = 1 -> -3,
                                    ;     L3 dy 2 -> 1: 2 + 0 + 0 - 3 + 1 = 0
        .word 0
        .word 60, 152, $8200        ; #36 L0 d 12 -> 0, L1 d 10 -> 0, L2 d 2 >> 1 = 1 -> -3,
                                    ;     L3 dy 0 -> 3: 2 - 3 + 3 = 2
        .word 0
        .word 60, 150, $8700        ; #37 L0 d 10 -> 0, L1 d 10 -> 0, L2 d 0 -> -4, L3 dy 2 -> 1:
                                    ;     2 - 4 + 1 = -1 -> 7
        ; -- base colour index of tiles and sprites; unlit; FIXED --
        .word 8, L1I,0, L2I,0, L3I,0, AMBIENT,0, L0X,18, L0Y,18, L0I,7, L0F,0
        .word 18, 18, $8715         ; #38 tile palette 2 colour 5: base 21, lit d 0 -> 7
        .word 0
        .word 20, 17, $8415         ; #39 d = 2 + 1 = 3 -> 4
        .word 0
        .word 50, 18, $800B         ; #40 tile palette 1 colour 3: base 11; d = 32 -> 0
        .word 3, FIXED,3, L0X,34, L0Y,18
        .word 34, 18, $831D         ; #41 unlit tile (light at the pixel would give 7): FIXED 3, base 29
        .word 3, L0X,102, L0Y,102, L0I,4
        .word 102, 102, $842D       ; #42 sprite palette 1 colour 5: base 45, lit d 0 -> 4
        .word 0
        .word 122, 102, $833D       ; #43 unlit sprite palette 3: base 61, FIXED 3
        .word 1, VCTRL,$0B
        .word 18, 18, $8315         ; #44 light field disabled: FIXED 3 for a lit tile
        .word 0
        .word 200, 200, $8300       ; #45 ...and for the backdrop
        .word 1, FIXED,$FFFF
        .word 102, 102, $872D       ; #46 FIXED keeps bits 2-0: 7
        .word 5, VCTRL,$1B, FIXED,0, L0X,200, L0Y,200, L0I,5
        .word 200, 200, $8500       ; #47 the backdrop is always lit: 5, not FIXED 0
        .word 3, VCTRL,$19, L0X,18, L0Y,18
        .word 18, 18, $8500         ; #48 BG0 disabled: the backdrop (base 0) is output, lit 5
        .word 3, VCTRL,$13, L0X,102, L0Y,102
        .word 102, 102, $8500       ; #49 sprites disabled: backdrop, lit 5
        .word 4, VCTRL,$1B, L0X,18, L0Y,18, L0I,7
        .word $0112, 18, $8715      ; #50 PROBEX keeps bits 7-0: 0112 -> 12h = 18
        .word $FFFF

; flying table: (L0X, PROBEX, PROBEY) for the line after each LINE interrupt
FLYTAB: .word 60, 62, 101
        .word 200, 203, 102
        .word 200, 0, $01FF
FLYLOG  = $8120

; LINE handler for the flying test: R4-R6 hold the next line's L0X, PROBEX, PROBEY, written
; first (entry at cycle 171 + 12 = 183; the three stores start at 183, 189, 195 < 228).
; Then logs PROBE (this line's capture) at [R3]+, loads the next triple from [R2]+ and moves
; LINECMP down one line.
LH:     ST   R4, [L0X]
        ST   R5, [PROBEX]
        ST   R6, [PROBEY]
        PUSH R0
        LD   R0, [PROBE]
        ST   R0, [R3]+
        LD   R4, [R2]+
        LD   R5, [R2]+
        LD   R6, [R2]+
        LD   R0, [LINECMP]
        ADDQ R0, #1
        ST   R0, [LINECMP]
        MOVQ R0, #2
        ST   R0, [IF]
        POP  R0
        RTI

; PROBEAT: R0 = x, R1 = y. Waits for vertical blank, sets the probe, clears any old capture and
; returns R0 = PROBE once the next frame has captured (x, y). Register writes made before the call
; therefore apply to the whole captured frame. Clobbers R0, R6.
PROBEAT:
        PUSH R0
        CALL WAITVB
        POP  R0
        ST   R0, [PROBEX]
        ST   R1, [PROBEY]
        LD   R0, [PROBE]
.w:     LD   R0, [VSTAT]
        TSTW R0, #4
        BEQ  .w
        LD   R0, [PROBE]
        RTS

; WAITREADY: poll VSTAT bit 2. Clobbers R6.
WAITREADY:
        LD   R6, [VSTAT]
        TSTW R6, #4
        BEQ  WAITREADY
        RTS

; CLEARVRAM-style fills use DMA from E000 (reads 0, §9.38): R0 = dest, R1 = words, R2 = target
DMAZERO:
        MOVW R6, #$E000
        ST   R6, [DMASRC]
        ST   R0, [DMADST]
        ST   R1, [DMALEN]
        ST   R2, [DMACTL]
        RTS

start:  MOVQ R7, #1
        ; ---- scene set-up (display disabled) ----
        MOVQ R0, #0                 ; tiles 0-2 (72 bytes = 36 words) cleared
        MOVQ R1, #36
        MOVQ R2, #1
        CALL DMAZERO
        MOVW R0, #$6000             ; BG0 map cleared (2048 words)
        MOVW R1, #2048
        MOVQ R2, #1
        CALL DMAZERO
        MOVQ R0, #0                 ; OAM cleared (256 words)
        MOVW R1, #256
        MOVQ R2, #2
        CALL DMAZERO
        MOVQ R0, #$18               ; tile 1 at 0018: planes 0 and 2 all ones -> pixel 5
        ST   R0, [VADDR]
        MOVW R0, #$FFFF
        MOVQ R1, #0
        ST   R0, [VDATA]
        ST   R0, [VDATA]
        ST   R0, [VDATA]
        ST   R0, [VDATA]
        ST   R1, [VDATA]
        ST   R1, [VDATA]
        ST   R1, [VDATA]
        ST   R1, [VDATA]
        ST   R0, [VDATA]
        ST   R0, [VDATA]
        ST   R0, [VDATA]
        ST   R0, [VDATA]
        ; tile 2 at 0030: planes 0 and 1 all ones -> pixel 3 (plane 2 already 0)
        ST   R0, [VDATA]
        ST   R0, [VDATA]
        ST   R0, [VDATA]
        ST   R0, [VDATA]
        ST   R0, [VDATA]
        ST   R0, [VDATA]
        ST   R0, [VDATA]
        ST   R0, [VDATA]
        MOVW R0, #$6104             ; map (2,2): tile 1, palette 2
        ST   R0, [VADDR]
        MOVW R0, #$0801
        ST   R0, [VDATA]
        MOVW R0, #$6108             ; map (4,2): tile 1, palette 3, unlit
        ST   R0, [VADDR]
        MOVW R0, #$8C01
        ST   R0, [VDATA]
        MOVW R0, #$610C             ; map (6,2): tile 2, palette 1
        ST   R0, [VADDR]
        MOVW R0, #$0402
        ST   R0, [VDATA]
        MOVQ R0, #0                 ; sprite 0: Y 100, X 100, tile 1 palette 1, 8x8
        ST   R0, [OAMADDR]
        MOVQ R0, #100
        ST   R0, [OAMDATA]
        ST   R0, [OAMDATA]
        MOVW R0, #$0401
        ST   R0, [OAMDATA]
        MOVQ R0, #0
        ST   R0, [OAMDATA]
        MOVQ R0, #100               ; sprite 1: Y 100, X 120, tile 1 palette 3, unlit
        ST   R0, [OAMDATA]
        MOVQ R0, #120
        ST   R0, [OAMDATA]
        MOVW R0, #$8C01
        ST   R0, [OAMDATA]
        MOVQ R0, #0
        ST   R0, [OAMDATA]
        MOVQ R0, #$16               ; sprites 2-63: +6 bit 1 = hide
        MOVQ R1, #2
.hide:  ST   R0, [OAMADDR]
        ST   R1, [OAMDATA]
        ADDQ R0, #8
        CMPW R0, #$200
        BLO  .hide
        MOVQ R0, #$1B
        ST   R0, [VCTRL]

        ; ---- #1-#50 the probe table ----
        MOVW R3, #PTAB
.rec:   LD   R2, [R3]+
        CMPW R2, #$FFFF
        BEQ  .tdone
.pair:  TST  R2, R2
        BEQ  .probe
        LD   R4, [R3]+
        LD   R5, [R3]+
        ST   R5, [R4]
        ADDQ R2, #-1
        BRA  .pair
.probe: LD   R0, [R3]+
        LD   R1, [R3]+
        CALL PROBEAT
        LD   R1, [R3]+
        CALL CHECK
        BRA  .rec
.tdone:
        ; state now: VCTRL 1B, L0 (18,18) I 7 F 0, other lights off, AMBIENT 0, FIXED 0

        ; ---- ready flag (manual 5.11) ----
        MOVW R0, #200               ; backdrop at (200,200): L0 far away -> shade 0
        MOVW R1, #200
        CALL PROBEAT
        ; #51 capture value (ready set)
        MOVW R1, #$8000
        CALL CHECK
        ; wait for the next frame's capture, leave it unread
        CALL WAITVB
        CALL WAITREADY
        ; #52 VSTAT bit 2 = 1
        LD   R0, [VSTAT]
        ANDW R0, #4
        MOVQ R1, #4
        CALL CHECK
        ; #53 reading VSTAT does not clear it
        LD   R0, [VSTAT]
        ANDW R0, #4
        MOVQ R1, #4
        CALL CHECK
        ; #54 a byte read of PROBE's high half returns ready|shade = 80 and clears ready
        LDB  R0, [PROBE+1]
        MOVW R1, #$80
        CALL CHECK
        ; #55 the next read: the same capture without the ready bit
        LD   R0, [PROBE]
        MOVQ R1, #0
        CALL CHECK
        ; #56 VSTAT bit 2 cleared too
        LD   R0, [VSTAT]
        ANDW R0, #4
        MOVQ R1, #0
        CALL CHECK
        ; a lit capture to have a distinctive latched value: L0 at (200,200) I 5 -> 8500
        MOVW R0, #200
        ST   R0, [L0X]
        ST   R0, [L0Y]
        MOVQ R0, #5
        ST   R0, [L0I]
        MOVW R0, #200
        MOVW R1, #200
        CALL PROBEAT
        ; #57
        MOVW R1, #$8500
        CALL CHECK
        ; #58 ready is set at dot 256 of the probe line: probe (200,200), where L0 (200,200) I 5
        ; gives 8500. Early in line 200 the flag is still clear...
        CALL WAITVB
        MOVW R0, #200
        ST   R0, [PROBEY]
        LD   R0, [PROBE]
        MOVW R0, #200
        CALL LINESTART
        LD   R0, [VSTAT]
        ANDW R0, #4
        MOVQ R1, #0
        CALL CHECK
        ; #59 ...and set at dot 256 of line 200 (the LINE request comes at the same dot)
        MOVW R0, #200
        CALL WAITLN
        LD   R0, [VSTAT]
        ANDW R0, #4
        MOVQ R1, #4
        CALL CHECK
        LD   R0, [PROBE]            ; (8500, read: ready cleared)

        ; ---- display disabled: no capture, latch unchanged (manual 5.10, §3) ----
        MOVQ R0, #3                 ; FIXED 3: a (wrong) capture would differ from the latch
        ST   R0, [FIXED]
        MOVQ R0, #0
        ST   R0, [VCTRL]
        CALL WAITVB
        LD   R0, [PROBE]
        CALL WAITVB
        CALL WAITVB
        ; #60 no ready flag after two whole frames
        LD   R0, [VSTAT]
        ANDW R0, #4
        MOVQ R1, #0
        CALL CHECK
        ; #61 PROBE still holds the last capture (base 0, shade 5), without the ready bit
        LD   R0, [PROBE]
        MOVW R1, #$0500
        CALL CHECK
        ; #62 PROBEY 224 and above never capture (display on again)
        MOVQ R0, #$1B
        ST   R0, [VCTRL]
        MOVW R0, #224
        ST   R0, [PROBEY]
        CALL WAITVB
        CALL WAITVB
        CALL WAITVB
        LD   R0, [VSTAT]
        ANDW R0, #4
        MOVQ R1, #0
        CALL CHECK

        ; ---- a later capture in the same frame replaces an unread one ----
        ; L0 band at y 60, I 7 F 0; PROBEX 200. Line 50: dy 10 -> 0. Line 60: dy 0 -> 7.
        MOVW R0, #200
        ST   R0, [PROBEX]
        MOVQ R0, #50
        ST   R0, [PROBEY]
        MOVQ R0, #60
        ST   R0, [L0Y]
        MOVQ R0, #7
        ST   R0, [L0I]
        MOVQ R0, #BAND
        ST   R0, [L0F]
        CALL WAITVB
        LD   R0, [PROBE]
        MOVQ R0, #55
        CALL WAITLN                 ; line 50 captured (8000), unread
        MOVQ R0, #60
        ST   R0, [PROBEY]           ; latched from line 56
        MOVQ R0, #65
        CALL WAITLN
        ; #63 line 60's capture replaced it
        LD   R0, [PROBE]
        MOVW R1, #$8700
        CALL CHECK

        ; ---- dot-0 latching: a write during line y is first seen by line y + 1 (manual 5.8) ----
        ; L0 square at (20,100), I 7 F 0; probe (20,100).
        MOVQ R0, #20
        ST   R0, [L0X]
        ST   R0, [PROBEX]
        MOVQ R0, #100
        ST   R0, [L0Y]
        ST   R0, [PROBEY]
        MOVQ R0, #SQ
        ST   R0, [L0F]
        CALL WAITVB
        LD   R0, [PROBE]
        MOVQ R0, #100
        CALL LINESTART              ; cycle 15 of line 100: after its dot 0
        MOVQ R0, #60
        ST   R0, [L0X]
        CALL WAITREADY
        ; #64 line 100 still used L0X = 20: d 0 -> 7
        LD   R0, [PROBE]
        MOVW R1, #$8700
        CALL CHECK
        ; #65 the next frame's line 100 uses L0X = 60: dx 40 -> 0
        CALL WAITVB
        LD   R0, [PROBE]
        CALL WAITREADY
        LD   R0, [PROBE]
        MOVW R1, #$8000
        CALL CHECK

        ; ---- flying: LINE handler rewrites L0X and moves the probe down line by line ----
        ; Frame set-up: L0 square (20,100) I 7 F 0; probe (20,100); LINECMP 100.
        ; line 100: L0X 20,  probe (20,100):  dx 0, dy 0 -> 7              -> 8700
        ; line 101: L0X 60,  probe (62,101):  dx 2, dy 1, max 2 -> 5       -> 8500
        ; line 102: L0X 200, probe (203,102): dx 3, dy 2, max 3 -> 4       -> 8400
        ; (without per-line latching, lines 101/102 would see L0X 20 or 200 and give 0.)
        CALL WAITVB
        MOVQ R0, #20
        ST   R0, [L0X]
        ST   R0, [PROBEX]
        MOVQ R0, #100
        ST   R0, [PROBEY]
        ST   R0, [LINECMP]
        LD   R0, [PROBE]
        MOVW R2, #FLYTAB
        MOVW R3, #FLYLOG
        LD   R4, [R2]+
        LD   R5, [R2]+
        LD   R6, [R2]+
        MOVQ R0, #2
        ST   R0, [IE]
        ST   R0, [IF]
        EI
        WAI
        WAI
        WAI
        DI
        MOVQ R0, #0
        ST   R0, [IE]
        ; #66-#68
        LD   R0, [FLYLOG]
        MOVW R1, #$8700
        CALL CHECK
        LD   R0, [FLYLOG+2]
        MOVW R1, #$8500
        CALL CHECK
        LD   R0, [FLYLOG+4]
        MOVW R1, #$8400
        CALL CHECK
        ; #69 all three handler runs happened in one frame on lines 100-102: LINECMP ended at 103
        LD   R0, [LINECMP]
        MOVQ R1, #103
        CALL CHECK
        JMP  PASS
