# PrusaSlicer 3 project compatibility

Experimental native import and **whole-project export** for `3.0.0-alpha12`,
released September 21, 2026; verified September 23. Other 3.x versions are
detected and rejected until validated.

## Format and preservation

Prusa 3 keeps ZIP packaging and core 3MF geometry. Its main differences are the
metadata and object hierarchy:

| Concern | Prusa 2.x | Prusa 3.0 alpha12 |
|---|---|---|
| Part roles/overrides | XML volume triangle ranges | JSON object and volume resource IDs |
| Configuration | One legacy profile | Configuration containers with presets and beds |
| Bed placement | Existing project-wide workflow | Explicit XY origins; spatial object membership |
| Painting | Attributes on original triangle corners | Volume-ID annotations plus core triangle attributes |
| Instance printability | Legacy build attributes | JSON records with global build-item `ord` |
| Tools/materials | Legacy settings | Hardware/material descriptors and optional virtual-extruder recipes |

The hierarchy is mesh → volume wrapper → parent object → build instance.
Original meshes and ordered triangle corners remain unchanged. Export appends a
brim in the parent's coordinates and sets zero elephant-foot compensation on
printable parents and positive model volumes. Other settings remain untouched.
Nonprintable instances keep their original compensation.

Bed metadata is copied unchanged without assigning objects to beds or clipping
brims. All printable objects appear at their stored positions, and the
download retains every bed and configuration group. Checkboxes control only
which objects get new brim parts. The original archive remains the checkpoint
for every preview and export.

Original IDs are retained for the first instance of a parent. Repeated instances
receive separate wrappers when exporting independent brims; volume IDs,
painting references and printability ordinals follow those wrappers. Mesh data
is shared. New resources precede references to them, as required by alpha12.
Stale thumbnails are removed. Unrelated archive entries are copied.

## Tools, materials and virtual extruders

Multiple nozzles, MMU slots, material assignments, purge matrices, wipe towers,
bed custom G-code and virtual-extruder definitions are opaque preserved data.
The app does not renumber material slots, rebuild profiles or interpret blend
and gradient recipes. A new brim inherits its parent's material assignment;
existing painted colors stay on the original model rather than being projected
onto the brim. XL and MMU fixtures exercise these cases.

First-layer height is suggested only when the stored bed/tool values agree and
are supported absolute heights. Otherwise the app asks the user to match the
height manually. It does not alter print profiles. Wipe towers and painting are
not rendered, and wipe-tower clearance is left to inspection in the slicer.

## Compatibility boundary

Detection requires the exact Application tag `PrusaSlicer-3.0.0-alpha12` plus
compatible geometry and reference structures. `project.version` is a save
revision, not a schema version. Changing the Application tag is not conversion.
Prusa 3 markers prevent fallback to a generic mesh-only import.

Validation covers the data the app needs to read or modify: valid meshes,
transforms, known volume roles, resource/volume references, painting volume IDs,
instance printability and configuration fields needed for height suggestions and
unsupported print modes. Bed geometry is not interpreted. Full brims may extend
off a bed; placement and clearance checks belong in the slicer.

Unfamiliar print/object/volume settings, painting payloads and unrelated archive
sidecars are preserved. There is no full settings schema or virtual-extruder
parser. The app is not a validator for every possible source setting.

Unsupported: other version tags, changed object/volume hierarchy, external model
resources, required 3MF extensions, forward/cyclic references, SLA, vase mode,
and rafts. Additional
object/volume structures (for example height ranges or editable text metadata)
remain rejected until their effect on touched references/settings is understood.

Native Prusa 3 output requires supported native input. Generic mesh output uses
the existing Prusa 2.x, Bambu Studio or OrcaSlicer adapters.

## Validation

Committed native fixtures cover MINI and CORE One beds with different heights,
all five volume roles, shared meshes, scaled/mirrored/nonprintable instances,
painting, XL multi-tool profiles, MMU slots, blends, gradients, purge matrices and
wipe towers. See [fixture provenance](../tests/fixtures/README.md).

Tests check whole-project round trips, exact configuration preservation, original
mesh/painting retention, full brims crossing bed edges, unknown settings/sidecars
and exports from an unchanged source. Single and shared instances cover scales,
mirrors, rotations and X/Y tilts, with independent decoding of exported geometry
and native slicer reopening. No plate-selection or extraction path remains.

Set `PRUSA_SLICER3` to alpha12, or place the portable executable at
`.local/prusa3/PrusaSlicer-3.0.0-alpha12/PrusaSlicer.exe`, then run:

```powershell
npm run test -- tests/prusa3-slicer.integration.test.ts
```

Integration tests use their own `.local/prusa3-validation/data` profile store.
They reopen whole projects and compare beds, configuration, material recipes,
roles, settings and placement. Additional tests inspect actual first-layer brim
extrusion at different heights and with physical/virtual material assignments.
Without the executable, native tests are explicitly skipped; fixture tests run.

## References

- [Alpha12 release](https://github.com/prusa3d/PrusaSlicer/releases/tag/version_3.0.0-alpha12)
- [Project serializer](https://github.com/prusa3d/PrusaSlicer/blob/version_3.0.0-alpha12/src/slic3r-shared/src/Slic3r/Biz/Format/3mf/PrusaFile.cpp)
- [Core model serializer](https://github.com/prusa3d/PrusaSlicer/blob/version_3.0.0-alpha12/src/slic3r-shared/src/Slic3r/Biz/Format/3mf/Model3mf.cpp)
- [Bed assignment](https://github.com/prusa3d/PrusaSlicer/blob/version_3.0.0-alpha12/src/slic3r-shared/src/Slic3r/Biz/Scene/BedTracking.cpp)
- [Virtual-extruder serialization](https://github.com/prusa3d/PrusaSlicer/blob/version_3.0.0-alpha12/src/slic3r-shared/src/Slic3r/Biz/Format/VirtualExtruder.cpp)
