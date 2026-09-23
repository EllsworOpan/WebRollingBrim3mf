import { strFromU8, strToU8, zipSync } from 'fflate';
import { Matrix4 } from 'three';
import { transformMesh } from './mesh';
import { MIN_LAYER_HEIGHT, MAX_LAYER_HEIGHT } from './first-layer';
import { NS, xml, serialize, children, child, matrix, readMesh, checkIds, type Doc, type El } from './three-mf-xml';
import { configuration, settings, record, list, keys, finite, integer, fail, type JsonObject } from './prusa3-config';
import type { Project, ModelObject, ModelPart, BrimResult, Mesh, Ring } from './types';

export const PRUSA3_VERSION = 'PrusaSlicer-3.0.0-alpha12';
const PROJECT = 'Metadata/PrusaSlicer3_project.json', PAINT = 'Metadata/Slic3r_facets_annotation.json';
const ROLES = ['ModelPart','NegativeVolume','ParameterModifier','SupportEnforcer','SupportBlocker'];
const remove = (node: El) => node.parentNode?.removeChild(node);
const transformText = (m: Matrix4) => m.elements.filter((_,i) => i % 4 !== 3).join(' ');
function json(bytes: Uint8Array | undefined, label: string): unknown {
  if (!bytes) fail(`Missing ${label}.`);
  try { return JSON.parse(strFromU8(bytes!)); } catch { return fail(`Invalid ${label} JSON.`); }
}
function attrs(node: El, allowed: string[]) {
  for (const a of Array.from(node.attributes)) if (a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && !allowed.includes(a.name)) fail(`Unrecognized ${node.localName} attribute: ${a.name}.`);
}
function tags(node: El, allowed: string[]) {
  for (const c of Array.from(node.childNodes).filter(n => n.nodeType === 1) as El[]) if (c.namespaceURI !== NS || !allowed.includes(c.localName)) fail(`Unrecognized ${node.localName} element: ${c.nodeName}.`);
}
interface Bed {
  id: string; name: string; node: JsonObject; container: JsonObject; outline: Ring;
  x: number; y: number; minX: number; minY: number; maxX: number; maxY: number; height: number;
  instances: Instance[]; config: JsonObject;
}
interface Instance { index: number; item: El; cfg: JsonObject; parent: El; parts: ModelPart[]; printable: boolean }

