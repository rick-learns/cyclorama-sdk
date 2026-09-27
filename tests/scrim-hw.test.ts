// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// SCRIM compiler: programs that talk to the hardware (ports, interrupts, banks, DMA) and the
// runtime library, run on the full machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "./scrim-harness.ts";

test("PORT writes reach the hardware: CRAM via CRAMADDR/CRAMDATA, video registers; ports read back", () => {
  const t = run(`
PROGRAM Ports;
PORT PADLO: BYTE AT $F0C0;
VAR back: ARRAY [3] OF WORD; pad: WORD; padb: BYTE; vc: WORD;
BEGIN
  CRAMADDR := 5;
  CRAMDATA := $0ABC;
  CRAMDATA := $0123;
  CRAMDATA := $0FFF;
  CRAMADDR := 5;
  back[0] := CRAMDATA; back[1] := CRAMDATA; back[2] := CRAMDATA;
  VCTRL := %10011;
  L0X := 77;
  FIXED_PORT := 3;
  IE := 1;
  WAIT;
  vc := VCOUNT;
  IF_PORT := 1;
  pad := PAD1; padb := PADLO;
  IE := 0
END.`, { pads: () => [0x5a, 0] });
  assert.deepEqual(Array.from(t.m.video.cram.subarray(5, 8)), [0xabc, 0x123, 0xfff]);
  assert.deepEqual(t.words("back", 3), [0xabc, 0x123, 0xfff]);
  assert.equal(t.m.video.regs.VCTRL, 0x13);
  assert.equal(t.m.video.regs.L0X, 77);
  assert.equal(t.m.video.regs.FIXED, 3);
  assert.equal(t.w("vc"), 224, "WAIT (WAI) resumes at the start of vertical blank");
  assert.equal(t.w("pad"), 0x5a);
  assert.equal(t.b("padb"), 0x5a);
  assert.equal(t.m.bus.read16(0xf0da) & 1, 0, "IF_PORT write acknowledged VBLANK");
});

test("startup: display off, all sprites hidden, SP = C000, main returns into STOP", () => {
  const t = run(`
PROGRAM Boot;
VAR spv: WORD;
BEGIN
  ASM
    MOV R0, SP
    ST  R0, [spv]
  END
END.`);
  assert.equal(t.stopped, true);
  assert.equal(t.m.video.regs.VCTRL, 0);
  for (let i = 0; i < 64; i++) assert.equal(t.m.video.oam[i * 8 + 6] & 2, 2, `sprite ${i} hidden`);
  assert.equal(t.w("spv"), 0xc000 - 2, "main is called from startup: only its return address is on the stack");
  assert.equal(t.m.cpu.sp, 0xc000);
});

test("INTERRUPT PROC on VBLANK counts frames while main code runs; registers survive interrupts", () => {
  const t = run(`
PROGRAM Irq;
VAR frames, bad, loops, lineAt: WORD;
INTERRUPT PROC onVblank;
VAR t: WORD;
BEGIN
  t := frames + 1;
  frames := t;
  IF_PORT := 1
END;
INTERRUPT PROC onLine;
BEGIN
  lineAt := VCOUNT;
  IF_PORT := 2
END;
VECTOR VBLANK := onVblank;
VECTOR LINE := onLine;
FUNC churn(n: WORD): WORD;
VAR a, b, c, i: WORD;
BEGIN
  a := 0; b := 1;
  FOR i := 1 TO n DO c := a + b; a := b; b := c END;
  RETURN a
END;
BEGIN
  LINECMP := 100;
  IE := 3;
  ASM EI END;
  WHILE frames < 5 DO
    IF churn(20) <> 6765 THEN bad := bad + 1 END;
    loops := loops + 1
  END;
  ASM DI END
END.`, { frames: 20 });
  assert.equal(t.stopped, true);
  assert.equal(t.w("frames"), 5);
  assert.equal(t.w("bad"), 0);
  assert.ok(t.w("loops") > 50, `loops ${t.w("loops")}`);
  assert.equal(t.w("lineAt"), 100);
  assert.equal(t.frames, 5, "stops in the fifth frame, right after its VBLANK");
  assert.equal(t.m.bus.read16(0x0002), t.addr("onVblank"), "vector table points at the handler");
  assert.equal(t.m.bus.read16(0x0004), t.addr("onLine"));
});

