{
  // Sika doe: a wide horizontal pupil in a dark brown iris that fills most of
  // the eye, with almost no sclera showing.
  "eyeRadius": 125,
  "irisRadius": 112,

  // The slit radius is measured along the slit, so this is half the pupil's
  // width rather than half its height. Kept well short of the iris, with
  // pupilMax deepening the bar, so the pupil reads as a rounded oval rather
  // than the long lens a goat or a cat has.
  "slitPupilRadius": 54,
  "slitPupilHorizontal": true,
  // Blunt ends: a deer's pupil is a bar, not the pointed lens
  // a cat has.
  "slitPupilRounded": true,
  "pupilMin": 0.05,
  "pupilMax": 0.11,

  "eyelidColor": "0x0001",
  // Without this the eye shows the built-in back-of-eye colour, a dark red,
  // as a sliver at the rim when the gaze reaches its limit.
  "backColor": [ 0, 0, 0 ],
  // Photographed the pupil is a dark blue-grey, not black.
  "pupilColor": [ 20, 25, 33 ],

  // Adafruit's eyelid bitmaps hold the LID, painted from the edge of the
  // frame down to a curve, so both lids retract out of the eye when open and
  // the eyeball shows as a full circle. This package's hold the OPENING
  // instead -- an ellipse, so the eye keeps a deer's oval shape -- which
  // means its lids are inside the eye even wide open.
  //
  // That only works with tracking off. Tracking slides the lids with the
  // gaze, one opening as the other closes, and against an opening-shaped
  // pair it drags them across the middle of the eye: at the default squint
  // the upper lid cut the eye in half, and at squint 0 the lower lid did.
  // With tracking off both stay at their open edges and the oval holds
  // still; blinking is unaffected.
  "tracking": false,
  "irisTexture": "iris.bmp",
  "scleraTexture": "sclera.bmp",
  "upperEyelid": "upper.bmp",
  "lowerEyelid": "lower.bmp",
  "extensions": {
    "audio": {
      "sounds": [
        "deer.wav"
      ],
      "minInterval": 15000,
      "maxInterval": 45000
    }
  },
  "left": {},
  "right": {}
}
