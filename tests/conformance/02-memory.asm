; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Conformance 02: memory access. Every addressing form of LD/ST/LDB/STB
; (spec-notes §1 "Memory access" and groups 4-9, §2 memory map, §10.65),
; little-endian layout, zero-extending byte loads, aligned word access,
; ROM write protection, unmapped space and work RAM boundaries.
        .org $0000
        .word start, 0, 0, 0, 0
        .header title="CONFORMANCE 02 MEMORY", dev=$0001, date=$19870301, version=$0100
        .org $0040
        .include "_harness.inc"
        .include "_cpu.inc"

BUF = $8100                     ; scratch area in work RAM
TAB = $8140                     ; bytes 01 12 23 34 45 56 67 78

start:  MOVQ R7, #1
        MOVW R3, #BUF

; ---- little-endian layout, byte stores, zero-extending byte loads -------------
        MOVW R2, #$1234
        ST   R2, [R3]
        LDB  R0, [R3]           ; low byte at the even address
        MOV  R1, #$34
        CALL CHECK              ; 1
        LDB  R0, [R3+1]
        MOV  R1, #$12
        CALL CHECK              ; 2
        MOVW R2, #$ABCD
        STB  R2, [R3+1]         ; only the low byte of R2, only one byte of RAM
        LD   R0, [R3]
        MOVW R1, #$CD34
        CALL CHECK              ; 3
        STB  R2, [R3]
        LD   R0, [R3]
        MOVW R1, #$CDCD
        CALL CHECK              ; 4
        LD   R0, [R3+2]         ; neighbour word untouched (still 0)
        MOVQ R1, #0
        CALL CHECK              ; 5
        MOVW R2, #$80FF
        ST   R2, [R3+2]
        MOVW R0, #$5555
        LDB  R0, [R3+2]         ; zero-extends: 00FF, not FFFF
        MOVW R1, #$00FF
        CALL CHECK              ; 6
        MOVW R0, #$5555
        LDB  R0, [R3+3]
        MOVW R1, #$0080
        CALL CHECK              ; 7

; ---- short [Rs+d] maximum displacements (words 126, bytes 63) ----------------
        MOVW R2, #$7E7E
i_st126: ST  R2, [R3+126]
        LD   R0, [BUF+126]
        MOVW R1, #$7E7E
        CALL CHECK              ; 8
        LD   R0, [i_st126]      ; it really is the short form: 5 | d=2 s=3 p=63
        MOVW R1, #$54FF
        CALL CHECK              ; 9
        MOVW R2, #$C0DE
        ST   R2, [BUF+124]
        LD   R0, [R3+124]
        MOVW R1, #$C0DE
        CALL CHECK              ; 10
        MOV  R2, #$3F
i_stb63: STB R2, [R3+63]
        LDB  R0, [BUF+63]
        MOV  R1, #$3F
        CALL CHECK              ; 11
        LD   R0, [i_stb63]      ; 7 | d=2 s=3 p=63
        MOVW R1, #$74FF
        CALL CHECK              ; 12
i_ldb63: LDB R0, [R3+63]
        MOV  R1, #$3F
        CALL CHECK              ; 13
        LD   R0, [i_ldb63]      ; 6 | d=0 s=3 p=63
        MOVW R1, #$60FF
        CALL CHECK              ; 14
        ; short form with a 16-bit wrap: FFF0 + 20 = 0010 ("CY" of the header)
        MOVW R4, #$FFF0
        LD   R0, [R4+$20]
        MOVW R1, #$5943
        CALL CHECK              ; 15
        LDB  R0, [R4+$23]       ; 0013 = 'L'
        MOV  R1, #'L'
        CALL CHECK              ; 16

; ---- [Rs+d16] (group 8 mode 00) ---------------------------------------------
        MOVW R2, #$1111
        ST   R2, [BUF+200]
        LD   R0, [R3+200]       ; 200 > 126: long form
        MOVW R1, #$1111
        CALL CHECK              ; 17
        MOVW R2, #$2222
        ST   R2, [R3-2]         ; negative displacement -> 80FE
        LD   R0, [$80FE]
        MOVW R1, #$2222
        CALL CHECK              ; 18
        LDX  R0, [R3+2]         ; forced long form, small displacement
        MOVW R1, #$80FF
        CALL CHECK              ; 19
        MOVW R4, #$FFF0         ; wraparound: FFF0 + 8110 = 8100
        LDX  R0, [R4+$8110]
        MOVW R1, #$CDCD
        CALL CHECK              ; 20
        MOVW R2, #$3344
        STX  R2, [R4+$8114]     ; -> 8104
        LD   R0, [BUF+4]
        MOVW R1, #$3344
        CALL CHECK              ; 21
        LDBX R0, [R4+$8115]     ; -> 8105 = 33
        MOV  R1, #$33
        CALL CHECK              ; 22
        MOVW R2, #$9988
        STBX R2, [R3+301]       ; -> 822D, one byte
        LD   R0, [BUF+300]
        MOVW R1, #$8800
        CALL CHECK              ; 23
        MOVW R4, #$FFFE         ; FFFE + 2 wraps to 0000 = the RESET vector
        LDX  R0, [R4+2]
        MOVW R1, #start
        CALL CHECK              ; 24

