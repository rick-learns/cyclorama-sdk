; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Conformance 08: cartridge ROM banking (spec-notes §2 memory map, §10.51; manual ch. 4).
; An 8-bank (128 KiB) image. Bank n (1-7) carries the marker word B000+n at 4000 and E000+n at
; 7FFE; bank 0 carries B0B0 at 3FF0 (seen in the window at 7FF0 when BANK selects bank 0).
; Also: ROM writes ignored, cartridge RAM absent (header ram=0) reads 0, unused cartridge and
; unmapped addresses read 0.
        .rom 8
        .bank 0
        .org $0000
        .word start, 0, 0, 0, 0
        .header title="CONFORMANCE 08 BANKS", dev=$0001, date=$19870301, version=$0100
        .org $0040
        .include "_harness.inc"
        .include "_hw.inc"

start:  MOVQ R7, #1
        ; #1 BANK reset value is 1 (spec-notes §1 reset, registers.ts BANK)
        LD   R0, [BANK]
        MOVQ R1, #1
        CALL CHECK
        ; #2 the window shows bank 1 after reset
        LD   R0, [$4000]
        MOVW R1, #$B001
        CALL CHECK
        ; #3-#20 BANK = n selects bank n: BANK reads n, [4000] = B000+n, [7FFE] = E000+n (n = 2..7)
        MOVQ R3, #2
