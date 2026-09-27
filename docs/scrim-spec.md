# SCRIM language specification

SCRIM is the Cyclorama Development Kit's compiled language (in the fiction: shipped March 1987, author
Priya Venkataraman). It is a small structured language in the spirit of mid-1980s systems
languages: Pascal-like blocks, C-like brevity, no heap, no floating point. The compiler
translates SCRIM to CYASM assembly text, which CYASM assembles; it never calls host code at run
time. Everything a SCRIM program does is Tally machine code.

This specification is normative for the SCRIM compiler.

## 1. Lexical structure
- Case-insensitive keywords; identifiers `[A-Za-z_][A-Za-z0-9_]*` are case-sensitive.
- Comments: `--` to end of line, and `(* ... *)` (nestable).
- Numbers: decimal `123`, hex `$7F`, binary `%1010`, character `'A'`, fixed-point `1.5` (8.8).
- Strings: `"text"` with the CYASM escapes `\\ \" \' \n \0 \xHH`; printable ASCII only.

## 2. Types
| Type | Size | Meaning |
|---|---|---|
| `BYTE` | 1 | unsigned 0..255 |
| `WORD` | 2 | unsigned 0..65535 |
| `INT` | 2 | signed −32768..32767 |
| `FIXED` | 2 | signed 8.8 fixed point (−128.0..127.996) |
| `BOOL` | 1 | FALSE = 0, TRUE = 1 |
| `ARRAY [n] OF T` | n × size(T) | 0-based, n a constant |
| `RECORD f: T; ... END` | sum of fields (words aligned to even offsets) | |
| `POINTER TO T` | 2 | an address; `^p` dereferences; `@x` takes an address |

- Arithmetic is 16-bit and wraps. BYTE values widen to 16 bits in expressions (zero-extend);
  storing to a BYTE keeps the low 8 bits. INT/FIXED comparisons are signed; WORD/BYTE unsigned.
- Mixing signedness in one binary operation is an error unless one side is a literal (literals
  adapt). Explicit conversions: `WORD(x)`, `INT(x)`, `BYTE(x)`, `FIXED(x)` (integer → 8.8),
  `TRUNC(f)` (8.8 → INT, toward −∞ via ASR 8).
- `FIXED * FIXED` compiles to FMUL; `FIXED * INT` and `INT * INT` compile to MUL (low 16 bits).
  `/` and `MOD` call runtime routines (unsigned or signed by operand type); division by zero
  returns 0 (quotient) and the dividend (remainder), deterministically.

## 3. Declarations (module level)
```
CONST SPEED = 2; START_X = 120;
VAR x, y: INT;  lives: BYTE;  table: ARRAY [16] OF WORD;
VAR frame: WORD AT $8100;              -- absolute placement in work RAM
PORT VCTRL: WORD AT $F006;             -- I/O register; every access is a real bus access
DATA palette: ARRAY [8] OF WORD = ($112, $964, $533, $4A4, 0, 0, 0, 0);
DATA tiles: ARRAY OF BYTE = INCBIN "tiles.bin";
TYPE Actor = RECORD x, y: FIXED; vx, vy: FIXED; state: BYTE END;
```
- Every I/O register in `src/hw/registers.ts` is predeclared as a `PORT ... : WORD`.
- Module `VAR`s live in work RAM from 8000 upward in declaration order (unless `AT`), zeroed by
  the startup code. `DATA` lives in ROM and is read-only (assigning to it is an error).

## 4. Procedures and functions
```
PROC move(a: POINTER TO Actor; dx: INT);
VAR t: INT;
BEGIN
  a^.x := a^.x + FIXED(dx);
END;

FUNC clamp(v, lo, hi: INT): INT;
BEGIN
  IF v < lo THEN RETURN lo ELSIF v > hi THEN RETURN hi END;
  RETURN v
END;
```
- Calling convention (documented for mixing with assembly): arguments are pushed right to left
  as words; the callee's frame is addressed with `[SP+d]`; the caller removes arguments
  (`ADD SP,#n`). Results return in R0. R0–R3 are caller-saved scratch; R4–R6 callee-saved;
  R7 is reserved for the compiler's frame/temporary use. Recursion is allowed.
- `INTERRUPT PROC name; ... END` saves R0–R7, ends with RTI; `VECTOR VBLANK := name;` (also
  `LINE`, `TIMER`, `TRAP`) places it in the vector table.
- `FAR PROC name` lives in a switchable bank and is called through a trampoline in bank 0 that
  saves and restores BANK. `BANK n;` at module level places the following declarations in bank n.

