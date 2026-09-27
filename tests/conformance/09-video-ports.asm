; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Conformance 09: Barndoor register file and ports (spec-notes §2, §3, §8.5-8.8, §8.29, §8.34,
; §10.52; registers.ts; manual 5.2, 5.5, 5.7, 5.12, 5.14). The display stays disabled throughout:
; port wait cycles depend on the beam position only (§8.6).
        .org $0000
        .word start, 0, 0, 0, 0
        .header title="CONFORMANCE 09 VIDEO", dev=$0001, date=$19870301, version=$0100
        .org $0040
        .include "_harness.inc"
        .include "_hw.inc"

; Register table: address, reset value, value read back after writing FFFF (defined bits).
; Checks 2k+1 (reset value) and 2k+2 (mask) for row k = 0..40, i.e. #1-#82.
REGTAB: .word VADDR,    0,   $7FFF    ; §10.52 bits 14-0
        .word VINC,     2,   $00FF
        .word VCTRL,    0,   $001F
        .word LINECMP,  511, $01FF
        .word BG0SCX,   0,   $01FF
        .word BG0SCY,   0,   $00FF
        .word BG1SCX,   0,   $01FF
        .word BG1SCY,   0,   $00FF
        .word BG0MAP,   12,  $000F
        .word BG1MAP,   14,  $000F
        .word OAMADDR,  0,   $01FE    ; §10.52 bits 8-1
        .word CRAMADDR, 0,   $01FF
        .word L0X, 0, $03FF
        .word L0Y, 0, $03FF
        .word L0I, 0, $000F
        .word L0F, 0, $0037           ; falloff 2-0, shape 5-4
        .word L1X, 0, $03FF
        .word L1Y, 0, $03FF
        .word L1I, 0, $000F
        .word L1F, 0, $0037
        .word L2X, 0, $03FF
        .word L2Y, 0, $03FF
        .word L2I, 0, $000F
        .word L2F, 0, $0037
        .word L3X, 0, $03FF
        .word L3Y, 0, $03FF
        .word L3I, 0, $000F
        .word L3F, 0, $0037
        .word AMBIENT,  0, $0007
        .word FIXED,    7, $0007
        .word PROBEX,   0, $00FF
        .word PROBEY,   0, $01FF
        .word TRELOAD,  0, $FFFF
        .word TCOUNT,   0, $FFFF
        .word TCTRL,    0, $0007
        .word IE,       0, $0007
        .word DMASRC,   0, $FFFE      ; §10.52 bits 15-1
        .word DMADST,   0, $FFFF
        .word DMALEN,   0, $FFFF
        .word BANK,     1, $00FF
        .word MASTERVOL, 0, $000F     ; (RAMCTL is covered by 08b: without RAM its read-back is unspecified)
REGEND:

; Unused addresses in the register blocks: read 0, writes ignored (§2). One check each.
UNUSED: .word $E004, $F00E, $F024, $F02E, $F05A, $F07E, $F0B2, $F0BE, $F0C4, $F0CE
        .word $F0D6, $F0DC, $F0DE, $F0E8, $F0EE
UNEND:

start:  MOVQ R7, #1
        ; ---- #1-#82 reset values and defined-bit masks ----
        MOVW R3, #REGTAB
.reg:   LD   R4, [R3]               ; register address
        LD   R0, [R4]
        LD   R1, [R3+2]
        CALL CHECK                  ; reset value
        MOVW R0, #$FFFF
        ST   R0, [R4]
        LD   R0, [R4]
        LD   R1, [R3+4]
        CALL CHECK                  ; undefined bits read 0
        LD   R0, [R3+2]
        ST   R0, [R4]               ; restore the reset value
        ADDQ R3, #6
        CMPW R3, #REGEND
        BNE  .reg
        ; BANK is back to 1; TCTRL 0 stopped the timer; IE 0.

        ; ---- #83-#97 unused addresses ----
        MOVW R3, #UNUSED