; ---- [abs16] (group 8 mode 01) ----------------------------------------------
        MOVW R2, #$BEEF
        ST   R2, [$8120]
        LD   R0, [$8120]
        MOVW R1, #$BEEF
        CALL CHECK              ; 25
        LDB  R0, [$8121]
        MOV  R1, #$BE
        CALL CHECK              ; 26
        STB  R2, [$8123]
        LD   R0, [$8122]
        MOVW R1, #$EF00
        CALL CHECK              ; 27
        LDB  R0, [$0010]        ; header magic in ROM
        MOV  R1, #'C'
        CALL CHECK              ; 28

; ---- [Rs]+ and -[Rs] ----------------------------------------------------------
        MOVW R4, #TAB           ; build the table with post-increment word stores
        MOVW R2, #$1201
        ST   R2, [R4]+
        MOVW R2, #$3423
        ST   R2, [R4]+
        MOVW R2, #$5645
        ST   R2, [R4]+
        MOVW R2, #$7867
        ST   R2, [R4]+
        MOV  R0, R4
        MOVW R1, #TAB+8
        CALL CHECK              ; 29
        LD   R0, [TAB+6]
        MOVW R1, #$7867
        CALL CHECK              ; 30
        MOVW R4, #TAB
        LD   R0, [R4]+
        MOVW R1, #$1201
        CALL CHECK              ; 31
        LD   R0, [R4]+
        MOVW R1, #$3423
        CALL CHECK              ; 32
        MOV  R0, R4
        MOVW R1, #TAB+4
        CALL CHECK              ; 33
        LD   R0, -[R4]          ; back to TAB+2
        MOVW R1, #$3423
        CALL CHECK              ; 34
        MOV  R0, R4
        MOVW R1, #TAB+2
        CALL CHECK              ; 35
        MOVW R4, #TAB           ; byte post-increment steps by 1
        LDB  R0, [R4]+
        MOV  R1, #$01
        CALL CHECK              ; 36
        LDB  R0, [R4]+
        MOV  R1, #$12
        CALL CHECK              ; 37
        MOV  R0, R4
        MOVW R1, #TAB+2
        CALL CHECK              ; 38
        LDB  R0, -[R4]          ; byte pre-decrement steps by 1
        MOV  R1, #$12
        CALL CHECK              ; 39
        MOV  R0, R4
        MOVW R1, #TAB+1
        CALL CHECK              ; 40
        MOVW R4, #$8150         ; byte stores with post-increment / pre-decrement
        MOVW R2, #$A1B2
        STB  R2, [R4]+
        MOVW R2, #$C3
        STB  R2, [R4]+
        LD   R0, [$8150]
        MOVW R1, #$C3B2
        CALL CHECK              ; 41
        MOVW R2, #$D4
        STB  R2, -[R4]          ; 8151 <- D4
        LD   R0, [$8150]
        MOVW R1, #$D4B2
        CALL CHECK              ; 42
        MOVW R2, #$E5F6
        ST   R2, -[R4]          ; R4 = 8151 - 2 = 814F (odd): word at 814E
        LD   R0, [$814E]
        MOVW R1, #$E5F6
        CALL CHECK              ; 43
        MOV  R0, R4
        MOVW R1, #$814F
        CALL CHECK              ; 44

