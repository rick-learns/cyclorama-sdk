# LANTERN TEST (engineering test cartridge)

Not a canon release: an engineering cartridge used to verify the emulator and the browser player.
The stage cat walks a dark brick room with the D-pad; light 0 follows it. Its eyes are sprite 0
(flagged UNLIT, so they glow at the FIXED shade in any darkness) and its body is sprite 1 — the
lower OAM index wins overlaps, so the eyes must come first. AMBIENT 1 + intensity 6 keeps the light
sum at 7: with intensity 7 the 3-bit adder wraps to shade 0 and the lantern's centre goes black.

Art lives in `lantern-test.art` and is converted to tile data at build time by `tools/art.ts`
(the ROM stayed byte-identical when the hand-generated include was replaced).

Build: `npm run asm -- roms/lantern-test/lantern-test.asm -o build/lantern-test.rom`
