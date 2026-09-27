// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Browser player: runs a cartridge on the emulated Cyclorama and presents it.
// Machine timing never depends on the browser: the pacer decides how many whole
// frames to run; the canvas shows the latest one; audio is resampled output of
// the emulated Cue chip, fed to an AudioWorklet with dynamic rate control, or,
// where worklets are unavailable (non-secure contexts), to a ScriptProcessor that
// pulls from the same queue with the same rate control. Audio is output only.
import { Machine } from "../machine/machine.ts";
import { Tally } from "../machine/cpu.ts";
import type { LoadStateOptions } from "../machine/savestate.ts";
import { FramePacer } from "./pacing.ts";
import { Resampler } from "./resample.ts";
import { LevelMeter, SampleQueue, WORKLET_NAME, WORKLET_SOURCE, rateAdjust, type AudioReport } from "./audio-out.ts";
import { padFromGamepad, padFromKeys } from "./input.ts";

const CUE_HZ = 945e6 / 44 / 448;
const TARGET_QUEUE = 2400;   // output samples (~50 ms at 48 kHz)
const SP_BLOCK = 2048;       // ScriptProcessor block (the queue target is measured after each block is pulled)

export type AudioBackend = "worklet" | "script-processor" | "none";
/** peak: largest output sample magnitude so far (0 while the cartridge has been silent). */
export type PlayerStats = { frames: number; presented: number; underruns: number; played: number; queue: number; peak: number };

export class Player {
  readonly machine: Machine;
  private ctx2d: CanvasRenderingContext2D;
  private image: ImageData;
  private px: Uint32Array;
  private pacer = new FramePacer();
  private keys = new Set<string>();
  private raf = 0;
  private audio: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private script: ScriptProcessorNode | null = null;
  private sink: ((out: Float32Array) => void) | null = null;
  private backend: AudioBackend = "none";
  private meter = new LevelMeter();
  private resampler: Resampler | null = null;
  readonly stats: PlayerStats = { frames: 0, presented: 0, underruns: 0, played: 0, queue: 0, peak: 0 };
  private listeners: [EventTarget, string, EventListener][] = [];
  private stopped = false;
  private nodeConnected = false;
  private closedAudio: AudioContext | null = null;
  /** Pad values (controller 1, 2) passed to the machine for the most recent frame. */
  lastPads: [number, number] = [0, 0];

  constructor(canvas: HTMLCanvasElement, rom: Uint8Array) {
    this.machine = new Machine(rom, { cpu: new Tally() });
    canvas.width = 256; canvas.height = 224;
    this.ctx2d = canvas.getContext("2d", { alpha: false })!;
    this.image = this.ctx2d.createImageData(256, 224);
    this.px = new Uint32Array(this.image.data.buffer);
    this.on(window, "keydown", e => { const k = (e as KeyboardEvent).code; if (k in KEYS) { this.keys.add(k); e.preventDefault(); } });
    this.on(window, "keyup", e => this.keys.delete((e as KeyboardEvent).code));
    this.on(window, "blur", () => this.keys.clear());
    this.on(document, "visibilitychange", () => { this.pacer.reset(); if (document.hidden) this.audio?.suspend(); else this.audio?.resume(); });
  }

  private on(t: EventTarget, type: string, fn: EventListener) { t.addEventListener(type, fn); this.listeners.push([t, type, fn]); }

  /** Current pad bytes from keyboard (player 1) and gamepads. */
  private pads(): [number, number] {
    let p1 = padFromKeys(this.keys), p2 = 0;
    const gps = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
    let i = 0;
    for (const g of gps) { if (!g) continue; if (i === 0) p1 |= padFromGamepad(g); else if (i === 1) p2 = padFromGamepad(g); i++; }
    return [p1, p2];
  }

