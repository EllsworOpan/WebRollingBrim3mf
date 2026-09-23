import { readFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { children, child, xml, type El } from '../src/core/three-mf-xml';
import { archive, box, meshXml } from './fixtures';
import { modelSnapshot } from './painted-fixtures';
import { worldPoint } from './scaled-fixtures';
import { P3_MODEL, P3_PROJECT } from './prusa3-fixtures';

export const formats = ['prusa','bambu','orca','prusa3'] as const;
export type Format = typeof formats[number];
export const transforms = [
  {name:'uniform scale',matrix:'2 0 0 0 2 0 0 0 2 20 20 0',bounds:() => [20,20,60,60]},
  {name:'nonuniform scale',matrix:'1.5 0 0 0 0.75 0 0 0 3 90 20 0',bounds:() => [90,20,120,35]},
  {name:'rotation',matrix:'0 1.25 0 -0.5 0 0 0 0 4 200 20 0',bounds:() => [190,20,200,45]},
  {name:'mirror',matrix:'-1.5 0 0 0 0.75 0 0 0 2 250 20 0',bounds:() => [220,20,250,35]},
  {name:'X tilt',matrix:'1 0 0 0 0.8 0.6 0 -0.6 0.8 20 80 0',bounds:(z:number) => [20,80-0.75*z,40,80+4*z/3]},
  {name:'Y tilt',matrix:'0.8 0 0.6 0 1 0 -0.6 0 0.8 90 80 0',bounds:(z:number) => [90-0.75*z,80,90+4*z/3,100]},
  {name:'mirrored nonuniform tilt',matrix:'-1.5 0 0 0 0.6 0.45 0 -1.2 1.6 180 80 0',bounds:(z:number) => [150,80-0.75*z,180,80+4*z/3]},
];

/** Every build item deliberately shares the same resource and volume metadata. */
export function transformedFixture(format: Format, cases = transforms): Uint8Array {
  const mesh = meshXml(box(0,0,20,20,4));
  const build = (id:number) => cases.map(c => `<item objectid="${id}" transform="${c.matrix}"/>`).join('');
  if (format === 'prusa') return new Uint8Array(archive(`<object id="1" type="model">${mesh}</object>`,build(1),`<config><object id="1" instances_count="${cases.length}"><metadata type="object" key="name" value="Shared body"/><volume firstid="0" lastid="11"><metadata type="volume" key="name" value="Body"/><metadata type="volume" key="volume_type" value="ModelPart"/></volume></object></config>`));
  const fixture = format === 'prusa3' ? 'box-prusa3-alpha12' : `painted-plates-${format}`;
  const files = unzipSync(readFileSync(`tests/fixtures/${fixture}.3mf`));
  const doc = xml(strFromU8(files[P3_MODEL]));
  const resources = `<object id="1" type="model">${mesh}</object><object id="2" name="Body" type="model"><components><component objectid="1"/></components></object>`;
  const parent = '<object id="3" name="Shared body" type="model"><components><component objectid="2"/></components></object>';
  files[P3_MODEL] = strToU8(doc.toString().replace(/<resources\b[^>]*>[\s\S]*?<\/resources>/,`<resources>${resources}${format === 'prusa3' ? parent : ''}</resources>`).replace(/<build\b[^>]*>[\s\S]*?<\/build>/,`<build>${build(format === 'prusa3' ? 3 : 2)}</build>`));
  if (format !== 'prusa3') {
    files['Metadata/model_settings.config'] = strToU8(`<config><object id="2"><metadata key="name" value="Shared body"/><part id="1" subtype="normal_part"><metadata key="name" value="Body"/></part></object><plate><metadata key="plater_id" value="1"/>${cases.map((_,i) => `<model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="${i}"/></model_instance>`).join('')}</plate></config>`);
    for (const path of ['Metadata/layer_heights_profile.txt','Metadata/layer_config_ranges.xml','Metadata/cut_information.xml','Metadata/brim_ear_points.txt']) delete files[path];
  } else {
    const data = JSON.parse(strFromU8(files[P3_PROJECT]));
    data.objects[0].object_settings = {elefant_foot_compensation:0.2};
    files[P3_PROJECT] = strToU8(JSON.stringify(data));
  }
  return zipSync(files);
}

const identity = '1 0 0 0 1 0 0 0 1 0 0 0';
const meta = (node:El,key:string) => children(node,'metadata').find(n => n.getAttribute('key') === key)?.getAttribute('value');
export type Faces = number[][][];
/** Decode serialized coordinates without the app's mesh/matrix transform code. */
export function serializedParts(bytes:Uint8Array, format:Format): {body:Faces; brim:Faces}[] {
  if (format === 'prusa') return modelSnapshot(bytes).map(o => {
    const faces = (brim:boolean) => o.parts.filter(p => (p.settings.name === 'Rolling brim') === brim).flatMap(p => p.faces.map(f => f.corners.map(v => worldPoint(v,o.transform || identity))));
    return {body:faces(false),brim:faces(true)};
  });
  const files = unzipSync(bytes), docs = new Map<string,ReturnType<typeof xml>>();
  const document = (path:string) => { if (!docs.has(path)) docs.set(path,xml(strFromU8(files[path]))); return docs.get(path)!; };
  const resource = (path:string,id:string) => children(child(document(path).documentElement,'resources'),'object').find(o => o.getAttribute('id') === id)!;
  const faces = (path:string,id:string,placements:string[]):Faces => {
    const object = resource(path,id), mesh = children(object,'mesh')[0];
    if (!mesh) return children(child(object,'components'),'component').flatMap(c => faces((c.getAttribute('p:path') || path).replace(/^\//,''),c.getAttribute('objectid')!,[c.getAttribute('transform') || identity,...placements]));
    const vertices = children(child(mesh,'vertices'),'vertex').map(v => ['x','y','z'].map(k => Number(v.getAttribute(k))));
    return children(child(mesh,'triangles'),'triangle').map(t => ['v1','v2','v3'].map(k => placements.reduce((p,m) => worldPoint(p,m),vertices[Number(t.getAttribute(k))])));
  };
  const config = format === 'prusa3' ? undefined : xml(strFromU8(files['Metadata/model_settings.config']));
  return children(child(document(P3_MODEL).documentElement,'build'),'item').map(item => {
    const parent = resource(P3_MODEL,item.getAttribute('objectid')!);
    const cfg = config && children(config.documentElement,'object').find(o => o.getAttribute('id') === item.getAttribute('objectid'));
    const parts = children(child(parent,'components'),'component').map(c => {
      const id = c.getAttribute('objectid')!, path = (c.getAttribute('p:path') || P3_MODEL).replace(/^\//,'');
      const name = cfg ? meta(children(cfg,'part').find(p => p.getAttribute('id') === id)!,'name') : resource(path,id).getAttribute('name');
      return {brim:name === 'Rolling brim',faces:faces(path,id,[c.getAttribute('transform') || identity,item.getAttribute('transform') || identity])};
    });
    return {body:parts.filter(p => !p.brim).flatMap(p => p.faces),brim:parts.filter(p => p.brim).flatMap(p => p.faces)};
  });
}
