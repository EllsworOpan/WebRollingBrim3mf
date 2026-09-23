# Rolling Brim 3MF

A local browser workbench for adding rolling-brim **mesh parts** to STL, OBJ and 3MF models. Based on the UI and rolling-circle region classifier in the sibling `WebRollingBrim` project. The legacy Python script is not used.

## Run

```powershell
npm ci
npm run dev
```

Open the local address printed by Vite. For a production build:

```powershell
npm run check
npm run build
docker compose up --build -d
```

Docker serves the app on port **8081**. The production output in `dist/` can also be served by any static host. No backend, account, or upload service is involved. Geometry, imports and exports run in a Web Worker. The source project is never modified.

## Workflow

1. Open one `.stl`, `.obj` or `.3mf`. Named OBJ objects and 3MF objects receive separate brims.
2. Adjust rolling diameter, width, and separation gap. Enclosed holes and narrow-entry pockets remain independent options, using the same classifier as the G-code workbench.
3. Expand **First layer & part settings** when needed (collapsed by default). Set the assumed first-layer height (default **0.2 mm**). The mesh is intersected at **half that height**, or **Z=0.1 mm** by default. The generated brim spans **Z=0–0.2 mm**. For PrusaSlicer projects with an absolute first-layer height, a button offers that value; it does not silently change the assumption.
4. Use **Compare layer outlines** for sloping/flared bases. Blue shows the section just above the bed (Z=0.010 mm by default); pink dashes show the section just below the layer top (Z=0.190 mm). Coincident edges show blue through the pink dashes; separated lines indicate changing shape. The gray midpoint section at Z=0.100 mm remains the outline used for brim generation. The comparison cuts sit up to 0.01 mm inside the layer (5% of the layer height for thin layers), avoiding tiny base offsets that can make a one-micron cut miss an entire shell. The comparison is not a bed-contact test: a shell starting above the lower cut can still have only a pink outline. The legend and inline explanation show the current heights, including the gray brim reference.
5. Check which objects should receive a brim. Unselected objects still obstruct the rolling circle. Click an object name to highlight it.
6. Download the 3MF and **open it as a project in PrusaSlicer**, retaining part settings. Match the first-layer height used in the workbench, inspect the sliced preview, and slice for your own printer.

The compact bar below the viewer retains the first-layer height, object/brim counts, comparison toggle and a **Details** button. Details start collapsed and reveal metrics and model notes. The fallback download link stays visible even while details are collapsed.

Each selected object gets a printable **Rolling brim** part, already aligned with the object. Disconnected brim regions belong to the same part. An STL is one object, even if it contains multiple shells; 3MF object/component groupings determine the hierarchy. Model parts, negative volumes, modifiers, and support enforcers/blockers remain distinct in supported PrusaSlicer projects. Only printable model parts (minus negative volumes) contribute to the footprint.

The original clearance-test-plate STL is included. With a 10 mm rolling diameter, the upper-left hole and upper-right narrow-entry pocket demonstrate the independent toggles. The small lower-left hole stays empty; the wide lower-right opening remains reachable.

## Brim part overrides

| Setting | Exported value |
|---|---|
| Perimeters | 99 by default; adjustable |
| Infill density | 0% |
| Top and bottom solid layers | 0 |
| Minimum top and bottom shell thickness | 0 |
| Vertical shell enforcement | Disabled |
| Gap fill | Disabled |
| Ironing | Disabled |
| First-layer single-perimeter override | Disabled |
| Top-surface single-perimeter override | Disabled |

**Elephant-foot compensation is set to 0 on every exported object**, covering the original model and its brim. This object override also replaces any existing object-level value; the global print profile is retained. General XY size compensation is unchanged.

Other settings, including speeds and perimeter generation, inherit from the existing project or the user's PrusaSlicer profile. Generated files from STL do not inject a printer or filament profile. First-layer height is an assumption for geometry; the app does not overwrite the project's print profile.

**Print order is controlled by PrusaSlicer.** The validation fixture starts with brim paths, but brim-first ordering is not guaranteed. The app does not claim that part-list ordering forces it. The slicer also decides seam placement, perimeter widths, small-feature treatment and the sequence of loops. A solid brim band filled with perimeters is not an exact reproduction of the previous app's hand-planned paths.

## Import/export behavior

