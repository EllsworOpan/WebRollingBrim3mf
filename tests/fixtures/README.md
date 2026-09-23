# Painted PrusaSlicer fixtures

These tiny test models are original box geometry created by `tests/painted-fixtures.ts`, covered by this repository's MIT license. They contain no user models or printer credentials.

- `painted-prusa.3mf`: two positive model parts, a negative volume, an infill modifier, a support enforcer and a support blocker. The positive parts have MMU, support, seam and fuzzy-skin painting, including partial-triangle subdivisions. Object/part overrides, three filament colors, a variable layer-height profile and a height-range override exercise settings preservation.
- `painted-instances-prusa.3mf`: the same painted multipart geometry with an additional mirrored instance, saved using PrusaSlicer's component-reference representation.

Both were saved by PrusaSlicer 2.9.6. Its CLI `--export-3mf` omits the global print profile, so the first fixture's original embedded test profile was restored afterward. Integration tests use `--save` to independently verify that PrusaSlicer loads the profile and color palette before and after our export. The profile is a generic validation fixture, not a printer preset intended for physical printing.

To reproduce, run `npm run test -- tests/painting-slicer.integration.test.ts` with PrusaSlicer installed (or set `PRUSA_SLICER`). Copy `.local/painting/baseline.3mf` and `.local/painting/instances-seed-saved.3mf` to the corresponding files here. Unit tests use these committed files on CI even without a slicer installation.

Painting encodings follow PrusaSlicer's [3MF implementation](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/libslic3r/Format/3mf.cpp) and [TriangleSelector serialization](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/libslic3r/TriangleSelector.cpp). Tests compare each encoded value with its ordered triangle corners; merely finding paint strings in the archive would not prove that painting remains on the correct face.