; ---- d = s: a load keeps the loaded value; a store stores the old value -------
        MOVW R4, #TAB
        LD   R4, [R4]+
        MOVW R1, #$1201
        MOV  R0, R4
        CALL CHECK              ; 45
        MOVW R4, #TAB+4
        LD   R4, -[R4]          ; TAB+2 -> 3423
        MOV  R0, R4
        MOVW R1, #$3423
        CALL CHECK              ; 46
        MOVW R4, #TAB+6
        LDB  R4, [R4]+          ; byte 67
        MOV  R0, R4
        MOV  R1, #$67
        CALL CHECK              ; 47
        MOVW R4, #TAB+5
        LDB  R4, -[R4]          ; byte at TAB+4 = 45
        MOV  R0, R4
        MOV  R1, #$45
        CALL CHECK              ; 48
        MOVW R4, #$8160
        ST   R4, [R4]+          ; stores 8160 at 8160
        LD   R0, [$8160]
        MOVW R1, #$8160
        CALL CHECK              ; 49
        MOV  R0, R4
        MOVW R1, #$8162
        CALL CHECK              ; 50
        MOVW R4, #$8166
        ST   R4, -[R4]          ; stores 8166 (old) at 8164
        LD   R0, [$8164]
        MOVW R1, #$8166
        CALL CHECK              ; 51
        MOV  R0, R4
        MOVW R1, #$8164
        CALL CHECK              ; 52
        MOVW R4, #$8171
        STB  R4, [R4]+          ; stores 71 at 8171
        LDB  R0, [$8171]
        MOV  R1, #$71
        CALL CHECK              ; 53
        MOV  R0, R4
        MOVW R1, #$8172
        CALL CHECK              ; 54
        MOVW R4, #$8175
        STB  R4, -[R4]          ; stores 75 at 8174
        LD   R0, [$8174]
        MOV  R1, #$75
        CALL CHECK              ; 55
        MOV  R0, R4
        MOVW R1, #$8174
        CALL CHECK              ; 56

; ---- odd register with word post-increment / pre-decrement (§10.65) ----------
        MOVW R4, #TAB+1
        LD   R0, [R4]+          ; aligned word at TAB
        MOVW R1, #$1201
        CALL CHECK              ; 57
        MOV  R0, R4             ; exactly +2: stays odd
        MOVW R1, #TAB+3
        CALL CHECK              ; 58
        LD   R0, -[R4]          ; R4 = TAB+1, word at TAB
        MOVW R1, #$1201
        CALL CHECK              ; 59
        MOV  R0, R4
        MOVW R1, #TAB+1
        CALL CHECK              ; 60
        MOVW R4, #$8181
        MOVW R2, #$A00A
        ST   R2, [R4]+          ; word at 8180
        LD   R0, [$8180]
        MOVW R1, #$A00A
        CALL CHECK              ; 61
        MOV  R0, R4
        MOVW R1, #$8183
        CALL CHECK              ; 62
        MOVW R2, #$B00B
        ST   R2, -[R4]          ; R4 = 8181, word at 8180
        LD   R0, [$8180]
        MOVW R1, #$B00B
        CALL CHECK              ; 63
        LD   R0, [$8182]        ; untouched
        MOVQ R1, #0
        CALL CHECK              ; 64
        MOVW R4, #TAB+1         ; byte post-increment at an odd address: that byte
        LDB  R0, [R4]+
        MOV  R1, #$12
        CALL CHECK              ; 65
        MOV  R0, R4
        MOVW R1, #TAB+2
        CALL CHECK              ; 66

; ---- post-increment / pre-decrement wrap at 16 bits ---------------------------
        MOVW R4, #$FFFE
        LD   R0, [R4]+          ; FFFE is unmapped: reads 0
        MOV  R1, #0
        CALL CHECK              ; 67
        MOV  R0, R4
        MOVQ R1, #0
        CALL CHECK              ; 68
        LD   R0, -[R4]          ; 0000 - 2 = FFFE
        MOV  R0, R4
        MOVW R1, #$FFFE
        CALL CHECK              ; 69
        MOVW R4, #$FFFF
        LDB  R0, [R4]+
        MOV  R0, R4
        MOVQ R1, #0
        CALL CHECK              ; 70
        LDB  R0, -[R4]
        MOV  R0, R4
        MOVW R1, #$FFFF
        CALL CHECK              ; 71

; ---- [SP+d] (group 9) ------------------------------------------------------
        MOV  R6, SP             ; save SP (C000)
        MOVW R4, #$9000
        MOV  SP, R4
        MOVW R2, #$5150
        ST   R2, [SP]
        LD   R0, [$9000]
        MOVW R1, #$5150
        CALL CHECK              ; 72
        MOVW R2, #$5A5A
        ST   R2, [SP+510]       ; maximum displacement
        LD   R0, [$91FE]
        MOVW R1, #$5A5A
        CALL CHECK              ; 73
        MOVW R2, #$6116
        ST   R2, [$9100]
        LD   R0, [SP+$100]
        MOVW R1, #$6116
        CALL CHECK              ; 74
        LD   R0, [SP+510]
        MOVW R1, #$5A5A
        CALL CHECK              ; 75
        MOV  SP, R6

