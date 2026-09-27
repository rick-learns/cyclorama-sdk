# Cyclorama engineering specification notes (authoritative design decisions)

This file is the design authority behind the M1 manual. The data tables in
`src/isa/isa.ts` (encodings, cycles) and `src/hw/registers.ts` (I/O map) are normative;
this file defines every behaviour they do not. The manual must agree with both.
Canon values (clocks, sizes, the light-field rule) come from `canon/canon.json`.

## 1. CPU (Tally, AV-1601)

### Registers
- R0–R7: 16-bit general registers, fully orthogonal.
- SP: 16-bit stack pointer (separate from R0–R7). PC: 16-bit program counter.
- F: flags. Bit 0 Z (zero), bit 1 N (negative, = bit 15 of result), bit 2 C (carry/borrow),
  bit 3 V (signed overflow), bit 4 I (interrupt enable). Bits 15–5 read 0.

### Memory access
- Byte-addressed, little-endian. Word accesses ignore address bit 0 (always aligned;
  the word at an odd address A is the word at A & FFFE). Instruction fetch likewise.
- Every bus access (instruction word fetch, extension fetch, data read/write) costs
  2 CPU cycles. Cycle totals are in `CYCLES` in `src/isa/isa.ts`.
- Byte stores to RAM change one byte. Byte loads zero-extend into the register.

### Flag conventions
- ADD/ADC/INC/ADDQ: C = unsigned carry out of bit 15; V = signed overflow.
- SUB/SBC/CMP/DEC/NEG: C = **borrow** (set when the unsigned subtrahend is larger, i.e.
  `a < b` for CMP a,b). SBC computes a − b − C. V = signed overflow. NEG d = 0 − d.
- MOV, MOVQ, SXB, ZXB, SWPB, NOT: Z and N from result; C and V unchanged except NOT (C,V cleared).
- AND, OR, XOR, TST: Z, N from result; C = 0, V = 0. TST and CMP do not write Rd.
- Shifts/rotates (SHL, SHR, ASR, ROL by register or immediate): count n. If n = 0:
  result unchanged, Z/N from value, C unchanged, V = 0. Otherwise C = last bit shifted
  out (for ROL: bit 0 of result), V = 0, Z/N from result. SHL/SHR by 16 give 0.
  By register: n = Rs & 15. By imm16: n = imm & 15. Group-0 immediate forms
  (SHLI etc.): n = imm4 + 1 (1..16).
- MUL: Rd = low 16 bits of unsigned Rd × Rs; C = 1 if the full product exceeds FFFF;
  V = 0; Z/N from result.
- FMUL: signed 8.8 fixed-point multiply: Rd = (signed(Rd) × signed(Rs)) >> 8 (arithmetic
  shift of the 32-bit product), truncated to 16 bits; V = 1 if the shifted product does
  not fit in signed 16 bits; C = 0; Z/N from the truncated result.
- Loads (LD, LDB) and stores never affect flags. Moves to/from SP, PUSH/POP, jumps,
  calls do not affect flags. SETF sets all of F (bits 4–0) from Rd; GETF copies F to Rd.

### Instruction semantics (by group)
- Group 0: NOP. STOP halts the CPU until reset (used by test ROMs to end; the emulator
  reports STOP). WAI stops fetching until (IE & IF) ≠ 0; then, if I = 1, the interrupt
  is taken; if I = 0, execution continues with the next instruction. RTS: PC ← pop.
  RTI: F ← pop, then PC ← pop. EI: I ← 1, effective after the *next* instruction
  (one-instruction delay, so `EI; RTS` returns before an interrupt). DI: I ← 0 immediately.
  TRAP #n: push PC (address of next instruction), push F, I ← 0, PC ← word at 0008.
  JMPR [Rd]: PC ← Rd. CALLR [Rd]: push return PC, PC ← Rd. PUSH Rd: SP ← SP − 2,
  mem[SP] ← Rd. POP Rd: Rd ← mem[SP], SP ← SP + 2. MOVFS: Rd ← SP. MOVTS: SP ← Rd
  (bit 0 forced to 0).
- Group 1/2: `op Rd, Rs` / `op Rd, #imm16`. Group 3: MOVQ Rd,#s8 (sign-extended),
  ADDQ Rd,#s8 (sign-extended, flags as ADD).
- Group 4–7: `LD Rd,[Rs+d]` etc. Word forms d = 0..126 (even), byte forms d = 0..63.
- Group 8: mode 00 `[Rs+d16]` (16-bit wraparound add), 01 `[abs16]` (Rs field ignored),
  10 `[Rs]+` (access at Rs, then Rs += 2, or 1 for byte forms), 11 `-[Rs]` (Rs −= 2 or 1,
  then access). If d = s on a post-increment/pre-decrement load, the loaded value is what
  remains in the register. A store with d = s stores the register value *before* the
  increment/decrement.
