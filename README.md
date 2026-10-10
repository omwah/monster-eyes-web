# Monster Eyes for the browser

Animated monster eyes that follow the mouse, for a screen or a projector. This
is a browser port of Adafruit's Monster Eyes, with some extensions: slit and
bar-shaped pupils, rolling eyeballs, flowing irises, single-eye packages and
more, all set from each package's `config.eye`.

**The finished thing is one file: `dist/monster-eyes.html`.** It holds the
code and all 26 eye packages. Double-click it, or copy it to a USB stick or
attach it to an email. It needs no internet, no install and no web server.

## Using it

Open `monster-eyes.html` in Chrome, Edge or Firefox. Move the mouse to bring
up the controls. They fade out after three seconds, and so does the mouse
pointer, so the screen shows only the eyes.

| Control | Key | |
|---|---|---|
| ◀ / list / ▶ | ← → | Choose the eyes |
| Eyes: Auto · 1 · 2 | A, 1, 2 | Auto shows one or two eyes, as each eye package prefers |
| − / + | − / +, mouse wheel | Smaller / bigger |
| Fit | 0 | Back to filling the screen, centred |
| Drag an eye | | Moves the pair. With **Move separately** on (S), or holding Shift, it moves one eye |
| Follow | M | Eyes follow the pointer. When the pointer stops for 5 s, they go back to looking around by themselves |
| Click an eye, Blink | Space | Blink |
| Full screen | F | |
| | H | Hide the controls now |
| FPS | I | Frame-rate overlay: frame rate, slowest frame, time to draw the eyes, and their resolution. It stays up when the controls hide |
| Add eyes… | | Pick an eye folder, or a folder of them, from the computer. Dropping folders on the page works too |

For a projector, press **F** for full screen, then drag and resize the eyes
to fit the window or prop. The page remembers the size, position, eye choice
and settings for next time. While it is open it keeps the screen from going to
sleep.

The background is each package's eyelid colour. Most packages are black; Anime,
for one, is a skin tone.

## Eye packages

A package is a directory with a `config.eye` and its bitmaps: 24-bit texture
BMPs, and 1-bit BMPs for the eyelids, the same format Adafruit's Monster Eyes
uses.
`eyes/` holds the 26 packages that are built in. To change the built-in set,
change `eyes/` and rebuild. To add eyes without rebuilding, use **Add eyes…** in
the page. Chrome keeps added eyes for next time; other browsers may forget
them when the page closes.

Sounds (`.wav`) are ignored, because this version is silent.

## Building

```sh
python3 tools/build.py        # -> dist/monster-eyes.html, and build/eyes-data.js
```

The build needs only the Python standard library. `src/index.html` is the same
page unbundled and runs straight from disk once `build/eyes-data.js` exists,
which is handy while editing.

| File | |
|---|---|
| `src/eyes-assets.js` | `config.eye` parsing, BMP decoding. A port of `Eyes_Assets.cpp` |
| `src/eyes-renderer.js` | The renderer and animators. A port of `Adafruit_Monster_Eyes.cpp`; the differences are listed at its top |
| `src/app.js` | Layout, input, controls, wake lock, adding folders |
| `tools/build.py` | Inlines everything into the single HTML file |

No runtime dependencies, and no modules, because ES modules do not load from
`file://`.

## Testing

Everything is installed inside this directory:

```sh
npm install && npm run install-browser   # Playwright + Chromium in ./.playwright-browsers
pixi run build-sim --sim DIR             # the C++ renderer, as a reference
npm run parity                           # JS port vs C++, pixel by pixel
python3 tools/build.py && npm test       # the page itself, over file://
```

`DIR` is the source directory of `eye-sim`, the desktop build of a C++ fork of
Monster Eyes that the port was made from: the directory with its
`CMakeLists.txt`. Setting `MONSTER_EYES_SIM` to it works too. Nothing in that
checkout is written to; the build goes to `vendor/`. To use an `eye-sim` built
somewhere else, set `EYE_SIM` to its path when running the parity test.

`npm run parity` renders every package with both renderers and compares the
frames in RGB565: four fixed gaze and pupil states each, plus 60 frames of
seeded animation with blinks, saccades, pupil noise, spin and iris flow. In
this mode the port draws at the C++ renderer's sizes, a 128 px pair or a 240 px
single eye, and matches it exactly. All 26 packages are currently
pixel-identical.

`npm test` opens `dist/monster-eyes.html` from disk in headless Chromium and
checks:
- every package draws, on its own background colour
- Auto / 1 / 2
- following the pointer and converging on it
- the controls hiding when idle
- dragging, separately and together
- sizing
- the wake lock
- adding folders
- that two eyes at 1920×1080 hold 60 fps

Chromium needs some system libraries. If it will not start, run
`sudo PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npx playwright install-deps chromium`.

## Performance

Each eye is drawn on the CPU into its own canvas, at up to 512 px, and the
browser scales it to the size on screen. Two 512 px eyes take a few
milliseconds a frame. If a machine cannot keep up, the page lowers the
resolution by itself.

## Licence and credits

MIT; see [`LICENSE`](LICENSE). The renderer is ported from Adafruit's Monster
Eyes (MIT, Adafruit Industries), and the extensions and the browser app are
MIT as well.

The eye artwork:

- `anime`, `big_blue`, `demon`, `doom-red`, `doom-spiral`, `fish_eyes`,
  `fizzgig`, `hypno_red`, `reflection`, `skull`, `snake_green`, `spikes` and
  `toonstripe` are Adafruit's, from
  [M4_Eyes](https://github.com/adafruit/Adafruit_Learning_System_Guides/tree/main/M4_Eyes/eyes)
  (MIT), resized and reprojected.
- `cat`, `dragon`, `hazel`, `nauga`, `newt`, `no_sclera`, `owl` and
  `terminator` come from [Uncanny Eyes](https://github.com/adafruit/Uncanny_Eyes)
  by Phil Burgess for Adafruit (MIT).
- `big_anime`, `deer`, `goat`, `pomni` and `sauron` are original to this
  project, under its MIT licence.

The browser app plays no sound, but the packages keep their `.wav` files so
that they stay complete:

| Package | Sound | Licence |
|---|---|---|
| `big_anime` | [Shimmer glitter magic](https://opengameart.org/content/shimmer-glitter-magic), by The Berklee College of Music (submitted by qubodup) | CC BY 3.0 |
| `cat` | [Cat Purr & Meow](https://opengameart.org/content/cat-purr-meow) | CC0 |
| `deer` | [Animal or beast sounds](https://opengameart.org/content/animal-or-beast-sounds) | CC0 |
| `dragon` | [80 CC0 creature SFX #2](https://opengameart.org/content/80-cc0-creture-sfx-2) | CC0 |
| `fizzgig` | Adafruit's M4_Eyes `fizzgig` package | MIT |
| `goat` | [Goat bleat](https://opengameart.org/content/goat-bleat) | CC BY 4.0 |
| `nauga` | [sound-cc0](https://github.com/code4fukui/sound-cc0) | CC0 |
| `newt` | [Frog Croaks](https://opengameart.org/content/frog-croaks) | CC0 |
| `no_sclera` | [80 CC0 creature SFX #2](https://opengameart.org/content/80-cc0-creture-sfx-2) | CC0 |
| `owl` | [Google Assistant Sound Library, Owl Hooting](https://actions.google.com/sounds/v1/animals/owl_hooting.ogg) | Google sound-library terms |
| `terminator` | [sound-cc0](https://github.com/code4fukui/sound-cc0) | CC0 |
