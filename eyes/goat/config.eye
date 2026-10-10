{
  // Domestic goat: a wide horizontal bar of a pupil in an amber iris that
  // fills nearly the whole eye, with no white showing at all. Drawn from
  // photographs; tools/make_goat_eye.py has the references and what was taken
  // from them.
  "eyeRadius": 125,
  // The iris is kept short of the eyeball rather than filling it, so the eye
  // has somewhere to travel when it looks around. Filling it looked right in
  // a still frame and moved by one pixel over 150 frames: with a bar pupil
  // spanning the iris there is nothing left to see move. At 100 the pupil
  // travels about 6 px on a 128 px eye, which is the small-amplitude shift a
  // goat actually makes -- they are grazers with a 320-340 degree field and
  // aim the head, not the eye.
  "irisRadius": 100,

  // The slit radius is measured along the slit, so this is half the pupil's
  // width. A goat's pupil reaches most of the way across the iris, which is
  // what separates it from a deer's shorter oval.
  "slitPupilRadius": 62,
  "slitPupilHorizontal": true,
  // Blunt ends: the pupil is a bar with rounded corners, not the pointed lens
  // a cat has.
  "slitPupilRounded": true,
  // The bar keeps some depth even contracted -- a goat in daylight still has
  // a visibly rectangular pupil, not a hairline.
  "pupilMin": 0.045,
  "pupilMax": 0.11,

  "eyelidColor": "0x0001",
  // Without this the eye shows the built-in back-of-eye colour, a dark red,
  // as a sliver at the rim when the gaze reaches its limit.
  "backColor": [ 0, 0, 0 ],
  // Photographed the pupil is flatly black, with none of the blue-grey a
  // deer's carries.
  "pupilColor": [ 0, 0, 0 ],

  // Adafruit's eyelid bitmaps hold the LID, painted from the edge of the
  // frame down to a curve, so both lids retract out of the eye when open and
  // the eyeball shows as a full circle. This package's hold the OPENING
  // instead -- an ellipse, so the eye keeps a goat's wide oval -- which means
  // its lids are inside the eye even wide open.
  //
  // That only works with tracking off. Tracking slides the lids with the
  // gaze, one opening as the other closes, and against an opening-shaped
  // pair it drags them across the middle of the eye. With tracking off both
  // stay at their open edges and the oval holds still; blinking is
  // unaffected.
  "tracking": false,
  // A goat holds its gaze and turns its head; it does not flick its eyes
  // around the way a cat does. This is the longest wait between movements.
  "gazeMax": 5000000,
  "irisTexture": "iris.bmp",
  "scleraTexture": "sclera.bmp",
  "upperEyelid": "upper.bmp",
  "lowerEyelid": "lower.bmp",
  "extensions": {
    "animation": {
      // A goat counter-rotates its eyes as its head goes down to graze,
      // keeping the slit level with the horizon. There is no head here, so
      // the gaze stands in for it: this is the angle at full downward gaze.
      "cyclovergence": 50
    },
    "audio": {
      "sounds": [
        "goat.wav"
      ],
      "minInterval": 15000,
      "maxInterval": 45000
    }
  },
  "left": {},
  "right": {}
}
