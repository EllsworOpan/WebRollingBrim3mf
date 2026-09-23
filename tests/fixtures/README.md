# Native slicer fixtures

`painted-plates-bambu.3mf` and `painted-plates-orca.3mf` are original box geometry from `tests/native-fixtures.ts`, saved by Bambu Studio 2.8.2.61 and OrcaSlicer 2.4.2 respectively. They contain four plates, repeated instances, a nonprintable instance, negative volumes, triangle painting, filament assignments and object/part settings. Their generic validation profiles are for automated testing, not physical printing. They contain no user models or credentials.

Run `tests/bambu-slicer.integration.test.ts` with `BAMBU_STUDIO` and `ORCA_SLICER` pointing to the appropriate executables (or portable copies in `.local/bambu` and `.local/orca`). Copy `.local/bambu-integration-fixture.3mf` and `.local/orca-integration-fixture.3mf` here to regenerate the fixtures. Tests without installed slicers exercise both files, including whole-project exports, mesh/painting preservation and the retained core plate-extraction helper. Integration tests additionally reopen exports in both slicers and inspect G-code to verify that brim extrusion remains a single layer of walls.

## PrusaSlicer

These tiny test models are original box geometry created by `tests/painted-fixtures.ts`, covered by this repository's MIT license. They contain no user models or printer credentials.

- `painted-prusa.3mf`: two positive model parts, a negative volume, an infill modifier, a support enforcer and a support blocker. The positive parts have MMU, support, seam and fuzzy-skin painting, including partial-triangle subdivisions. Object/part overrides, three filament colors, a variable layer-height profile and a height-range override exercise settings preservation.
- `painted-instances-prusa.3mf`: the same painted multipart geometry with an additional mirrored instance, saved using PrusaSlicer's component-reference representation.

Both were saved by PrusaSlicer 2.9.6. Its CLI `--export-3mf` omits the global print profile, so the first fixture's original embedded test profile was restored afterward. Integration tests use `--save` to independently verify that PrusaSlicer loads the profile and color palette before and after our export. The profile is a generic validation fixture, not a printer preset intended for physical printing.

To reproduce, run `npm run test -- tests/painting-slicer.integration.test.ts` with PrusaSlicer installed (or set `PRUSA_SLICER`). Copy `.local/painting/baseline.3mf` and `.local/painting/instances-seed-saved.3mf` to the corresponding files here. Unit tests use these committed files on CI even without a slicer installation.

Painting encodings follow PrusaSlicer's [3MF implementation](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/libslic3r/Format/3mf.cpp) and [TriangleSelector serialization](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/libslic3r/TriangleSelector.cpp). Tests compare each encoded value with its ordered triangle corners; merely finding paint strings in the archive would not prove that painting remains on the correct face.

## PrusaSlicer 3.0.0-alpha12

- `box-prusa3-alpha12.3mf`: original 20 × 20 × 10 mm box, saved by the official alpha12 CLI with its bundled Prusa MINI 0.4, 0.20mm STRUCTURAL and Prusament PLA profiles.
- `painted-plates-prusa3-alpha12.3mf`: the same original box geometry, assembled by `prusa3Fixture` in `tests/prusa3-fixtures.ts`, then saved by alpha12. It has two MINI beds and one CORE One bed with a different first-layer height. It includes all five volume roles, shared meshes, all four painting channels with partial-face subdivisions, a mirrored/nonuniformly scaled instance, a nonprintable copy, object/volume overrides and bed-specific custom G-code.

These are development fixtures; they contain bundled slicer preset data and no user models, credentials or profiles. Original source paths were replaced with `original-box.stl`. The fixture geometry is original to this repository. The executable and full preset distribution are not committed.

To regenerate, use alpha12 with a separate `--datadir` and create MINI and CORE One box seeds using `--export-3mf --dont-arrange --no-ensure-on-bed`, selecting the bundled printer/print/material profiles. For the CORE seed use `Prusa CORE One 0.4 HF`, `0.15mm STRUCTURAL @COREONE 0.4HF` and `Prusament PLA @COREONE HF0.4@COREONE 0.4`. Pass both seed archives to `prusa3Fixture`, then open/save its output using the same CLI flags. Keep resources in dependency order and scrub source file paths before committing. Alpha12 normalizes bed origins and updates object placement on save; the saved fixture intentionally tests the slicer's native result.

Unit tests always exercise these committed fixtures. Set `PRUSA_SLICER3` to alpha12 (or use `.local/prusa3/PrusaSlicer-3.0.0-alpha12/PrusaSlicer.exe`) to enable `tests/prusa3-slicer.integration.test.ts`. It reopens whole projects and extracted beds, verifies native settings/painting/placement, then checks actual perimeter-only brim extrusion at two heights and with physical, blend and gradient material assignments. It writes only to ignored `.local/prusa3-validation/` and uses its own profile store.

- `multimaterial-xl-prusa3-alpha12.3mf`: native Prusa XL 2T profile, two material slots, two beds, physical material 2, a 25%/75% blend and a three-stop gradient. Shared geometry includes mirrored/nonuniform and nonprintable instances, partial-face painting, wipe towers, a custom purge matrix and bed-specific G-code.
- `multimaterial-mmu-prusa3-alpha12.3mf`: equivalent geometry using Prusa MK4S MMU3, one nozzle and five material slots. Unused material slots and the full purge matrix are intentional preservation cases.

To regenerate these two fixtures, create a native box seed with the isolated alpha12 CLI. The XL seed uses printer profile `Prusa XL 2T 0.4, 0.4`, print profile `0.20mm`, tool-print profile `0.20mm STRUCTURAL @XL 0.4`, and material profile `Prusament PLA @XL 0.4`. The MMU seed uses `Prusa MK4S MMU3 0.4`, `0.20mm STRUCTURAL @MK4S 0.4` and `Prusament PLA @MK4S 0.4`. Pass each seed to `multiMaterialFixture` in `tests/prusa3-multimaterial-fixtures.ts`, then save the result through alpha12 with `--export-3mf --dont-arrange --no-ensure-on-bed`. Painting hex encodings must be uppercase, as required by the native annotation loader.
