# CUE SOUND TEST (Cyclorama Development Kit test cartridge)

Not a canon retail release: the dev-kit cartridge that demonstrates the Cue Sound Driver
(`roms/lib/cuesound.inc`). It starts straight into its own screen, plays its own theme and fires
sound effects over it. It shows no Curtain Up splash: this is an open demo, and the official
start-up splash is a brand asset that is not part of the SDK (TRADEMARKS.md); the console never
checks for a splash.

**"Followspot"** (`sound-test.song`): an original upbeat theme in C major, 150 BPM (speed 6, one
row per 16th note). Two-bar intro (bass, chord stabs, drums), then an 8-bar A section (the hook:
a "short-short-long" figure answered a step lower) and an 8-bar B section (a longer singing line
over Am–F–C–G, ending on a ii–V back to the top); A–B loops (256 rows, 25.6 s).
Voice 0 lead (25 % pulse, delayed vibrato), voice 1 triangle bass bouncing in octaves, voice 2
12.5 % pulse chords arpeggiated every frame (3+3+2 stabs in A, quarters in B), voice 3 noise drums
(swept "buzz" kick, snare, hat).

| Button | Action |
|---|---|
| A | jump (voice 2, rising square blip) |
| B | gem (voice 2, three-note chime) |
| C | boom (voice 3, falling noise burst) |
| LEFT | power-up (voice 2, arpeggiated climb) |
| UP / DOWN | hurry tempo (+25 %, `SND_TEMPO`) / normal |
| START | fade out (`SND_FADE`); once faded, play again |

The screen shows, per Cue voice, who holds it (MUS / SFX / ---), its current volume (VxCTRL
bits 11-8) and FREQ, plus the tempo and the driver's row counter.

Effects borrow only voice 2 or 3, so lead and bass never drop out. Tests:
`tests/sound-test.test.ts`. A 20-second recording: `node tools/song-wav.ts` → `.tmp/sound-test.wav`.
