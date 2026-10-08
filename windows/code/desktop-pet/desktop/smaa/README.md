SMAA 1x Medium WebGL port adapted from three.js r180 (MIT):
https://github.com/mrdoob/three.js/blob/r180/examples/jsm/shaders/SMAAShader.js
https://github.com/mrdoob/three.js/blob/r180/examples/jsm/postprocessing/SMAAPass.js
Original algorithm: https://github.com/iryoku/smaa/releases/tag/v2.8

Local changes: raw WebGL fullscreen vertex attributes, alpha-aware color edge detection, and premultiplied RGBA neighborhood blending without gamma conversion. The pet uses a resolved 4x SSAA source, box downsamples to physical display resolution, then applies the three SMAA passes. Lookup PNGs are embedded as in the upstream pass. No three.js runtime dependency.
