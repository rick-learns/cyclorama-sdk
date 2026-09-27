# Trademark policy

The Cyclorama machine is open: anyone may implement it, write software for it and
distribute that software. The **brand** is not open. This policy says what that means
in practice. It exists so players can always tell the official Cyclorama products from
community ones, and so the community can build freely without fear.

This is a policy statement, not legal advice. Nothing here has been registered yet. Marks are claimed as unregistered marks (™)
until registrations issue.

## What is claimed

In connection with video games, game software, emulators, game consoles and
accessories, development tools, printed matter, and entertainment services:

- **Names:** AVENELL™, CYCLORAMA™, AVENELL CYCLORAMA™, and OFFICIAL CYCLORAMA™.
- **Logos and wordmarks:** the Avenell and Cyclorama logos and the stylised
  AVENELL CYCLORAMA wordmark, in any colour, including pixel renderings on the console.
- **The Curtain Up sequence:** the spotlight-sweep splash over the wordmark and its
  signature chime (visual and sound identity), as implemented in the Curtain Up source
  (`curtainup.inc`, which is not part of the open SDK) and as recorded in any medium.
- **Trade dress:** the distinctive look of official products: packaging layout, the
  cartridge shell and label design, the official app's shelf/museum presentation, and
  the HED-0041 manual's cover design.

Fictional in-world names (Tally, Barndoor, Cue, SCRIM, Avenell Playhouse, Erg and
other characters) are protected as part of the copyrighted fiction and may be claimed
as marks later. Plain technical words used by the spec (such as "light field" or
"shade plane") are **not** claimed; use them freely.

## What you MAY do (no permission needed)

- **Build compatible things.** Write emulators, assemblers, compilers, debuggers,
  hardware (FPGA) re-implementations, tools and games for the Cyclorama architecture,
  under the open licences.
- **Say what they are compatible with, in plain text.** For example:
  - "Compatible with the Cyclorama architecture"
  - "Runs Cyclorama ROMs"
  - "A homebrew game for the Cyclorama"
  - "An emulator for the Avenell Cyclorama fantasy console"

  Use ordinary type, no logos, and no more of the name than you need to say it
  (nominative fair use). The product's own name must come first and be more
  prominent.
- **Talk about it.** Reviews, videos, streams, articles, teaching, speedruns, fan art
  and commentary may use the names to refer to the platform and its official games.
- **Redistribute unmodified official open releases** (for example the reference
  player or conformance suite) under their own names, as long as you do not suggest
  you are the official source.
- **Use the open SDK** (except Curtain Up) inside your ROMs.

## What you may NOT do (without a written licence)

- Call your product, build, service or event **"official"**, "authorised",
  "certified" or "licensed" Cyclorama, or imply endorsement or partnership.
- Use **"Cyclorama" or "Avenell" as the first or dominant part of your product,
  company, domain, app or channel name** (e.g. "Cyclorama Emu", "CycloramaBox"). A
  name like "YourGame: a homebrew game for the Cyclorama" is fine.
- Use the **logos, wordmark, or trade dress**, or anything confusingly similar, on
  products, packaging, store pages, app icons or cartridge labels.
- **Display the Curtain Up splash or play its chime** in unofficial software.
  Homebrew may show its own splash. (A neutral "your studio here" splash example is planned
  for a later SDK release.)
- Sell physical goods (cartridges, boxes, manuals, apparel, posters) bearing the marks.
- Register domains, social handles or trademarks containing the marks.
- Present modified versions of the spec or manual as the official version. CC BY 4.0
  lets you adapt the text. Label adaptations clearly as unofficial and say what
  changed.

### Why homebrew may not display Curtain Up (and why that stays harmless)

In the fiction, Avenell's licensing terms required licensed cartridges to open with
Curtain Up. Community cartridges without it are therefore "unlicensed carts". That is
honest, in-world, and a nice bit of flavour.

The rule protects the splash as a **badge of origin**. It never works as a lock-out:

- The Cyclorama has no boot ROM. The console, the reference emulator and the official
  app **must never check for, require, or reward the splash**, or any other trademark,
  in order to boot or run a ROM. This is a permanent design rule.
- Precedent: in *Sega Enterprises Ltd. v. Accolade, Inc.* (9th Cir. 1992), Sega's
  console displayed a Sega trademark message when a cartridge contained the code its
  security check looked for. The court held that disassembly for compatibility was fair
  use. It also held that Sega could not hold Accolade responsible for a trademark
  display Sega's own system caused. We avoid that design entirely, so the brand
  never becomes a technical barrier to compatibility.

## "Official Cyclorama" certification (future)

When a community marketplace launches, a cartridge may be
licensed to carry the **Official Cyclorama** badge and to open with **Curtain Up**.
Certification would require:

1. **Technical:** valid ROM header; passes budget report (capacity, CPU, sprites,
   voices) on the reference toolchain; deterministic completion replay supplied; no
   crashes in automated smoke tests; byte-identical rebuild from the submitted source
   (source held privately under agreement), or a reproducible binary hash.
2. **Content:** original work with clear rights; no real-world brands inside the
   Cyclorama fiction; age-rating survey completed; player instructions.
3. **Agreement:** a trademark licence with usage guidelines and a marketplace
   distribution agreement.

Certification marks a cartridge. It is **never** DRM. Uncertified ROMs run identically
everywhere, including in the official app.

## Reporting and permissions

Ask before you assume. Requests for permission and reports of misuse go to
hello@playcyclorama.com. We would rather grant a licence than send a complaint.
