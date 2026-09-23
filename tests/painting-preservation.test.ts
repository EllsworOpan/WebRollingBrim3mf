import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { importProject, exportProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';
import { CONFIG, MODEL, PAINT, direct, encode, modelSnapshot, paintedSeed, parse } from './painted-fixtures';
import { archive, box, meshXml } from './fixtures';

const input = () => new Uint8Array(paintedSeed(readFileSync('examples/validation.ini','utf8')));
const addBrims = (bytes: Uint8Array, enabled?: string[]) => {
  // Buffer.slice() shares its backing pool. Copy the visible bytes so imports
  // never receive neighboring allocations from a readFileSync Buffer.
  const p = importProject('painted.3mf',new Uint8Array(bytes).buffer);
  return exportProject(p,generateBrims(p,DEFAULT_BRIM,enabled));
};
const isBrim = (p: ReturnType<typeof modelSnapshot>[number]['parts'][number]) => p.settings.source_file === 'rolling-brim.generated.stl';

describe('PrusaSlicer painting and settings preservation', () => {
  it.each(['painted-prusa.3mf','painted-instances-prusa.3mf'])('preserves the checked-in PrusaSlicer fixture %s without requiring a slicer installation', name => {
    const source = readFileSync(`tests/fixtures/${name}`), before = modelSnapshot(source);
    const after = modelSnapshot(addBrims(source));
    expect(after).toHaveLength(before.length);
    after.forEach((object,i) => {
      expect(object.settings).toEqual({...before[i].settings,elefant_foot_compensation:'0'});
      expect(object.transform).toEqual(before[i].transform);
      expect(object.parts.filter(p => !isBrim(p))).toEqual(before[i].parts);
      expect(object.parts.filter(isBrim)).toHaveLength(1);
    });
  });
  it.each(['painted-prusa.3mf','painted-instances-prusa.3mf'])('loads only the fixture bytes when %s occupies part of a Node Buffer', name => {
    const source = readFileSync(`tests/fixtures/${name}`);
    // Force surrounding bytes and a nonzero offset, independent of how this
    // Node version or OS allocates small readFileSync buffers.
    const storage = Buffer.alloc(source.byteLength+128,0xff);
    source.copy(storage,64);
    const view = storage.subarray(64,64+source.byteLength);
    expect(view.byteOffset).toBeGreaterThan(0);
    expect(view.buffer.byteLength).toBeGreaterThan(view.byteLength);
    const expected = modelSnapshot(addBrims(new Uint8Array(source)));
    expect(modelSnapshot(addBrims(view))).toEqual(expected);
    expect(view).toEqual(source);
  });
  it('preserves all painting types, partial-face encodings, part roles and settings across edits from the same upload', () => {
    const bytes = input(), original = bytes.slice();
    const project = importProject('painted.3mf',bytes.slice().buffer);
    const checkpoint = structuredClone(project);
    const before = modelSnapshot(bytes)[0];
    expect(before.parts).toHaveLength(6);
    for (const attribute of PAINT) expect(before.parts.some(p => p.faces.some(f => (f.attributes[attribute]?.length || 0)>1))).toBe(true);
    for (let pass=0;pass<3;pass++) {
      const settings = {...DEFAULT_BRIM,width:2+pass,perimeters:99-pass};
      const output = exportProject(project,generateBrims(project,settings));
      const after = modelSnapshot(output)[0];
      expect(after.settings).toEqual({...before.settings,elefant_foot_compensation:'0'});
      expect(after.parts.filter(p => !isBrim(p))).toEqual(before.parts);
      expect(after.parts.filter(isBrim)).toHaveLength(1);
      expect(after.parts.find(isBrim)!.faces.every(f => PAINT.every(key => !(key in f.attributes)))).toBe(true);
      expect(after.parts.find(isBrim)!.settings.perimeters).toBe(String(settings.perimeters));
      expect(project).toEqual(checkpoint);
      expect(bytes).toEqual(original);
    }
  });

  it('keeps every unrelated archive entry byte-for-byte, including profiles, color mappings and auxiliary settings', () => {
    const files = unzipSync(input());
    // Opaque data must survive even when this app does not interpret it.
    Object.assign(files, {
      'Metadata/Slic3r_PE_layer_heights_profile.txt':strToU8('object_id=1|0;0.2;5;0.15;10;0.2\n'),
      'Metadata/Prusa_Slicer_layer_config_ranges.xml':strToU8('<objects><object id="1"><range min_z="2" max_z="4"><option opt_key="perimeters">6</option></range></object></objects>'),
      'Metadata/Prusa_Slicer_full_spectrum.json':strToU8('{"preservation-fixture":"opaque color mapping"}'),
      'Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml':strToU8('<custom_gcodes_per_print_z><code print_z="3" extruder="1" color="Pause fixture" gcode="M601"/></custom_gcodes_per_print_z>'),
      'Metadata/Prusa_Slicer_wipe_tower_information.xml':strToU8('<wipe_tower/>'),
      'Metadata/thumbnail.png':new Uint8Array([1,2,3,4]),
      'Metadata/unknown-extension.bin':new Uint8Array([0,255,9]),
    });
    const output = unzipSync(addBrims(zipSync(files)));
    for (const [path,value] of Object.entries(files)) if (![MODEL,CONFIG,'[Content_Types].xml'].includes(path)) expect(output[path],path).toEqual(value);
    const before = parse(files[MODEL]), after = parse(output[MODEL]);
    expect(direct(after.documentElement,'metadata').map(n => n.toString())).toEqual(direct(before.documentElement,'metadata').map(n => n.toString()));
  });

  it('keeps painting and overrides on independently selected, translated and mirrored instances', () => {
    const files = unzipSync(input()), model = parse(files[MODEL]);
    const build = direct(model.documentElement,'build')[0], item = direct(build,'item')[0];
    const clone = item.cloneNode(true) as Element;
    clone.setAttribute('transform','-1 0 0 0 1 0 0 0 1 150 0 0'); build.appendChild(clone);
    files[MODEL] = encode(model);
    const source = zipSync(files), before = modelSnapshot(source), after = modelSnapshot(addBrims(source,['object-1']));
    expect(after).toHaveLength(2);
    after.forEach((object,i) => {
      expect(object.transform).toEqual(before[i].transform);
      expect(object.settings).toEqual({...before[i].settings,elefant_foot_compensation:'0'});
      expect(object.parts.filter(p => !isBrim(p))).toEqual(before[i].parts);
      expect(object.parts.filter(isBrim)).toHaveLength(i);
    });
  });

  it('preserves unknown object and part settings instead of copying only a known whitelist', () => {
    const files = unzipSync(input()), config = parse(files[CONFIG]);
    const object = direct(config.documentElement,'object')[0], part = direct(object,'volume')[0];
    for (const [parent,type] of [[object,'object'],[part,'volume']] as const) {
      const m = config.createElement('metadata');
      m.setAttribute('type',type); m.setAttribute('key','future_setting'); m.setAttribute('value','Keep & preserve <everything>'); parent.appendChild(m);
    }
    files[CONFIG] = encode(config);
    const source = zipSync(files), before = modelSnapshot(source)[0], after = modelSnapshot(addBrims(source))[0];
    expect(after.settings).toEqual({...before.settings,elefant_foot_compensation:'0'});
    expect(after.parts[0]).toEqual(before.parts[0]);
  });

  it('keeps distinct painting and settings associated with each separate object', () => {
    const files = unzipSync(input()), model = parse(files[MODEL]), config = parse(files[CONFIG]);
    const resources = direct(model.documentElement,'resources')[0];
    const second = direct(resources,'object')[0].cloneNode(true) as Element;
    second.setAttribute('id','9'); resources.appendChild(second);
    for (const face of Array.from(second.getElementsByTagName('triangle'))) if (face.hasAttribute(PAINT[0])) face.setAttribute(PAINT[0],'8');
    const item = direct(direct(model.documentElement,'build')[0],'item')[0].cloneNode(true) as Element;
    item.setAttribute('objectid','9'); item.setAttribute('transform','1 0 0 0 1 0 0 0 1 90 0 0');
    direct(model.documentElement,'build')[0].appendChild(item);
    const secondConfig = direct(config.documentElement,'object')[0].cloneNode(true) as Element;
    secondConfig.setAttribute('id','9');
    direct(secondConfig,'metadata').find(m => m.getAttribute('key') === 'name')!.setAttribute('value','Independent second object');
    direct(secondConfig,'metadata').find(m => m.getAttribute('key') === 'perimeters')!.setAttribute('value','7');
    config.documentElement.appendChild(secondConfig);
    files[MODEL] = encode(model); files[CONFIG] = encode(config);
    const bytes = zipSync(files), before = modelSnapshot(bytes), after = modelSnapshot(addBrims(bytes));
    expect(after).toHaveLength(2);
    expect(before[0].parts[0].faces).not.toEqual(before[1].parts[0].faces);
    after.forEach((object,i) => {
      expect(object.settings).toEqual({...before[i].settings,elefant_foot_compensation:'0'});
      expect(object.parts.filter(p => !isBrim(p))).toEqual(before[i].parts);
      expect(object.parts.filter(isBrim)).toHaveLength(1);
    });
  });

  it.each(PAINT)('rejects component flattening that would discard %s painting', key => {
    const resource = meshXml(box()).replace('<triangle ',`<triangle ${key}="4" `);
    const source = archive(`<object id="1">${resource}</object><object id="2"><components><component objectid="1"/></components></object>`,'<item objectid="2"/>');
    expect(() => importProject('assembly.3mf',source)).toThrow(/painted or annotated/);
  });

  it.each(['Metadata/Slic3r_PE_layer_heights_profile.txt','Metadata/Prusa_Slicer_layer_config_ranges.xml'])('does not detach instances while invalidating object references in %s', path => {
    const files = unzipSync(input()), model = parse(files[MODEL]);
    const build = direct(model.documentElement,'build')[0];
    build.appendChild(direct(build,'item')[0].cloneNode(true));
    files[MODEL] = encode(model); files[path] = strToU8('existing per-object layer settings');
    expect(() => addBrims(zipSync(files))).toThrow(/independent objects/);
  });

});
