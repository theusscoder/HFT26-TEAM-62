// ---------------------------------------------------------------------------
// Provisional palette — extracted programmatically from the approved Pinterest
// references (colour histograms, not visual inspection). NOT FINAL until the
// references are visually verified. All scene colours live here.
//
//   ref1 (composition): midnight-blue panorama #081828, slate-lavender city
//   cluster #5D5574..#665470, steel-blue glow #15406A..#084878.
//   ref2 (primary palette): charcoal-teal field #080C0C..#081818, desaturated
//   mint/teal glow #48706C..#577C85, near-black vignette.
// ---------------------------------------------------------------------------

export const palette = {
  page: '#0a0e0f',
  sceneBackground: '#0b1214',
  fog: '#0d161a',

  terrainTopLow: '#152226', // lower ground
  terrainTopHigh: '#2b4247', // higher ground (subtle relief shading)
  terrainSideTop: '#132023', // slab skirt walls — upper stratum (just below the rim)
  terrainSideBottom: '#080e11', // slab skirt walls — lower stratum (dark base)
  terrainBottom: '#070c0d', // slab underside
  undersideDeep: '#04080a', // deepest underside facets (towards the cap)
  underGlow: '#163a44', // glow beneath the floating slab
  rimGlow: '#4d8494', // emissive perimeter ribbon (cool teal/blue-white)

  water: '#123844',
  park: '#26352c',

  road: '#9db1b5', // major roads — pale desaturated ribbon
  roadMinor: '#5d7278', // residential / service

  buildingWalls: ['#333f42', '#3a484c', '#374541', '#303d40', '#47565c', '#2c3639'],
  buildingRoofLighten: 0.42, // roofs = wall colour lightened by this factor
  accentTeal: '#48706c', // glass accent (reserved for landmark towers, Phase 3)

  marker: '#f43f5e', // accident markers (Phase 4)

  hudText: 'rgba(255, 255, 255, 0.85)',
} as const