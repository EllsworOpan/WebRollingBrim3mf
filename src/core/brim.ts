import { boundsOf, classifyRegions, intersectPolygons, offsetPolygons, polygonsOf, subtractPolygons, totalArea, unionPolygons } from './geometry';
import { extrude, sliceMesh } from './mesh';
import { sampleHeights, MIN_LAYER_HEIGHT, MAX_LAYER_HEIGHT } from './first-layer';
import type { Bounds, BrimResult, BrimSettings, ModelObject, Project, Rings } from './types';

export function footprint(object: ModelObject, z: number): Rings {
  const positives = object.parts.filter(p => p.kind === 'ModelPart').flatMap(p => sliceMesh(p.mesh, z));
  const negatives = object.parts.filter(p => p.kind === 'NegativeVolume').flatMap(p => sliceMesh(p.mesh, z));
  return subtractPolygons(unionPolygons(positives), unionPolygons(negatives));
}

/** Measure outward from the rolled boundary, including its arcs across gaps. */
function rolledBand(free: Rings, bounds: Bounds, width: number, gap: number): Rings {
  // Recover the finite rolled outline from free space. Its outer boundary is
  // inside the model's bounds; the margin keeps polygon rounding off the crop.
  // This also discards the classifier's artificial frame around infinite space.
  const margin = 1;
  const outline = subtractPolygons([[
    { x: bounds.minX - margin, y: bounds.minY - margin }, { x: bounds.maxX + margin, y: bounds.minY - margin },
    { x: bounds.maxX + margin, y: bounds.maxY + margin }, { x: bounds.minX - margin, y: bounds.maxY + margin },
  ]], free);
  return subtractPolygons(offsetPolygons(outline, gap + width), offsetPolygons(outline, gap));
}

/** Keep local bands with their parents, then attach connecting sections once. */
function assignBand(band: Rings, footprints: Rings[], selected: boolean[], width: number, gap: number) {
  const areas: Rings[] = footprints.map(() => []), shared = footprints.map(() => false);
  const order = footprints.map((_, i) => i).sort((a,b) => Number(selected[b]) - Number(selected[a]));
  let claimed: Rings = [];
  for (const i of order) {
    const neighbours = unionPolygons(footprints.filter((_, j) => j !== i).flat());
    const local = subtractPolygons(
      intersectPolygons(band, offsetPolygons(footprints[i], Math.max(0, width + gap))),
      offsetPolygons(neighbours, Math.max(0, gap)),
    );
    areas[i] = subtractPolygons(local, claimed);
    shared[i] = totalArea(local) - totalArea(areas[i]) > 0.05;
    claimed = unionPolygons([...claimed, ...areas[i]]);
  }
  // Reserve unselected objects' local bands as well, so selecting one object
  // cannot acquire an entire unselected neighbour's brim through a connection.
  const touching = areas.map(area => offsetPolygons(area, 0.01));
  for (const polygon of polygonsOf(subtractPolygons(band, claimed))) {
    const bridge = [polygon.outer, ...polygon.holes];
    const owners = order.filter(i => selected[i] && totalArea(intersectPolygons(bridge, touching[i])) > 0);
    if (owners.length) {
      areas[owners[0]] = unionPolygons([...areas[owners[0]], ...bridge]);
      if (owners.length > 1) shared[owners[0]] = true;
    }
  }
  return { areas: areas.map((area,i) => selected[i] ? area : []), shared };
}

export function generateBrims(project: Project, settings: BrimSettings, enabled = project.objects.map(o => o.id)): BrimResult {
  const start = performance.now();
  if (![settings.diameter, settings.width, settings.gap, settings.height, settings.perimeters].every(Number.isFinite) || settings.diameter < 0.5 || settings.diameter > 100 || settings.width < 0.1 || settings.width > 50 || settings.height < MIN_LAYER_HEIGHT || settings.height > MAX_LAYER_HEIGHT || settings.gap < -0.5 || settings.gap > 5 || settings.perimeters < 1 || settings.perimeters > 999 || !Number.isInteger(settings.perimeters)) throw new Error('Brim settings are outside the supported range.');
  const heights = sampleHeights(settings.height);
  const footprints = project.objects.map(o => footprint(o, heights.middle));
  const model = unionPolygons(footprints.flat());
  if (!model.length) throw new Error('No model intersects the first-layer sampling plane. Check the assumed first-layer height and the model placement in your slicer.');
  const regions = classifyRegions(model, settings.diameter);
  const allowed = unionPolygons([...regions.outside, ...(settings.holes ? regions.holes : []), ...(settings.pockets ? regions.pockets : [])]);
  const selected = project.objects.map(o => enabled.includes(o.id));
  const modelBounds = boundsOf(model);
  const bands = assignBand(rolledBand(allowed, modelBounds, settings.width, settings.gap), footprints, selected, settings.width, settings.gap);
  // The full-circle preview uses the same boundary with a diameter-wide band.
  const sweeps = assignBand(rolledBand(allowed, modelBounds, settings.diameter, settings.gap), footprints, selected, settings.diameter, settings.gap);
  const warnings: string[] = [];
  const sweepAreas: Rings = [];
  const objects = project.objects.map((object, index) => {
    const shape = footprints[index], notes: string[] = [];
    const bottom = footprint(object, heights.bottom);
    const top = footprint(object, heights.top);
    const changeArea = totalArea(subtractPolygons(top, bottom)) + totalArea(subtractPolygons(bottom, top));
    if (!shape.length) notes.push('No footprint at the sampling plane; no brim was added.');
    if (changeArea > Math.max(0.5, totalArea(shape) * 0.01)) notes.push('The base changes shape within the first layer. Use Compare layer outlines to inspect it.');
    let area: Rings = [];
    if (selected[index] && shape.length) {
      area = bands.areas[index];
      let sweep = sweeps.areas[index];
      if (project.bed.length) {
        const clipped = intersectPolygons(area, [project.bed]);
        if (totalArea(area) - totalArea(clipped) > 0.05) notes.push('Brim clipped to the project’s print bed.');
        area = clipped;
        sweep = intersectPolygons(sweep, [project.bed]);
      }
      sweepAreas.push(...sweep);
      if (bands.shared[index]) notes.push('Connecting brim sections are assigned once to adjacent objects; their parts meet without overlapping.');
      if (!area.length) notes.push('No brim fits the current width and rolling diameter.');
    }
    return { id: object.id, footprint: shape, bottom, top, area, mesh: extrude(area, settings.height), areaMm2: totalArea(area), changeArea, warnings: notes };
  });
  if (!objects.some(o => o.area.length)) warnings.push('No printable brim area is selected.');
  return { objects, circleSweep: unionPolygons(sweepAreas), bounds: boundsOf(unionPolygons([...model, ...objects.flatMap(o => o.area)])), regions: regions.counts, settings: { ...settings }, warnings, computeMs: performance.now() - start };
}