## 5. Statements
```
x := expr;                      a[i] := v;          r.field := v;        p^ := v;
IF c THEN ... ELSIF c THEN ... ELSE ... END;
WHILE c DO ... END;             REPEAT ... UNTIL c;
FOR i := a TO b [STEP k] DO ... END;   FOR i := a DOWNTO b DO ... END;
CASE e OF 1: ...; 2, 3: ...; ELSE ... END;       -- compiled to JMPT when dense
EXIT;                           -- leave the innermost loop
RETURN [expr];
WAIT;                           -- WAI
ASM ... END;                    -- inline CYASM; SCRIM names usable as symbols
```
- `AND` / `OR` short-circuit in conditions; on integers they are bitwise. `NOT` likewise.
- Operators and precedence (high → low): unary `- NOT @ ^`; `* / MOD SHL SHR AND`;
  `+ - OR XOR`; comparisons `= <> < <= > >=`.

## 6. Program structure and startup
```
PROGRAM Lantern;
HEADER title = "LANTERN", dev = $0001, date = $19870918, version = $0100;
... declarations ...
BEGIN          -- main body
  ...
END.
```
- The compiler emits the vector table, the `.header`, startup code (SP = C000, display off,
  zero module VARs, hide all sprites), then calls the main body; if main returns, the CPU
  executes STOP.
- Runtime library (written in CYASM, shipped with the compiler, linked only when used):
  division/modulo, `MEMCPY`, `MEMSET`, `VRAM_COPY` (DMA), `RANDOM` (16-bit LFSR, seedable),
  `WAIT_VBLANK`.

## 7. Determinism and budgets
- Output assembly is a pure function of the source files (no timestamps, stable symbol order).
- The compiler reports per-procedure code size and a static worst-case cycle estimate for
  straight-line code; the build's budget report uses the emulator for real cycle measurement.

## 8. Errors
Every error has file:line:column and a message; compilation stops at the first 20 errors.
Undeclared names, type mismatches, assignment to CONST/DATA, wrong argument counts, non-constant
array sizes, out-of-range constants for BYTE and FIXED, and unreachable RETURN types are errors.

## 9. Implementation rulings
Decisions made while building the compiler (src/scrim); each is pinned by tests/scrim-*.test.ts.
1. I/O registers whose names are SCRIM keywords are predeclared as `IF_PORT`, `BANK_PORT`, `FIXED_PORT`.
2. There is no EI/DI statement: use `ASM EI END` / `ASM DI END`.
3. Signed `/` truncates toward zero; `MOD` takes the dividend's sign; −32768 / −1 = −32768.
4. FIXED ± INT is an error; FIXED*INT and FIXED/INT scale the raw 8.8 value; FIXED/FIXED, MOD on FIXED and INT(FIXED) are errors (use TRUNC or WORD). An integer literal is n.0 in `+ −` and comparisons, but a plain factor in `*` and `/`.
5. BYTE op BYTE yields WORD; BYTE and WORD convert freely on assignment (stores truncate); BYTE mixed with INT is a signedness error.
6. Untyped constant expressions are exact integers until they meet a typed operand. Literal ranges: BYTE 0..255, WORD/INT −32768..65535, FIXED −128.0..127.996. Explicit BYTE()/WORD() of a constant wraps.
7. Shift counts are taken mod 16 (as the hardware does); SHR on INT/FIXED is arithmetic.
8. FOR evaluates its limit once; STEP is a positive constant (also for DOWNTO); the control variable is a BYTE/WORD/INT variable, holds last+step (wrapped) after a normal finish, and loops ending at a type's limit terminate.
9. CASE accepts `lo..hi` ranges; with no match and no ELSE nothing happens; dense (JMPT) when ≥ 4 values, span ≤ 3 × count and ≤ 256.
10. Records align to their largest field and are padded to that alignment.
11. Parameters and results are scalar (pass arrays/records by POINTER); procedures are not nested and may be called before declaration; constants must be declared before use; locals are not zeroed; arguments are evaluated right to left.
12. FAR FUNC is allowed; a non-FAR procedure after `BANK n` (n ≥ 1) is an error; DATA in bank n is readable only by FAR procedures in bank n (`@` works anywhere).
13. An INTERRUPT PROC has no parameters, cannot be called directly, and must acknowledge its own IF bit.
14. `VAR … AT` variables are neither allocated nor zeroed and may overlap others.
15. HEADER title defaults to the program name; `ram` and `generation` fields are accepted.
16. Names beginning `__` and runtime routine names are reserved; names equal to R0–R7/SP or an I/O register (any case) are errors, except redeclaring a register as a PORT at its own address.
17. Additions: `SIZEOF`, `LEN`, `NIL`, `INCLUDE "file"`, `T(x)` conversions for named types, `SEED_RANDOM`.
18. Runtime: `MEMCPY(dst, src, bytes)`, `MEMSET(dst, value, n)`, `VRAM_COPY(vramAddr, src, words)`; `RANDOM()` is a 16-bit Galois LFSR (taps $B400, default seed $ACE1, seed 0 becomes $ACE1); `WAIT_VBLANK` polls VCOUNT until line 224.
19. Strings appear only in DATA (ARRAY OF BYTE, zero-padded, no terminator) and HEADER; there is no BOOL() conversion.
20. Inline ASM sees globals, constants, procedures and DATA by name; locals/parameters become `[SP+d]`; the block must preserve R4–R6; a procedure containing ASM keeps all locals on the stack; the block ends at the first `END` outside comments and strings.
21. Parsing stops at the first syntax error; semantic errors are collected up to 20. §8's "unreachable RETURN types" means a FUNC that can reach END without RETURN.
22. `@a` of an ARRAY (including a DATA string) has type POINTER TO ARRAY [n] OF T and is not assignable to POINTER TO T; write `@a[0]` for a pointer to the first element (SLICE gate, `text` in roms/slice-test). Pointer arithmetic goes through WORD: `PB(WORD(p) + i)`.

