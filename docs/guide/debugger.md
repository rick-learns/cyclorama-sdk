# Debugging

The SDK's debugger is a library with no user interface: [`DebugSession`](../../src/web/debugger/session.ts)
adds instruction stepping, PC breakpoints and write watchpoints to a machine, and
[`views.ts`](../../src/web/debugger/views.ts) turns machine state into things to show:
disassembly around the PC, hex dumps, the cartridge header, sprites, lights and the light
field's shade at any pixel. Both run in Node and in the browser, so you can script a debugging
session, write a test that stops at a label, or build your own debugger front end on them.

This page walks through [`examples/debug/trace.ts`](../../examples/debug/trace.ts), which a test
runs on every check. It debugs Tutorial 1's step 2
([Tutorial 1](tutorial-1-cyasm.md) explains the program).

<!-- run -->
```sh
node examples/debug/trace.ts
```

## A session with symbols

<!-- sample: examples/debug/trace.ts lines 13-19 -->
```ts
// Assemble with symbols, so breakpoints and watchpoints can use the program's own names.
const built = assemble("examples/tutorial-1/step2.asm", sourceReader(p => readFileSync(p)));
const sym = (name: string) => built.symbols.get(name)!;
const s = new DebugSession(built.rom);
const m = s.machine, cpu = m.cpu;
const regs = () => `R0-R7 ${[...cpu.r].map(hex4).join(" ")}  SP ${hex4(cpu.sp)}  flags ${flagString(cpu.f)}`;
const NONE = [0, 0] as const, RIGHT = [8, 0] as const, A = [16, 0] as const;
```

`assemble` returns the ROM together with its symbol table, a map from every label and constant
to its value, and `labelBanks`, the bank of every label (`npm run asm -- … --sym file` writes both
to a file). A `DebugSession`
owns a `Machine` (`s.machine`): everything in [Embedding](embedding.md) applies to it. The CPU's
registers are `cpu.r` (R0-R7), `cpu.sp`, `cpu.pc` and `cpu.f` (the flags: Z, N, C, V and the
interrupt enable I).

## Breakpoints

<!-- sample: examples/debug/trace.ts lines 21-25 -->
```ts
// 1. A breakpoint on the VBLANK handler: advanceFrame stops there instead of finishing the frame.
s.breakpoints.add(sym("vblank"));
const hit = s.advanceFrame(RIGHT);
console.log(`break: ${hit?.kind} at ${hex4(cpu.pc)} (vblank), frame ${m.frame}`);
console.log(regs());
```

`breakpoints` is a set of addresses. `advanceFrame(pads)` runs to the end of the frame, or stops
before an instruction at a breakpoint address and returns `{ kind: "breakpoint", pc }`. It stops
here at the first VBLANK: the interrupt has been taken (SP is two words lower: the CPU pushed the
return address and the flags) and `PUSHM` is next.

## Stepping

<!-- sample: examples/debug/trace.ts lines 27-32 -->
```ts
// 2. Step three instructions, showing each one before it runs.
for (let i = 0; i < 3; i++) {
  const [line] = disasmWindow(a => m.bus.read8(a), cpu.pc, 0, 0);
  s.stepInstruction(RIGHT);
  console.log(`step: ${hex4(line.addr)}  ${line.text.padEnd(20)} -> ${regs()}`);
}
```

`stepInstruction(pads)` executes exactly one instruction (or one interrupt entry); from `WAI` it
idles until the CPU resumes, at most two frames. `disasmWindow(read, pc, before, after)`
disassembles around an address through any byte reader; `m.bus.read8` reads what the CPU sees.
The output shows `PUSHM R0-R3` taking SP down four words, then the load of `PAD1` and of the
lamp's x position (0078 = 120).

Stepping is exact: the session calls the same machine step a free-running frame does, so a
stepped machine computes exactly what an unstepped one does. One difference to know about: while
a frame is being stepped, the pads it latches are the ones passed when the previous frame
closed. That is why `PAD1` reads 0 in this first VBLANK even though Right is passed.

## Watchpoints

<!-- sample: examples/debug/trace.ts lines 34-39 -->
```ts
// 3. A watchpoint on the palette variable: pressing A writes it, and execution stops there.
s.breakpoints.clear();
s.watchpoints.add(sym("LPAL"));
let w = null;
for (let f = 0; f < 10 && !w; f++) w = s.advanceFrame(f < 3 ? NONE : A);
if (w?.kind === "watch") console.log(`watch: LPAL (${hex4(w.addr)}) <- ${hex4(w.value)} by the instruction at ${hex4(w.pc)}, frame ${m.frame}`);
```

`watchpoints` is a set of CPU addresses; a word write covers both of its bytes. When the program
writes one, `advanceFrame` stops after the writing instruction and returns
`{ kind: "watch", addr, value, pc }`, where `pc` is the address of the instruction that wrote.
Here the first new press of A swaps the palette, and the watchpoint names the `ST` that stored it.

## Looking at the video chip

<!-- sample: examples/debug/trace.ts lines 41-45 -->
```ts
// 4. Finish the frame and decode sprite 0 from OAM.
s.watchpoints.clear();
s.advanceFrame(NONE);
const lamp = decodeOam(m.video.oam, 0);
console.log(`sprite 0: x ${lamp.x} y ${lamp.y} tile ${lamp.tile} palette ${lamp.palette} size ${lamp.size}${lamp.hidden ? " hidden" : ""}`);
```

With no breakpoints or watchpoints, `advanceFrame` runs the frame at full speed. `decodeOam`
reads one sprite's four OAM words into named fields. The other helpers in `views.ts`:

| Helper | What it gives |
|---|---|
| `hexRows` | Hex dump rows of any memory region |
| `parseAddress` | An address from text: hex, or a symbol name |
| `parseHeader` | The cartridge header: title, developer code, date, version, banks, cartridge RAM, and the stored and computed checksums |
| `decodeLight`, `litShade` | A light's registers in named fields; the shade the light field computes at a pixel |
| `shadeOverlay` | The shade of every pixel of the current frame, for a false-colour view |
| `renderTileSheet`, `renderMap` | VRAM tiles at a chosen palette and shade; a tile map (named by its map register) at a chosen shade |

To start a session from a moment you reached elsewhere, save the state there with
`machine.saveState()` (the reference player's `player.saveState()` gives the same bytes) and load
it into a session with `s.loadStored(state, title)`. It returns `null` when the state loaded, or
the reason it refused it (another ROM, a damaged state), and a refused state changes nothing.