.un:    LD   R4, [R3]+
        MOVW R0, #$FFFF
        ST   R0, [R4]
        LD   R0, [R4]
        MOVQ R1, #0
        CALL CHECK
        CMPW R3, #UNEND
        BNE  .un

        ; ---- byte access to a storage register (§2): writes one half, reads one half ----
        ; #98 BG0SCX = 0034; STB FF to F011 (high half) keeps bit 8 only -> 0134
        MOVQ R0, #$34
        ST   R0, [BG0SCX]
        MOVW R0, #$FF
        STB  R0, [BG0SCX+1]
        LD   R0, [BG0SCX]
        MOVW R1, #$0134
        CALL CHECK
        ; #99 LDB of the high half reads 01
        LDB  R0, [BG0SCX+1]
        MOVQ R1, #1
        CALL CHECK
        ; #100 STB 56 to the low half leaves the high half: 0156
        MOVQ R0, #$56
        STB  R0, [BG0SCX]
        LD   R0, [BG0SCX]
        MOVW R1, #$0156
        CALL CHECK
        MOVQ R0, #0
        ST   R0, [BG0SCX]

        ; ---- VADDR / VDATA / VINC (manual 5.2, §8.5) ----
        ; #101 two word writes at 0100 with VINC 2 advance VADDR to 0104
        MOVW R0, #$0100
        ST   R0, [VADDR]
        MOVW R0, #$1234
        ST   R0, [VDATA]
        MOVW R0, #$5678
        ST   R0, [VDATA]
        LD   R0, [VADDR]
        MOVW R1, #$0104
        CALL CHECK
        ; #102-#103 read back both words
        MOVW R0, #$0100
        ST   R0, [VADDR]
        LD   R0, [VDATA]
        MOVW R1, #$1234
        CALL CHECK
        LD   R0, [VDATA]
        MOVW R1, #$5678
        CALL CHECK
        ; #104 reads advance VADDR too: 0104
        LD   R0, [VADDR]
        MOVW R1, #$0104
        CALL CHECK
        ; #105 wrap: a write at 7FFE advances VADDR to 0000 (mod 32 KiB)
        MOVW R0, #$7FFE
        ST   R0, [VADDR]
        MOVW R0, #$ABCD
        ST   R0, [VDATA]
        LD   R0, [VADDR]
        MOVQ R1, #0
        CALL CHECK
        ; #106 and the word landed at 7FFE
        MOVW R0, #$7FFE
        ST   R0, [VADDR]
        LD   R0, [VDATA]
        MOVW R1, #$ABCD
        CALL CHECK
        ; #107 VINC = FF from 7FF0: VADDR = (7FF0 + FF) mod 8000 = 00EF
        MOVW R0, #$FF
        ST   R0, [VINC]
        MOVW R0, #$7FF0
        ST   R0, [VADDR]
        LD   R0, [VDATA]
        LD   R0, [VADDR]
        MOVW R1, #$00EF
        CALL CHECK
        ; #108-#109 VINC = 1: a word access at odd VADDR uses the even word (bit 0 ignored)
        ; VADDR 0200: write 1111 -> VADDR 0201; write 2222 goes to word 0200 again -> VADDR 0202
        MOVQ R0, #1
        ST   R0, [VINC]
        MOVW R0, #$0200
        ST   R0, [VADDR]
        MOVW R0, #$1111
        ST   R0, [VDATA]
        MOVW R0, #$2222
        ST   R0, [VDATA]
        LD   R0, [VADDR]
        MOVW R1, #$0202
        CALL CHECK
        MOVQ R0, #2
        ST   R0, [VINC]
        MOVW R0, #$0200
        ST   R0, [VADDR]
        LD   R0, [VDATA]
        MOVW R1, #$2222
        CALL CHECK
        ; #110 VINC = 128 walks a map column: 3 writes from 6000 -> VADDR 6180
        MOVW R0, #128
        ST   R0, [VINC]
        MOVW R0, #$6000
        ST   R0, [VADDR]
        ST   R0, [VDATA]
        ST   R0, [VDATA]
        ST   R0, [VDATA]
        LD   R0, [VADDR]
        MOVW R1, #$6180
        CALL CHECK
        MOVQ R0, #2
        ST   R0, [VINC]
        ; Byte access (§8.5): F002 = even byte at VADDR & ~1, F003 = odd byte; either adds VINC.
        ; #111 STB 11 to F002 at 0300 -> VADDR 0302
        MOVW R0, #$0300
        ST   R0, [VADDR]
        MOVQ R0, #$11
        STB  R0, [VDATA]
        LD   R0, [VADDR]
        MOVW R1, #$0302
        CALL CHECK
        ; #112 STB 22 to F003 at 0300; word at 0300 = 2211 (even byte is the low half)
        MOVW R0, #$0300
        ST   R0, [VADDR]
        MOVQ R0, #$22
        STB  R0, [VDATA+1]
        MOVW R0, #$0300
        ST   R0, [VADDR]
        LD   R0, [VDATA]
        MOVW R1, #$2211
        CALL CHECK
        ; #113 STB 33 to F002 with VADDR = 0301 (odd): writes the even byte 0300 -> 2233
        MOVW R0, #$0301
        ST   R0, [VADDR]
        MOVQ R0, #$33
        STB  R0, [VDATA]
        MOVW R0, #$0300
        ST   R0, [VADDR]
        LD   R0, [VDATA]
        MOVW R1, #$2233
        CALL CHECK
        ; #114-#116 byte reads, VINC = 1: LDB F002 at 0300 = 33, VADDR 0301; LDB F003 at 0301 = 22
        MOVQ R0, #1
        ST   R0, [VINC]
        MOVW R0, #$0300
        ST   R0, [VADDR]
        LDB  R0, [VDATA]
        MOVQ R1, #$33
        CALL CHECK
        LDB  R0, [VDATA+1]
        MOVQ R1, #$22
        CALL CHECK
        LD   R0, [VADDR]
        MOVW R1, #$0302
        CALL CHECK
        MOVQ R0, #2
        ST   R0, [VINC]
        ; #117 VADDR bit 15 is ignored: writing 8300 selects 0300
        MOVW R0, #$8300
        ST   R0, [VADDR]
        LD   R0, [VDATA]
        MOVW R1, #$2233
        CALL CHECK

        ; ---- OAMADDR / OAMDATA (manual 5.5, §10.52) ----
        ; #118 OAMADDR 0000: two writes -> OAMADDR 0004
        MOVQ R0, #0
        ST   R0, [OAMADDR]
        MOVW R0, #$1234
        ST   R0, [OAMDATA]
        MOVW R0, #$5678
        ST   R0, [OAMDATA]
        LD   R0, [OAMADDR]
        MOVQ R1, #4
        CALL CHECK
        ; #119-#120 read back
        MOVQ R0, #0
        ST   R0, [OAMADDR]
        LD   R0, [OAMDATA]
        MOVW R1, #$1234
        CALL CHECK
        LD   R0, [OAMDATA]
        MOVW R1, #$5678
        CALL CHECK
        ; #121 OAMADDR = 0003 keeps bits 8-1: reads 0002
        MOVQ R0, #3
        ST   R0, [OAMADDR]
        LD   R0, [OAMADDR]
        MOVQ R1, #2
        CALL CHECK
        ; #122 a write at 0002 (from 0003) replaced 5678, OAMADDR -> 0004
        MOVW R0, #$9ABC
        ST   R0, [OAMDATA]
        MOVQ R0, #2
        ST   R0, [OAMADDR]
        LD   R0, [OAMDATA]
        MOVW R1, #$9ABC
        CALL CHECK
        ; #123 wrap: OAMADDR 01FE, one write -> 0000
        MOVW R0, #$01FE
        ST   R0, [OAMADDR]
        MOVW R0, #$CAFE
        ST   R0, [OAMDATA]
        LD   R0, [OAMADDR]
        MOVQ R1, #0
        CALL CHECK
        ; #124 the word is at 01FE; OAM is 512 bytes (0000 still 1234)
        MOVW R0, #$01FE
        ST   R0, [OAMADDR]
        LD   R0, [OAMDATA]
        MOVW R1, #$CAFE
        CALL CHECK
        ; #125 (continuing from the wrap) OAMDATA now reads 0000's word
        LD   R0, [OAMDATA]
        MOVW R1, #$1234
        CALL CHECK

        ; ---- CRAMADDR / CRAMDATA (manual 5.7, §8.5) ----
        ; #126 CRAMADDR 0005: two writes -> 0007
        MOVQ R0, #5
        ST   R0, [CRAMADDR]
        MOVW R0, #$0ABC
        ST   R0, [CRAMDATA]
        MOVW R0, #$0123
        ST   R0, [CRAMDATA]
        LD   R0, [CRAMADDR]
        MOVQ R1, #7
        CALL CHECK
        ; #127-#128 read back
        MOVQ R0, #5
        ST   R0, [CRAMADDR]
        LD   R0, [CRAMDATA]
        MOVW R1, #$0ABC
        CALL CHECK
        LD   R0, [CRAMDATA]
        MOVW R1, #$0123
        CALL CHECK
        ; entries are 12 bits: FFFF written at 01FF
        MOVW R0, #$01FF
        ST   R0, [CRAMADDR]
        MOVW R0, #$FFFF
        ST   R0, [CRAMDATA]
        ; #129 CRAMADDR wrapped 01FF -> 0000
        LD   R0, [CRAMADDR]
        MOVQ R1, #0
        CALL CHECK
        ; #130 ...reads back 0FFF (bits 15-12 read 0)
        MOVW R0, #$01FF
        ST   R0, [CRAMADDR]
        LD   R0, [CRAMDATA]
        MOVW R1, #$0FFF
        CALL CHECK
        ; #131 byte write 5A to F022 (low half) at 000A, CRAMADDR advances to 000B
        MOVQ R0, #10
        ST   R0, [CRAMADDR]
        MOVQ R0, #$5A
        STB  R0, [CRAMDATA]
        LD   R0, [CRAMADDR]
        MOVQ R1, #11
        CALL CHECK
        ; #132 byte write F3 to F023 (high half) at 000A: bits 15-12 dropped -> entry 035A
        MOVQ R0, #10
        ST   R0, [CRAMADDR]
        MOVW R0, #$F3
        STB  R0, [CRAMDATA+1]
        MOVQ R0, #10
        ST   R0, [CRAMADDR]
        LD   R0, [CRAMDATA]
        MOVW R1, #$035A
        CALL CHECK
        ; #133-#135 byte reads: LDB F023 at 000A = 03 and advances to 000B; LDB F022 at 000A = 5A
        MOVQ R0, #10
        ST   R0, [CRAMADDR]
        LDB  R0, [CRAMDATA+1]
        MOVQ R1, #3
        CALL CHECK
        LD   R0, [CRAMADDR]
        MOVQ R1, #11
        CALL CHECK
        MOVQ R0, #10
        ST   R0, [CRAMADDR]
        LDB  R0, [CRAMDATA]
        MOVQ R1, #$5A
        CALL CHECK

        ; ---- read-only registers ignore writes (§8.29), DMACTL reads 0 ----
        ; #136 VCOUNT: at line 70, writing 0 to VCOUNT changes nothing
        MOVQ R0, #70
        CALL LINESTART
        MOVQ R0, #0
        ST   R0, [VCOUNT]
        LD   R0, [VCOUNT]
        MOVQ R1, #70
        CALL CHECK
        ; #137 VSTAT in active display, after writing FFFF: 0 (no vblank, no overflow, no probe).
        ; The mask loop above briefly wrote VCTRL = 1F with OAM all zero (64 sprites on lines
        ; 0-7), which may have set the sticky overflow bit; reading VSTAT once clears it (§8.2).
        LD   R0, [VSTAT]
        MOVW R0, #$FFFF
        ST   R0, [VSTAT]
        LD   R0, [VSTAT]
        MOVQ R1, #0
        CALL CHECK
        ; #138 PROBE (never captured: display disabled)
        MOVW R0, #$FFFF
        ST   R0, [PROBE]
        LD   R0, [PROBE]
        MOVQ R1, #0
        CALL CHECK
        ; #139-#140 PAD1, PAD2 (no controller input in this ROM)
        MOVW R0, #$FFFF
        ST   R0, [PAD1]
        ST   R0, [PAD2]
        LD   R0, [PAD1]
        MOVQ R1, #0
        CALL CHECK
        LD   R0, [PAD2]
        MOVQ R1, #0
        CALL CHECK
        ; #141 DMACTL is write-only and reads 0
        LD   R0, [DMACTL]
        MOVQ R1, #0
        CALL CHECK

        ; ---- VCOUNT and VSTAT bit 0 through the frame ----
        ; #142-#143 at the VBLANK wake: VCOUNT = 224, VSTAT bit 0 = 1
        CALL WAITVB
        LD   R0, [VCOUNT]
        MOVW R1, #224
        CALL CHECK
        LD   R0, [VSTAT]
        MOVQ R1, #1
        CALL CHECK
        ; #144-#145 line 261 (last vblank line): VCOUNT = 261, VSTAT bit 0 = 1
        MOVW R0, #261
        CALL WAITLN
        LD   R0, [VCOUNT]
        MOVW R1, #261
        CALL CHECK
        LD   R0, [VSTAT]
        MOVQ R1, #1
        CALL CHECK
        ; #146 the next line is 0 and VSTAT bit 0 = 0
        MOVQ R0, #0
        CALL WAITVC
        LD   R0, [VSTAT]
        MOVQ R1, #0
        CALL CHECK
        ; #147-#148 line 223 (last visible line): VSTAT bit 0 = 0
        MOVW R0, #223
        CALL WAITLN
        LD   R0, [VCOUNT]
        MOVW R1, #223
        CALL CHECK
        LD   R0, [VSTAT]
        MOVQ R1, #0
        CALL CHECK
        ; #149-#150 VCOUNT steps through every line: from line 0, count changes until line 0
        ; returns (262 lines per frame), keeping the largest value seen (261)
        MOVQ R0, #0
        CALL WAITVC
        MOVQ R2, #0                 ; previous value
        MOVQ R3, #0                 ; number of changes
        MOVQ R4, #0                 ; largest value