- STL: binary and ASCII, assumed millimetres, translated vertically onto Z=0. Model XY coordinates are kept. Identical triangle corners share vertex indices in 3MF; distinct coordinates are not rounded or welded by proximity. Triangles with coincident corners are discarded, while collinear triangles with three distinct corners are retained to preserve connections. Closed shells that meet along an edge retain separate topology.
- OBJ: polygon mesh geometry, with shared position indices, triangles, quads and concave n-gons, positive/negative references, and optional UV/normal references. Each `o` record creates an independent object; `g` records remain within that object to avoid splitting a closed mesh at face-group boundaries. An OBJ with only groups is one print object. The scene is assumed to use millimetres and Z-up, and is grounded with one translation that preserves relative placement. Materials/textures, vertex colors, lines and points are not imported; free-form surfaces are rejected with instructions to export a polygon mesh. No MTL files or textures are fetched.
- Standard 3MF: same-file component assemblies, unit conversions, nested transforms, mirrored meshes, multiple build objects and repeated instances.
- PrusaSlicer 2.x 3MF: original archive entries are retained. Original model triangles and their attributes, object/part overrides (except elephant-foot compensation), profiles, and metadata are preserved when adding a brim to a direct mesh object. The new mesh is transformed back into each parent's coordinates. Independently generated instance brims are detached into separate object resources when needed.
- Reimporting a generated file replaces marked brim parts. It does not accumulate copies. Identification uses the generated part's `source_file` marker, which survives a PrusaSlicer 2.9.6 save.
- Native project thumbnails are retained and can therefore show the input before the new brim; PrusaSlicer can regenerate them when saving.
- Known project bed boundaries clip the brim. Files without bed metadata have no bed clipping. Existing native brim and general XY size compensation settings are retained, with notes where detected. Elephant-foot compensation is overridden to 0 per object.
- Overlapping brim bands use stable ownership: earlier objects retain shared regions, later brims are clipped with a 0.02 mm separation. A note explains affected objects. Rolling-circle accessibility considers the whole arrangement.

### Current limits

- Targeted and tested with **PrusaSlicer 2.9.6**. Bambu/Orca project metadata, mandatory 3MF extensions, external `.model` component resources, and material-assigned generic component assemblies are rejected with guidance to save through PrusaSlicer first.
- Repeated instances with custom layer-height profiles/ranges must be made independent objects in PrusaSlicer before processing. Slicer-configured component assemblies also require a normal PrusaSlicer save.
- Rafts are unsupported. 3MF placements are respected; a floating model with no section at the sampling height gets no brim. Automatic orientation, mesh repair, arrangement and support generation are outside this workbench.
- Open or inconsistently oriented cross-sections are reported instead of guessing a closure. The model should be repaired and saved in the slicer. Apart from STL triangles with coincident corners, degenerate or nonmanifold input is not automatically repaired.
- The 2D footprint applies negative volumes. The 3D view shows original positive meshes, not a Boolean rendering of negative volumes/modifiers.
- Geometry is quantized to 0.001 mm for polygon operations. The preview is uncompensated mesh geometry, not deposited extrusion. Small slivers can disappear during slicing, and compensation can alter the final separation gap.
- Up to 200 MB input, 500 MB expanded 3MF data, and two million scene triangles. Repeated instances count toward the scene limit.

## Validation

```powershell
npm run check
```

Tests cover midpoint sampling on a flared base, watertight extrusion and hole walls, broken contours, mirrored meshes, original hole/pocket semantics, shared brim ownership, bed clipping, negative volumes, object grouping, unit/placement transforms, repeated instances, preserved metadata/settings/triangle attributes, malformed files, and replacement of generated brims.

When PrusaSlicer is installed at its usual Windows path, the integration test also opens and saves a generated two-object project, verifies the saved per-part settings, and slices it. Every identified brim extrusion must be a perimeter on the first layer. Set `PRUSA_SLICER` to a console executable elsewhere to enable this test; without a slicer the integration test is explicitly skipped.

STL regressions cover shared vertex indices, touching shells, collapsed and collinear triangles, and coordinate precision. Compensation validation checks both body and brim extrusion bounds with a nonzero global profile, including a control export without the object override. To compare a private STL against its generated 3MF in the installed slicer, set `ROLLING_BRIM_TEST_STL` to its absolute path and run `npm run test -- tests/local-model.integration.test.ts`. The input is never copied into test fixtures; the export and comparison report go to ignored `.local/`.

Validation artifacts go to ignored `.local/`, including `two-objects.3mf`, the slicer roundtrip, validation G-code, and `slicer-validation.json`. G-code exists only as a development check; the application accepts STL/OBJ/3MF and exports only 3MF.

Browser verification covers sample loading, hole/pocket toggles, 2D/3D previews, base comparison, multi-object 3MF input, object selection, height changes and export preparation. The Codex in-app browser did not expose a native file-download event. A direct **Save prepared 3MF** link remains available after export; use the local URL in a regular browser if the in-app browser does not save the file.

## License

MIT, with original application attribution retained from WebRollingBrim. The included test plate is original to that project. Runtime third-party license texts and attribution are generated by `npm run licenses` and served in `public/THIRD_PARTY_NOTICES.txt`.
