import { boundsOf, classifyRegions, intersectPolygons, offsetPolygons, subtractPolygons, totalArea, unionPolygons } from './geometry';
import { extrude, sliceMesh } from './mesh';
import { sampleHeights, MIN_LAYER_HEIGHT, MAX_LAYER_HEIGHT } from './first-layer';
import type { BrimResult, BrimSettings, ModelObject, Project, Rings } from './types';

export function footprint(object: ModelObject, z: number): Rings {
  const positives = object.parts.filter(p => p.kind === 'ModelPart').flatMap(p => sliceMesh(p.mesh, z));
  const negatives = object.parts.filter(p => p.kind === 'NegativeVolume').flatMap(p => sliceMesh(p.mesh, z));
  return subtractPolygons(unionPolygons(positives), unionPolygons(negatives));
}

export function generateBrims(project: Project, settings: BrimSettings, enabled = project.objects.map(o => o.id)): BrimResult {
  const start = performance.now();
  if (![settings.diameter, settings.width, settings.gap, settings.height, settings.perimeters].every(Number.isFinite) || settings.diameter < 0.5 || settings.diameter > 100 || settings.width < 0.1 || settings.width > 50 || settings.height < MIN_LAYER_HEIGHT || settings.height > MAX_LAYER_HEIGHT || settings.gap < -0.5 || settings.gap > 5 || settings.perimeters < 1 || settings.perimeters > 999 || !Number.isInteger(settings.perimeters)) throw new Error('Brim settings are outside the supported range.');
  const heights = sampleHeights(settings.height);
  const footprints = project.objects.map(o => footprint(o, heights.middle));
  const model = unionPolygons(footprints.flat());
  if (!model.length) throw new Error('No model intersects the first-layer sampling plane. Check the assumed first-layer height and the model placement in your slicer.');
  const regions = classifyRegions(model, settings.diameter, -settings.gap);
  const allowed = unionPolygons([...regions.outside, ...(settings.holes ? regions.holes : []), ...(settings.pockets ? regions.pockets : [])]);
  const warnings: string[] = [];
  let occupied: Rings = [];
  const objects = project.objects.map((object, index) => {
    const shape = footprints[index], notes: string[] = [];
    const bottom = footprint(object, heights.bottom);
    const top = footprint(object, heights.top);
    const changeArea = totalArea(subtractPolygons(top, bottom)) + totalArea(subtractPolygons(bottom, top));
    if (!shape.length) notes.push('No footprint at the sampling plane; no brim was added.');
    if (changeArea > Math.max(0.5, totalArea(shape) * 0.01)) notes.push('The base changes shape within the first layer. Use Compare layer outlines to inspect it.');
    let area: Rings = [];
    if (enabled.includes(object.id) && shape.length) {
      area = intersectPolygons(subtractPolygons(offsetPolygons(shape, settings.width + settings.gap), offsetPolygons(shape, settings.gap)), allowed);
      const otherModels = unionPolygons(footprints.filter((_, i) => i !== index).flat());
      area = subtractPolygons(area, offsetPolygons(otherModels, Math.max(settings.gap, 0)));
      if (project.bed.length) {
        const clipped = intersectPolygons(area, [project.bed]);
        if (totalArea(area) - totalArea(clipped) > 0.05) notes.push('Brim clipped to the project’s print bed.');
        area = clipped;
      }
      const before = totalArea(area);
      // Stable ownership: earlier objects retain shared brim area. A tiny clearance
      // keeps adjacent independent parts separate after slicer polygon rounding.
      area = subtractPolygons(area, offsetPolygons(occupied, 0.02));
      if (before - totalArea(area) > 0.05) notes.push('Shared brim area assigned to an earlier object to prevent overlapping brims.');
      occupied = unionPolygons([...occupied, ...area]);
      if (!area.length) notes.push('No brim fits the current width and rolling diameter.');
    }
    return { id: object.id, footprint: shape, bottom, top, area, mesh: extrude(area, settings.height), areaMm2: totalArea(area), changeArea, warnings: notes };
  });
  if (!objects.some(o => o.area.length)) warnings.push('No printable brim area is selected.');
  return { objects, bounds: boundsOf(unionPolygons([...model, ...occupied])), regions: regions.counts, settings: { ...settings }, warnings, computeMs: performance.now() - start };
}
