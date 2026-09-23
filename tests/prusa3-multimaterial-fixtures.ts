import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { child, children, serialize, xml, NS } from '../src/core/three-mf-xml';
import { P3_MODEL, P3_PROJECT, P3_PAINT } from './prusa3-fixtures';

// Build original test geometry around a native alpha12 XL/MMU seed. Always
// round-trip this result through alpha12 before committing it as a fixture.
export function multiMaterialFixture(seed: Uint8Array): Uint8Array {
  const files = unzipSync(seed), data = JSON.parse(strFromU8(files[P3_PROJECT])), model = xml(strFromU8(files[P3_MODEL]));
  const container = data.config_containers[0], slots = container.preset.materials.length, blend = slots+1;
  container.virtual_extruders = [
    {id:blend,kind:'fullspectrum',components:[{extruder:1,ratio:0.25},{extruder:2,ratio:0.75}]},
    {id:20,kind:'gradient',minz:0,maxz:10,components:[{extruder:1,position:0},{extruder:2,position:0.5},{extruder:1,position:1}]},
  ];
  container.beds = [
    {...container.beds[0],wipe_tower:{x:180,y:140,rotation_angle:0}},
    {...container.beds[0],position_x:420,position_y:0,wipe_tower:{x:160,y:150,rotation_angle:15},custom_gcode:{mode:2,gcodes:[{gcode:{type:4,print_z:0.6,extruder:2,color:'',extra:'M117 selected multi-material bed'}}]}},
  ];
  // Include a non-default, directed purge table; no palette or matrix pruning.
  container.configuration.project_settings.wiping_volumes_matrix = Array.from({length:slots*slots},(_,i) => Math.floor(i/slots) === i%slots ? 0 : 90+i);
  container.configuration.project_settings.wiping_volumes_use_custom_matrix = true;
  const resources = child(model.documentElement,'resources'), originalVolume = children(resources,'object').find(o => o.getAttribute('id') === '2')!;
  const originalParent = children(resources,'object').find(o => o.getAttribute('id') === '3')!;
  const first = data.objects[0]; first.object_settings.extruder = 2;
  first.volumes[0].source = {filepath:'original-box.stl',objectIdx:0,volumeIdx:0};
  first.volumes[0].volume_settings.extruder = 0;
  originalParent.setAttribute('name','Physical material 2');
  for (const [index,material] of [blend,20].entries()) {
    const volumeId = 4+index*2, parentId = volumeId+1;
    const volume = originalVolume.cloneNode(true) as Element; volume.setAttribute('id',String(volumeId)); resources.appendChild(volume);
    const parent = originalParent.cloneNode(true) as Element; parent.setAttribute('id',String(parentId)); parent.setAttribute('name',index ? 'Gradient material' : 'Blend material'); child(child(parent,'components'),'component').setAttribute('objectid',String(volumeId)); resources.appendChild(parent);
    const object = structuredClone(first); object.id = parentId; object.object_settings.extruder = material; object.volumes[0].id = volumeId; data.objects.push(object);
  }
  const build = child(model.documentElement,'build'); children(build,'item').forEach(item => build.removeChild(item));
  for (const [objectId,placement] of [[3,'1 0 0 0 1 0 0 0 1 0 0 0'],[3,'-1.5 0 0 0 0.75 0 0 0 1 520 0 0'],[5,'1 0 0 0 1 0 0 0 1 520 0 0'],[7,'1 0 0 0 1 0 0 0 1 590 0 0'],[3,'1 0 0 0 1 0 0 0 1 500 80 0']] as const) {
    const item = model.createElementNS(NS,'item'); item.setAttribute('objectid',String(objectId)); item.setAttribute('transform',placement); build.appendChild(item);
  }
  first.instances = [{ord:4,printable:false}];
  const encode = (id: number) => id < 3 ? (id*4).toString(16) : id <= 16 ? `${(id-3).toString(16)}c` : `${(id-17).toString(16).padStart(2,'0')}ec`;
  files[P3_PAINT] = strToU8(JSON.stringify([2,4,6].map(id => ({id,mmSegmentationFacetsVersion:2,mmSegmentationFacets:[{triangle:6,dividing:encode(blend).toUpperCase()},{triangle:7,dividing:encode(20).toUpperCase()},{triangle:8,dividing:'841'}]}))));
  files[P3_PROJECT] = strToU8(JSON.stringify(data)); files[P3_MODEL] = serialize(model);
  return zipSync(files);
}
