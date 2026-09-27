; SPDX-FileCopyrightText: 2026 rick-learns
; SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
;
; SCRIM runtime library (CYASM), shipped with the compiler (docs/scrim-spec.md §6).
; Each section starts with ";@@ NAME [needs OTHER ...]"; the compiler links a routine only when
; the program uses it, together with the routines it needs.
;
; Routines named in capitals follow the SCRIM calling convention (callable from SCRIM and from
; assembly): arguments pushed right to left as words, the caller removes them, the result is in
; R0, R0-R3 and R7 may be changed, R4-R6 are preserved.
; The compiler helpers __divu/__divs take R0 = dividend and R1 = divisor and return R0 = quotient
; and R1 = remainder; they preserve R2-R6 and change R7.

;@@ __divu
; Unsigned 16-bit division (restoring shift-and-subtract, 16 steps).
; Division by zero returns quotient 0 and remainder = dividend.
__divu:
        TST  R1, R1
        BNE  .go
        MOV  R1, R0
        MOVQ R0, #0
        RTS
.go:    PUSH R2
        MOVQ R7, #0             ; partial remainder
        MOVQ R2, #16            ; bit counter
.loop:  ADD  R0, R0             ; next dividend bit into C; quotient bits enter at bit 0
        ADC  R7, R7             ; remainder = remainder * 2 + bit
        BCS  .sub               ; a 17-bit remainder is certainly >= the divisor
        CMP  R7, R1
        BLO  .next
.sub:   SUB  R7, R1
        ADDQ R0, #1             ; quotient bit 1
.next:  ADDQ R2, #-1
        BNE  .loop
        MOV  R1, R7
        POP  R2
        RTS

;@@ __divs needs __divu
; Signed 16-bit division, truncating toward zero; the remainder takes the dividend's sign.
; Division by zero returns quotient 0 and remainder = dividend. -32768 / -1 wraps to -32768.
__divs:
        PUSH R3
        MOV  R3, R0
        XOR  R3, R1             ; bit 15: sign of the quotient
        PUSH R3
        MOV  R3, R0             ; bit 15: sign of the remainder
        TST  R0, R0
        BPL  .a
        NEG  R0
.a:     TST  R1, R1
        BPL  .b
        NEG  R1
.b:     CALL __divu
        TST  R3, R3
        BPL  .c
        NEG  R1
.c:     POP  R3
        TST  R3, R3
        BPL  .d
        NEG  R0
.d:     POP  R3
        RTS

;@@ MEMCPY
; MEMCPY(dst, src, n): copy n bytes upward from src to dst. Uses word moves when dst, src and n
; are all even. Overlapping blocks are copied correctly only when dst < src.
MEMCPY:
        LD   R0, [SP+2]         ; dst
        LD   R1, [SP+4]         ; src
        LD   R2, [SP+6]         ; n
        TST  R2, R2
        BEQ  .done
        MOV  R3, R0
        OR   R3, R1
        OR   R3, R2
        TST  R3, #1
        BNE  .bytes
        SHR  R2, #1
.words: LD   R3, [R1]+
        ST   R3, [R0]+
        ADDQ R2, #-1
        BNE  .words
        RTS
.bytes: LDB  R3, [R1]+
        STB  R3, [R0]+
        ADDQ R2, #-1
        BNE  .bytes
.done:  RTS

;@@ MEMSET
; MEMSET(dst, value, n): store the low byte of value into n bytes starting at dst.
MEMSET:
        LD   R0, [SP+2]         ; dst
        LD   R1, [SP+4]         ; value
        LD   R2, [SP+6]         ; n
        TST  R2, R2
        BEQ  .done
.loop:  STB  R1, [R0]+
        ADDQ R2, #-1
        BNE  .loop
.done:  RTS

;@@ VRAM_COPY
; VRAM_COPY(vramAddr, src, words): DMA `words` words from CPU address src (0000-DFFF) to VRAM.
; The CPU is stopped for the transfer (4 + 2 x words cycles in blanking, 4 + 4 x words otherwise).
VRAM_COPY:
        LD   R0, [SP+4]
        ST   R0, [DMASRC]
        LD   R0, [SP+2]
        ST   R0, [DMADST]
        LD   R0, [SP+6]
        ST   R0, [DMALEN]
        MOVQ R0, #1             ; target VRAM: starts the transfer
        ST   R0, [DMACTL]
        RTS

;@@ RANDOM
; RANDOM(): WORD - the next state of a 16-bit Galois LFSR (taps $B400, period 65535).
; The state lives in __rnd (a work-RAM word the startup code seeds with $ACE1).
RANDOM:
        LD   R0, [__rnd]
        SHR  R0, #1
        BCC  .keep
        XOR  R0, #$B400
.keep:  ST   R0, [__rnd]
        RTS

;@@ SEED_RANDOM
; SEED_RANDOM(seed): restart the RANDOM sequence from seed (0, which would stop the LFSR,
; becomes $ACE1).
SEED_RANDOM:
        LD   R0, [SP+2]
        TST  R0, R0
        BNE  .ok
        MOVW R0, #$ACE1
.ok:    ST   R0, [__rnd]
        RTS

;@@ WAIT_VBLANK
; WAIT_VBLANK: return at the start of the next vertical blank (VCOUNT reaches 224).
; Polls VCOUNT, which has no read side effects; the interrupt state is left alone.
WAIT_VBLANK:
.in:    LD   R0, [VCOUNT]       ; already in vertical blank: wait for it to end
        CMP  R0, #224
        BHS  .in
.out:   LD   R0, [VCOUNT]
        CMP  R0, #224
        BLO  .out
        RTS
