import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { archive, box, meshXml } from './fixtures';
import type { Mesh } from '../src/core/types';

export const MODEL = '3D/3dmodel.model';
export const CONFIG = 'Metadata/Slic3r_PE_model.config';
export const PAINT = ['slic3rpe:mmu_segmentation','slic3rpe:custom_supports','slic3rpe:custom_seam','slic3rpe:fuzzy_skin'];
export const parse = (bytes: Uint8Array) => new DOMParser().parseFromString(strFromU8(bytes),'application/xml');
export const encode = (doc: Document) => strToU8(new XMLSerializer().serializeToString(doc));
export const direct = (element: Element, name: string) => Array.from(element.childNodes).filter(n => n.nodeType === 1 && (n as Element).localName === name) as Element[];
export const metadata = (element: Element) => Object.fromEntries(direct(element,'metadata').map(m => [m.getAttribute('key')!, m.getAttribute('value')!]));
const metas = (settings: Record<string,string>, type = 'volume') => Object.entries(settings).map(([key,value]) => `<metadata type="${type}" key="${key}" value="${value}"/>`).join('');

/** Original small fixture. Painting encodings follow PrusaSlicer 2.9.6's
 * TriangleSelector serialization: 4/8/0C are whole faces; 0C81 and 0C8411
 * contain partial-triangle subdivisions, so preservation must keep corner order.
 * The integration test validates these by an actual PrusaSlicer save first.
 */
export function paintedSeed(profile: string): ArrayBuffer {
  const parts = [box(),box(46,20,10,10,8),box(24,24,5,5),box(32,24,4,5),box(20,20,3,3,5),box(38,38,2,2,8)];
  const mesh: Mesh = {vertices:parts.flatMap(p => p.vertices),triangles:parts.flatMap((p,i) => p.triangles.map(v => v+i*8))};
  let face = 0;
  const body = meshXml(mesh).replace(/<triangle /g, () => {
    const i = face++;
    if (i >= 24) return '<triangle ';
    const values = [
      ['4','8','0C','0C81','0C8411',''][i%6],
      ['4','8','841',''][i%4],
      ['8','4','481',''][i%4],
      ['4','8','841',''][i%4],
    ];
    return '<triangle ' + PAINT.map((key,j) => values[j] ? `${key}="${values[j]}" ` : '').join('');
  });
  const kinds = ['ModelPart','ModelPart','NegativeVolume','ParameterModifier','SupportEnforcer','SupportBlocker'];
  const names = ['Painted body','Second color part','Cutout','Infill modifier','Support enforcer','Support blocker'];
  const volumes = parts.map((_,i) => `<volume firstid="${i*12}" lastid="${i*12+11}">${metas({name:names[i],volume_type:kinds[i],...(i<2 ? {extruder:String(i+2),perimeters:String(i+3),fill_density:`${23+i}%`,external_perimeter_speed:'22',seam_position:'rear'} : i===3 ? {fill_density:'65%',perimeters:'5'} : {})})}</volume>`).join('');
  const config = `<config><object id="1" instances_count="1">${metas({name:'Painted multipart model',extruder:'1',perimeters:'4',layer_height:'0.2',xy_size_compensation:'0.07',elefant_foot_compensation:'0.3',support_material:'1',support_material_auto:'0'},'object')}${volumes}</object></config>`;
  const profileText = profile + '\n' + [
    'nozzle_diameter = 0.4,0.4,0.4', 'filament_diameter = 1.75,1.75,1.75',
    'filament_colour = #FF0000;#00FF00;#0000FF', 'extruder_colour = #FF0000;#00FF00;#0000FF',
    'filament_type = PLA;PLA;PLA', 'single_extruder_multi_material = 1',
    'wipe_tower = 0', 'xy_size_compensation = 0.12', 'elefant_foot_compensation = 0.25',
    'print_settings_id = Painting preservation fixture', 'printer_settings_id = Test MMU printer',
    'filament_settings_id = Red test;Green test;Blue test',
  ].join('\n');
  // Embedded PrusaSlicer profiles use G-code-style "; key = value" lines,
  // unlike standalone INI files. Collapse duplicate keys before serializing.
  const settings = Object.fromEntries(profileText.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^;?\s*([^;#=\s]+)\s*=\s*(.*)$/);
    return match ? [[match[1],match[2]]] : [];
  }));
  const extra = {'Metadata/Slic3r_PE.config':strToU8(Object.entries(settings).map(([key,value]) => `; ${key} = ${value}`).join('\n')+'\n')};
  const files = unzipSync(new Uint8Array(archive(`<object id="1" type="model">${body}</object>`,'<item objectid="1"/>',config,extra)));
  const versions = ['FdmSupports','Seam','FuzzySkin','Mm'].map(name => `<metadata name="slic3rpe:${name}PaintingVersion">1</metadata>`).join('');
  files[MODEL] = strToU8(strFromU8(files[MODEL]).replace('<model ', '<model xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06" ').replace('<resources>',`<metadata name="slic3rpe:Version3mf">1</metadata>${versions}<resources>`));
  return zipSync(files).slice().buffer;
}

/** Compare ordered triangle corners and every non-index face attribute, rather
 * than merely checking that paint strings occur somewhere in the archive. */
export function modelSnapshot(bytes: Uint8Array) {
  const files = unzipSync(bytes), model = parse(files[MODEL]), config = parse(files[CONFIG]);
  const resources = direct(direct(model.documentElement,'resources')[0],'object');
  return direct(direct(model.documentElement,'build')[0],'item').map(item => {
    const id = item.getAttribute('objectid');
    let object = resources.find(o => o.getAttribute('id') === id)!;
    // PrusaSlicer saves extra instances as identity component aliases.
    const components = direct(object,'components')[0];
    if (components) object = resources.find(o => o.getAttribute('id') === direct(components,'component')[0].getAttribute('objectid'))!;
    const cfg = direct(config.documentElement,'object').find(o => o.getAttribute('id') === object.getAttribute('id'))!;
    const mesh = direct(object,'mesh')[0], vertices = direct(direct(mesh,'vertices')[0],'vertex');
    const triangles = direct(direct(mesh,'triangles')[0],'triangle');
    return {settings:metadata(cfg), transform:item.getAttribute('transform') || '', parts:direct(cfg,'volume').map(volume => {
      const first = Number(volume.getAttribute('firstid')), last = Number(volume.getAttribute('lastid'));
      return {settings:metadata(volume), faces:triangles.slice(first,last+1).map(t => ({
        corners:['v1','v2','v3'].map(key => ['x','y','z'].map(axis => Number(vertices[Number(t.getAttribute(key))].getAttribute(axis)))),
        attributes:Object.fromEntries(Array.from(t.attributes).filter(a => !['v1','v2','v3'].includes(a.name)).map(a => [a.name,a.value])),
      }))};
    })};
  });
}
