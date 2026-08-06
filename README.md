# Tone Shack 🎸

A tiny, no-install browser guitar amp + practice tool. Plug a guitar into your
audio interface, open the site, hit **POWER ON**, and play — everything runs
in the browser with the Web Audio API. No backend, no downloads.

**Live:** https://godhet.github.io/guitar-amp/

## Features
- **Amp** — instant headphone monitoring with curated presets (Oasis acoustic,
  Oasis electric, AC/DC crunch). Draggable knobs: Gain, Bass, Mid, Treble,
  Reverb, Level.
- **Learn**
  - **Tuner** — pluck a string, get the note + how sharp/flat you are.
  - **Chord Trainer** — shows a chord, listens to you play it, and
    auto-advances when it hears it (D → G → C → Em).

## Running locally
Because browsers only grant mic access over HTTPS or `localhost`, serve it —
don't just open the file:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Notes
- Tone is shaped entirely with Web Audio nodes (waveshaper drive + EQ-based
  cabinet sim + convolver reverb). No external impulse-response files needed.
- The input's echo-cancellation / noise-suppression / auto-gain are disabled on
  purpose — those "features" mangle guitar tone.
