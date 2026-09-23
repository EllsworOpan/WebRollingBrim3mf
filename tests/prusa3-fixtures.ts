import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { xml, children, child, serialize } from '../src/core/three-mf-xml';

export const P3_MODEL = '3D/3dmodel.model', P3_PROJECT = 'Metadata/PrusaSlicer3_project.json', P3_PAINT = 'Metadata/Slic3r_facets_annotation.json';
export function prusa3Fixture(mini: Uint8Array, core: Uint8Array): Uint8Array {
  const files = unzipSync(mini), doc = xml(strFromU8(files[P3_MODEL])), data = JSON.parse(strFromU8(files[P3_PROJECT]));
  const second = JSON.parse(strFromU8(unzipSync(core)[P3_PROJECT])).config_containers[0];
  const resources = child(doc.documentElement,'resources'), parent = children(resources,'object').find(o => o.getAttribute('id') === '3')!;
  parent.setAttribute('name','Painted body');
  data.objects[0].object_settings.elefant_foot_compensation = 0.3;
  data.objects[0].volumes[0].source = {filepath:'original-box.stl',objectIdx:0,volumeIdx:0};
  data.objects[0].volumes[0].volume_settings = {perimeters:4,fill_density:{value:42,is_percent:true},elefant_foot_compensation:0.15,wipe_into_infill:false};
  const roles = ['NegativeVolume','ParameterModifier','SupportEnforcer','SupportBlocker'];
  for (const [i,type] of roles.entries()) {
    const id = String(i+4), volume = doc.createElementNS(doc.documentElement.namespaceURI!,'object'); volume.setAttribute('id',id); volume.setAttribute('name',type);
    const cs = doc.createElementNS(doc.documentElement.namespaceURI!,'components'), geometry = doc.createElementNS(doc.documentElement.namespaceURI!,'component'); geometry.setAttribute('objectid','1'); cs.appendChild(geometry); volume.appendChild(cs); resources.appendChild(volume);
    const ref = doc.createElementNS(doc.documentElement.namespaceURI!,'component'); ref.setAttribute('objectid',id); ref.setAttribute('transform',`0.25 0 0 0 0.25 0 0 0 1 ${20+i} 20 0`); child(parent,'components').appendChild(ref);
    data.objects[0].volumes.push({id:Number(id),type,volume_settings:{wipe_into_infill:false,...(type === 'ParameterModifier' ? {fill_density:{value:65,is_percent:true}} : {})}});
  }
  parent.setAttribute('id','8'); data.objects[0].id = 8;
  resources.removeChild(parent); resources.appendChild(parent);
  const build = child(doc.documentElement,'build'); children(build,'item').forEach(i => build.removeChild(i));
  for (const transform of ['1 0 0 0 1 0 0 0 1 0 0 0','-1.5 0 0 0 0.75 0 0 0 3 450 -270 0','1 0 0 0 1 0 0 0 1 445 -260 0','1 0 0 0 1 0 0 0 1 485 -260 0','1 0 0 0 1 0 0 0 1 80 400 0']) {
    const item = doc.createElementNS(doc.documentElement.namespaceURI!,'item'); item.setAttribute('objectid','8'); item.setAttribute('transform',transform); build.appendChild(item);
  }
  data.objects[0].instances = [{ord:3,printable:false}];
  const first = data.config_containers[0]; first.beds.push({...first.beds[0],position_x:80,position_y:400});
  second.beds[0] = {...second.beds[0],position_x:350,position_y:-270,custom_gcode:{mode:1,gcodes:[{gcode:{type:4,print_z:0.6,extruder:1,color:'',extra:'M117 selected bed'}}]}};
  second.configuration.print_settings.first_layer_height = {value:0.3,is_percent:false};
  data.config_containers.push(second);
  files[P3_MODEL] = serialize(doc); files[P3_PROJECT] = strToU8(JSON.stringify(data));
  files[P3_PAINT] = strToU8(JSON.stringify([{id:2,mmSegmentationFacetsVersion:1,mmSegmentationFacets:[{triangle:0,dividing:'4'}],supportedFacetsVersion:1,supportedFacets:[{triangle:1,dividing:'8'}],seamFacetsVersion:1,seamFacets:[{triangle:2,dividing:'481'}],fuzzySkinFacetsVersion:1,fuzzySkinFacets:[{triangle:3,dividing:'841'}]}]));
  return zipSync(files);
}