; ---- word access at odd addresses uses the aligned word -----------------------
        LD   R0, [TAB+1]        ; absolute, odd
        MOVW R1, #$1201
        CALL CHECK              ; 76
        MOVW R2, #$C11C
        ST   R2, [$8191]        ; writes the word at 8190
        LD   R0, [$8190]
        MOVW R1, #$C11C
        CALL CHECK              ; 77
        LD   R0, [$8192]
        MOVQ R1, #0
        CALL CHECK              ; 78
        MOVW R4, #$8101
        LDX  R0, [R4+$42]       ; odd base: 8143 -> word at 8142
        MOVW R1, #$3423
        CALL CHECK              ; 79
        MOVW R4, #TAB+1
        LD   R0, [R4+4]         ; short form, odd base: 8145 -> word at 8144
        MOVW R1, #$5645
        CALL CHECK              ; 80
        MOVW R4, #$8199
        MOVW R2, #$D22D
        ST   R2, [R4+2]         ; 819B -> word at 819A
        LD   R0, [$819A]
        MOVW R1, #$D22D
        CALL CHECK              ; 81

; ---- writes to ROM are ignored ----------------------------------------------
        LD   R0, [romword]
        MOVW R1, #$A55A
        CALL CHECK              ; 82
        MOVQ R2, #0
        ST   R2, [romword]
        STB  R2, [romword+1]
        LD   R0, [romword]
        MOVW R1, #$A55A
        CALL CHECK              ; 83
        LD   R0, [$4000]        ; bank 1 in the window
        MOVW R1, #$B1B1
        CALL CHECK              ; 84
        ST   R2, [$4000]
        LD   R0, [$4000]
        MOVW R1, #$B1B1
        CALL CHECK              ; 85

; ---- unmapped and unused addresses read 0, writes ignored ---------------------
        MOVW R2, #$FFFF
        ST   R2, [$E100]
        LD   R0, [$E100]
        MOVQ R1, #0
        CALL CHECK              ; 86
        ST   R2, [$F0F0]
        LD   R0, [$F0F0]
        MOVQ R1, #0
        CALL CHECK              ; 87
        LD   R0, [$EFFE]
        MOVQ R1, #0
        CALL CHECK              ; 88
        LDB  R0, [$FFFF]
        MOVQ R1, #0
        CALL CHECK              ; 89
        LD   R0, [$E004]        ; unused cartridge register address
        MOVQ R1, #0
        CALL CHECK              ; 90
        LD   R0, [$F00E]        ; unused console I/O address
        MOVQ R1, #0
        CALL CHECK              ; 91
        MOVQ R0, #1             ; no cartridge RAM fitted (ram=0): C000-DFFF reads 0
        ST   R0, [RAMCTL]
        ST   R2, [$C000]
        LD   R0, [$C000]
        MOVQ R1, #0
        CALL CHECK              ; 92
        MOVQ R0, #0
        ST   R0, [RAMCTL]

; ---- work RAM boundaries -----------------------------------------------------
        MOVW R2, #$8001
        ST   R2, [$8000]
        LD   R0, [$8000]
        MOVW R1, #$8001
        CALL CHECK              ; 93
        MOVW R2, #$BFFE
        ST   R2, [$BFFE]        ; top word (the stack's first push slot)
        LD   R0, [$BFFE]
        MOVW R1, #$BFFE
        CALL CHECK              ; 94
        MOV  R2, #$5B
        STB  R2, [$BFFF]
        LDB  R0, [$BFFF]
        MOV  R1, #$5B
        CALL CHECK              ; 95
        LD   R0, [$C000]        ; no wrap past the top of work RAM
        MOVQ R1, #0
        CALL CHECK              ; 96
        LD   R0, [$7FFE]        ; last word of the bank window (unused ROM = FF)
        MOVW R1, #$FFFF
        CALL CHECK              ; 97

; ---- loads and stores do not affect flags ------------------------------------
        MOVQ R1, #2|4|8
        MOVQ R0, #2|4|8
        SETF R0
        LD   R0, [$E100]        ; loads 0: flags must stay N C V (no Z)
        CALL CHECKF             ; 98
        MOVW R4, #BUF
        MOVQ R1, #1
        MOVQ R0, #1
        SETF R0
        LDB  R2, [$4000]        ; B1: a load of a non-zero value keeps Z
        ST   R2, [R4]+
        STB  R2, -[R4]
        LD   R2, [SP]
        CALL CHECKF             ; 99

        JMP  PASS

romword: .word $A55A

        .bank 1
        .org $4000
        .word $B1B1
