import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { importProject, exportProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { boundsOf, totalArea } from '../src/core/geometry';
import { sliceMesh } from '../src/core/mesh';
import { DEFAULT_BRIM, type Mesh } from '../src/core/types';
import { archive, box, meshXml, project } from './fixtures';

const body = `<object id="1">${meshXml(box())}</object>`;
const item = '<item objectid="1"/>';
const load = (resources = body, build = item, config = '<config/>', extra = {}, unit = 'millimeter') => importProject('fixture.3mf', archive(resources, build, config, extra, unit));
const parse = (bytes: Uint8Array) => new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
const range = (first: string, last: string, generated = false) => `<volume firstid="${first}" lastid="${last}">${generated ? '<metadata key="source_file" value="rolling-brim.generated.stl"/>' : ''}</volume>`;

describe('3MF data preservation and validation', () => {
  it('replaces generated geometry without growing vertices on successive exports', () => {
    let p = project([box()]);
    let counts: number[] | undefined;
    for (let cycle = 0; cycle < 4; cycle++) {
      const bytes = exportProject(p, generateBrims(p, DEFAULT_BRIM));
      const model = parse(unzipSync(bytes)['3D/3dmodel.model']);
      const current = ['vertex', 'triangle'].map(tag => model.getElementsByTagName(tag).length);
      if (counts) expect(current).toEqual(counts);
      counts = current;
      p = importProject('roundtrip.3mf', bytes.slice().buffer);
      expect(totalArea(sliceMesh(p.objects[0].parts[0].mesh, 0.1))).toBe(400);
    }
  });

  it('removes brims before and after body parts while preserving negative volumes, painting and original spare vertices', () => {
    const meshes = [box(-50,0), box(), box(25,25,5,5), box(100,0)];
    const mesh: Mesh = {vertices:meshes.flatMap(m => m.vertices),triangles:meshes.flatMap((m,i) => m.triangles.map(n => n+i*8))};
    mesh.vertices.push(123,456,789); // An original unreferenced vertex is not brim-owned.
    const config = `<config><object id="1">${range('0','11',true)}${range('12','23')}<volume firstid="24" lastid="35"><metadata key="volume_type" value="NegativeVolume"/><metadata key="name" value="Cutout"/></volume>${range('36','47',true)}</object></config>`;
    const p = load(`<object id="1">${meshXml(mesh).replaceAll('<triangle ', '<triangle paint_supports="1" ')}</object>`,item,config);
    const result = generateBrims(p,DEFAULT_BRIM);
    const bytes = exportProject(p,result), model = parse(unzipSync(bytes)['3D/3dmodel.model']);
    expect(model.getElementsByTagName('vertex').length).toBe(17 + result.objects[0].mesh.vertices.length/3);
    expect(Array.from(model.getElementsByTagName('triangle')).filter(t => t.getAttribute('paint_supports') === '1')).toHaveLength(24);
    const round = importProject('roundtrip.3mf',bytes.slice().buffer);
    expect(round.objects[0].parts.map(p => p.kind)).toEqual(['ModelPart','NegativeVolume']);
    expect(generateBrims(round,DEFAULT_BRIM).objects[0].footprint).toEqual(result.objects[0].footprint);
  });

  it.each([
    ['gap', range('1', '11')],
    ['overlap', range('0', '6') + range('6', '11')],
    ['out of bounds', range('0', '12')],
    ['fractional', range('0', '10.5')],
    ['generated out of bounds', range('0', '11') + range('12', '99', true)],
    ['generated missing range', '<volume><metadata key="source_file" value="rolling-brim.generated.stl"/></volume>'],
  ])('rejects %s part ranges before they can hide or remove model faces', (_, volumes) => {
    expect(() => load(body, item, `<config><object id="1">${volumes}</object></config>`)).toThrow(/range|numeric/);
  });

  it.each(['0', 'false'])('leaves nonprintable build items untouched (%s)', printable => {
    const p = load(body + `<object id="2">${meshXml(box(70,20))}</object>`, `<item objectid="2" printable="${printable}"/>${item}`);
    expect(p.objects.map(o => o.buildIndex)).toEqual([1]);
    const files = unzipSync(exportProject(p, generateBrims(p, DEFAULT_BRIM)));
    const items = parse(files['3D/3dmodel.model']).getElementsByTagName('item');
    expect(items[0].getAttribute('objectid')).toBe('2');
    expect(items[0].getAttribute('printable')).toBe(printable);
    expect(parse(files['Metadata/Slic3r_PE_model.config']).getElementsByTagName('object').length).toBe(1);
  });

  it.each([
    ['duplicate object IDs', body + body, '<config/>'],
    ['duplicate object configs', body, '<config><object id="1"/><object id="1"/></config>'],
    ['component settings', body + '<object id="2"><components><component objectid="1"/></components></object>', '<config><object id="1"><metadata key="perimeters" value="4"/></object></config>'],
  ])('rejects ambiguous or unsupported %s', (_, resources, config) => {
    expect(() => load(resources, resources.includes('<components>') ? '<item objectid="2"/>' : item, config)).toThrow(/duplicate|component.*settings/i);
  });

  it.each([
    '0 0 0 0 0 0 0 0 0 0 0 0',
    '1e308 0 0 0 1e308 0 0 0 1e308 0 0 0',
    '1 0 0 0 1 0 0 0 1 1e308 0 0',
    '1 0 0 0 1 0 0 0 1 0 0',
  ])('rejects unusable placement transforms: %s', transform => {
    expect(() => load(body, `<item objectid="1" transform="${transform}"/>`)).toThrow(/transform|coordinates/);
  });

  it('preserves three differently transformed instances with only one selected', () => {
    const p = load(body, item + '<item objectid="1" transform="-1 0 0 0 1 0 0 0 1 100 0 0"/><item objectid="1" transform="0 1 0 -1 0 0 0 0 1 160 0 0"/>');
    const result = generateBrims(p, DEFAULT_BRIM, ['object-1']);
    const bytes = exportProject(p, result), files = unzipSync(bytes);
    expect(strFromU8(files['Metadata/Slic3r_PE_model.config']).match(/value="Rolling brim"/g)).toHaveLength(1);
    const round = importProject('round.3mf', bytes.slice().buffer);
    expect(new Set(round.objects.map(o => o.resourceId)).size).toBe(3);
    expect(generateBrims(round, DEFAULT_BRIM).objects.map(o => boundsOf(o.footprint))).toEqual(result.objects.map(o => boundsOf(o.footprint)));
  });

  it.each(['NaN', 'Infinity', '0', '-0.1', '200%', '2'])('does not offer an unusable first-layer height (%s)', value => {
    const p = load(body, item, '<config/>', {'Metadata/Slic3r_PE.config': strToU8(`; first_layer_height = ${value}\n`)});
    expect(p.suggestedHeight).toBeUndefined();
  });

  it.each(['0x0,10x0', '0x0,10x0,20x0', '0x0,10x0,NaNx10', '0x0x1,10x0,10x10'])('rejects unusable stored beds: %s', bed => {
    expect(() => load(body, item, '<config/>', {'Metadata/Slic3r_PE.config': strToU8(`; bed_shape = ${bed}\n`)})).toThrow(/bed shape/);
  });
});

describe('3MF container boundaries', () => {
  const rewrite = (edit: (files: Record<string,Uint8Array>) => void) => {
    const files = unzipSync(new Uint8Array(archive(body,item)));
    edit(files);
    return zipSync(files).slice().buffer;
  };
  it.each([
    ['missing model', (f: Record<string,Uint8Array>) => { delete f['3D/3dmodel.model']; }, /missing/],
    ['external relationship', (f: Record<string,Uint8Array>) => { f['_rels/.rels'] = strToU8('<Relationships><Relationship Type="x/3dmodel" TargetMode="External" Target="https://example.com/model"/></Relationships>'); }, /internal/],
    ['parent traversal', (f: Record<string,Uint8Array>) => { f['_rels/.rels'] = strToU8('<Relationships><Relationship Type="x/3dmodel" Target="/%2e%2e/3D/3dmodel.model"/></Relationships>'); }, /path/],
    ['entity declaration', (f: Record<string,Uint8Array>) => { f['3D/3dmodel.model'] = strToU8('<!DOCTYPE model [<!ENTITY injected "x">]>' + strFromU8(f['3D/3dmodel.model'])); }, /entity/],
    ['required extension', (f: Record<string,Uint8Array>) => { f['3D/3dmodel.model'] = strToU8(strFromU8(f['3D/3dmodel.model']).replace('<model ', '<model requiredextensions="vendor" ')); }, /extensions/],
    ['wrong namespace', (f: Record<string,Uint8Array>) => { f['3D/3dmodel.model'] = strToU8(strFromU8(f['3D/3dmodel.model']).replace('http://schemas.microsoft.com/3dmanufacturing/core/2015/02','urn:unrelated')); }, /core model/],
  ] as const)('rejects %s', (_, edit, message) => {
    expect(() => importProject('bad.3mf',rewrite(edit))).toThrow(message);
  });

  it('enforces the expanded archive limit before decompression', () => {
    const bytes = new Uint8Array(archive(body,item)), view = new DataView(bytes.buffer);
    // fflate emits a ZIP without a comment. Set the first central-directory
    // entry's declared expanded size, without allocating a huge test fixture.
    const central = view.getUint32(bytes.length-22+16,true);
    expect(view.getUint32(central,true)).toBe(0x02014b50);
    view.setUint32(central+24,500_000_001,true);
    expect(() => importProject('oversized.3mf',bytes.buffer)).toThrow(/expanded.*limit/);
  });

  it('rejects external components and excessive component nesting', () => {
    expect(() => load('<object id="1"><components><component objectid="2" path="other.model"/></components></object>')).toThrow(/External/);
    const nested = Array.from({length:67},(_,i) => `<object id="${i+1}"><components><component objectid="${i+2}"/></components></object>`).join('');
    expect(() => load(nested)).toThrow(/nesting/);
  });

  it('rejects unsupported units and raft projects, while retaining relative layer heights as an assumption', () => {
    expect(() => load(body,item,'<config/>',{},'constructor')).toThrow(/unit/);
    expect(() => load(body,item,'<config/>',{'Metadata/Slic3r_PE.config':strToU8('; raft_layers = 2\n')})).toThrow(/Raft/);
    const p = load(body,item,'<config/>',{'Metadata/Slic3r_PE.config':strToU8('; first_layer_height = 150%\n')});
    expect(p.suggestedHeight).toBeUndefined();
  });
});