- Group 9: `LD Rd,[SP+d]`, `ST Rd,[SP+d]`, d = 0..510 even.
- Group A: branch target = (address of the next instruction) + disp × 2. BSR pushes the
  address of the next instruction. Conditions: RA always; EQ Z; NE !Z; LO C; HS !C;
  MI N; PL !N; VS V; VC !V; HI !C && !Z; LS C || Z; LT N≠V; GE N=V; GT !Z && N=V;
  LE Z || N≠V; SR always + push (BSR). Assembler aliases: BCS = BLO, BCC = BHS.
- Group B: JMP abs16; CALL abs16 (push next-instruction address); PUSHM mask pushes
  registers from R7 down to R0 (for each set bit), so R0 ends at the lowest address;
  POPM mask pops R0 up to R7. ADDSP #s8: SP ← SP + s8 × 2 (assembler syntax `ADD SP,#n`
  with n even, −256..254). JMPT Rd, table: PC ← word at (table + Rd × 2).
- **Reserved encodings** (group 0 ops 27–31, group B ops 6–15, majors C–F): execute as a
  2-cycle no-operation on all Cyclorama models. Must-be-zero bits in otherwise valid
  encodings are ignored. The assembler never emits reserved encodings.

### Reset and interrupts
- Vectors (words in ROM bank 0): 0000 RESET, 0002 VBLANK, 0004 LINE, 0006 TIMER,
  0008 TRAP; 000A–000F reserved.
- Power-on/reset: R0–R7 = 0, SP = C000, F = 0 (interrupts disabled), PC = word at 0000,
  BANK = 1, all I/O registers at their documented reset values (0 unless stated).
  Work RAM, VRAM, OAM and CRAM contents are **undefined on real hardware**; the
  reference behaviour (the emulator) is all zeros. Software must initialise them.
- Lockout: at reset the console checks for the four bytes "CYCL" at ROM 0010. If absent,
  the CPU is held in reset (black screen).
- Interrupt sources: VBLANK (IF bit 0, set at dot 0 of line 224), LINE (bit 1, set at dot
  256 of the line where VCOUNT = LINECMP), TIMER (bit 2). Pending = IE & IF. Checked
  between instructions: if I = 1 and pending ≠ 0, the highest-priority source (VBLANK >
  LINE > TIMER) is taken: push PC, push F, I ← 0, PC ← its vector; 12 cycles. IF is NOT
  cleared automatically; the handler writes 1 to its IF bit.

### Timing scheduler
- Master clock M = 945/44 MHz. CPU cycle = 6 M, dot = 4 M, audio sample = 448 M.
- Line = 1368 M = 342 dots = 228 CPU cycles; frame = 262 lines. Visible dots 0–255 of
  lines 0–223.
- Execution is instruction-granular: an instruction's cycles complete before events at
  later master-cycle times are observed, and I/O register accesses take effect at the
  master-cycle time the instruction *starts* plus its fetch cycles (the reference
  emulator applies them at instruction start; documented as "within the instruction").
  For determinism, the reference rule is: **all register reads and writes in an
  instruction happen at the instruction's start time.**

## 2. Memory map
| Range | Contents |
|---|---|
| 0000–3FFF | Cartridge ROM bank 0 (fixed). Vectors at 0000, header at 0010–003F. |
| 4000–7FFF | Cartridge ROM window: bank BANK (reset 1). |
| 8000–BFFF | Work RAM, 16 KiB. |
| C000–DFFF | Cartridge RAM (8 KiB, if fitted; writes only while RAMCTL bit 0 = 1). Reads 0 if not fitted. |
| E000–E0FF | Cartridge registers (BANK, RAMCTL); unused addresses read 0. |
| E100–EFFF | Unmapped: reads 0, writes ignored. |
| F000–F0EF | Console I/O (see `src/hw/registers.ts`); unused addresses read 0. |
| F0F0–FFFF | Unmapped: reads 0, writes ignored. |
- Writes to ROM are ignored. Byte access to an I/O register: a byte read returns the
  requested half of the 16-bit register value; a byte write writes that half and leaves
  the other half unchanged (side effects such as VDATA auto-increment happen on either).

### Cartridge header (ROM 0010–003F)
| Offset | Size | Field |
|---|---|---|
| 0010 | 4 | Magic "CYCL" |
| 0014 | 1 | Header version (1) |
| 0015 | 1 | ROM size in 16 KiB banks − 1 (0 = 16 KiB … 255 = 4 MiB) |
| 0016 | 1 | Cartridge RAM: 0 none, 1 8 KiB battery-backed |
| 0017 | 1 | Generation: 0 Standard, 1 Deep |
| 0018 | 24 | Title, ASCII, space padded |
| 0030 | 2 | Developer code |
| 0032 | 4 | Release date, BCD YYYYMMDD |
| 0036 | 2 | Version (BCD major.minor) |
| 0038 | 2 | Checksum: 16-bit sum of all ROM words with this field taken as 0 |
| 003A | 6 | Reserved, 0 |
- ROM images are a whole number of 16 KiB banks; sizes 32 KiB and up are powers of two.