function archive(files: Record<string, Uint8Array>, modelPath: string, modelDocument?: Doc) {
  const doc = modelDocument || xml(strFromU8(files[modelPath])), root = doc.documentElement;
  const application = children(root,'metadata').filter(m => m.getAttribute('name') === 'Application');
  if (application.length !== 1 || application[0].textContent !== PRUSA3_VERSION) fail('This PrusaSlicer version has not been validated.');
  if (root.namespaceURI !== NS || root.localName !== 'model' || root.getAttribute('unit') !== 'millimeter') fail('Expected a core 3MF model in millimetres.');
  if (root.getAttribute('requiredextensions')) fail('3MF extensions/external model resources are not supported yet.');
  attrs(root,['unit','xml:lang']); tags(root,['metadata','resources','build']);
  if (children(root,'resources').length !== 1 || children(root,'build').length !== 1) fail('Expected one resources section and one build.');
  for (const path of Object.keys(files)) if (![modelPath,PROJECT,PAINT,'[Content_Types].xml','_rels/.rels','Metadata/thumbnail.png','Metadata/rolling_brim.json'].includes(path)) fail(`Unrecognized archive entry: ${path}.`);
  const data = record(json(files[PROJECT], 'PrusaSlicer 3 project'), 'project file');
  keys(data,['objects','project','config_containers'],'project');
  const projectInfo = record(data.project,'project identity'); keys(projectInfo,['id','version'],'project identity');
  if (typeof projectInfo.id !== 'string') fail('Changed project identity schema.');
  integer(projectInfo.version,'project save revision');
  const resources = child(root,'resources'), build = child(root,'build'); tags(resources,['object']); tags(build,['item']);
  attrs(resources,[]); attrs(build,[]);
  const objects = children(resources,'object'); checkIds(objects,'resource');
  const resource = (id: string) => objects.find(o => o.getAttribute('id') === id) || fail(`Missing resource ${id}.`);
  const meshes = new Map<string,Mesh>();
  const declared = new Set<string>();
  for (const object of objects) {
    attrs(object,['id','name','type']);
    if (object.hasAttribute('type') && object.getAttribute('type') !== 'model') fail('Non-model resource types.');
    tags(object,['mesh','components']);
    if (children(object,'mesh').length + children(object,'components').length !== 1) fail('Changed mesh/component hierarchy.');
    if (children(object,'mesh').length) {
      const mesh = child(object,'mesh'); attrs(mesh,[]); tags(mesh,['vertices','triangles']);
      if (children(mesh,'vertices').length !== 1 || children(mesh,'triangles').length !== 1) fail('Changed mesh hierarchy.');
      const vertices = child(mesh,'vertices'), triangles = child(mesh,'triangles');
      attrs(vertices,[]); attrs(triangles,[]); tags(vertices,['vertex']); tags(triangles,['triangle']);
      for (const t of children(triangles,'triangle')) { attrs(t,['v1','v2','v3','slic3rpe:mmu_segmentation']); tags(t,[]); }
      for (const v of children(vertices,'vertex')) { attrs(v,['x','y','z']); tags(v,[]); }
      meshes.set(object.getAttribute('id')!,readMesh(mesh));
    } else {
      const components = child(object,'components'); attrs(components,[]); tags(components,['component']);
      for (const c of children(components,'component')) {
        attrs(c,['objectid','transform']); tags(c,[]); matrix(c.getAttribute('transform'));
        if (!declared.has(c.getAttribute('objectid')!)) fail('Components must reference an earlier resource; forward or cyclic references are unsupported.');
      }
    }
    declared.add(object.getAttribute('id')!);
  }
  const configurations = list(data.objects,'objects').map(v => record(v,'object'));
  const configIds = new Set<number>(), volumeIds = new Set<number>();
  for (const cfg of configurations) {
    keys(cfg,['id','volumes','instances','object_settings'],'object');
    const id = integer(cfg.id,'object id',1); if (configIds.has(id)) fail('Duplicate object metadata.'); configIds.add(id);
    settings(cfg.object_settings,'Object');
    const parent = resource(String(id)), refs = children(child(parent,'components'),'component');
    const volumes = list(cfg.volumes,'volumes').map(v => record(v,'volume'));
    if (volumes.length !== refs.length || !volumes.length) fail('Volume metadata does not match the components.');
    const localIds = new Set<number>();
    for (const [i,v] of volumes.entries()) {
      keys(v,['id','type','volume_settings','source'],'volume');
      const vid = integer(v.id,'volume id',1); volumeIds.add(vid);
      if (localIds.has(vid) || refs[i].getAttribute('objectid') !== String(vid)) fail('Ambiguous volume references.'); localIds.add(vid);
      if (!ROLES.includes(String(v.type))) fail(`Unknown volume type: ${v.type}.`);
      settings(v.volume_settings,'Volume');
      if (v.source !== undefined) {
        const source = record(v.source,'volume source'); keys(source,['filepath','offset','isFromInch','isFromMeters','objectIdx','volumeIdx','repair'],'volume source');
      }
      const volume = resource(String(vid)), geometry = children(child(volume,'components'),'component');
      if (geometry.length !== 1 || geometry[0].hasAttribute('transform') || !meshes.has(geometry[0].getAttribute('objectid')!)) fail('Unsupported nested volume geometry.');
    }
  }
  const painting = files[PAINT] ? list(json(files[PAINT],'painting'),'painting').map(v => record(v,'painting entry')) : [];
  const paintKinds = ['mmSegmentationFacets','supportedFacets','seamFacets','fuzzySkinFacets'];
  const painted = new Set<number>();
  for (const p of painting) {
    keys(p,['id',...paintKinds,...paintKinds.map(k => `${k}Version`)],'painting');
    const id = integer(p.id,'painted volume',1);
    if (!volumeIds.has(id) || painted.has(id)) fail('Painting refers to a missing or duplicate volume.'); painted.add(id);
    const leaf = child(resource(String(id)),'components');
    const count = meshes.get(child(leaf,'component').getAttribute('objectid')!)!.triangles.length / 3;
    for (const kind of paintKinds) {
      if (p[kind] === undefined && p[`${kind}Version`] === undefined) continue;
      if (![1,2].includes(integer(p[`${kind}Version`] ?? 1,'painting version',1))) fail('Unrecognized painting version.');
      const triangles = new Set<number>();
      for (const item of list(p[kind],kind)) {
        const face = record(item,'painted triangle'); keys(face,['triangle','dividing'],'painted triangle');
        const index = integer(face.triangle,'painted triangle');
        if (index >= count || triangles.has(index) || typeof face.dividing !== 'string' || !/^[0-9a-f]+$/i.test(face.dividing)) fail('Invalid painting indices or encoding.');
        triangles.add(index);
      }
    }
  }
  const beds: Bed[] = [];
  for (const c of list(data.config_containers,'configuration groups')) {
    const container = record(c,'configuration group'); keys(container,['beds','preset','configuration','virtual_extruders'],'configuration group');
    if (container.virtual_extruders !== undefined) fail('Virtual extruders are not supported yet.');
    const preset = record(container.preset,'preset'), hw = record(preset.hw_config,'printer hardware');
    if (hw.technology !== 'fff' || hw.tool_count !== 1 || list(preset.materials,'materials').length !== 1) fail('Only single-tool, single-material FFF profiles are supported.');
    const config = configuration(container.configuration), printer = record(config.printer_settings,'printer settings'), print = record(config.print_settings,'print settings');
    if (printer.printer_technology !== 'FFF' || printer.single_extruder_multi_material === true || print.spiral_vase === true || Number(print.raft_layers) !== 0) fail('SLA, multimaterial, vase and raft printing are not supported.');
    const outline = list(printer.bed_shape,'bed outline').map(p => { const pair = list(p,'bed vertex'); if (pair.length !== 2) fail('Invalid bed vertex.'); return {x:finite(pair[0],'bed X'),y:finite(pair[1],'bed Y')}; });
    const minX = Math.min(...outline.map(p => p.x)), maxX = Math.max(...outline.map(p => p.x)), minY = Math.min(...outline.map(p => p.y)), maxY = Math.max(...outline.map(p => p.y));
    if (outline.length !== 4 || minX >= maxX || minY >= maxY || new Set(outline.map(p => `${p.x},${p.y}`)).size !== 4 || outline.some((p,i) => (p.x !== minX && p.x !== maxX) || (p.y !== minY && p.y !== maxY) || (p.x !== outline[(i+1)%4].x && p.y !== outline[(i+1)%4].y))) fail('Only rectangular bed outlines are supported.');
    const height = finite(printer.max_print_height,'print height'); if (height <= 0) fail('Invalid print height.');
    for (const value of list(container.beds,'beds')) {
      const node = record(value,'bed'); keys(node,['position_x','position_y','wipe_tower','custom_gcode'],'bed');
      if (node.wipe_tower !== null && node.wipe_tower !== undefined) fail('Wipe towers are not supported in this single-material adapter.');
      if (node.custom_gcode !== null && node.custom_gcode !== undefined) {
        const code = record(node.custom_gcode,'bed G-code'); keys(code,['mode','gcodes'],'bed G-code'); integer(code.mode,'G-code mode');
        for (const entry of list(code.gcodes,'bed G-code entries')) { const item = record(entry,'G-code entry'); keys(item,['gcode'],'G-code entry'); const g = record(item.gcode,'G-code'); keys(g,['type','print_z','extruder','color','extra'],'G-code'); integer(g.type,'G-code type'); finite(g.print_z,'G-code height'); if (integer(g.extruder,'G-code extruder') > 1 || typeof g.color !== 'string' || typeof g.extra !== 'string') fail('Unsupported bed G-code.'); }
      }
      const id = String(beds.length+1), printerName = typeof hw.config_name === 'string' ? hw.config_name : 'FFF';
      beds.push({id,name:`Bed ${id} · ${printerName}`,node,container,outline,config,x:finite(node.position_x,'bed position'),y:finite(node.position_y,'bed position'),minX,minY,maxX,maxY,height,instances:[]});
    }
  }
  if (!beds.length) fail('No beds are stored in this project.');
  for (const [i,a] of beds.entries()) if (beds.slice(i+1).some(b => a.minX+a.x < b.maxX+b.x && a.maxX+a.x > b.minX+b.x && a.minY+a.y < b.maxY+b.y && a.maxY+a.y > b.minY+b.y)) fail('Overlapping beds have ambiguous object assignments.');
  const items = children(build,'item'), printability = new Map<number,boolean>();
  for (const cfg of configurations) for (const value of cfg.instances === undefined ? [] : list(cfg.instances,'instances')) {
    const instance = record(value,'instance'); keys(instance,['ord','printable'],'instance'); const ord = integer(instance.ord,'instance order');
    if (ord >= items.length || printability.has(ord) || items[ord].getAttribute('objectid') !== String(cfg.id) || typeof instance.printable !== 'boolean') fail('Invalid instance metadata.');
    printability.set(ord,instance.printable as boolean);
  }
  let triangles = 0;
  for (const [index,item] of items.entries()) {
    attrs(item,['objectid','transform']); tags(item,[]);
    const cfg = configurations.find(c => String(c.id) === item.getAttribute('objectid')) || fail('Missing object settings.');
    const parent = resource(String(cfg.id)), transform = matrix(item.getAttribute('transform'));
    const volumes = cfg.volumes as JsonObject[];
    const parts = children(child(parent,'components'),'component').map((ref,i): ModelPart => {
      const volume = resource(ref.getAttribute('objectid')!), geometry = child(child(volume,'components'),'component');
      const mesh = meshes.get(geometry.getAttribute('objectid')!)!; triangles += mesh.triangles.length/3;
      if (triangles > 2_000_000) fail('The scene exceeds the two-million-triangle browser limit.');
      return {name:volume.getAttribute('name') || `Part ${volumes[i].id}`,kind:String(volumes[i].type),mesh:transformMesh(mesh,transform.clone().multiply(matrix(ref.getAttribute('transform'))))};
    });
    const positive = parts.filter(p => p.kind === 'ModelPart'); if (!positive.length) fail('An object has no positive model parts.');
    const bounds = {minX:Infinity,minY:Infinity,minZ:Infinity,maxX:-Infinity,maxY:-Infinity,maxZ:-Infinity};
    for (const part of positive) for (let i=0;i<part.mesh.vertices.length;i+=3) { const [x,y,z] = part.mesh.vertices.slice(i,i+3); bounds.minX=Math.min(bounds.minX,x); bounds.minY=Math.min(bounds.minY,y); bounds.minZ=Math.min(bounds.minZ,z); bounds.maxX=Math.max(bounds.maxX,x); bounds.maxY=Math.max(bounds.maxY,y); bounds.maxZ=Math.max(bounds.maxZ,z); }
    const candidates = beds.filter(b => bounds.minX >= b.x+b.minX-1e-5 && bounds.maxX <= b.x+b.maxX+1e-5 && bounds.minY >= b.y+b.minY-1e-5 && bounds.maxY <= b.y+b.maxY+1e-5 && bounds.minZ >= -1e-5 && bounds.maxZ <= b.height+1e-5);
    if (candidates.length !== 1) fail(`Object ${parent.getAttribute('name') || cfg.id} must fit completely inside exactly one bed. Move outside or crossing objects in PrusaSlicer first.`);
    if (Number(record(cfg.object_settings ?? {},'object settings').raft_layers ?? 0) !== 0) fail('Object rafts are not supported.');
    candidates[0].instances.push({index,item,cfg,parent,parts,printable:printability.get(index) !== false});
  }
  return {doc,root,resources,build,data,painting,beds};
}