## 10. Linking assembly and assets
A SCRIM program links CYASM source into its ROM: kit libraries such as the Cue Sound Driver
(`roms/lib/cuesound.inc`), the kit's converted art and music, and assembly written in place.
`EXTERN` declarations give the symbols that assembly defines SCRIM types. (In the fiction: the 1987 kit
shipped SCRIM together with the Cue Sound Driver; `EXTERN` is how games called it.)

```
PROGRAM Hero;
ASSET "gfx/hero.art";                  -- converted by the kit (tools/art.ts), then linked
ASSET "hero.song";                     -- converted by the kit (tools/song.ts), then linked
LINK "../lib/cuesound.inc";            -- CYASM source, linked as written
ASM                                    ; CYASM written in place (CYASM comments inside)
Twice:  LD   R0, [SP+2]
        ADD  R0, R0
        RTS
END;

VAR SND_RAM: ARRAY [136] OF WORD;          -- the driver's 272 bytes, allocated by SCRIM (10.7)
    i: WORD;
EXTERN DATA HERO: ARRAY OF BYTE;           -- a ROM label, read-only like DATA
            HERO_PAL: ARRAY [8] OF WORD;
EXTERN CONST HERO_TILES: WORD;             -- an equate or a label, used as a number
             SONG_theme: WORD;
             SFX_jump: WORD;
EXTERN VAR SND_ROWS: WORD;                 -- RAM the assembly owns
EXTERN PROC SndInit;                       -- routines that follow the SCRIM convention (§4)
EXTERN PROC SndPlaySong(song: WORD);
EXTERN PROC SndSfx(sfx: WORD);
EXTERN PROC SndTick;
EXTERN FUNC Twice(x: WORD): WORD;

INTERRUPT PROC onVblank;
BEGIN
  SndTick;                                 -- once per frame, first thing in VBLANK
  IF_PORT := 1
END;
VECTOR VBLANK := onVblank;

BEGIN
  VRAM_COPY(0, @HERO[0], HERO_TILES * 12); -- 24 bytes (12 words) a tile
  CRAMADDR := 0;
  FOR i := 0 TO 7 DO CRAMDATA := HERO_PAL[i] END;
  SndInit;
  SndPlaySong(SONG_theme);
  IE := 1;
  ASM EI END;
  WHILE TRUE DO
    WAIT;
    IF (PAD1 AND 1) <> 0 THEN SndSfx(SFX_jump) END
  END
END.
```

1. **Placement.** `LINK "file";`, `ASSET "file";` and a module-level `ASM ... END;` are module
   declarations (also allowed in INCLUDEd files). Each places its assembly in the *link area* of
   the bank current at the declaration (`BANK n;`): after that bank's procedures, runtime routines
   and `DATA`, in declaration order, each preceded by `.align 2`. `LINK` emits
   `.include "file"`. `ASSET "x.art"` / `ASSET "x.song"` emits `.include "x.art.inc"` /
   `.include "x.song.inc"`, which the kit generates from `x.art` / `x.song` on demand, exactly as
   every ROM build does (`tools/art.ts` `sourceReader`; a hand-made `x.art.inc` on disk takes
   precedence). `ASSET` takes only `.art` and `.song` files; other files are linked with `LINK`.
2. **Paths** are relative to the SCRIM file that names them. The generated `.asm` writes them
   relative to the main file's directory, with forward slashes, so assembling the compiler's
   `.asm` output with the kit's reader gives the same ROM (tested). A file named twice (for
   example by two INCLUDEd modules) is linked once, where it was first named.
3. **Shared names.** Every module-level SCRIM name is an assembler symbol of the same name
   (§9.20): a CONST is an equate, a VAR is its work-RAM address, DATA and PROC/FUNC are labels.
   Linked assembly may use them; that is how a library receives its configuration (10.7). Linked
   files must not define a name SCRIM declares (the assembler reports it as defined twice) or
   names beginning `__` (§9.16).
