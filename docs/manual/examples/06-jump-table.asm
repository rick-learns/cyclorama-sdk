; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0
;
; Example 6: dispatching on a game state with JMPT. Each handler ends
; with RTS, which returns to Dispatch's caller.
State   = $8040

        .org    $0600
Dispatch:
        LD      R0, [State]
        CMP     R0, #3          ; three states: 0, 1, 2
        BHS     .reset          ; unsigned: also catches "negative" values
        JMPT    R0, StateTable
.reset: MOV     R0, #0
        ST      R0, [State]
        RTS

StateTable:
        .word   TitleState, PlayState, PauseState

TitleState:
        LD      R1, [PAD1]
        TST     R1, #$80        ; START pressed?
        BEQ     .done
        MOV     R0, #1
        ST      R0, [State]     ; go to PlayState next frame
.done:  RTS
PlayState:
        RTS
PauseState:
        RTS
