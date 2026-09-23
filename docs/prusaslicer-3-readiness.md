# PrusaSlicer 3 project compatibility

Status: **experimental native import and selected-bed export for 3.0.0-alpha12**.
Baseline: `version_3.0.0-alpha12`, released September 21, 2026; verified September 23.
Other 3.x versions are detected and rejected until explicitly validated.

## Format differences

Prusa 3 retains the ZIP package and core 3MF meshes/components/build placements.
The meaningful changes are in the project metadata around those meshes:

| Concern | Prusa 2.x | Prusa 3.0 alpha12 |
|---|---|---|
| Part roles and overrides | `Slic3r_PE_model.config`, XML volume triangle ranges | `PrusaSlicer3_project.json`, object and volume resource IDs, typed overrides |
| Configuration | `Slic3r_PE.config`, one legacy profile | `config_containers` with independent configurations, presets and beds |
| Bed placement | No selectable-bed interpretation in this app | Explicit XY origins; the slicer determines object membership spatially |
| Painting | Attributes on original triangle corners | `Slic3r_facets_annotation.json`, keyed by volume resource ID and triangle index; MMU paint also appears in core triangles |
| Instance printability | Legacy build attributes | JSON instance records use zero-based global build-item `ord` |
| Per-tool settings | Legacy strings/scalars | Typed JSON values, with nullable per-tool overrides of print settings |

The model hierarchy is mesh resource → volume wrapper → parent object → build
instance. Export preserves the original mesh resources and their triangle order,
clones wrappers/parents per instance, and remaps metadata and painting IDs.
New brim meshes remain separate. Referenced resources precede their users, as
required by core 3MF and alpha12's loader.

`project.version` is an incrementing save revision, **not** a schema identifier.
Compatibility checks use the exact Application value `PrusaSlicer-3.0.0-alpha12`
plus structural validation. Changing the Application tag alone is not conversion.

