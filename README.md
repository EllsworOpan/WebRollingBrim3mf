# Rolling Brim 3MF

A browser workbench for adding rolling-brim **mesh parts** to STL, OBJ and 3MF models. Each selected model gets its own aligned brim part and PrusaSlicer overrides in a downloadable 3MF. Built from WebRollingBrim's interface and rolling-circle geometry.

**Files stay in your browser.** Import, preview, brim generation and export run locally on your device. Heavy geometry processing runs in a Web Worker. No backend, account or model upload is required, including on GitHub Pages.

[MIT licensed](LICENSE) · [Deploy to GitHub Pages](#deploy-to-github-pages) · [Workflow](#workflow)

## Run

Use **Node.js 24** and npm. The version is recorded in `.node-version` and used by the deployment workflow and Docker build.

```powershell
npm ci
npm run dev
```

Open the local address printed by Vite. For a production build:

```powershell
npm run check
npm run licenses -- --check
npm run build
npm run preview
```

The preview serves the production build at `http://127.0.0.1:4173/`. It is a local verification server; deploy the contents of `dist/` to a static host for public use.

Alternatively, run `docker compose up --build -d` to serve the app on port **8081**. The source model is never modified.

## Deploy to GitHub Pages

The included [deployment workflow](.github/workflows/pages.yml) builds and publishes the site when `main` is pushed, or when started manually from GitHub's Actions tab.

1. Create a GitHub repository and push this project's `main` branch to it. If creating an empty repository for this existing Git history, leave GitHub's README and license initialization options unchecked; both files are already included.
2. In the repository, open **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
3. Open **Actions → Deploy GitHub Pages → Run workflow**, choosing `main`. After this first deployment, pushes to `main` deploy automatically. If the initial push ran before Pages was enabled, rerun that workflow after step 2.
4. Open the published URL from the deployment result or **Settings → Pages**.

The workflow uses the Pages configuration to select the correct asset prefix: `/repository-name/` for a project site, or `/` for an account site or a configured custom domain. There is no repository name to hard-code in the source. It uses GitHub's automatic token; no personal access token or custom deployment secret is needed. Build checks run before deployment, and only `dist/` is uploaded. Private models, `.local/` diagnostics and `node_modules/` are not published.

For a custom domain, configure it in **Settings → Pages**, complete GitHub's DNS setup, then rerun the workflow so the app is rebuilt for that URL. If you rename the default branch from `main`, update the workflow's push trigger and deploy condition as well.

The setup follows [Vite's GitHub Pages deployment guide](https://vite.dev/guide/static-deploy.html#github-pages) and [GitHub's Pages deployment action](https://github.com/actions/deploy-pages).

Pull requests also run typechecking, tests, license checks and a production build under a repository subpath. They do not deploy the site or require Pages configuration.

### Test a repository subpath locally

Use the same base path for both build and preview. For example, in PowerShell:

```powershell
$env:BASE_PATH = '/WebRollingBrim3mf/'
npm run build
npm run preview
```

Open `http://127.0.0.1:4173/WebRollingBrim3mf/`. Load the example, switch previews and export a 3MF to exercise the bundled model and worker under the subpath. The footer's license and third-party notice links should also work.

When finished, stop preview with Ctrl+C, run `Remove-Item Env:BASE_PATH`, and rebuild to return to the default `/` path. In a POSIX shell, use `BASE_PATH=/WebRollingBrim3mf/ npm run build` and `BASE_PATH=/WebRollingBrim3mf/ npm run preview` instead.

## Workflow

1. Open one `.stl`, `.obj` or `.3mf`. Named OBJ objects and 3MF objects receive separate brims.
2. Adjust rolling diameter, width, and separation gap. Enclosed holes and narrow-entry pockets remain independent options, using the same classifier as the G-code workbench.
3. Expand **First layer & part settings** when needed (collapsed by default). Set the assumed first-layer height (default **0.2 mm**). The mesh is intersected at **half that height**, or **Z=0.1 mm** by default. The generated brim spans **Z=0–0.2 mm**. For PrusaSlicer projects with an absolute first-layer height, a button offers that value; it does not silently change the assumption.
4. Use **Compare layer outlines** for sloping/flared bases. Blue shows the section just above the bed (Z=0.010 mm by default); pink dashes show the section just below the layer top (Z=0.190 mm). Coincident edges show blue through the pink dashes; separated lines indicate changing shape. The gray midpoint section at Z=0.100 mm remains the outline used for brim generation. The comparison cuts sit up to 0.01 mm inside the layer (5% of the layer height for thin layers), avoiding tiny base offsets that can make a one-micron cut miss an entire shell. The comparison is not a bed-contact test: a shell starting above the lower cut can still have only a pink outline. The legend and inline explanation show the current heights, including the gray brim reference.
5. Check which objects should receive a brim. Unselected objects still obstruct the rolling circle. Click an object name to highlight it.
6. Download the 3MF and **open it as a project in PrusaSlicer**, retaining part settings. Match the first-layer height used in the workbench, inspect the sliced preview, and slice for your own printer.

The compact bar below the viewer retains the first-layer height, object/brim counts, comparison toggle and a **Details** button. Details start collapsed and reveal metrics and model notes. The fallback download link stays visible even while details are collapsed.

**Circle sweep** shows a translucent teal area where the full rolling circle fits, equivalent to a brim band as wide as the rolling diameter. The orange band remains the actual brim. The sweep follows the hole/pocket toggles, object selection, neighbouring models and bed clipping; it does not change the exported mesh. A circle at the pointer provides a size reference. There is no center-path line.

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

**Elephant-foot compensation (`elefant_foot_compensation`) is set to 0 on every exported printable object**, covering the original model and its brim. This is the only existing slicer setting the app adds or overwrites. The global print profile is retained, including its own compensation value. General XY size compensation (`xy_size_compensation`) is unchanged.

Other settings, including speeds and perimeter generation, inherit from the existing project or the user's PrusaSlicer profile. Generated files from STL do not inject a printer or filament profile. First-layer height is an assumption for geometry; the app does not overwrite the project's print profile.

**Print order is controlled by PrusaSlicer.** The validation fixture starts with brim paths, but brim-first ordering is not guaranteed. The app does not claim that part-list ordering forces it. The slicer also decides seam placement, perimeter widths, small-feature treatment and the sequence of loops. A solid brim band filled with perimeters is not an exact reproduction of the previous app's hand-planned paths.

## Import/export behavior

- STL: binary and ASCII, assumed millimetres, translated vertically onto Z=0. Model XY coordinates are kept. Identical triangle corners share vertex indices in 3MF; distinct coordinates are not rounded or welded by proximity. Triangles with coincident corners are discarded, while collinear triangles with three distinct corners are retained to preserve connections. Closed shells that meet along an edge retain separate topology.
- OBJ: polygon mesh geometry, with shared position indices, triangles, quads and concave n-gons, positive/negative references, and optional UV/normal references. Each `o` record creates an independent object; `g` records remain within that object to avoid splitting a closed mesh at face-group boundaries. An OBJ with only groups is one print object. The scene is assumed to use millimetres and Z-up, and is grounded with one translation that preserves relative placement. Materials/textures, vertex colors, lines and points are not imported; free-form surfaces are rejected with instructions to export a polygon mesh. No MTL files or textures are fetched.
- Standard 3MF: same-file component assemblies, unit conversions, nested transforms, mirrored meshes, multiple build objects and repeated instances.
- PrusaSlicer 2.x 3MF: the input archive is the source of truth. Original triangle order, corner indices, and attributes are kept, including **MMU color painting, painted supports, seams and fuzzy skin**, with partial-face painting attached to the same corners. Original object/part settings and modifier roles are retained; only the parent elephant-foot override changes. Printer, filament and print profiles, color mappings, layer settings, and other archive entries are carried through without being recreated.
- The new brim mesh is appended in each parent's coordinates with its own part settings. Native PrusaSlicer instance references are supported; independent instance brims receive separate mesh resources when needed. Nonprintable build items are kept unchanged.
- Model scaling is respected, including uniform, nonuniform, rotated and mirrored scales. Brim height, width and gap are measured in final print millimetres. The exporter applies the inverse parent transform to the new brim, so scaling a model up does not scale a 0.2 mm brim into multiple layers. Rescaling the entire object afterward in PrusaSlicer also rescales its attached parts; regenerate from the original model at the new scale if the brim dimensions must remain fixed.
- Every preview and export starts from the clean imported checkpoint. Changing options never accumulates brim geometry or edits the original upload. STL/OBJ inputs keep their imported meshes as the checkpoint; there is no need for an intermediate 3MF conversion. Upload a model without a brim: the app does not detect, remove or replace existing brim geometry. To adjust an export, keep editing the original upload in the workbench.
- Native project thumbnails are retained and can therefore show the input before the new brim; PrusaSlicer can regenerate them when saving.
- Known project bed boundaries clip the brim. Files without bed metadata have no bed clipping. Existing native brim and general XY size compensation settings are retained, with notes where detected. Elephant-foot compensation is overridden to 0 per object.
- Overlapping brim bands use stable ownership: earlier objects retain shared regions, later brims are clipped with a 0.02 mm separation. A note explains affected objects. Rolling-circle accessibility considers the whole arrangement.

### Current limits

- Targeted and tested with **PrusaSlicer 2.9.6**. Bambu/Orca project metadata, mandatory 3MF extensions, external `.model` component resources, and generic component assemblies with materials or triangle annotations are rejected with guidance to save through PrusaSlicer first. Native PrusaSlicer instance aliases retain their original configured mesh and painting.
- Repeated instances with custom layer-height profiles/ranges must be made independent objects in PrusaSlicer before processing. Slicer-configured component assemblies also require a normal PrusaSlicer save.
- Rafts are unsupported. 3MF placements are respected; a floating model with no section at the sampling height gets no brim. Automatic orientation, mesh repair, arrangement and support generation are outside this workbench.
- Open or inconsistently oriented cross-sections are reported instead of guessing a closure. The model should be repaired and saved in the slicer. Apart from STL triangles with coincident corners, degenerate or nonmanifold input is not automatically repaired.
- Invalid placements, duplicate resource IDs, incomplete or overlapping part ranges, and unusable bed outlines are rejected before generating brims. First-layer heights are supported from 0.05 to 1 mm; unusable stored heights are reported rather than offered as a preset.
- The 2D footprint applies negative volumes. The 3D view shows original positive meshes, not a Boolean rendering of negative volumes/modifiers. Painting is preserved in the export but is not displayed in this workbench's preview; inspect it in PrusaSlicer.
- Geometry is quantized to 0.001 mm for polygon operations. The preview is uncompensated mesh geometry, not deposited extrusion. Small slivers can disappear during slicing, and compensation can alter the final separation gap.
- Up to 200 MB input, 500 MB expanded 3MF data, and two million scene triangles. Repeated instances count toward the scene limit.

## Validation

```powershell
npm run check
```

Tests cover midpoint sampling on a flared base, watertight extrusion and hole walls, broken contours, mirrored meshes, original hole/pocket semantics, shared brim ownership, bed clipping, negative volumes, object grouping, unit/placement transforms, repeated instances, preserved metadata/settings/triangle attributes, malformed files, and fresh exports from an unchanged import.

Hardening regressions check closed, consistently oriented brim meshes across widths, zero/negative separation gaps and layer heights, including collinear hole bridges and nested islands. They also cover repeated-export vertex counts, preservation of every original part regardless of its filename, nonprintable items, archive/XML boundaries, truncated STL files, discarded triangles below the model, and recovery after failed worker requests. Worker tests change and restore settings after exporting STL, OBJ and painted 3MF inputs, verifying that the original checkpoint and model data remain unchanged. A processing error clears the previous preview and prepared download so stale geometry cannot be mistaken for the new result.

When PrusaSlicer is installed at its usual Windows path, the integration test also opens and saves a generated two-object project, verifies the saved per-part settings, and slices it. Every identified brim extrusion must be a perimeter on the first layer. Set `PRUSA_SLICER` to a console executable elsewhere to enable this test; without a slicer the integration test is explicitly skipped.

Painting tests compare original face attributes against their exact ordered triangle corners, all original part roles/settings, and unrelated archive entries byte-for-byte. Checked-in [painted fixtures](tests/fixtures/README.md) exercise real PrusaSlicer serialization on CI. Installed-slicer tests independently open/save MMU, support, seam and fuzzy-skin painting, verify the loaded filament palette and print/printer settings, retain variable layer heights and height-range overrides, and test a selected mirrored instance. A control save accounts for PrusaSlicer's own metadata normalization.

Scale regressions independently decode exported world coordinates for enlarged, reduced, nonuniform, rotated and mirrored models. They check preserved model geometry and real brim height/width at 0.2 and 0.3 mm. PrusaSlicer integration saves scaled inputs, reopens the outputs and slices both heights, asserting every brim extrusion stays on the first layer. Sweep-preview tests cover diameter versus brim width, holes/pockets, tight entrances, disabled neighbours and bed clipping.

STL regressions cover shared vertex indices, touching shells, collapsed and collinear triangles, and coordinate precision. Compensation validation checks both body and brim extrusion bounds with a nonzero global profile, including a control export without the object override. To compare a private STL against its generated 3MF in the installed slicer, set `ROLLING_BRIM_TEST_STL` to its absolute path and run `npm run test -- tests/local-model.integration.test.ts`. The input is never copied into test fixtures; the export and comparison report go to ignored `.local/`.

Validation artifacts go to ignored `.local/`, including `two-objects.3mf`, the slicer roundtrip, validation G-code, and `slicer-validation.json`. G-code exists only as a development check; the application accepts STL/OBJ/3MF and exports only 3MF.

Browser verification covers sample loading, hole/pocket toggles, 2D/3D previews, base comparison, multi-object input, object selection, height changes and export preparation. A direct **Save prepared 3MF** link remains available after export if the automatic download does not start.

## License

Released under the [MIT License](LICENSE), copyright © 2026 EllsworOpan, with the original WebRollingBrim attribution retained. The included test plate is original to that project.

Dependencies retain their own licenses. Run `npm run licenses` after dependency updates to refresh the [hosted MIT license](public/LICENSE.txt) and [third-party notices](public/THIRD_PARTY_NOTICES.txt), then commit those files. Deployment runs `npm run licenses -- --check` to ensure the published notices match the locked dependencies and root license. Both are linked from the app footer.