export function importPrusa3Project(name: string, files: Record<string,Uint8Array>, modelPath: string, plateId?: string, modelDocument?: Doc): Project {
  const a = archive(files,modelPath,modelDocument), bed = plateId === undefined ? a.beds.find(b => b.instances.some(i => i.printable)) || a.beds[0] : a.beds.find(b => b.id === plateId);
  if (!bed) fail('The requested bed does not exist.');
  const translation = new Matrix4().makeTranslation(-bed!.x,-bed!.y,0);
  const objects: ModelObject[] = bed!.instances.filter(i => i.printable).map(i => ({id:`object-${i.index}`,name:i.parent.getAttribute('name') || `Object ${i.index+1}`,resourceId:String(i.cfg.id),buildIndex:i.index,transform:translation.clone().multiply(matrix(i.item.getAttribute('transform'))).toArray(),parts:i.parts.map(p => ({...p,mesh:transformMesh(p.mesh,translation)}))}));
  const warnings = ['Experimental PrusaSlicer 3.0.0-alpha12 support. Export contains only the selected bed.'];
  if (!objects.length) warnings.push('This bed has no printable model objects. Choose another bed.');
  const print = record(bed!.config.print_settings,'print settings'), tool = record(bed!.config.toolprint_settings,'tool settings');
  const effective = (key: string) => Array.isArray(tool[key]) && tool[key][0] !== null ? tool[key][0] : print[key];
  const h = record(effective('first_layer_height'),'first-layer height');
  const suggestedHeight = h.is_percent === false && typeof h.value === 'number' && h.value >= MIN_LAYER_HEIGHT && h.value <= MAX_LAYER_HEIGHT ? h.value : undefined;
  if (suggestedHeight === undefined) warnings.push('Choose the first-layer height manually; the stored value is relative or outside the supported range.');
  if (Number(effective('brim_width')) > 0 || bed!.instances.some(i => Number(record(i.cfg.object_settings ?? {},'object settings').brim_width) > 0)) warnings.push('Native slicer brim is enabled. Disable it in the slicer if unwanted.');
  if (Number(effective('xy_size_compensation')) || bed!.instances.some(i => Number(record(i.cfg.object_settings ?? {},'object settings').xy_size_compensation))) warnings.push('The project applies XY compensation. Check the separation gap after slicing.');
  if (objects.some(o => o.parts.some(p => p.kind === 'NegativeVolume'))) warnings.push('Negative volumes are applied in the footprint view. The 3D view shows the original positive meshes.');
  return {name,objects,bed:bed!.outline,warnings,suggestedHeight,format:'prusa3',source:{files,modelPath},plates:a.beds.map(b => ({id:b.id,name:b.name,objectCount:b.instances.length})),activePlateId:bed!.id};
}