test("FAR PROC/FUNC in switchable banks, called through bank-0 trampolines that restore BANK", () => {
  const t = run(`
PROGRAM Banks;
VAR r: ARRAY [8] OF WORD;
FUNC base(x: WORD): WORD; BEGIN RETURN x + 1000 END;
BANK 2;
DATA t2: ARRAY [4] OF WORD = (21, 22, 23, 24);
FAR FUNC inBank2(i: WORD): WORD;
BEGIN RETURN t2[i] + BANK_PORT * 100 + get3(i) + t2[0] END;
FAR PROC store2(v: WORD);
BEGIN r[7] := t2[0] + v + base(1) END;
BANK 3;
DATA t3: ARRAY [4] OF WORD = (31, 32, 33, 34);
FAR FUNC get3(i: WORD): WORD; BEGIN RETURN t3[i] END;
BANK 0;
BEGIN
  r[0] := BANK_PORT;
  r[1] := get3(2);
  r[2] := BANK_PORT;
  r[3] := inBank2(1);
  store2(5);
  r[4] := BANK_PORT;
END.`);
  assert.deepEqual(t.words("r", 8), [1, 33, 1, 22 + 200 + 32 + 21, 1, 0, 0, 21 + 5 + 1001]);
  assert.equal(t.r.rom!.length, 4 * 16384, "banks 0-3 used: 64 KiB image");
  assert.ok(t.addr("__far_get3") >= 0x4000 && t.addr("__far_inBank2") >= 0x4000, "bodies live in the 4000-7FFF window");
  assert.ok(t.addr("get3") < 0x4000, "the callable entry (trampoline) lives in bank 0");
  assert.match(t.r.asm, /\.bank 2/);
  assert.match(t.r.asm, /\.bank 3/);
});

test("runtime library: MEMCPY (byte and word paths), MEMSET, VRAM_COPY (DMA), RANDOM LFSR, WAIT_VBLANK", () => {
  const t = run(`
PROGRAM Rt;
DATA tiles: ARRAY [8] OF WORD = ($1111, $2222, $3333, $4444, $5555, $6666, $7777, $8888);
VAR src, dst: ARRAY [12] OF BYTE; ws, wd: ARRAY [6] OF WORD;
    rnd: ARRAY [5] OF WORD; rnd0: ARRAY [3] OF WORD; vc, i: WORD;
BEGIN
  FOR i := 0 TO 11 DO src[i] := BYTE(i + 1); dst[i] := $EE END;
  FOR i := 0 TO 5 DO ws[i] := i * $1001 END;
  MEMCPY(@dst[1], @src[0], 5);
  MEMCPY(@wd[1], @ws[0], 8);
  MEMSET(@dst[7], $AA, 3);
  MEMCPY(@dst[11], @src[0], 0);
  VRAM_COPY($0100, @tiles, 8);
  FOR i := 0 TO 2 DO rnd0[i] := RANDOM() END;
  SEED_RANDOM(1);
  FOR i := 0 TO 4 DO rnd[i] := RANDOM() END;
  WAIT_VBLANK;
  vc := VCOUNT;
END.`);
  assert.deepEqual(Array.from({ length: 12 }, (_, i) => t.b("dst", i)), [0xee, 1, 2, 3, 4, 5, 0xee, 0xaa, 0xaa, 0xaa, 0xee, 0xee]);
  assert.deepEqual(t.words("wd", 6), [0, 0, 0x1001, 0x2002, 0x3003, 0]);
  const vram = t.m.video.vram;
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => vram[0x100 + 2 * i] | (vram[0x101 + 2 * i] << 8)),
    [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888]);
  const lfsr = (s: number, n: number) => { const out: number[] = []; for (let k = 0; k < n; k++) { s = (s >>> 1) ^ (s & 1 ? 0xb400 : 0); out.push(s); } return out; };
  assert.deepEqual(t.words("rnd0", 3), lfsr(0xace1, 3), "default seed ACE1");
  assert.deepEqual(t.words("rnd", 5), lfsr(1, 5));
  assert.equal(t.w("vc"), 224);
});

test("runtime routines are linked only when used", () => {
  const t = run(`PROGRAM Small; VAR x: WORD; BEGIN x := 3 END.`);
  for (const name of ["__divu", "__divs", "MEMCPY", "MEMSET", "VRAM_COPY", "RANDOM", "WAIT_VBLANK"])
    assert.equal(t.r.symbols!.has(name), false, name);
  const d = run(`PROGRAM Div; VAR x, y: WORD; BEGIN x := 300; y := x / 7 END.`);
  assert.equal(d.r.symbols!.has("__divu"), true);
  assert.equal(d.r.symbols!.has("__divs"), false);
  assert.equal(d.w("y"), 42);
});

test("HEADER fields become the cartridge header; the title defaults to the program name", () => {
  const t = run(`
PROGRAM Lantern;
HEADER title = "LANTERN", dev = $0001, date = $19870918, version = $0100;
BEGIN END.`);
  const rom = t.r.rom!;
  const text = (a: number, n: number) => String.fromCharCode(...rom.subarray(a, a + n));
  assert.equal(text(0x10, 4), "CYCL");
  assert.equal(text(0x18, 24), "LANTERN".padEnd(24));
  assert.equal(rom[0x30] | (rom[0x31] << 8), 1);
  assert.equal((rom[0x32] | (rom[0x33] << 8) | (rom[0x34] << 16) | (rom[0x35] << 24)) >>> 0, 0x19870918);
  assert.equal(rom[0x36] | (rom[0x37] << 8), 0x0100);
  const d = run(`PROGRAM Nightside; BEGIN END.`);
  assert.equal(String.fromCharCode(...d.r.rom!.subarray(0x18, 0x18 + 9)), "Nightside");
});