## 3. Video (Barndoor, AV-2210)

### Memory
- VRAM 32 KiB, CPU-accessed only through VADDR/VDATA (or DMA). Tiles: 1024 × 24 bytes at
  0000–5FFF (tile n at n × 24). A tile is three bitplanes of 8 bytes: bytes 0–7 plane 0
  (rows 0–7), 8–15 plane 1, 16–23 plane 2. Pixel value = p0 | p1<<1 | p2<<2; bit 7 of each
  byte is the leftmost pixel. Maps may overlap tile memory if fewer tiles are used.
- VRAM words are little-endian: byte at even address = low half.
- Map: 64 × 32 entries, 2 bytes each, row-major: entry (tx, ty) at base + (ty × 64 + tx) × 2.
  Entry: bits 9–0 tile, 11–10 palette (BG palette 0–3), 12 h-flip, 13 v-flip,
  14 priority (drawn above sprites), 15 unlit.
- OAM: 64 sprites × 8 bytes (internal, via OAMADDR/OAMDATA or DMA).
  +0 Y: signed 9-bit (bits 8–0), top line of the sprite. +2 X: signed 9-bit (bits 8–0).
  +4 bits 9–0 tile, 11–10 palette (sprite palette 0–3 = palettes 4–7), 12 h-flip,
  13 v-flip, 14 behind (drawn behind BG1), 15 unlit.
  +6 bit 0 size (0 = 8×8, 1 = 16×16), bit 1 hide. Other bits reserved (ignored).
  16×16 sprites use tiles n (top-left), n+1 (top-right), n+2 (bottom-left),
  n+3 (bottom-right); flips apply to the whole 16×16 sprite.
- CRAM: 512 entries of 12-bit colour 0RGB. Entry index = shade × 64 + palette × 8 + pixel.

### Line pipeline
- The chip fetches everything needed for line y during the horizontal blank before it,
  so each visible line is rendered with the VRAM, OAM, CRAM and register state present at
  **dot 0 of that line** (the reference emulator renders the whole line at dot 0).
  All video registers, including lights, scroll, AMBIENT, FIXED and probe position, are
  latched at dot 0.
- Sprite evaluation per line: scan OAM in order 0..63; a sprite is on line y if it is not
  hidden and 0 ≤ y − Y < height. The first 16 found are drawn; any more set VSTAT bit 1.
  Lower OAM index wins overlaps between sprites.
- Pixel compositing, back to front (only enabled layers, colour 0 is transparent in all
  tiles and sprites):
  1. backdrop: palette 0 colour 0 (base index 0), lit;
  2. BG0 tiles without priority;
  3. sprites with the behind flag;
  4. BG1 tiles without priority;
  5. sprites without the behind flag;
  6. BG0 tiles with priority, then BG1 tiles with priority.
  The winning pixel yields base index (palette × 8 + pixel) and its unlit flag.
- Shade: if the light field is disabled (VCTRL bit 4 = 0) or the pixel is unlit,
  shade = FIXED. Otherwise the light-field rule in canon.json, with dx = |x − LX|,
  dy = |y − LY| for screen coordinates x 0..255, y 0..223, and lights with intensity 0
  contributing 0.
- Display disabled (VCTRL bit 0 = 0): every pixel is CRAM[FIXED × 64] and no sprite
  evaluation, probe latching or overflow occurs.
- Probe: when line PROBEY is rendered (and the display is enabled), the pixel at
  column PROBEX is latched into PROBE (base index, shade), and the ready bit is set at
  dot 256 of that line.
- DMA: while running, the CPU is stopped. Cost: 4 + 2 × words CPU cycles, or 4 + 4 × words
  if the transfer starts or runs during active display (dot < 256 of lines 0–223); the
  reference rule uses the state at the start of the transfer. The transfer's effect is
  applied at its start time.

## 4. Audio (Cue, AV-3105)
- One output sample every 448 M (~47,940.34 Hz), mono.
- Voices 0–2: 16-bit phase accumulator P += FREQ each sample (mod 65536). Per sample,
  a 4-bit step value s (0–15):
  pulse duty k (12.5/25/50/75%): s = 15 if P < 8192 × {1,2,4,6}[k] else 0;
  triangle: t = P >> 11 (0–31), s = t < 16 ? t : 31 − t;
  sawtooth: s = P >> 12;
  wavetable: sample index P >> 11 (0–31) from WAVE0–WAVE7; silent: s = 7.5 → treat as
  output 0 (voice contributes 0).
