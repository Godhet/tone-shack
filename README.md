# Tone Shack 🎸

A tiny, no-install browser guitar amp + practice tool. Plug a guitar into your
audio interface, open the site, hit **POWER ON**, and play — everything runs
in the browser with the Web Audio API. No backend, no downloads.

**Live:** https://godhet.github.io/tone-shack/

## Features
- **Amp** — instant headphone monitoring with curated presets (Oasis acoustic,
  Oasis electric, AC/DC crunch). Draggable knobs: Gain, Bass, Mid, Treble,
  Reverb, Level.
- **Learn**
  - **Tuner** — pluck a string, get the note + how sharp/flat you are.
  - **Chords** — shows a chord, listens to you play it, and auto-advances
    when it hears it (D → G → C → Em).
  - **Scales** — fretboard maps for minor pentatonic, blues, and major
    pentatonic in any key, with root notes marked and the classic first
    box highlighted.

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

## License
Licensed under the [GNU GPL v3.0](LICENSE). You're free to use, modify, and
share it — but distributed derivatives must stay open-source under the same
license.
