; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Example 4: calling a routine in another ROM bank through a trampoline
; in fixed bank 0. In: R6 = bank, R7 = address in 4000-7FFF.
; R0-R5 pass through in both directions; R6 and R7 are not preserved.
Score   = $8020

        .bank   0
        .org    $0400
Award:  MOV     R0, #50         ; argument for AddScore
        MOV     R6, #3          ; AddScore lives in bank 3
        MOV     R7, #AddScore
        CALL    FarCall
        RTS

FarCall:
        PUSH    R6              ; stack: target bank
        LD      R6, [BANK]
        PUSH    R6              ; stack: caller's bank, target bank
        LD      R6, [SP+2]
        ST      R6, [BANK]      ; the window now shows the target bank
        CALL    [R7]            ; the far routine ends with RTS
        POP     R6
        ST      R6, [BANK]      ; the caller's bank is back in the window
        ADD     SP, #2          ; drop the target-bank slot
        RTS

        .bank   3
AddScore:                       ; bank 3, address 4000
        LD      R1, [Score]
        ADD     R1, R0
        ST      R1, [Score]
        RTS
