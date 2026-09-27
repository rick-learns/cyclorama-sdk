// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// The debugger logic without a user interface: break at a label, step instructions with a
// disassembly, stop when a variable is written, and look at a sprite.
//   node examples/debug/trace.ts
import { readFileSync } from "node:fs";
import { assemble } from "../../src/asm/assembler.ts";
import { sourceReader } from "../../tools/art.ts";
import { DebugSession } from "../../src/web/debugger/session.ts";
import { decodeOam, disasmWindow, flagString, hex4 } from "../../src/web/debugger/views.ts";

// Assemble with symbols, so breakpoints and watchpoints can use the program's own names.
const built = assemble("examples/tutorial-1/step2.asm", sourceReader(p => readFileSync(p)));
const sym = (name: string) => built.symbols.get(name)!;
const s = new DebugSession(built.rom);
const m = s.machine, cpu = m.cpu;
const regs = () => `R0-R7 ${[...cpu.r].map(hex4).join(" ")}  SP ${hex4(cpu.sp)}  flags ${flagString(cpu.f)}`;
const NONE = [0, 0] as const, RIGHT = [8, 0] as const, A = [16, 0] as const;

// 1. A breakpoint on the VBLANK handler: advanceFrame stops there instead of finishing the frame.
s.breakpoints.add(sym("vblank"));
const hit = s.advanceFrame(RIGHT);
console.log(`break: ${hit?.kind} at ${hex4(cpu.pc)} (vblank), frame ${m.frame}`);
console.log(regs());

// 2. Step three instructions, showing each one before it runs.
for (let i = 0; i < 3; i++) {
  const [line] = disasmWindow(a => m.bus.read8(a), cpu.pc, 0, 0);
  s.stepInstruction(RIGHT);
  console.log(`step: ${hex4(line.addr)}  ${line.text.padEnd(20)} -> ${regs()}`);
}

// 3. A watchpoint on the palette variable: pressing A writes it, and execution stops there.
s.breakpoints.clear();
s.watchpoints.add(sym("LPAL"));
let w = null;
for (let f = 0; f < 10 && !w; f++) w = s.advanceFrame(f < 3 ? NONE : A);
if (w?.kind === "watch") console.log(`watch: LPAL (${hex4(w.addr)}) <- ${hex4(w.value)} by the instruction at ${hex4(w.pc)}, frame ${m.frame}`);

// 4. Finish the frame and decode sprite 0 from OAM.
s.watchpoints.clear();
s.advanceFrame(NONE);
const lamp = decodeOam(m.video.oam, 0);
console.log(`sprite 0: x ${lamp.x} y ${lamp.y} tile ${lamp.tile} palette ${lamp.palette} size ${lamp.size}${lamp.hidden ? " hidden" : ""}`);