Sources: [3.0 announcement](https://blog.prusa3d.com/prusaslicer-3-0-preview-built-for-the-future-of-3d-printing_137672/),
[alpha12 release](https://github.com/prusa3d/PrusaSlicer/releases/tag/version_3.0.0-alpha12),
[project serializer](https://github.com/prusa3d/PrusaSlicer/blob/version_3.0.0-alpha12/src/slic3r-shared/src/Slic3r/Biz/Format/3mf/PrusaFile.cpp),
[core model serializer](https://github.com/prusa3d/PrusaSlicer/blob/version_3.0.0-alpha12/src/slic3r-shared/src/Slic3r/Biz/Format/3mf/Model3mf.cpp),
[bed assignment](https://github.com/prusa3d/PrusaSlicer/blob/version_3.0.0-alpha12/src/slic3r-shared/src/Slic3r/Biz/Scene/BedTracking.cpp),
[typed configuration](https://github.com/prusa3d/PrusaSlicer/blob/version_3.0.0-alpha12/src/slic3r-shared/src/Slic3r/Biz/Config/ConfigJson.cpp).

## Supported subset

- Native alpha12 projects with single-tool, single-material FFF configurations.
- Multiple nonoverlapping rectangular beds, including different printer profiles
  and first-layer heights across configuration groups.
- Objects wholly contained in exactly one bed. The selected bed's origin is
  subtracted from placements without arranging, rotating or grounding objects.
- Repeated, scaled, rotated, mirrored and nonprintable instances.
- Positive parts, negative volumes, parameter modifiers, support enforcers and
  support blockers, with recognized object and volume overrides.
- Color, support, seam and fuzzy-skin painting using known annotation versions.
  Painting is retained on its original ordered triangle corners.
- Selected-bed custom layer G-code, full effective configuration and opaque
  preset descriptors. Preset feature dictionaries are vendor-defined data;
  they are preserved without interpreting their keys.

The plate picker uses a stable flattened bed order and identifies each bed's
printer. Each import/selection/export starts from the unchanged upload. Export
contains only the selected bed and all its instances, including unchecked and
nonprintable ones. Checkboxes choose which printable instances receive brims.
Bed controls are shared; there is no combined multi-bed edited export.

Export retains the selected configuration group and removes other beds, unused
resources and the stale thumbnail. It applies native typed settings to new brim
volumes. Elephant-foot compensation is set to zero on printable parents and
positive model volumes (whose overrides otherwise take precedence). Nonprintable
instances retain their compensation. The global profile is unchanged.

Prusa 2.9 also has multiple beds, but this app does not currently offer plate
selection for Prusa 2.x projects. Prusa 3 does not use Bambu's regular plate grid.
Our wholly-contained-object rule is deliberately narrower than Prusa's full
collision-based bed assignment and never guesses the nearest bed.

## Rejection boundary

Prusa 3 project/painting markers take precedence over legacy/Bambu metadata. An
Application value identifying PrusaSlicer 3 or newer also prevents generic
fallback. Unsupported inputs fail before brim generation, with a reason.

The adapter rejects other version tags, missing or changed structural data,
unknown configuration keys/types/enums, unknown XML elements/attributes, additional
archive entries, external model resources/3MF extensions, invalid references,
forward/cyclic components, unsupported painting versions or invalid facet indices.

Currently unsupported features include SLA, multiple tools/materials, virtual
extruders, wipe towers, vase mode, rafts, nonrectangular or overlapping beds,
objects outside/across beds, variable layer-height profiles, height ranges, cut
information and editable text/embossing metadata. Such a feature anywhere in the
project rejects the project, even if another bed would otherwise be usable.

These checks bound the supported alpha format; they cannot predict a semantic
change made without a version or structure change. A future release requires new
native fixtures and integration validation before widening the version gate.
Native Prusa 3 output requires native Prusa 3 input. The generic mesh workflow's
Prusa output remains 2.x; cross-slicer profile conversion is not provided.

## Code and schema provenance

`three-mf.ts` validates archive boundaries and routes import, selection and
export through explicit dialect adapters. `prusa-3mf.ts` contains the existing
2.x/generic implementation, `bambu-3mf.ts` the Bambu/Orca implementation, and
`prusa3-3mf.ts` the alpha12 implementation. The worker and brim engine use the same
selected-plate project contract. No rolling-circle or geometry algorithm changed.

`prusa3-config.ts` validates alpha12's typed settings against
`prusa3-schema.json`. The latter contains setting names, types, enums, override
scopes and nullability extracted from the official executable's schema; it does
not contain slicer implementation code, configuration values or user profiles.
To regenerate with that exact executable and an isolated data directory:

```powershell
& $env:PRUSA_SLICER3 --datadir .local/prusa3-schema-data --export-config-schema .local/prusa3-schema.json
node scripts/update-prusa3-schema.mjs .local/prusa3-schema.json
```

Do not regenerate from another release and broaden support without reviewing the
format, updating native fixtures and passing the tests below.

## Validation

Committed fixtures were saved by the official alpha12 executable. They cover
three beds, MINI and CORE One profiles, all five volume roles, painting, shared
meshes, mirrored/nonuniform instances and printability. See
[fixture provenance](../tests/fixtures/README.md).

Unit tests verify bed/profile selection, exact original geometry and ordered
painted corners, complete selected-bed exports, settings preservation, correct
brim dimensions, repeated exports from an unchanged source and explicit rejection
of future/unsupported features. Worker tests verify selected-bed format/filename
and restoring the same export after switching beds.

Set `PRUSA_SLICER3` to the alpha12 executable, or use the portable Windows path
`.local/prusa3/PrusaSlicer-3.0.0-alpha12/PrusaSlicer.exe`, then run:

```powershell
npm run test -- tests/prusa3-slicer.integration.test.ts
```

These tests use an isolated `.local/prusa3-validation/data` profile store. They
reopen each bed's exported project in alpha12 and compare configuration, profile
fields, roles, volume settings, painting, placement and printability. The slicer
can assign a local hardware ID and add resolved material descriptors on save;
those changes do not alter effective configuration. Slicing checks use scaled,
mirrored input at 0.2 and 0.3 mm and inspect actual G-code extrusion, requiring all
identified brim paths to be first-layer perimeters. Without the executable,
native integration tests are explicitly skipped; fixture tests still run.
