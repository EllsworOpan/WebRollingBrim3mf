import { boundsOf, classifyRegions, intersectPolygons, offsetPolygons, subtractPolygons, totalArea, unionPolygons } from './geometry';
import { extrude, sliceMesh } from './mesh';
import { sampleHeights, MIN_LAYER_HEIGHT, MAX_LAYER_HEIGHT } from './first-layer';
import type { Bounds, BrimResult, BrimSettings, ModelObject, Project, Rings } from './types';

export function footprint(object: ModelObject, z: number): Rings {
  const positives = object.parts.filter(p => p.kind === 'ModelPart').flatMap(p => sliceMesh(p.mesh, z));
  const negatives = object.parts.filter(p => p.kind === 'NegativeVolume').flatMap(p => sliceMesh(p.mesh, z));
  return subtractPolygons(unionPolygons(positives), unionPolygons(negatives));
}

function rolledOutline(free: Rings, bounds: Bounds): Rings {
  // Recover the finite rolled outline from free space. Its outer boundary is
  // inside the model's bounds; the margin keeps polygon rounding off the crop.
  // This also discards the classifier's artificial frame around infinite space.
  const margin = 1;
  return subtractPolygons([[
    { x: bounds.minX - margin, y: bounds.minY - margin }, { x: bounds.maxX + margin, y: bounds.minY - margin },
    { x: bounds.maxX + margin, y: bounds.maxY + margin }, { x: bounds.minX - margin, y: bounds.maxY + margin },
  ]], free);
}

export function generateBrims(project: Project, settings: BrimSettings, enabled = project.objects.map(o => o.id)): BrimResult {
  const start = performance.now();
  if (![settings.diameter, settings.width, settings.gap, settings.height, settings.perimeters].every(Number.isFinite) || settings.diameter < 0.5 || settings.diameter > 100 || settings.width < 0.1 || settings.width > 50 || settings.height < MIN_LAYER_HEIGHT || settings.height > MAX_LAYER_HEIGHT || settings.gap < -0.5 || settings.gap > 5 || settings.perimeters < 1 || settings.perimeters > 999 || !Number.isInteger(settings.perimeters)) throw new Error('Brim settings are outside the supported range.');
  const heights = sampleHeights(settings.height);
  const footprints = project.objects.map(o => footprint(o, heights.middle));
  if (!footprints.some(shape => shape.length)) throw new Error('No model intersects the first-layer sampling plane. Check the assumed first-layer height and the model placement in your slicer.');
  const counts = { outside:0, holes:0, pockets:0 };
  const warnings: string[] = [];
  const sweepAreas: Rings = [];
  const objects = project.objects.map((object, index) => {
    const shape = footprints[index], notes: string[] = [];
    // Each Objects-panel entry is a separate job. Its own parts/shells share
    // one footprint; neighbours never affect the rolled boundary or brim.
    const regions = classifyRegions(shape, settings.diameter);
    counts.outside += regions.counts.outside; counts.holes += regions.counts.holes; counts.pockets += regions.counts.pockets;
    const bottom = footprint(object, heights.bottom);
    const top = footprint(object, heights.top);
    const changeArea = totalArea(subtractPolygons(top, bottom)) + totalArea(subtractPolygons(bottom, top));
    if (!shape.length) notes.push('No footprint at the sampling plane; no brim was added.');
    if (changeArea > Math.max(0.5, totalArea(shape) * 0.01)) notes.push('The base changes shape within the first layer. Use Compare layer outlines to inspect it.');
    let area: Rings = [];
    if (enabled.includes(object.id) && shape.length) {
      const allowed = unionPolygons([...regions.outside, ...(settings.holes ? regions.holes : []), ...(settings.pockets ? regions.pockets : [])]);
      const outline = rolledOutline(allowed, boundsOf(shape));
      const inner = offsetPolygons(outline, settings.gap);
      // Measure both bands from the same rolled boundary, including its arcs.
      area = subtractPolygons(offsetPolygons(outline, settings.gap + settings.width), inner);
      // The circle stays against the rolled boundary. Separation shifts only
      // the brim, never this sweep or which passages the circle can enter.
      // Neither band is trimmed against other objects.
      let sweep = subtractPolygons(offsetPolygons(outline, settings.diameter), outline);
      if (project.bed.length) {
        const clipped = intersectPolygons(area, [project.bed]);
        if (totalArea(area) - totalArea(clipped) > 0.05) notes.push('Brim clipped to the project’s print bed.');
        area = clipped;
        sweep = intersectPolygons(sweep, [project.bed]);
      }
      sweepAreas.push(...sweep);
      if (!area.length) notes.push('No brim fits the current width and rolling diameter.');
    }
    return { id: object.id, footprint: shape, bottom, top, area, mesh: extrude(area, settings.height), areaMm2: totalArea(area), changeArea, warnings: notes };
  });
  if (!objects.some(o => o.area.length)) warnings.push('No printable brim area is selected.');
  return { objects, circleSweep: unionPolygons(sweepAreas), bounds: boundsOf([...footprints.flat(), ...objects.flatMap(o => o.area)]), regions: counts, settings: { ...settings }, warnings, computeMs: performance.now() - start };
}
