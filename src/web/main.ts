// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Entry point for the standalone player page. The ROM bytes are embedded at
// build time (window.__ROM_B64__), so the page needs no network or server.
import { Player } from "./player.ts";

declare global { interface Window { __ROM_B64__: string; __ROM_TITLE__: string; __player?: Player } }

const bin = atob(window.__ROM_B64__);
const rom = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) rom[i] = bin.charCodeAt(i);

const canvas = document.getElementById("screen") as HTMLCanvasElement;
const player = new Player(canvas, rom);
window.__player = player;
player.start();

const overlay = document.getElementById("start")!;
const begin = async () => { overlay.remove(); try { await player.enableAudio(); } catch (e) { console.warn("audio unavailable", e); } };
overlay.addEventListener("click", begin, { once: true });
window.addEventListener("keydown", () => { if (overlay.isConnected) begin(); }, { once: true });

let saved: Uint8Array | null = null;
window.addEventListener("keydown", e => {
  if (e.code === "F5") { e.preventDefault(); saved = player.saveState(); }
  if (e.code === "F8" && saved) { e.preventDefault(); player.loadState(saved); }
});