.sel:   ST   R3, [BANK]
        LD   R0, [BANK]
        MOV  R1, R3
        CALL CHECK
        LD   R0, [$4000]
        MOVW R1, #$B000
        ADD  R1, R3
        CALL CHECK
        LD   R0, [$7FFE]
        MOVW R1, #$E000
        ADD  R1, R3
        CALL CHECK
        ADDQ R3, #1
        CMPW R3, #8
        BNE  .sel
        ; #21 byte reads of the window follow the bank too: BANK = 5, LDB [4000] = 05 (low byte of B005)
        MOVQ R0, #5
        ST   R0, [BANK]
        LDB  R0, [$4000]
        MOVQ R1, #5
        CALL CHECK
        ; #22 BANK = 0 is legal and shows bank 0 in the window: [7FF0] = bank 0's 3FF0 marker
        MOVQ R0, #0
        ST   R0, [BANK]
        LD   R0, [$7FF0]
        MOVW R1, #$B0B0
        CALL CHECK
        ; #23 ...and [4000] is ROM word 0000, the RESET vector
        LD   R0, [$4000]
        MOVW R1, #start
        CALL CHECK
        ; #24-#25 BANK = 8 reads back 8 and selects 8 mod 8 = bank 0 (§10.51)
        MOVQ R0, #8
        ST   R0, [BANK]
        LD   R0, [BANK]
        MOVQ R1, #8
        CALL CHECK
        LD   R0, [$7FF0]
        MOVW R1, #$B0B0
        CALL CHECK
        ; #26 BANK = 9 selects bank 1
        MOVQ R0, #9
        ST   R0, [BANK]
        LD   R0, [$4000]
        MOVW R1, #$B001
        CALL CHECK
        ; #27 BANK = 255 selects 255 mod 8 = bank 7
        MOVW R0, #255
        ST   R0, [BANK]
        LD   R0, [$4000]
        MOVW R1, #$B007
        CALL CHECK
        ; #28-#29 BANK keeps bits 7-0 only: write 1203 -> reads 0003, selects bank 3
        MOVW R0, #$1203
        ST   R0, [BANK]
        LD   R0, [BANK]
        MOVQ R1, #3
        CALL CHECK
        LD   R0, [$4000]
        MOVW R1, #$B003
        CALL CHECK
        ; #30 a byte write to BANK's high half (E001) writes undefined bits only: BANK stays 3
        MOVQ R0, #6
        STB  R0, [$E001]
        LD   R0, [BANK]
        MOVQ R1, #3
        CALL CHECK
        ; #31 a byte write to the low half (E000) sets the bank: 6 -> window shows bank 6
        MOVQ R0, #6
        STB  R0, [$E000]
        LD   R0, [$4000]
        MOVW R1, #$B006
        CALL CHECK

        ; ---- far call through the bank-0 trampoline (manual ch. 4, example 4) ----
        ; Main (bank 0) selects bank 2 and calls Bank2Entry in the window. Bank2Entry far-calls
        ; Bank3Add (R0 += bank 3's marker B003) through FarCall, then adds its own marker word read
        ; from the window (only correct if bank 2 was restored) and returns.
        ; R0 = 0010: 0010 + B003 = B013; + B002 = 16015 -> 6015 (16-bit).
        MOVQ R0, #2
        ST   R0, [BANK]
        MOVQ R0, #$10
        CALL Bank2Entry
        MOV  R3, R0
        ; #32 result of the far call chain
        MOV  R0, R3
        MOVW R1, #$6015
        CALL CHECK
        ; #33 the caller's bank (2) is selected again
        LD   R0, [BANK]
        MOVQ R1, #2
        CALL CHECK
        ; #34 the far routine ran with BANK = 3 (it stored BANK to 8010)
        LD   R0, [$8010]
        MOVQ R1, #3
        CALL CHECK
        ; #35 the stack is balanced (SP back at C000)
        MOV  R0, SP
        MOVW R1, #$C000
        CALL CHECK

        ; ---- writes to ROM are ignored (§2) ----
        ; #36 word store into bank 0 ROM
        MOVW R0, #$1234
        ST   R0, [$3FF0]
        LD   R0, [$3FF0]
        MOVW R1, #$B0B0
        CALL CHECK
        ; #37 word store into the window (bank 2)
        MOVW R0, #$1234
        ST   R0, [$4000]
        LD   R0, [$4000]
        MOVW R1, #$B002
        CALL CHECK
        ; #38 byte store into the window, high byte of the marker
        MOVQ R0, #$55
        STB  R0, [$4001]
        LD   R0, [$4000]
        MOVW R1, #$B002
        CALL CHECK
        ; #39 bank 2 reselected through another BANK value (10 mod 8 = 2) still holds B002
        MOVQ R0, #10
        ST   R0, [BANK]
        LD   R0, [$4000]
        MOVW R1, #$B002
        CALL CHECK

        ; ---- cartridge RAM absent (header ram=0): C000-DFFF reads 0, writes ignored ----
        ; #40-#42 reads at C000, DFFE and a byte read at DFFF are 0
        LD   R0, [$C000]
        MOVQ R1, #0
        CALL CHECK
        LD   R0, [$DFFE]
        MOVQ R1, #0
        CALL CHECK
        LDB  R0, [$DFFF]
        MOVQ R1, #0
        CALL CHECK
        ; #43 even with RAMCTL bit 0 set, a write to C000 is not stored ("no effect" without RAM)
        MOVQ R0, #1
        ST   R0, [RAMCTL]
        MOVW R0, #$A55A
        ST   R0, [$C000]
        STB  R0, [$C003]
        LD   R0, [$C000]
        MOVQ R1, #0
        CALL CHECK
        ; #44 byte store did not stick either
        LD   R0, [$C002]
        MOVQ R1, #0
        CALL CHECK
        MOVQ R0, #0
        ST   R0, [RAMCTL]
        ; #45 work RAM just below is ordinary memory (sanity: the decoder boundary is at C000)
        MOVW R0, #$5AA5
        ST   R0, [$BFF0]
        LD   R0, [$BFF0]
        MOVW R1, #$5AA5
        CALL CHECK

        ; ---- unused cartridge-register and unmapped addresses read 0, writes ignored (§2) ----
        ; #46 E004 (unused cartridge register) after a write
        MOVW R0, #$FFFF
        ST   R0, [$E004]
        LD   R0, [$E004]
        MOVQ R1, #0
        CALL CHECK
        ; #47 E0FE
        MOVW R0, #$FFFF
        ST   R0, [$E0FE]
        LD   R0, [$E0FE]
        MOVQ R1, #0
        CALL CHECK
        ; #48 E100 (unmapped)
        MOVW R0, #$FFFF
        ST   R0, [$E100]
        LD   R0, [$E100]
        MOVQ R1, #0
        CALL CHECK
        ; #49 EFFE (unmapped)
        MOVW R0, #$FFFF
        ST   R0, [$EFFE]
        LD   R0, [$EFFE]
        MOVQ R1, #0
        CALL CHECK
        ; #50 F0F0 (unmapped)
        MOVW R0, #$FFFF
        ST   R0, [$F0F0]
        LD   R0, [$F0F0]
        MOVQ R1, #0
        CALL CHECK
        ; #51 FFFE (unmapped)
        MOVW R0, #$FFFF
        ST   R0, [$FFFE]
        LD   R0, [$FFFE]
        MOVQ R1, #0
        CALL CHECK
        ; #52 the unused writes did not disturb BANK (still 10)
        LD   R0, [BANK]
        MOVQ R1, #10
        CALL CHECK
        JMP  PASS

; FarCall: R6 = target bank, R7 = routine address in 4000-7FFF (manual example 4).
; R7 is the check counter elsewhere, so callers save it; R0-R5 pass through.
FarCall:
        PUSH R6
        LD   R6, [BANK]
        PUSH R6
        LD   R6, [SP+2]
        ST   R6, [BANK]
        CALL [R7]
        POP  R6
        ST   R6, [BANK]
        ADD  SP, #2
        RTS

        .org $3FF0
        .word $B0B0

; ---- banks 1-7: markers ----
        .bank 1
        .org $4000
        .word $B001
        .org $7FFE
        .word $E001

        .bank 2
        .org $4000
        .word $B002
; Bank2Entry: runs in the window (bank 2). R0 += Bank3's marker via FarCall, then += B002.
Bank2Entry:
        PUSH R7                 ; R7 is the check number
        MOVQ R6, #3
        MOVW R7, #Bank3Add
        CALL FarCall
        POP  R7
        LD   R1, [$4000]        ; our own marker: only B002 if bank 2 is back in the window
        ADD  R0, R1
        RTS
        .org $7FFE
        .word $E002

        .bank 3
        .org $4000
        .word $B003
Bank3Add:
        LD   R1, [$4000]
        ADD  R0, R1
        LD   R1, [BANK]
        ST   R1, [$8010]
        RTS
        .org $7FFE
        .word $E003

        .bank 4
        .org $4000
        .word $B004
        .org $7FFE
        .word $E004

        .bank 5
        .org $4000
        .word $B005
        .org $7FFE
        .word $E005

        .bank 6
        .org $4000
        .word $B006
        .org $7FFE
        .word $E006

        .bank 7
        .org $4000
        .word $B007
        .org $7FFE
        .word $E007