function meshResource(doc: Doc, id: string, mesh: Mesh): El {
  const object = doc.createElementNS(NS,'object'); object.setAttribute('id',id);
  const body = doc.createElementNS(NS,'mesh'), vertices = doc.createElementNS(NS,'vertices'), triangles = doc.createElementNS(NS,'triangles'); object.appendChild(body); body.appendChild(vertices); body.appendChild(triangles);
  for (let i=0;i<mesh.vertices.length;i+=3) { const v = doc.createElementNS(NS,'vertex'); ['x','y','z'].forEach((k,j) => v.setAttribute(k,String(mesh.vertices[i+j]))); vertices.appendChild(v); }
  for (let i=0;i<mesh.triangles.length;i+=3) { const t = doc.createElementNS(NS,'triangle'); ['v1','v2','v3'].forEach((k,j) => t.setAttribute(k,String(mesh.triangles[i+j]))); triangles.appendChild(t); }
  return object;
}
export function exportPrusa3Project(project: Project, result: BrimResult, modelDocument?: Doc): Uint8Array {
  if (!project.source || project.format !== 'prusa3') fail('Native PrusaSlicer 3 input is required.');
  if (!result.objects.some(o => o.mesh.triangles.length)) throw new Error('Generate at least one brim before exporting.');
  const source = project.source!, files = {...source.files}, a = archive(files,source.modelPath,modelDocument);
  const bed = a.beds.find(b => b.id === project.activePlateId) || fail('Select a bed before export.');
  let id = Math.max(...children(a.resources,'object').map(o => Number(o.getAttribute('id'))))+1;
  const output: JsonObject[] = [], outputPainting: JsonObject[] = [];
  children(a.build,'item').forEach(remove);
  for (const [ordinal,i] of bed.instances.entries()) {
    const parent = i.parent.cloneNode(true) as El, parentId = id++; parent.setAttribute('id',String(parentId));
    const cfg = structuredClone(i.cfg), volumes = cfg.volumes as JsonObject[]; cfg.id = parentId;
    for (const [index,v] of volumes.entries()) {
      const oldId = Number(v.id), volumeId = id++;
      const original = children(a.resources,'object').find(o => o.getAttribute('id') === String(oldId))!;
      const volume = original.cloneNode(true) as El; volume.setAttribute('id',String(volumeId)); a.resources.appendChild(volume);
      children(child(parent,'components'),'component')[index].setAttribute('objectid',String(volumeId)); v.id = volumeId;
      const paint = a.painting.find(p => p.id === oldId); if (paint) outputPainting.push({...paint,id:volumeId});
    }
    delete cfg.instances; if (!i.printable) cfg.instances = [{ord:ordinal,printable:false}];
    if (i.printable) {
      cfg.object_settings = {...record(cfg.object_settings ?? {},'object settings'),elefant_foot_compensation:0};
      // Alpha12 permits volume-level compensation, which overrides the parent.
      for (const v of volumes) if (v.type === 'ModelPart') v.volume_settings = {...record(v.volume_settings ?? {},'volume settings'),elefant_foot_compensation:0};
    }
    const transform = new Matrix4().makeTranslation(-bed.x,-bed.y,0).multiply(matrix(i.item.getAttribute('transform')));
    const brim = i.printable && result.objects.find(o => o.id === `object-${i.index}`);
    if (brim && brim.mesh.triangles.length) {
      const meshId = id++, volumeId = id++;
      a.resources.appendChild(meshResource(a.doc,String(meshId),transformMesh(brim.mesh,transform.clone().invert())));
      const volume = a.doc.createElementNS(NS,'object'); volume.setAttribute('id',String(volumeId)); volume.setAttribute('name','Rolling brim');
      const components = a.doc.createElementNS(NS,'components'), geometry = a.doc.createElementNS(NS,'component'); geometry.setAttribute('objectid',String(meshId)); components.appendChild(geometry); volume.appendChild(components); a.resources.appendChild(volume);
      const component = a.doc.createElementNS(NS,'component'); component.setAttribute('objectid',String(volumeId)); child(parent,'components').appendChild(component);
      volumes.push({id:volumeId,type:'ModelPart',volume_settings:{perimeters:result.settings.perimeters,fill_density:{value:0,is_percent:true},top_solid_layers:0,bottom_solid_layers:0,top_solid_min_thickness:0,bottom_solid_min_thickness:0,gap_fill_enabled:false,ensure_vertical_shell_thickness:'disabled',only_one_perimeter_first_layer:false,top_one_perimeter_type:'none',ironing:false,elefant_foot_compensation:0,wipe_into_infill:false}});
    }
    output.push(cfg); a.resources.appendChild(parent);
    const item = i.item.cloneNode(true) as El; item.setAttribute('objectid',String(parentId)); item.setAttribute('transform',transformText(transform)); a.build.appendChild(item);
  }
  a.data.objects = output;
  a.data.config_containers = [{...bed.container,beds:[{...bed.node,position_x:0,position_y:0}]}];
  const all = children(a.resources,'object'), used = new Set<string>();
  const visit = (id: string) => { if (used.has(id)) return; used.add(id); const object = all.find(o => o.getAttribute('id') === id)!; for (const cs of children(object,'components')) for (const c of children(cs,'component')) visit(c.getAttribute('objectid')!); };
  children(a.build,'item').forEach(i => visit(i.getAttribute('objectid')!)); all.filter(o => !used.has(o.getAttribute('id')!)).forEach(remove);
  files[PROJECT] = strToU8(JSON.stringify(a.data,null,2));
  if (files[PAINT]) files[PAINT] = strToU8(JSON.stringify(outputPainting,null,2));
  delete files['Metadata/thumbnail.png'];
  const rels = xml(strFromU8(files['_rels/.rels']));
  children(rels.documentElement,'Relationship').filter(r => /\/thumbnail$/.test(r.getAttribute('Type') || '')).forEach(remove); files['_rels/.rels'] = serialize(rels);
  const ct = xml(strFromU8(files['[Content_Types].xml']));
  children(ct.documentElement,'Override').filter(n => n.getAttribute('PartName') === '/Metadata/thumbnail.png').forEach(remove); files['[Content_Types].xml'] = serialize(ct);
  children(a.root,'metadata').filter(m => /^Thumbnail/i.test(m.getAttribute('name') || '')).forEach(remove);
  files[source.modelPath] = serialize(a.doc);
  files['Metadata/rolling_brim.json'] = strToU8(JSON.stringify({version:1,settings:result.settings,sourceBed:bed.name,sampleZ:result.settings.height/2,printOrder:'Determined by PrusaSlicer; brim-first is not guaranteed.'}));
  return zipSync(files,{level:6});
}