- Noise voice 3: 15-bit LFSR L, seeded to 7FFF at key-on. Accumulator Q += FREQ per
  sample; on each overflow past FFFF: b = (L ^ (L >> 1)) & 1; L = (L >> 1) | (b << 14);
  in short mode also L = (L & ~0x40) | (b << 6). s = (L & 1) ? 0 : 15.
- Voice output o = (2s − 15) × volume (volume 0–15), so −225..225. A keyed-off voice has
  volume 0.
- Envelope: an envelope tick occurs every 750 samples (a global counter from reset).
  For a voice with period p > 0, every p ticks the volume moves one step in its direction,
  stopping at 0 or 15.
- Mix = (o0 + o1 + o2 + o3) × MASTERVOL, a signed integer in −13500..13500. The host
  scales mix / 13500 to ±1.0 (reference: `mix * 2` as signed 16-bit PCM).

## 5. Input and timer
- PAD1/PAD2 sampled at dot 0 of line 224. The host supplies one input word per frame.
- Timer: when enabled, a prescale counter counts CPU cycles; every {1,16,64,256} cycles
  TCOUNT decrements; when it decrements from 0 it becomes TRELOAD and IF bit 2 is set.
  The prescale counter resets when TCTRL is written.

## 6. Determinism rules for implementations
- Machine state is integer-only. No host time, randomness or floating point affects it.
- A frame is run as `runFrame(input)`: from dot 0 of line 0 to dot 0 of line 0 of the
  next frame (358,416 M). Instructions that straddle the boundary finish in the next
  frame's accounting (cycle debt carried over).

## 7. Assembler language (Avenell "CYASM" syntax)
- One statement per line; `;` starts a comment. Case-insensitive mnemonics, registers and
  directives; case-sensitive symbols.
- Labels: `name:` at line start. Local labels start with `.` (e.g. `.loop:`) and are scoped
  to the most recent non-local label. `name = expr` or `name .equ expr` defines a constant.
- Registers `R0`–`R7`, `SP`. Immediates `#expr`. Numbers: decimal, `$1F` or `0x1F` hex,
  `%1010` binary, `'A'` character. Expressions: `+ - * / % & | ^ ~ << >>`, parentheses,
  unary minus, `<expr` (low byte), `>expr` (high byte), `*` (current address) — C precedence.
- Operand syntax:
  - `op Rd, Rs` · `op Rd, #imm` (ALU; `MOV Rd,#n` and `ADD Rd,#n` pick MOVQ/ADDQ when n
    fits −128..127 and is known in pass 1; `MOVW`/`ADDW` force the 16-bit form)
  - `SHL Rd, #n` (1..16) uses the group-0 form; `SHL Rd, Rs` the group-1 form.
  - `LD Rd, [Rs]`, `LD Rd, [Rs+expr]` (short form when 0..126 even for words / 0..63 bytes,
    else group 8 mode 00), `LD Rd, [expr]` (absolute), `LD Rd, [Rs]+`, `LD Rd, -[Rs]`,
    `LD Rd, [SP+expr]`. Stores: `ST Rs, [...]` (register first). `LDB`/`STB` likewise.
  - Branches `BRA/BEQ/.../BSR label` (error if out of range). `JMP label`, `CALL label`,
    `JMP [Rd]`, `CALL [Rd]`, `JMPT Rd, table`.
  - `PUSH Rd`, `POP Rd`, `PUSHM R0,R3-R5`, `POPM ...`, `ADD SP,#n`, `MOV Rd,SP`,
    `MOV SP,Rd`, `GETF Rd`, `SETF Rd`, `TRAP #n`, and the zero-operand instructions.
- Directives: `.org expr` (set address within the current bank), `.bank n` (start output
  bank n; bank 0 assembles at 0000–3FFF, other banks at 4000–7FFF), `.word e,...`,
  `.byte e,...`, `.ascii "text"`, `.asciz "text"`, `.fill count, value`, `.align n`,
  `.include "file"`, `.incbin "file"`, `.header title="…", dev=$xxxx, date=$YYYYMMDD,
  version=$0100, ram=0|1, generation=0|1` (fills 0010–003F; checksum and size computed),
  `.rom banks` (total ROM size in banks; default = highest bank used + 1, rounded up to a
  power of two, minimum 2).
- Predefined symbols: every I/O register name in `src/hw/registers.ts`.
- Output: a ROM image (bytes) plus a symbol table and a listing. Unused bytes are 0xFF.
  Assembly is a pure function of the source files: identical input gives identical bytes.

## 8. Resolved ambiguities (from manual and assembler work, 2026-09-26)
Normative; the manual and implementations follow these.

### Video / DMA
1. Sprite priority is resolved **before** layering: among sprites covering a pixel, the
   lowest OAM index with an opaque pixel wins; that single sprite pixel is then placed at
   compositing step 3 (behind flag set) or step 5 (clear).