4. **EXTERN** declares a symbol that the linked assembly (a LINK, an ASSET or a module ASM block)
   defines; it emits no storage and no code. After assembling, the compiler checks that every
   EXTERN is defined, used or not (`EXTERN PROC 'X' is not defined by any LINK, ASSET or ASM
   block`, at the EXTERN's line); each use of an undefined symbol also fails at its own line
   (`assembler: undefined symbol 'X'`). The forms:
   - `EXTERN DATA name: T;` — a ROM label with DATA's rules: read-only, indexable, `@name`
     works, and the bank rule of §9.12 with the bank current at the EXTERN. `ARRAY OF T` without
     a size is allowed (an asset's length is the converter's business): its indices are not
     bounds-checked and `LEN` / `SIZEOF` of it are errors; write `ARRAY [n] OF T` for both.
   - `EXTERN CONST name: T;` (BYTE, WORD, INT, FIXED or POINTER TO T) — a *link-time constant*,
     an equate's or a label's value, loaded with `MOVW Rd, #name` (a BYTE keeps the low 8 bits).
     It is an ordinary value in expressions but not a constant expression: it cannot size an
     array or appear in CONST, DATA initialisers, CASE labels, STEP, AT, BANK or HEADER (the
     error adds `EXTERN CONST 'X' is only known when linking`). It cannot be assigned, and `@`
     does not apply to it.
   - `EXTERN VAR name: T;` — RAM the assembly owns (for example the driver's `SND_ROWS`), read
     and written like a VAR at the symbol's address; SCRIM neither allocates nor zeroes it.
   - `EXTERN PROC name[(params)];` / `EXTERN FUNC name[(params)]: T;` — an assembly routine that
     follows §4's calling convention exactly: arguments pushed right to left as words (the first
     argument is at `[SP+2]` on entry; BYTE arguments arrive zero-extended), the caller removes
     them, a FUNC returns its result in R0, and the routine preserves R4–R6 (R0–R3, R7 and the
     flags may change) and returns with RTS. Parameters and results are scalar (§9.11); calls may
     come before the declaration. External routines live in bank 0: an EXTERN PROC/FUNC after
     `BANK n` (n ≥ 1) is an error, and there are no FAR or INTERRUPT forms. Routines with a
     register convention (such as `SND_SFX`, argument in R0) are called from `ASM` blocks, or
     through a stack-convention entry point (`SndSfx`).
   More `EXTERN DATA|CONST|VAR` declarations may follow one keyword, as in VAR blocks, and names
   may share a type (`EXTERN DATA FLOOR, WALL: ARRAY [24] OF BYTE;`, roms/slice-test); each
   PROC/FUNC needs its own `EXTERN`. An initialiser (`EXTERN DATA d: T = ...`) is an error.
5. **Errors in linked assembly** are reported at the LINK or ASSET line, naming the file and the
   line inside it: `main.scr:4:1: assembler: lib/bad.inc:12: unknown mnemonic 'FROB'`. A file
   that cannot be read, and an asset the converter rejects (`hero.art:7: row width 9, expected
   8`), are reported the same way. Errors in a module-level ASM block are reported at its lines.
6. `EXTERN`, `LINK` and `ASSET` are reserved words.
7. **RAM for linked assembly (recommended pattern).** A library takes the address of its RAM
   from a symbol the program defines, never from a fixed address (roms/lib/README.md). In SCRIM,
   define that symbol as a module VAR of the right size, so the VAR allocator reserves it, startup
   zeroes it, and no other VAR can overlap it: `VAR SND_RAM: ARRAY [136] OF WORD;` gives the Cue
   Sound Driver its `SND_RAM_SIZE` = 272 bytes, and `ARRAY OF WORD` keeps it on the even address
   the driver needs (an `ARRAY [272] OF BYTE` may land on an odd one). The size can be checked at
   run time through `EXTERN CONST SND_RAM_SIZE: WORD;`. Placing the block with `VAR ... AT` (or
   a CONST address) also works, but such blocks are outside the allocator (§9.14) and the stack
   grows down from C000, so the program must keep them clear by hand.
8. The size report (§7) lists SCRIM procedures only; linked code and data are not attributed to
   them. Linked symbols appear in the symbol table and listing like any others.
9. Symbols of kit assets: a `.art` block `@tiles NAME` or `@sprite16 NAME` defines `NAME` (planar
   tile data, 24 bytes a tile) and `NAME_TILES` (the tile count); `@palette NAME` defines `NAME`
   (8 words). A `.song` defines `SONG_name`, `SONG_name_RATE`, `SONG_name_ROWS`,
   `SONG_name_LOOP_ROWS`, `SFX_name` and internals (roms/lib/README.md §2). Tests:
   `tests/scrim-link.test.ts`.
