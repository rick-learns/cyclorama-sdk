; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Example 1: vectors and the power-on initialisation routine.
; The cartridge header (0010-003F) is written by .header and not shown.
        .org    $0000
        .word   Reset, VBlank, NoInt, NoInt, NoInt  ; RESET VBLANK LINE TIMER TRAP

        .org    $0040
Reset:  MOV     R0, #$C000
        MOV     SP, R0          ; stack grows down from the top of work RAM
        MOV     R0, #0
        ST      R0, [VCTRL]     ; display off while memory is prepared
        MOV     R1, #$8000      ; clear work RAM, 8000-BFFF
        MOV     R2, #$2000      ; 8192 words
.ram:   ST      R0, [R1]+
        DEC     R2
        BNE     .ram
        ST      R0, [VADDR]     ; clear all 32 KiB of VRAM through VDATA
        MOV     R3, #VDATA
        MOV     R2, #$4000      ; 16384 words; VINC is 2 after reset
.vram:  ST      R0, [R3]
        DEC     R2
        BNE     .vram
        MOV     R0, #1
        ST      R0, [IF]        ; discard a VBLANK that is already pending
        ST      R0, [IE]        ; enable the VBLANK source
        EI
Main:   WAI                     ; sleep until the next vertical blank
        BRA     Main

VBlank: PUSH    R0
        MOV     R0, #1
        ST      R0, [IF]        ; acknowledge: write 1 to IF bit 0
        POP     R0
NoInt:  RTI
