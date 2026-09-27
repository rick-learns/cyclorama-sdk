// SPDX-FileCopyrightText: 2026 rick-learns
// SPDX-License-Identifier: Apache-2.0
//
// Cyclorama I/O register map. Shared by the emulator's address decoder, the
// assembler's predefined symbols and the manual's register tables.
// All registers are 16 bits wide and word-aligned. Byte accesses to a register
// read or write the corresponding half (see manual: "Byte access to I/O").

export type Chip = "cartridge" | "video" | "audio" | "input" | "system" | "dma";
export type Register = { name: string; addr: number; chip: Chip; access: "r" | "w" | "rw"; description: string };

export const CHIP_RANGES: Record<Chip, [number, number]> = {
  cartridge: [0xe000, 0xe0ff],
  video: [0xf000, 0xf07f],
  audio: [0xf080, 0xf0bf],
  input: [0xf0c0, 0xf0cf],
  system: [0xf0d0, 0xf0df],
  dma: [0xf0e0, 0xf0ef],
};

const R: Register[] = [
  // Cartridge (decoded by the cartridge board)
  { name: "BANK", addr: 0xe000, chip: "cartridge", access: "rw", description: "ROM bank shown in the 4000-7FFF window, bits 7-0 (0-255). Bits 15-8 ignored, read 0. Reset value 1. The bank shown is BANK mod the bank count, which is the ROM image length / 16 KiB (the header size byte is not used)." },
  { name: "RAMCTL", addr: 0xe002, chip: "cartridge", access: "rw", description: "Bit 0: cartridge RAM write enable (1 = writes to C000-DFFF are stored). Reset value 0. Other bits read 0. Has no effect on cartridges without RAM." },

  // Video (Barndoor)
  { name: "VADDR", addr: 0xf000, chip: "video", access: "rw", description: "VRAM byte address for VDATA, bits 14-0; bit 0 is kept and reads back, but no access uses it: a word access to VDATA uses VADDR & 7FFE, a byte access to F002 the byte at VADDR & 7FFE and a byte access to F003 the byte at VADDR | 1. Bit 15 is not stored: it is ignored on writing and bit 15 reads 0." },
  { name: "VDATA", addr: 0xf002, chip: "video", access: "rw", description: "Reads or writes the VRAM word at VADDR, then adds VINC to VADDR (modulo 32 KiB: bits 14-0). Costs 2 extra CPU cycles during active display." },
  { name: "VINC", addr: 0xf004, chip: "video", access: "rw", description: "Amount added to VADDR after each VDATA access, bits 7-0. Reset value 2." },
  { name: "VCTRL", addr: 0xf006, chip: "video", access: "rw", description: "Bit 0 display enable, bit 1 BG0 enable, bit 2 BG1 enable, bit 3 sprite enable, bit 4 light field enable. Reset value 0 (screen shows backdrop colour CRAM[FIXED*64] when display is disabled)." },
  { name: "VSTAT", addr: 0xf008, chip: "video", access: "r", description: "Bit 0 in vertical blank (lines 224-261), bit 1 a line has had more than 16 sprites since VSTAT was last read, bit 2 probe ready. Reading VSTAT clears bit 1. Bit 2 is cleared by reading PROBE." },
  { name: "VCOUNT", addr: 0xf00a, chip: "video", access: "r", description: "Current line number 0-261, incremented at dot 0 of each line." },
  { name: "LINECMP", addr: 0xf00c, chip: "video", access: "rw", description: "LINE interrupt compare, bits 8-0. When VCOUNT equals LINECMP at dot 256 (start of horizontal blank), IF bit 1 is set. Reset value 511 (never matches)." },
  { name: "BG0SCX", addr: 0xf010, chip: "video", access: "rw", description: "BG0 horizontal scroll, bits 8-0 (0-511). Screen x maps to map x = (x + BG0SCX) mod 512." },
  { name: "BG0SCY", addr: 0xf012, chip: "video", access: "rw", description: "BG0 vertical scroll, bits 7-0 (0-255). Screen y maps to map y = (y + BG0SCY) mod 256." },
  { name: "BG1SCX", addr: 0xf014, chip: "video", access: "rw", description: "BG1 horizontal scroll, bits 8-0, as BG0SCX." },
  { name: "BG1SCY", addr: 0xf016, chip: "video", access: "rw", description: "BG1 vertical scroll, bits 7-0, as BG0SCY." },
  { name: "BG0MAP", addr: 0xf018, chip: "video", access: "rw", description: "BG0 map base = value x 2048 bytes, bits 3-0 (0-15; values above 14 place the 4 KiB map past VRAM and wrap). Reset value 12 (6000)." },
  { name: "BG1MAP", addr: 0xf01a, chip: "video", access: "rw", description: "BG1 map base = value x 2048 bytes, bits 3-0. Reset value 14 (7000)." },
  { name: "OAMADDR", addr: 0xf01c, chip: "video", access: "rw", description: "OAM byte address for OAMDATA, bits 8-1 (0-510, even). Bit 0 is not stored: bit 0 reads 0." },
  { name: "OAMDATA", addr: 0xf01e, chip: "video", access: "rw", description: "Reads or writes the OAM word at OAMADDR, then adds 2 to OAMADDR (modulo 512). A byte access reads or writes the addressed half of the word and also adds 2. Costs 2 extra CPU cycles during active display." },
  { name: "CRAMADDR", addr: 0xf020, chip: "video", access: "rw", description: "CRAM entry index for CRAMDATA, bits 8-0 (0-511); advances modulo 512." },
  { name: "CRAMDATA", addr: 0xf022, chip: "video", access: "rw", description: "Reads or writes CRAM entry CRAMADDR as 0000 RRRR GGGG BBBB, then adds 1 to CRAMADDR (wrapping). Bits 15-12 read 0. Costs 2 extra CPU cycles during active display." },
  ...[0, 1, 2, 3].flatMap((i): Register[] => [
    { name: `L${i}X`, addr: 0xf030 + i * 8, chip: "video", access: "rw", description: `Light ${i} X position, signed 10-bit (bits 9-0, -512..511) in screen pixels. Latched at dot 0 of each line.` },
    { name: `L${i}Y`, addr: 0xf032 + i * 8, chip: "video", access: "rw", description: `Light ${i} Y position, signed 10-bit (bits 9-0) in screen lines. Latched at dot 0 of each line.` },
    { name: `L${i}I`, addr: 0xf034 + i * 8, chip: "video", access: "rw", description: `Light ${i} intensity, signed 4-bit (bits 3-0, -8..7). 0 turns the light off. Latched at dot 0 of each line.` },
    { name: `L${i}F`, addr: 0xf036 + i * 8, chip: "video", access: "rw", description: `Light ${i} falloff in bits 2-0 (distance is shifted right by this amount) and shape in bits 5-4 (0 diamond, 1 square, 2 octagon, 3 band). Latched at dot 0 of each line.` },
  ]),
  { name: "AMBIENT", addr: 0xf050, chip: "video", access: "rw", description: "Ambient shade added to every lit pixel's light sum, bits 2-0. Latched at dot 0 of each line." },
  { name: "FIXED", addr: 0xf052, chip: "video", access: "rw", description: "Shade used by unlit tiles and sprites, and by every pixel while the light field is disabled, bits 2-0. Reset value 7. Latched at dot 0 of each line." },
  { name: "PROBEX", addr: 0xf054, chip: "video", access: "rw", description: "Probe column 0-255, bits 7-0. Latched at dot 0 of each line." },
  { name: "PROBEY", addr: 0xf056, chip: "video", access: "rw", description: "Probe line 0-223, bits 8-0 (values 224 and above are stored but never match). Latched at dot 0 of each line." },
  { name: "PROBE", addr: 0xf058, chip: "video", access: "r", description: "Probe result: bits 5-0 base colour index (palette x 8 + pixel) of the pixel output at (PROBEX, PROBEY), bits 10-8 its shade, bit 15 ready (same as VSTAT bit 2). Updated and ready set at dot 256 of line PROBEY. Reading clears ready." },

  // Audio (Cue)
  ...[0, 1, 2, 3].flatMap((i): Register[] => [
    { name: `V${i}FREQ`, addr: 0xf080 + i * 8, chip: "audio", access: "rw", description: i < 3 ? `Voice ${i} phase increment added to a 16-bit phase accumulator once per audio sample. Frequency = FREQ x 47940.34 / 65536 Hz for 16-step and 32-step waveforms alike.` : "Noise voice clock: the LFSR shifts once each time the 16-bit phase accumulator, advanced by this value once per sample, overflows." },
    { name: `V${i}WAVE`, addr: 0xf082 + i * 8, chip: "audio", access: "rw", description: i < 3 ? `Voice ${i} waveform, bits 2-0: 0 pulse 12.5%, 1 pulse 25%, 2 pulse 50%, 3 pulse 75%, 4 triangle, 5 sawtooth, 6 wavetable, 7 silent.` : "Noise mode, bit 0: 0 long (15-bit) LFSR, 1 short (7-bit) LFSR." },
    { name: `V${i}ENV`, addr: 0xf084 + i * 8, chip: "audio", access: "rw", description: `Voice ${i} envelope: bits 3-0 starting volume, bit 4 direction (0 falls, 1 rises), bits 7-5 step period in envelope ticks (0 = hold). Takes effect at the next key-on.` },
    { name: `V${i}CTRL`, addr: 0xf086 + i * 8, chip: "audio", access: "rw", description: `Voice ${i} control: writing 1 to bit 0 keys the voice on (loads the envelope volume, resets the envelope timer${i === 3 ? " and seeds the LFSR with all ones" : " and the phase accumulator to 0"}); writing 0 to bit 0 keys it off (volume 0). Both act at the moment of the write. Reads return bit 0 = keyed on and bits 11-8 = current volume, reflecting a key-on or key-off at once. Only a word write or a write to the low byte acts; a byte write to the high byte is ignored.` },
  ]),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i): Register => ({ name: `WAVE${i}`, addr: 0xf0a0 + i * 2, chip: "audio", access: "rw", description: `Wavetable samples ${i * 4}-${i * 4 + 3}, four 4-bit samples per word: bits 3-0 is sample ${i * 4}, bits 15-12 sample ${i * 4 + 3}.` })),
  { name: "MASTERVOL", addr: 0xf0b0, chip: "audio", access: "rw", description: "Master volume, bits 3-0 (0 silent, 15 full). Reset value 0." },

  // Input
  { name: "PAD1", addr: 0xf0c0, chip: "input", access: "r", description: "Controller 1, 1 = pressed: bit 0 Up, 1 Down, 2 Left, 3 Right, 4 A, 5 B, 6 C, 7 START. Sampled at dot 0 of line 224 (start of vertical blank) and held for the frame." },
  { name: "PAD2", addr: 0xf0c2, chip: "input", access: "r", description: "Controller 2, same layout and sampling as PAD1." },

  // System: timer and interrupt controller
  { name: "TRELOAD", addr: 0xf0d0, chip: "system", access: "rw", description: "Timer reload value. When the counter passes zero it is reloaded from TRELOAD and IF bit 2 is set." },
  { name: "TCOUNT", addr: 0xf0d2, chip: "system", access: "rw", description: "Timer counter. Decremented once per prescaled tick while enabled. Writing sets the counter directly." },
  { name: "TCTRL", addr: 0xf0d4, chip: "system", access: "rw", description: "Bit 0 timer enable; bits 2-1 prescaler: 0 = every CPU cycle, 1 = every 16, 2 = every 64, 3 = every 256 CPU cycles. Reset value 0." },
  { name: "IE", addr: 0xf0d8, chip: "system", access: "rw", description: "Interrupt enable: bit 0 VBLANK, bit 1 LINE, bit 2 TIMER. Reset value 0." },
  { name: "IF", addr: 0xf0da, chip: "system", access: "rw", description: "Interrupt pending flags, same bit layout as IE. Set by hardware whether or not enabled; writing 1 to a bit clears it. Only a word write or a write to the low byte clears bits; a byte write to the high byte is ignored." },

  // DMA
  { name: "DMASRC", addr: 0xf0e0, chip: "dma", access: "rw", description: "DMA source CPU address, bits 15-1 (bit 0 is not stored: bit 0 reads 0). Advances by 2 per word transferred, modulo 64 KiB." },
  { name: "DMADST", addr: 0xf0e2, chip: "dma", access: "rw", description: "DMA destination, all 16 bits kept: the target address is DMADST & 7FFE (VRAM), & 01FE (OAM) or & 01FF (CRAM index), depending on the DMACTL target. Advances by 2 (VRAM, OAM) or 1 (CRAM) per word, modulo 64 KiB." },
  { name: "DMALEN", addr: 0xf0e4, chip: "dma", access: "rw", description: "Number of words to transfer (0 means none). Counts down to 0 during the transfer." },
  { name: "DMACTL", addr: 0xf0e6, chip: "dma", access: "w", description: "Writing starts a transfer; bits 1-0 select the target: 1 VRAM, 2 OAM, 3 CRAM (0 does nothing). The CPU is stopped for 4 + 2 x DMALEN cycles if the transfer starts outside active display, or 4 + 4 x DMALEN if it starts during active display. Only a word write or a write to the low byte starts a transfer; a byte write to the high byte (odd address) is ignored." },
];

export const REGISTERS: readonly Register[] = R;
const byName = new Map(R.map(r => [r.name, r]));
const byAddr = new Map(R.map(r => [r.addr, r]));

export function reg(name: string): Register {
  const r = byName.get(name);
  if (!r) throw new Error(`unknown register ${name}`);
  return r;
}
export function registerAt(addr: number): Register | undefined {
  return byAddr.get(addr & 0xfffe);
}
