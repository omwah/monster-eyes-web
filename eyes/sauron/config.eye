{
  // The Eye of Sauron: a black upright slit in a wheel of fire, with the
  // flames reaching straight out from the pupil and the sides of the eye
  // burning a much deeper red than its top and bottom. Artwork is generated
  // by tools/make_sauron_eye.py.
  "eyeRadius": 125,
  // The fire fills the eye; the sclera is only the dying ember at its rim.
  "irisRadius": 124,

  // An upright pointed slit, as a cat's is, which is the shape the pupil
  // holds in every frame of the reference. slitPupilRadius is measured along
  // the slit, so this is half the pupil's height.
  "slitPupilRadius": 80,
  "slitPupilHorizontal": false,
  "slitPupilRounded": false,
  // A narrow range, and a slow one: the fire breathes in and out a little
  // rather than the pupil visibly dilating. Widening the pupil also stretches
  // the iris texture outwards, which reads as the flames surging.
  "pupilMin": 0.04,
  "pupilMax": 0.07,

  "pupilColor": [ 0, 0, 0 ],
  // Nothing behind or beside the eye: the fire should float in the dark.
  "backColor": [ 0, 0, 0 ],
  "eyelidColor": "0x0000",

  // Texture column 0 sits at the top of the screen, which is what puts the
  // cool, dark red part of the fire at the left and right of the pupil where
  // the generator drew it.
  "irisAngle": 0,
  "scleraAngle": 0,
  // The flames emerge; they never go round. Both textures are nailed down.
  "irisSpin": 0.0,
  "scleraSpin": 0.0,

  // The fire moves outward instead. Each pixel is sampled a little nearer or
  // further from the pupil than it sits, on a wave travelling out from the
  // pupil, so heat drawn at one depth in the texture appears at another and
  // the flames lick outward. Sectors are out of step with each other, so the
  // crests do not arrive as one ring.
  "irisFlow": 0.16,
  "irisFlowSpeed": 1.3,
  "irisFlowWaves": 1.7,

  "irisTexture": "iris.bmp",
  "scleraTexture": "sclera.bmp",

  // No eyelid bitmaps, deliberately. A missing lid loads as "fully out of the
  // way" for both its open and its closed position, so the blink timer moves
  // nothing and the Eye never closes. Tracking only slides the lids, so with
  // no lids it has nothing to do either.
  "tracking": false,

  // One eye filling the panel rather than two side by side. There is only one
  // Eye of Sauron, and the artwork is worth the whole screen.
  "extensions": {
    "display": {
      "singleEye": true
    }
  },

  "left": {},
  "right": {}
}
