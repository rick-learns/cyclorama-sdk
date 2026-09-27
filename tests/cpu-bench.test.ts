// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Tally interpreter throughput: ~5M instructions of a mixed tight loop. Prints MIPS; the
// assertion (> 4 MIPS, four times the ~1 MIPS real-time need) is deliberately loose: it only catches gross regressions and must not flake under parallel load. Throughput over time is tracked by the project's benchmark report, not here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { enc, ALU_OPS, UNARY_OPS, CONDITIONS } from "../src/isa/isa.ts";
import type { Bus } from "../src/machine/types.ts";
import { Tally } from "../src/machine/cpu.ts";

class RamBus implements Bus {
  mem = new Uint8Array(0x10000);
  read8(a: number) { return this.mem[a]; }
  read16(a: number) { return this.mem[a] | (this.mem[a + 1] << 8); }
  write8(a: number, v: number) { this.mem[a] = v; }
  write16(a: number, v: number) { this.mem[a] = v; this.mem[a + 1] = v >> 8; }
  pendingInterrupts() { return 0; }
  takeExtraCycles() { return 0; }
}

const A = (m: string) => ALU_OPS.indexOf(m as (typeof ALU_OPS)[number]);
const U = (m: string) => UNARY_OPS.indexOf(m as (typeof UNARY_OPS)[number]);
const B = (m: string) => CONDITIONS.indexOf(m as (typeof CONDITIONS)[number]);

// Under coverage instrumentation (npm run coverage: node sets NODE_V8_COVERAGE for every test process)
// the interpreter runs several times slower, so a throughput floor would only measure the instrumentation.
const instrumented = process.env.NODE_V8_COVERAGE ? "coverage instrumentation makes timing meaningless" : false;

test("benchmark: Tally interpreter throughput > 4 MIPS (4x real time)", { skip: instrumented }, () => {
  const bus = new RamBus();
  const code = [
    enc.aluI(A("MOV"), 5), 0x8000,            // MOVW R5,#$8000
    // loop:
    enc.quick(true, 0, 1),                    // ADDQ R0,#1
    enc.aluR(A("ADD"), 2, 0),                 // ADD  R2,R0
    enc.aluR(A("XOR"), 3, 2),                 // XOR  R3,R2
    enc.mem(false, false, 4, 5, 1),           // LD   R4,[R5+2]
    enc.mem(false, true, 3, 5, 2),            // ST   R3,[R5+4]
    enc.unary(U("SHLI"), 4, 2),               // SHL  R4,#3
    enc.aluR(A("CMP"), 0, 4),                 // CMP  R0,R4
    enc.branch(B("EQ"), 0),                   // BEQ  next (taken or not)
    enc.branch(B("RA"), 0x100 - 8),           // BRA  loop
  ];
  bus.mem[0] = 0x00; bus.mem[1] = 0x01;
  code.forEach((w, i) => { bus.mem[0x100 + 2 * i] = w & 0xff; bus.mem[0x101 + 2 * i] = w >> 8; });
  const cpu = new Tally();
  cpu.reset(bus);
  // warm up the JIT
  for (let i = 0; i < 200_000; i++) cpu.step(bus);
  const n = 5_000_000;
  let cycles = 0;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) cycles += cpu.step(bus);
  const ms = performance.now() - t0;
  const mips = n / ms / 1000;
  console.log(`Tally: ${n} instructions in ${ms.toFixed(1)} ms = ${mips.toFixed(1)} MIPS (${cycles} CPU cycles)`);
  assert.equal(cpu.mode, "run");
  assert.ok(cpu.pc >= 0x0104 && cpu.pc <= 0x0112, `still in the loop, PC=${cpu.pc.toString(16)}`);
  assert.ok(mips > 4, `${mips.toFixed(1)} MIPS`);
});
