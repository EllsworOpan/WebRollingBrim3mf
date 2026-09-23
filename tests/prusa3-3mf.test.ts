import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { importProject, exportProject, selectPlate } from '../src/core/three-mf';
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
  it('reads three beds with different printers, heights, painting and part roles', () => {
    const p = open(fixture()); expect(p.format).toBe('prusa3');
    expect(p.plates?.map(p => p.objectCount)).toEqual([1,1,3]);
    const mini = selectPlate(p,'2'), core = selectPlate(p,'3');
    expect(Math.max(...mini.bed.map(p => p.x))).toBe(180); expect(Math.max(...core.bed.map(p => p.x))).toBe(250);
    expect(mini.suggestedHeight).toBe(0.2); expect(core.suggestedHeight).toBe(0.3);
    expect(core.objects).toHaveLength(2);
    expect(core.objects[0].parts.map(p => p.kind)).toEqual(['ModelPart','NegativeVolume','ParameterModifier','SupportEnforcer','SupportBlocker']);
    expect(core.warnings.join(' ')).toContain('Experimental');
  });
  it.each(['1','2','3'])('exports exactly bed %s with unchanged original geometry and paint', id => {
    const source = fixture(), p = selectPlate(open(source),id), before = structuredClone(p);
    const result = generateBrims(p,DEFAULT_BRIM,[p.objects[0].id]), output = exportProject(p,result), round = open(output);
    expect(round.plates).toHaveLength(1); expect(round.plates![0].objectCount).toBe(p.plates!.find(b => b.id === id)!.objectCount);
    expect(round.objects).toHaveLength(p.objects.length);
    expect(round.objects.flatMap(o => o.parts).filter(p => p.name === 'Rolling brim')).toHaveLength(1);
    for (const [i,object] of round.objects.entries()) expect(object.parts.filter(p => p.name !== 'Rolling brim')).toEqual(p.objects[i].parts);
    const originals = paintedFaces(source);
    for (const paint of paintedFaces(output)) expect(originals).toContainEqual(paint);
    const meta = metadata(output), src = metadata(source), selectedContainer = src.config_containers[id === '3' ? 1 : 0];
    expect(meta.config_containers).toHaveLength(1);
    expect(meta.config_containers[0].configuration).toEqual(selectedContainer.configuration);
    expect(meta.config_containers[0].preset).toEqual(selectedContainer.preset);
    expect(meta.config_containers[0].beds[0]).toEqual({...selectedContainer.beds[id === '2' ? 1 : 0],position_x:0,position_y:0});
    if (id === '3') {
      expect(meta.objects).toHaveLength(3);
      const nonprintable = meta.objects.find((o: {instances?: unknown[]}) => o.instances?.length);
      expect(nonprintable.instances[0].printable).toBe(false);
      expect(nonprintable.object_settings.elefant_foot_compensation).toBe(0.3);
      expect(nonprintable.volumes[0].volume_settings.elefant_foot_compensation).toBe(0.15);
      for (const o of meta.objects.filter((o: {instances?: unknown[]}) => !o.instances)) expect(o.volumes[0].volume_settings.elefant_foot_compensation).toBe(0);
    }
    expect(exportProject(p,result)).toEqual(output); expect(p).toEqual(before);
  });
  it('keeps mirrored and nonuniformly scaled brim height in world millimetres', () => {
    const p = selectPlate(open(fixture()),'3');
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
    ['unknown setting', (d:ReturnType<typeof metadata>) => {d.config_containers[0].configuration.print_settings.future_compensation=2;}],
    ['changed setting type', (d:ReturnType<typeof metadata>) => {d.objects[0].volumes[0].volume_settings.perimeters='4';}],
    ['missing material setting value', (d:ReturnType<typeof metadata>) => {d.config_containers[0].configuration.filament_settings.filament_diameter=[null];}],
    ['multi-tool', (d:ReturnType<typeof metadata>) => {d.config_containers[0].preset.hw_config.tool_count=2;}],
    ['SLA', (d:ReturnType<typeof metadata>) => {d.config_containers[0].preset.hw_config.technology='sla';}],
    ['raft', (d:ReturnType<typeof metadata>) => {d.config_containers[0].configuration.print_settings.raft_layers=1;}],
    ['vase', (d:ReturnType<typeof metadata>) => {d.config_containers[0].configuration.print_settings.spiral_vase=true;}],
    ['layer ranges', (d:ReturnType<typeof metadata>) => {d.objects[0].ranges=[];}],
    ['unknown painting', (_:unknown,f:Record<string,Uint8Array>) => {const p=JSON.parse(strFromU8(f[P3_PAINT]));p[0].seamFacetsVersion=3;f[P3_PAINT]=strToU8(JSON.stringify(p));}],
    ['bad painting index', (_:unknown,f:Record<string,Uint8Array>) => {const p=JSON.parse(strFromU8(f[P3_PAINT]));p[0].seamFacets[0].triangle=99999;f[P3_PAINT]=strToU8(JSON.stringify(p));}],
    ['overlapping beds', (d:ReturnType<typeof metadata>) => {d.config_containers[0].beds[1].position_x=0;}],
    ['outside objects', (_:unknown,f:Record<string,Uint8Array>) => {const doc=xml(strFromU8(f[P3_MODEL]));child(child(doc.documentElement,'build'),'item').setAttribute('transform','1 0 0 0 1 0 0 0 1 -1000 0 0');f[P3_MODEL]=serialize(doc);}],
    ['unknown archive data', (_:unknown,f:Record<string,Uint8Array>) => {f['Metadata/future.bin']=new Uint8Array([1]);}],
    ['unknown mesh element', (_:unknown,f:Record<string,Uint8Array>) => {f[P3_MODEL]=strToU8(strFromU8(f[P3_MODEL]).replace('</triangles>','<future/></triangles>'));}],
    ['forward resource references', (_:unknown,f:Record<string,Uint8Array>) => {const doc=xml(strFromU8(f[P3_MODEL])),resources=child(doc.documentElement,'resources'),first=child(resources,'object');resources.removeChild(first);resources.appendChild(first);f[P3_MODEL]=serialize(doc);}],
  ] as const)('rejects %s without falling back to generic geometry', (_,change) => {
    expect(() => open(altered(change))).toThrow(/Unsupported PrusaSlicer 3\.0 project/);
  });
  it('allows selecting an empty bed without carrying over printable objects', () => {
    const p = open(altered(d => {const beds=d.config_containers[0].beds;beds.push({...beds[0],position_x:1000,position_y:1000});}));
    const empty = selectPlate(p,'3');
    expect(empty.objects).toEqual([]); expect(empty.warnings.join(' ')).toContain('no printable');
    expect(selectPlate(empty,'1').objects).toEqual(p.objects);
  });
  it('keeps the source format locked and rejects mesh-only Prusa 3 exports', () => {
    const p = open(fixture()), result = generateBrims(p,DEFAULT_BRIM);
    expect(() => exportProject(p,result,'prusa')).toThrow(/original slicer/);
    expect(() => exportProject(p,result,'orca')).toThrow(/original slicer/);
    const generic = importProject('box.stl',stl(box()));
    expect(() => exportProject(generic,generateBrims(generic,DEFAULT_BRIM),'prusa3')).toThrow(/requires a supported native/);
  });
});
