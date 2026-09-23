import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { importProject, exportProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';
import { xml, children, child, serialize } from '../src/core/three-mf-xml';
import { boundsOf } from '../src/core/geometry';
import { sliceMesh } from '../src/core/mesh';
import { P3_MODEL, P3_PROJECT, P3_PAINT } from './prusa3-fixtures';
import { box, stl } from './fixtures';

const fixture = () => new Uint8Array(readFileSync('tests/fixtures/painted-plates-prusa3-alpha12.3mf'));
const open = (bytes: Uint8Array) => importProject('prusa3.3mf',bytes.slice().buffer);
const metadata = (bytes: Uint8Array) => JSON.parse(strFromU8(unzipSync(bytes)[P3_PROJECT]));
function altered(change: (data: ReturnType<typeof metadata>, files: Record<string,Uint8Array>) => void) {
  const files = unzipSync(fixture()), data = metadata(fixture()); change(data,files); files[P3_PROJECT] = strToU8(JSON.stringify(data)); return zipSync(files);
}
function paintedFaces(bytes: Uint8Array) {
  const f = unzipSync(bytes), root = xml(strFromU8(f[P3_MODEL])).documentElement, resources = children(child(root,'resources'),'object');
  const paints = JSON.parse(strFromU8(f[P3_PAINT])) as Record<string,unknown>[];
  return paints.map(p => {
    const volume = resources.find(r => r.getAttribute('id') === String(p.id))!, meshId = child(child(volume,'components'),'component').getAttribute('objectid');
    const mesh = child(resources.find(r => r.getAttribute('id') === meshId)!,'mesh');
    const vertices = children(child(mesh,'vertices'),'vertex').map(v => ['x','y','z'].map(k => Number(v.getAttribute(k))));
    const corners = children(child(mesh,'triangles'),'triangle').map(t => ['v1','v2','v3'].map(k => vertices[Number(t.getAttribute(k))]));
    const {id:_id,...values} = p; return {values,corners};
  });
}
describe('PrusaSlicer 3 alpha12 native projects', () => {
  it('reads every printable instance and reports differing first-layer heights', () => {
    const p = open(fixture()); expect(p.format).toBe('prusa3');
    expect(p.objects).toHaveLength(4); expect(p.suggestedHeight).toBeUndefined();
    expect(p.objects[0].parts.map(p => p.kind)).toEqual(['ModelPart','NegativeVolume','ParameterModifier','SupportEnforcer','SupportBlocker']);
    expect(p.warnings.join(' ')).toContain('differing');
  });

  it('preserves every configuration, original painted corner and nonprintable override', () => {
    const source = fixture(), p = open(source), before = structuredClone(p);
    const result = generateBrims(p,DEFAULT_BRIM,[p.objects[0].id]), output = exportProject(p,result), round = open(output);
    expect(round.objects).toHaveLength(p.objects.length);
    expect(round.objects.flatMap(o => o.parts).filter(p => p.name === 'Rolling brim')).toHaveLength(1);
    for (const [i,object] of round.objects.entries()) expect(object.parts.filter(p => p.name !== 'Rolling brim')).toEqual(p.objects[i].parts);
    for (const paint of paintedFaces(output)) expect(paintedFaces(source)).toContainEqual(paint);
    const meta = metadata(output);
    expect(meta.config_containers).toEqual(metadata(source).config_containers);
    expect(meta.objects).toHaveLength(5);
    const nonprintable = meta.objects.find((o: {instances?: unknown[]}) => o.instances?.length);
    expect(nonprintable.instances[0].printable).toBe(false);
    expect(nonprintable.object_settings.elefant_foot_compensation).toBe(0.3);
    expect(nonprintable.volumes[0].volume_settings.elefant_foot_compensation).toBe(0.15);
    for (const o of meta.objects.filter((o: {instances?: unknown[]}) => !o.instances)) expect(o.volumes[0].volume_settings.elefant_foot_compensation).toBe(0);
    expect(unzipSync(exportProject(p,result))).toEqual(unzipSync(output)); expect(p).toEqual(before);
  });

  it('keeps mirrored and nonuniformly scaled brim height in world millimetres', () => {
    const p = open(fixture());
    for (const height of [0.2,0.3]) {
      const result = generateBrims(p,{...DEFAULT_BRIM,height}), round = open(exportProject(p,result));
      for (const [i,object] of round.objects.entries()) {
        const brim = object.parts.find(p => p.name === 'Rolling brim')!;
        const zs = brim.mesh.vertices.filter((_,i) => i%3===2);
        expect(Math.min(...zs)).toBeCloseTo(0,6); expect(Math.max(...zs)).toBeCloseTo(height,6);
        const bounds = boundsOf(sliceMesh(brim.mesh,height/2)), expected = boundsOf(result.objects[i].area);
        expect(bounds.minX).toBeCloseTo(expected.minX,4); expect(bounds.maxX).toBeCloseTo(expected.maxX,4);
      }
    }
  });
  it.each([
    ['future release', (_:unknown,f:Record<string,Uint8Array>) => {f[P3_MODEL]=strToU8(strFromU8(f[P3_MODEL]).replace('alpha12','alpha13'));}],
    ['unknown structural field', (d:ReturnType<typeof metadata>) => {d.new_feature={};}],
    ['SLA', (d:ReturnType<typeof metadata>) => {d.config_containers[0].configuration.printer_settings.printer_technology='SLA';}],
    ['raft', (d:ReturnType<typeof metadata>) => {d.config_containers[0].configuration.print_settings.raft_layers=1;}],
    ['vase', (d:ReturnType<typeof metadata>) => {d.config_containers[0].configuration.print_settings.spiral_vase=true;}],
    ['layer ranges', (d:ReturnType<typeof metadata>) => {d.objects[0].ranges=[];}],
    ['missing painted volume', (_:unknown,f:Record<string,Uint8Array>) => {const p=JSON.parse(strFromU8(f[P3_PAINT]));p[0].id=999999;f[P3_PAINT]=strToU8(JSON.stringify(p));}],
    ['additional model resources', (_:unknown,f:Record<string,Uint8Array>) => {f['3D/extra.model']=f[P3_MODEL];}],
    ['unknown mesh element', (_:unknown,f:Record<string,Uint8Array>) => {f[P3_MODEL]=strToU8(strFromU8(f[P3_MODEL]).replace('</triangles>','<future/></triangles>'));}],
    ['forward resource references', (_:unknown,f:Record<string,Uint8Array>) => {const doc=xml(strFromU8(f[P3_MODEL])),resources=child(doc.documentElement,'resources'),first=child(resources,'object');resources.removeChild(first);resources.appendChild(first);f[P3_MODEL]=serialize(doc);}],
  ] as const)('rejects %s without falling back to generic geometry', (_,change) => {
    expect(() => open(altered(change))).toThrow(/Unsupported PrusaSlicer 3\.0 project/);
  });
  it('does not interpret empty, overlapping or nonrectangular bed metadata', () => {
    const p = open(altered(d => {
      const c=d.config_containers[0]; c.beds.push({...c.beds[0]});
      c.configuration.printer_settings.bed_shape = [[0,0],[5,0],[0,5]];
    }));
    expect(p.objects).toHaveLength(4);
    const output = exportProject(p,generateBrims(p,DEFAULT_BRIM));
    expect(metadata(output).config_containers).toEqual(JSON.parse(strFromU8(p.source!.files[P3_PROJECT])).config_containers);
  });

  it('keeps the source format locked and rejects mesh-only Prusa 3 exports', () => {
    const p = open(fixture()), result = generateBrims(p,DEFAULT_BRIM);
    expect(() => exportProject(p,result,'prusa')).toThrow(/original slicer/);
    expect(() => exportProject(p,result,'orca')).toThrow(/original slicer/);
    const generic = importProject('box.stl',stl(box()));
    expect(() => exportProject(generic,generateBrims(generic,DEFAULT_BRIM),'prusa3')).toThrow(/requires a supported native/);
  });
});
