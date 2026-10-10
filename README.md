# Monster Eyes for the browser

Animated monster eyes that follow the mouse, for a screen or a projector. This
is a browser port of Adafruit's Monster Eyes, with some extensions: slit and
bar-shaped pupils, rolling eyeballs, flowing irises, single-eye packages and
more, all set from each package's `config.eye`.

**Try it: https://omwah.github.io/monster-eyes-web/**. That page is rebuilt
and republished from `main` on every push. It is the web version: the eyes
load as you go, and you can add eye folders of your own.

## Three versions

`python3 tools/build.py` builds all three into `dist/`. None needs internet,
an install or a web server.

| Version | What it is | For |
|---|---|---|
| **Simple**: `monster-eyes-simple.html` | One file with all 26 eyes built in (about 8 MB). It can't import eyes; it just runs | Handing to someone who wants it to work. Double-click it, copy it to a USB stick, attach it to an email |
| **Customizable**: `monster-eyes-customizable.html` | One small file (about 130 KB) with no eyes in it. You add eye folders, and the browser keeps them | Bringing your own eyes |
| **Web**: the `web/` folder | A small `index.html`, with each eye in its own file under `eyes/`. The first eye shows straight away and the rest load behind it. Built-in eyes plus importing | The website. It also works copied or unzipped as a folder: open `index.html` |

All three share the same controls; the simple version has no Add eyes….

## Using it

Open the page in Chrome, Edge or Firefox. Move the mouse to bring
up the controls. They fade out after three seconds, and so does the mouse
pointer, so the screen shows only the eyes.

| Control | Key | |
|---|---|---|
| ◀ ▶ | ← → | The previous or next eye, skipping unchecked ones |
| Eye name ▾ | | Opens the list of eyes. Click a name to show it. Uncheck an eye to leave it out of ◀ ▶ and the slideshow; All and None check or uncheck the lot, and one always stays checked. In the list, ↑ ↓ move, Space checks, Enter shows, Esc closes. Imported eyes are marked `*` when built-in ones are listed too |
| Eyes: Auto · 1 · 2 | A, 1, 2 | Auto shows one or two eyes, as each eye package prefers |
| − / + | − / +, mouse wheel | Smaller / bigger |
| Drag an eye | | Moves the pair |
| Adjust separately | S, or hold Shift | Drag and resize one eye at a time. The wheel resizes the eye under the pointer, and − / + the last eye touched, which a dashed ring marks |
| Center | C | Back to the middle, keeping each eye's size |
| Fit | 0 | Back to the fitted size and position |
| Follow | M | Eyes follow the pointer. When the pointer stops for 5 s, they go back to looking around by themselves |
| Auto-blink | B | Lets the eyes blink now and then on their own. Greyed out for eyes with no lids |
| Click an eye | Space | Blink once |
| Full screen | F | |
| | H | Hide the controls now |
| FPS | I | Frame-rate overlay: frame rate, slowest frame, time to draw the eyes, and their resolution. It stays up when the controls hide |
| Add eyes… | | Pick an eye folder, or a folder of them, from the computer. Dropping folders on the page works too |

**Slideshow.** At the bottom of the eye list, *Show each eye* sets how long
each eye stays up: Always (no slideshow), 30 s, 1, 2 or 5 minutes. *Order*
is down the list or Random, which shows every checked eye once before any
comes round again and never shows the same eye twice in a row. Eyes close
and the next ones open in their place; eyes without lids fade through black.
Only checked eyes are shown, and choosing an eye yourself restarts the
timer. While a slideshow runs, the eye button shows how long each eye stays.

For a projector, press **F** for full screen, then drag and resize the eyes
to fit the window or prop; with **Adjust separately**, each eye can have its
own size and place. The page remembers the size, position, eye choice
and settings for next time. While it is open it keeps the screen from going to
sleep.

The background is always black, which is what a projector wants. Each eye is
drawn as a whole ball, cut to a circle, so nothing but the eye throws light.

## Eye packages

A package is a directory with a `config.eye` and its bitmaps: 24-bit texture
BMPs, and 1-bit BMPs for the eyelids, the same format Adafruit's Monster Eyes
uses.
`eyes/` holds the 26 packages that are built in. To change the built-in set,
change `eyes/` and rebuild. To add eyes without rebuilding, use **Add eyes…** in
the page. Chrome keeps added eyes for next time; other browsers may forget
them when the page closes.

A package can use lids or textures kept outside its own folder. A shared
folder beside the packages works (`"upperEyelid": "../lids/upper.bmp"`), and so
does borrowing from another package in Adafruit's style
(`"upperEyelid": "demon/upper.bmp"`). The build copies those files into the
package that uses them. When adding eyes in the page, pick the folder that
holds both the eyes and the shared files; the page names any file it can't
find.

Sounds (`.wav`) are ignored, because this version is silent.

## Building

```sh
python3 tools/build.py                       # all three versions, and build/eyes-data.js
python3 tools/build.py --target simple       # or one: simple, customizable or web
```

`npm run build`, `npm run build:simple`, `npm run build:customizable` and
`npm run build:web` do the same. The build needs only the Python standard
library. `src/index.html` is the same
page unbundled and runs straight from disk once `build/eyes-data.js` exists,
which is handy while editing.

| File | |
|---|---|
| `src/eyes-assets.js` | `config.eye` parsing, BMP decoding. A port of `Eyes_Assets.cpp` |
| `src/eyes-renderer.js` | The renderer and animators. A port of `Adafruit_Monster_Eyes.cpp`; the differences are listed at its top |
| `src/app.js` | Layout, input, controls, wake lock, adding folders |
| `tools/build.py` | Builds the three versions: inlines the code, and either bundles the eyes or writes one script per eye |
| `.github/workflows/pages.yml` | Publishes the web version to GitHub Pages on every push to `main` |

No runtime dependencies, and no modules, because ES modules do not load from
`file://`.

## Testing

Everything is installed inside this directory:

```sh
npm install && npm run install-browser   # Playwright + Chromium in ./.playwright-browsers
pixi run build-sim --sim DIR             # the C++ renderer, as a reference
npm run parity                           # JS port vs C++, pixel by pixel
python3 tools/build.py && npm test       # the pages themselves
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

`npm test` opens the three builds in headless Chromium, from disk, and the web
version over http too, and checks:
- every package draws as circles on black, with the eyeball whole rather than
  cut off at the sides
- Auto / 1 / 2
- following the pointer and converging on it
- the controls hiding when idle
- dragging, separately and together
- sizing
- the wake lock
- adding folders, lids kept in another folder, and removing imported eyes
- independent sizes, Center and Fit
- the eye checklist, the slideshow and its transitions, and Auto-blink
- what each build allows: no importing in the simple build, the empty start
  of the customizable build, and the web build's first eye showing before
  the rest have loaded
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