2. VSTAT bit 1 (overflow) is sticky: set when any line overflows, cleared only by reading VSTAT.
3. With sprites disabled (VCTRL bit 3 = 0) no sprite evaluation happens and no overflow is flagged.
4. 16×16 sprite tile numbers n+1..n+3 wrap modulo 1024.
5. Byte access to VDATA (F002/F003) reads/writes the even/odd VRAM byte at VADDR then adds
   VINC; byte access to CRAMDATA reads/writes the low/high half of the 12-bit entry, then advances.
6. "Active display" (port wait cycles, DMA cost) is judged by beam position only (dot < 256 of
   lines 0–223) at the start of the instruction or transfer, even when the display is disabled.
7. DMA: VRAM destination advances by 2 per word (VINC ignored); OAM by 2; CRAM by 1.
   DMALEN = 0 still costs 4 cycles. The source is read through the CPU bus decoder exactly as
   CPU reads would be (reading an I/O register through DMA has that register's read side effects).
8. Undefined register bits read 0 and ignore writes. A new probe capture overwrites an unread one.
9. WAI: the CPU idles; interrupt entry (if I = 1) begins at the first CPU-cycle boundary at or
   after the moment (IE & IF) becomes non-zero.
10. Audio order within one sample: envelope tick → accumulator step → compute s → mix.
    The first sample after key-on is therefore computed with P = FREQ.
11. Envelope steps count global ticks from key-on: a voice's first step happens on the p-th
    global tick after key-on (global tick counter never resets except at power-on).
12. The noise accumulator Q is not reset at key-on (the LFSR is).
13. Key-on of a playing voice restarts it; key-off sets volume 0 and stops the envelope while the
    accumulator keeps running; CTRL bit 0 reads 1 until key-off even if the volume has fallen to 0.
14. FREQ = 0 holds the current step value; output is zero only for the silent waveform or volume 0.
15. VRAM/OAM/CRAM writes after dot 0 of line y are not seen by line y (the chip's posted-write
    queue, Appendix E). This is the programmer's rule; the reference emulator renders the whole
    line at dot 0.

### Assembler (adopted as syntax)
16. `W` suffix on any ALU mnemonic (`MOVW`, `CMPW`, `SHLW`…) forces the group-2 imm16 form;
    `X` suffix on loads/stores (`LDX`, `STX`, `LDBX`, `STBX`) forces group-8 mode 00 [Rs+d16].
17. Out-of-range `SHL Rd,#n` (n outside 1..16) is an error; use `SHLW`.
18. Short/long selection needs values known in pass 1; forward references take the long form.
    `.org`, `.fill` count, `.align`, `.bank`, `.rom` operands must be known in pass 1.
19. Non-canonical words disassemble as `.word`. Odd word displacements, instructions at odd
    addresses and odd branch offsets are errors. Arithmetic is 32-bit signed, `/` truncates.
20. `<`/`>` are unary operators with unary precedence; `*` is the statement's start address.
21. `.header` fields are optional; the date is stored little-endian as a 32-bit BCD value;
    size byte and checksum are computed last over the whole padded ROM.
22. `.align n` aligns to n bytes (power of two); `.fill count[, value]` value defaults to 0;
    `.byte` accepts strings; `.rom` must be a power of two 1–256 and not smaller than the
    highest used bank + 1.
23. Local labels need a preceding global label and are exported as `global.local`. Register
    and I/O register names cannot be redefined. Includes resolve relative to the including
    file; recursion is an error.
24. Symbol tables record each label's bank as well as its 16-bit address (for debuggers).

### CPU / system (second batch)
25. SHLI/SHRI/ASRI/ROLI cost 2 + n cycles with n = imm4 + 1 (1..16). Group-2 shift immediates
    are written `SHLW Rd,#n` etc. (count = n & 15).
26. Only EI has the one-instruction delay. SETF and RTI that load I = 1 allow an interrupt at the
    very next instruction boundary. GETF immediately after EI reads I = 1 (the flag is set at
    once; only interrupt recognition is delayed).
27. JMPR/CALLR to an odd address: PC bit 0 is cleared (fetches are aligned); the pushed return
    address is the even address of the next instruction.
28. A DMA stall is part of the instruction that wrote DMACTL: interrupts are recognised after it.
29. Writes to read-only registers (VSTAT, VCOUNT, PROBE, PAD1, PAD2) are ignored; reads of
    write-only DMACTL return 0. PAD bits 15–8 read 0; an empty controller port reads 0.
30. The timer prescaler keeps counting during WAI and DMA stalls.
31. After reset the first instruction starts at dot 0 of line 0.
32. Header date/version are little-endian 32/16-bit BCD values; the checksum is the 16-bit sum
    of all little-endian ROM words of the whole padded image with the checksum field as 0.
33. TRAP's n is ignored by hardware (a handler reads it from the low nibble of the word at the
    return address − 2). Vectors 000A–000F are reserved and should be 0.