  start() {
    if (this.stopped) return;
    const loop = (now: number) => {
      if (this.stopped) return;
      const n = this.pacer.tick(now);
      for (let k = 0; k < n; k++) this.runOneFrame();
      if (n) this.present();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Stop for good: no more frames, input listeners removed, audio node disconnected, AudioContext closed. */
  async stop() {
    this.stopped = true;
    cancelAnimationFrame(this.raf); this.raf = 0;
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
    this.listeners = [];
    this.keys.clear();
    if (this.worklet) { this.worklet.port.onmessage = null; this.worklet.port.close(); this.worklet.disconnect(); this.worklet = null; }
    if (this.script) { this.script.onaudioprocess = null; this.script.disconnect(); this.script = null; }
    this.sink = null;
    this.nodeConnected = false;
    this.resampler = null;
    const ctx = this.audio;
    this.audio = null;
    if (ctx) { this.closedAudio = ctx; if (ctx.state !== "closed") await ctx.close(); }
  }

  /** True while the animation-frame loop is scheduled. */
  get looping(): boolean { return this.raf !== 0 && !this.stopped; }
  get listenerCount(): number { return this.listeners.length; }
  /** Output backend in use, real AudioContext state ("none" before audio was enabled) and whether its node is connected. */
  get audioStatus(): { backend: AudioBackend; state: string; connected: boolean } {
    return { backend: this.backend, state: (this.audio ?? this.closedAudio)?.state ?? "none", connected: this.nodeConnected };
  }
  get audioBackend(): AudioBackend { return this.backend; }
  /** Decaying peak level (0..1) of recently output samples, for a level meter. */
  get audioLevel(): number { return this.meter.read(performance.now()); }

  /** Run exactly one machine frame with the current input (also used by tests and debuggers). */
  runOneFrame() {
    const [p1, p2] = this.lastPads = this.pads();
    this.machine.runFrame(p1, p2);
    this.stats.frames++;
    const samples = this.machine.audio.takeSamples();
    if (this.sink && this.resampler) this.sink(this.resampler.push(samples));
  }

  present() {
    const fb = this.machine.framebuffer, px = this.px;
    for (let i = 0; i < fb.length; i++) { const c = fb[i]; px[i] = 0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff); }
    this.ctx2d.putImageData(this.image, 0, 0);
    this.stats.presented++;
  }

  /** Must be called from a user gesture (autoplay policy). Throws only when there is no usable audio output at all. */
  async enableAudio() {
    if (this.stopped) return;
    if (this.audio) { await this.audio.resume(); return; }
    if (typeof AudioContext !== "function") throw new Error("this browser has no Web Audio");
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.audio = ctx;                       // visible to stop() while the module loads
    const haveWorklet = await this.loadWorklet(ctx);
    if (this.stopped) return;               // ejected while loading: stop() already closed ctx
    const rs = new Resampler(CUE_HZ, ctx.sampleRate);
    if (haveWorklet) this.startWorklet(ctx, rs); else this.startScriptProcessor(ctx, rs);
    this.resampler = rs;
    await ctx.resume();
  }

  /** False when AudioWorklet is missing (e.g. a non-secure context) or its module will not load. */
  private async loadWorklet(ctx: AudioContext): Promise<boolean> {
    if (!ctx.audioWorklet || typeof AudioWorkletNode !== "function") return false;
    const blob = () => URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    const data = () => "data:text/javascript;base64," + btoa(WORKLET_SOURCE);
    for (const url of [blob, data]) {
      if (this.stopped) return false;
      const u = url();
      try { await ctx.audioWorklet.addModule(u); return true; }
      catch { /* try the next form, then fall back */ }
      finally { if (u.startsWith("blob:")) URL.revokeObjectURL(u); }
    }
    return false;
  }

  private startWorklet(ctx: AudioContext, rs: Resampler) {
    const node = new AudioWorkletNode(ctx, WORKLET_NAME, { outputChannelCount: [1] });
    node.port.onmessage = e => this.onReport(e.data as AudioReport, rs);
    node.connect(ctx.destination);
    this.worklet = node; this.backend = "worklet"; this.nodeConnected = true;
    this.sink = out => node.port.postMessage(out, [out.buffer]);
  }

  /** Fallback output: same queue, same rate control, pulled on the main thread. */
  private startScriptProcessor(ctx: AudioContext, rs: Resampler) {
    if (typeof ctx.createScriptProcessor !== "function") throw new Error("no AudioWorklet or ScriptProcessor output");
    const q = new SampleQueue();
    const node = ctx.createScriptProcessor(SP_BLOCK, 0, 1);
    node.onaudioprocess = e => { q.pull(e.outputBuffer.getChannelData(0)); this.onReport(q.report(), rs); };
    node.connect(ctx.destination);
    this.script = node; this.backend = "script-processor"; this.nodeConnected = true;
    this.sink = out => q.push(out);
  }

  private onReport(r: AudioReport, rs: Resampler) {
    if (this.stopped) return;
    this.stats.queue = r.depth; this.stats.underruns = r.under; this.stats.played = r.played;
    if (r.peak > this.stats.peak) this.stats.peak = r.peak;
    this.meter.feed(r.peak, performance.now());
    rs.setRateAdjust(rateAdjust(r.depth, TARGET_QUEUE));
  }

  saveState(): Uint8Array { return this.machine.saveState(); }
  /** Throws SaveStateError and changes nothing when the state does not fit this cartridge. */
  loadState(s: Uint8Array, o?: LoadStateOptions) { this.machine.loadState(s, o); this.pacer.reset(); this.present(); }
}

const KEYS: Record<string, true> = { ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true, KeyZ: true, KeyX: true, KeyC: true, Enter: true };