.vc:    LD   R0, [VCOUNT]
        CMP  R0, R2
        BEQ  .vc
        ADDQ R3, #1
        MOV  R2, R0
        CMP  R4, R0
        BHS  .vcmax
        MOV  R4, R0
.vcmax: TST  R0, R0
        BNE  .vc
        MOV  R0, R3
        MOVW R1, #262
        CALL CHECK
        MOV  R0, R4
        MOVW R1, #261
        CALL CHECK
        ; #151 a frame is 59,736 CPU cycles: VBLANK wake to VBLANK wake, timer at prescaler 1
        ; (the counter reloads FFFF at 0, so it is a mod-65536 down-counter)
        CALL TSTART
        CALL WAITVB
        LD   R4, [TCOUNT]
        CALL WAITVB
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVW R1, #59736
        CALL CHECK
        ; #152 a line is 228 cycles: LINE wake on line 100 to LINE wake on line 101
        MOVQ R0, #100
        CALL WAITLN
        LD   R4, [TCOUNT]
        MOVQ R0, #101
        CALL WAITLN
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVW R1, #228
        CALL CHECK

        ; ---- port wait cycles (manual 5.12, §8.6, §8.34) ----
        ; Measured as R4 - R5 = 6 (the first LD [TCOUNT]) + cycles of the instruction between.
        ; LD/ST/LDB/STB [abs16] = 6 cycles, + 2 while the instruction starts in active display.
        ; Vertical blank: returns from WAITVB at cycle 12 of line 224; all of #153-#160 run
        ; within lines 224-226.
        CALL WAITVB
        ; #153 LD VDATA in vblank: 6 + 6 = 12
        LD   R4, [TCOUNT]
        LD   R0, [VDATA]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #12
        CALL CHECK
        ; #154 ST VDATA
        LD   R4, [TCOUNT]
        ST   R0, [VDATA]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #12
        CALL CHECK
        ; #155 LDB F003
        LD   R4, [TCOUNT]
        LDB  R0, [VDATA+1]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #12
        CALL CHECK
        ; #156 LD OAMDATA
        LD   R4, [TCOUNT]
        LD   R0, [OAMDATA]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #12
        CALL CHECK
        ; #157 ST OAMDATA
        LD   R4, [TCOUNT]
        ST   R0, [OAMDATA]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #12
        CALL CHECK
        ; #158 LD CRAMDATA
        LD   R4, [TCOUNT]
        LD   R0, [CRAMDATA]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #12
        CALL CHECK
        ; #159 STB CRAMDATA
        LD   R4, [TCOUNT]
        STB  R0, [CRAMDATA]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #12
        CALL CHECK
        ; #160 control: LD VADDR (never waits)
        LD   R4, [TCOUNT]
        LD   R0, [VADDR]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #12
        CALL CHECK
        ; Active display: LINESTART returns at cycle 15 of the line (dot 22); the port access
        ; starts 6 cycles later (dot 31 < 256): 6 + 6 + 2 = 14. One line per measurement.
        ; #161 LD VDATA
        MOVQ R0, #100
        CALL LINESTART
        LD   R4, [TCOUNT]
        LD   R0, [VDATA]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #14
        CALL CHECK
        ; #162 ST VDATA
        MOVQ R0, #101
        CALL LINESTART
        LD   R4, [TCOUNT]
        ST   R0, [VDATA]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #14
        CALL CHECK
        ; #163 STB F003 (byte access waits too, §8.34)
        MOVQ R0, #102
        CALL LINESTART
        LD   R4, [TCOUNT]
        STB  R0, [VDATA+1]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #14
        CALL CHECK
        ; #164 LD OAMDATA
        MOVQ R0, #103
        CALL LINESTART
        LD   R4, [TCOUNT]
        LD   R0, [OAMDATA]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #14
        CALL CHECK
        ; #165 ST OAMDATA
        MOVQ R0, #104
        CALL LINESTART
        LD   R4, [TCOUNT]
        ST   R0, [OAMDATA]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #14
        CALL CHECK
        ; #166 LD CRAMDATA
        MOVQ R0, #105
        CALL LINESTART
        LD   R4, [TCOUNT]
        LD   R0, [CRAMDATA]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #14
        CALL CHECK
        ; #167 ST CRAMDATA on line 0 (the first visible line)
        MOVQ R0, #0
        CALL WAITVC
        MOVQ R0, #1
        CALL WAITVC
        LD   R4, [TCOUNT]
        ST   R0, [CRAMDATA]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #14
        CALL CHECK
        ; #168 control: LD VADDR in active display does not wait
        MOVQ R0, #106
        CALL LINESTART
        LD   R4, [TCOUNT]
        LD   R0, [VADDR]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #12
        CALL CHECK
        ; Horizontal blank of a visible line: WAITLN returns at cycle 183 (dot 274.5); the port
        ; access starts at cycle 189 (dot 283.5), before the line ends at cycle 228: no wait.
        ; #169 LD VDATA in hblank of line 110
        MOVQ R0, #110
        CALL WAITLN
        LD   R4, [TCOUNT]
        LD   R0, [VDATA]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #12
        CALL CHECK
        ; #170 ST OAMDATA in hblank of line 111
        MOVQ R0, #111
        CALL WAITLN
        LD   R4, [TCOUNT]
        ST   R0, [OAMDATA]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #12
        CALL CHECK
        ; #171 dots 0-255 of a vblank line are not active display: LD CRAMDATA early in line 230
        MOVW R0, #230
        CALL LINESTART
        LD   R4, [TCOUNT]
        LD   R0, [CRAMDATA]
        LD   R5, [TCOUNT]
        MOV  R0, R4
        SUB  R0, R5
        MOVQ R1, #12
        CALL CHECK
        MOVQ R0, #0
        ST   R0, [TCTRL]
        ST   R0, [IE]
        JMP  PASS