34. Video port wait cycles apply per access, byte or word.
35. CYASM symbols match [A-Za-z_][A-Za-z0-9_]*; labels begin at the start of a statement
    (leading whitespace allowed); MOVQ and ADDQ are accepted as explicit mnemonics.
36. Manual appendices are lettered in order of appearance; the engineering appendix and register
    summary take the letters the build assigns (no fixed "E").

## 9. External review resolutions (2026-09-26) — supersede earlier entries where they conflict
37. **DMA cost** is decided solely by the beam position when the transfer *starts*: 4 + 2 x words
    if it starts outside active display, 4 + 4 x words if it starts during active display (dot
    < 256 of lines 0-223). A transfer that starts in vertical blank and runs into line 0 keeps
    the cheap rate. Every occurrence in the manual uses this wording.
38. **DMA source range** (supersedes §8.7's I/O rule): DMA reads 0000-DFFF through the normal
    bus (ROM, bank window, work RAM, cartridge RAM). Source addresses E000-FFFF read as 0 with
    no side effects and no port wait. The source address wraps from FFFE to 0000.
39. **Audio reset phase**: at power-on/reset every phase accumulator (voices 0-2 and noise Q)
    is 0, every LFSR is 7FFF, every volume is 0 and keyed off, and the global envelope counter
    is 0. Audio sample k (k = 0, 1, 2, ...) is produced at master cycle 448 x (k + 1). The
    global envelope tick occurs on samples whose 1-based count is a multiple of 750 (samples
    k = 749, 1499, ...), before that sample's accumulator step (§8.10 order).
40. **Byte writes to command registers**: registers whose writes are commands rather than
    storage (DMACTL, V0CTRL-V3CTRL, IF) act only on a write to their low byte (the even
    address) or a word write, using the written low byte. A byte write to the high byte (odd
    address) is ignored. Reads of these registers return their documented read values.
41. **Determinism statement**: given the same ROM image, the same initial cartridge-RAM contents
    and the same per-frame controller samples, the reference machine produces identical state.
    (Real hardware's volatile memories power up undefined; the reference model zeroes them.)
42. **Frame boundaries are fixed.** Video frames always start every 358,416 master cycles. An
    instruction that crosses a frame boundary completes; its excess cycles are charged to the
    CPU's budget in the following frame (the CPU starts that frame's work late; the video does not).
43. **Line buffer (Appendix E):** the Barndoor renders line y into a line buffer during line y,
    starting at dot 0 with the state described in §3, and the buffer is scanned out to the
    television during line y + 1. VCOUNT, LINE interrupts and the probe refer to render lines.
    Sprite evaluation for line y therefore happens after dot 0 of line y, consistent with the
    rule that line y sees OAM as it is at its dot 0.
44. **VSTAT bit 1** reads "a line has overflowed since VSTAT was last read" everywhere.
45. **CYASM, exhaustive rules**:
    - Expression values are 32-bit two's complement; arithmetic wraps modulo 2^32. `/` truncates
      toward zero; `%` takes the sign of the dividend; division or remainder by zero is an error.
      `<<` and `>>` use the count & 31; `>>` is arithmetic (sign-propagating).
    - `.byte` values must lie in -128..255, `.word` in -32768..65535, instruction immediates
      and displacements in their field's range; anything else is an error (no silent truncation).
    - `.align n`: n must be a power of two from 1 to 16384, else error.
    - `.org` may move backwards; emitting a byte where one was already emitted is an error.
    - Strings are ASCII 0x20-0x7E with escapes `\`, `\"`, `\'`, `\n` (0A), `\0` (00) and `\xHH`;
      any other escape or character is an error.
    - Defining a symbol twice (label or constant) is an error.
    - `.rom 1` is legal when only bank 0 is used.

## 10. Outsider-review resolutions (2026-09-26, M1 acceptance review)
46. (B1) WAI wakes at the first CPU-cycle boundary at or after IF & IE becomes non-zero. CPU-cycle
    boundaries are the master cycles that are multiples of 6 counted from power-on.
47. (B2) Instruction fetches, extension fetches, stack pushes/pops and interrupt pushes are ordinary
    bus accesses: if they touch I/O registers they have the same side effects and wait cycles as
    data accesses, in program order (fetches first, then data accesses in the order the
    operation's pseudo-code performs them).
48. (B3) An audio register write made by an instruction starting at master cycle t affects exactly the
    samples whose timestamps are greater than t. (A sample due at exactly t is computed first.)
49. (B4) Key-on sets P = 0 (voices 0-2), reloads the LFSR (noise), loads the envelope volume and zeroes
    the voice's envelope tick count, all at the write. The next sample then steps the accumulator,
    so it is computed with P = FREQ. Envelope ticks counted by a voice are those of samples produced
    after the key-on write; the first step happens on the p-th such tick.
50. (B5) V*CTRL reads reflect the state at the moment of the read: key-on and key-off change the keyed
    bit and the volume immediately (key-off sets volume 0 immediately).
51. (B6) The bank count is the ROM image length ÷ 16 KiB (the header size byte is informational and is
    not checked). An image must be a whole, non-zero number of banks; BANK selects bank BANK mod count.
    Retail cartridges are 32 KiB or larger (Standard 32-256 KiB, Deep 512 KiB-1 MiB); development and
    test boards may be 16 KiB.
52. (B7) Address registers keep only their defined bits and ignored bits read 0: VADDR bits 14-0;
    OAMADDR bits 8-1; CRAMADDR bits 8-0; DMASRC bits 15-1; DMADST bits 15-0. Auto-increment wraps
    within the defined field (VADDR mod 32 KiB, OAMADDR mod 512, CRAMADDR mod 512, DMASRC and DMADST
    mod 64 KiB). DMA uses the low bits of DMADST for its target (VRAM: & 7FFE, OAM: & 01FE,
    CRAM: & 01FF) while DMADST itself advances mod 64 KiB (e.g. OAM, DMADST 01FE + 2 words = 0202).
53. (B11) An instruction at an odd address is an error; `.word` at an odd address is allowed and
    emitted there (it occupies the odd byte and the next byte).
54. (B12) Assembly starts in bank 0 at address 0000. `.org` may move backwards within the current
    bank's window; an address outside the window (bank 0: 0000-3FFF, others: 4000-7FFF) is an error;
    emitting over an already-emitted byte is an error. `.bank n` resumes bank n's own location
    counter (initially the start of its window).
55. (B13) A value is "known in pass 1" if every symbol it uses was defined on an earlier line by a value
    that was itself known in pass 1. `X = Later + 1` with a forward label is not known, so
    `MOV R0,#X` takes the long form.
56. (B10) `MOV Rd,#n` / `ADD Rd,#n` choose the quick form when n, taken as a 32-bit value, lies in
    -128..127; values 128..65535 and -32768..-129 take the long form; other values are an error.
    So `MOV R0,#$FFFF` assembles to the long form (2000 FFFF) and `MOV R0,#-1` to MOVQ (30FF).
    `.fill` value must lie in -128..255.
57. (B16) `SHLW/SHRW/ASRW/ROLW Rd,#n` require n in 0..15 (the hardware uses n & 15); `SHL Rd,#n` etc.
    require 1..16 (group 0).
58. (B17) `.header` defaults: title all spaces, dev 0, date 0, version 0, ram 0, generation 0; a title
    longer than 24 characters is an error. `.rom n`: n a power of two, 1-256, at least the highest
    used bank + 1.
59. (K5) The per-light horizontal counter is 11 bits (x - LX ranges over -511..767).
60. (X1) The largest possible light distance is 1502 (diamond, dx = 767, dy = 735); octagon 1134.

### CPU implementation rulings (adopted from the CPU core, 2026-09-26)
61. PC bit 0 is cleared on every PC load (reset vector, JMP, CALL, JMPT, RTS, RTI, interrupt and TRAP
    vectors, JMPR/CALLR), so pushed return addresses are always even.
62. A WAI that wakes with I = 0 is followed immediately by the next instruction.
63. WAI with an interrupt already pending: with I = 1 (and no EI delay in force) the interrupt is taken
    before WAI executes (the pushed return address is the WAI); directly after EI, WAI executes first
    and the interrupt is taken at the next boundary; with I = 0, WAI completes at once.
64. Interrupt entry costs 12 cycles plus any wait cycles its stack pushes incur.
65. Word post-increment/pre-decrement with an odd register value accesses the aligned word but adds or
    subtracts exactly 2 (the register stays odd).

### Minor items closed at M1 acceptance (research/m1-review.md M2, M5, M6, M8, M9, M13)
66. (M2) EI's one-instruction delay applies every time EI executes, even when I is already 1.
67. (M5) Cartridge RAM is fitted exactly when header byte 0016 = 1, whatever the generation byte 0017
    says (Deep boards are simply the ones that usually carry it).
68. (M6) Cartridge RAM contents on a new cartridge are undefined on real hardware; the reference model
    starts them at zero and, as a save-state component, preserves them exactly.
69. (M8) STOP halts only the CPU: the timer, video, audio and interrupt flags keep running.
70. (M9) The host supplies two bytes per frame, PAD1 then PAD2 (bit layout as the PAD registers).
71. (M13) The reference model converts 12-bit colour to 24-bit by multiplying each 4-bit channel by 17.

## 11. M1 re-check resolutions (research/m1-recheck.md)
72. (B2) Interrupt entry is timed like an instruction: its two pushes happen at the master-cycle time
    the entry starts, and any port wait they incur is judged at that time.
73. (B17) "Highest bank used" = the highest bank selected by `.bank` or containing any emitted byte
    (so `.bank 5` alone makes the default ROM size 8 banks). `.header` titles must be printable ASCII
    0x20-0x7E after escape processing (so `\x80` or `\0` in a title is an error). `.header` writes the
    reserved bytes 003A-003F as 0.
74. (N1) An odd displacement on a word load/store is an error in every form (short, long and SP-relative);
    it never selects the long form.
75. (N2) VADDR keeps bit 0. Word access to VDATA uses VADDR & 7FFE. A byte access to F002 uses the even
    byte (VADDR & 7FFE); a byte access to F003 uses the odd byte (VADDR | 1). E.g. VADDR = 0011:
    F002 reads byte 0010, F003 reads byte 0011.
76. (N3) Emitting code or data past the end of the current bank window (3FFF for bank 0, 7FFF otherwise)
    is an error; output never spills or wraps into another bank.
77. (N4) Every 16-bit field (imm16, d16, abs16, jump/call target, .word) accepts -32768..65535 and
    stores the value mod 65536; any other value is an error. [Rs+d16] addition wraps at run time.
78. (N5) An event whose time equals an instruction boundary (e.g. VBLANK at dot 0 of line 224) is
    processed before that boundary's interrupt check, so it can be taken there.
79. (N6) A label on the same line as `.org`, `.align` or `.bank` takes the address AFTER the directive.
    `.header` never moves any location counter.
80. (N7) Register names (R0-R7, SP) and predefined I/O register names are case-insensitive (`vctrl` =
    `VCTRL`); user-defined symbols are case-sensitive.
81. (N8) A numeric literal whose value does not fit in 32 bits (unsigned) is an error.
82. (N9-N11) Wording only: PROBEY >= 224 "never matches"; Appendix E describes the line buffer of
    §5.8; ADDSP's encoded field is named s8 (the SP change is s8 x 2).

### Hardware conformance gaps (2026-09-26)
83. A DMACTL write with target 0 does nothing at all: no transfer and no CPU stall.
84. On a cartridge without RAM, RAMCTL does not exist: it reads 0 and ignores writes.
85. Byte access to OAMDATA reads/writes the even (F01E) or odd (F01F) byte of the OAM word at
    OAMADDR & 1FE, then OAMADDR advances by 2.

## 12. Save-state format (emulator, not hardware; 2026-09-26)
Save states are an emulator feature; the console never saw them. Code: `src/machine/savestate.ts`
(container), `Machine.saveState` / `loadState` / `hash` (`src/machine/machine.ts`).

- **Layout, version 2 (written).** Little-endian u32 words: magic `43594353`, version `2`, then the
  ROM's SHA-256 (32 bytes, the same value as `roms/manifest.json` `sha256` and a replay's
  `romSha256`), the part count (8), the 8 part lengths, then the parts: scalars (clock, frame,
  latches, registers by sorted name), work RAM, cartridge RAM, VRAM, OAM, CRAM, CPU state, Cue state.
  The SHA-256 is computed synchronously in the core (`src/machine/sha256.ts`), once per ROM.
- **Version 1 (read only).** Magic, version `1`, part count, lengths, the same parts. It has no ROM
  identity, so `loadState` refuses it (`unverified-v1`) unless the caller passes
  `{ allowUnverifiedV1: true }`. The app does so only for a slot whose metadata has no `format`
  (written before v2); the museum only for v1 bytes in its store (it has written v2 since). The next
  save of that slot is v2. Frozen v1 fixtures of every shipped ROM, made by
  `tools/savestate-v1-fixtures.ts`, must keep loading (`tests/savestate-v1.test.ts`).
- **Compatibility rule.** A v2 state loads only into a machine whose ROM has the SHA-256 it names;
  any other build is `wrong-rom`. The app and museum then say "This save is from a different
  version of <title>", never load it and never delete it; the Steam Cloud mirror holds the same
  keys and goes through the same check.
- **Loading is transactional.** Everything is validated before the machine is written: magic,
  version, ROM identity, part count, every part length, total size (short = `truncated`, extra
  bytes = `corrupt`), register values within their masks, CRAM within 12 bits, and the CPU and Cue
  parts deserialized into fresh instances. Any failure throws `SaveStateError` (kind `wrong-rom`,
  `truncated`, `corrupt`, `unsupported-version` or `unverified-v1`) and leaves the machine
  bit-identical (`tests/savestate.test.ts` checks `hash()` and the full state after each kind).
- **Hash rule.** `Machine.hash()` is FNV-1a over the version 1 serialization (`saveStateV1()`),
  never over the v2 header, so the ROM identity does not enter it and every replay final hash,
  golden frame and manifest entry is unchanged by the format. A future format change must keep
  `hash()` on the v1-equivalent body.
