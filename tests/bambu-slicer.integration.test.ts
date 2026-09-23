import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { importProject, exportProject, selectPlate } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';
import { boundsOf } from '../src/core/geometry';
import { box, stl } from './fixtures';
import { nativeFixture } from './native-fixtures';
import { children, xml } from '../src/core/three-mf-xml';

for (const format of ['bambu','orca'] as const) {
  const executable = process.env[format === 'orca' ? 'ORCA_SLICER' : 'BAMBU_STUDIO'] || resolve(`.local/${format}/${format === 'orca' ? 'orca-slicer' : 'bambu-studio'}.exe`);
  describe.skipIf(!existsSync(executable))(`${format} native slicer integration`, () => {
    it('retains part overrides, imports a painted multi-plate project, and reopens an extracted plate', () => {
      mkdirSync('.local',{recursive:true});
      const path = (suffix: string) => resolve(`.local/${format}-integration-${suffix}.3mf`);
      const run = (input: string, output: string) => execFileSync(executable,['--arrange','0','--export-3mf',output,input],{cwd:resolve('.local'),windowsHide:true,timeout:60000,stdio:'pipe'});
      const p = importProject('body.stl',stl(box(20,20,20,20,2)));
      writeFileSync(path('generated'),exportProject(p,generateBrims(p,DEFAULT_BRIM),format));
      run(path('generated'),path('saved'));
      const saved = unzipSync(readFileSync(path('saved'))), cfg = strFromU8(saved['Metadata/model_settings.config']);
      expect(cfg).toContain('key="wall_loops" value="99"');
      expect(cfg).toContain(`key="ensure_vertical_shell_thickness" value="${format === 'orca' ? 'none' : 'disabled'}"`);
      for (const key of ['top_shell_layers','bottom_shell_layers','gap_infill_speed','only_one_wall_first_layer']) expect(cfg).toContain(`key="${key}" value="0"`);
      expect(cfg).toContain('key="sparse_infill_density" value="0%"');
      // Slice with an explicit generic validation profile, never embedded into
      // the product's mesh-only export. Verify actual extrusion roles and Z.
      const slicing = unzipSync(readFileSync(path('generated')));
      const slicingProfile = JSON.parse(strFromU8(saved['Metadata/project_settings.config']));
      Object.assign(slicingProfile,{printer_settings_id:'Validation printer',print_settings_id:'Validation process',filament_settings_id:['Validation PLA'],printer_model:'Generic',printer_variant:'0.4',inherits_group:['','',''],different_settings_to_system:['','',''],printable_area:['0x0','200x0','200x200','0x200'],printable_height:'200',layer_height:'0.2',initial_layer_print_height:'0.2',brim_type:'no_brim',brim_width:'0',enable_prime_tower:'0',skirt_loops:'0',skirt_height:'0',nozzle_temperature:['200'],nozzle_temperature_initial_layer:['200'],machine_start_gcode:'G28\nG92 E0',machine_end_gcode:'M104 S0',layer_change_gcode:'G92 E0',gcode_flavor:'marlin',use_relative_e_distances:'1'});
      slicing['Metadata/project_settings.config'] = strToU8(JSON.stringify(slicingProfile));
      slicing['3D/3dmodel.model'] = strToU8(strFromU8(slicing['3D/3dmodel.model']).replace('RollingBrim-0.1.0',format === 'orca' ? 'OrcaSlicer-2.4.2' : 'BambuStudio-02.08.02.61'));
      writeFileSync(path('slice'),zipSync(slicing));
      const dir = resolve(`.local/${format}-integration-sliced`); mkdirSync(dir,{recursive:true});
      execFileSync(executable,['--arrange','0','--slice','1','--outputdir',dir,path('slice')],{cwd:resolve('.local'),windowsHide:true,timeout:60000,stdio:'pipe'});
      let x=0,y=0,z=0,type='',brimMoves=0;
      for (const line of readFileSync(`${dir}/plate_1.gcode`,'utf8').split(/\r?\n/)) {
        if (line.startsWith(';TYPE:')) type=line.slice(6);
        if (line.startsWith('; FEATURE: ')) type=line.slice(11);
        if (!/^G[01] /.test(line)) continue;
        const fields = Object.fromEntries([...line.matchAll(/([XYZE])([-+]?(?:\d+\.?\d*|\.\d+))/g)].map(m=>[m[1],Number(m[2])]));
        const px=x,py=y; x=fields.X??x; y=fields.Y??y; z=fields.Z??z;
        if (!(fields.E>0) || Math.hypot(x-px,y-py)<0.001) continue;
        const mx=(x+px)/2,my=(y+py)/2;
        if (mx>=19.99 && mx<=40.01 && my>=19.99 && my<=40.01) continue;
        brimMoves++; expect(z).toBeCloseTo(0.2,4); expect(type).toMatch(/wall/i);
      }
      expect(brimMoves).toBeGreaterThan(100);
      const fixture = unzipSync(new Uint8Array(nativeFixture(format === 'orca' ? 'OrcaSlicer' : 'BambuStudio')));
      const profile = JSON.parse(strFromU8(saved['Metadata/project_settings.config']));
      Object.assign(profile,JSON.parse(strFromU8(fixture['Metadata/project_settings.config'])),{printer_settings_id:'Validation printer',print_settings_id:'Validation process',filament_settings_id:['Validation PLA','Validation PLA'],printer_model:'Generic',printer_variant:'0.4',inherits_group:['','','',''],different_settings_to_system:['','','','']});
      fixture['Metadata/project_settings.config'] = strToU8(JSON.stringify(profile));
      // Use a producer version accepted by the release being exercised.
      if (format === 'bambu') fixture['3D/3dmodel.model'] = strToU8(strFromU8(fixture['3D/3dmodel.model']).replace('BambuStudio-2.4.2','BambuStudio-02.08.02.61'));
      writeFileSync(path('seed'),zipSync(fixture)); run(path('seed'),path('fixture'));
      const input = readFileSync(path('fixture')), project = importProject('native.3mf',new Uint8Array(input).buffer);
      expect(project.format).toBe(format); expect(project.plates).toHaveLength(4);
      const selected = selectPlate(project,'2'), result = generateBrims(selected,DEFAULT_BRIM,[selected.objects[0].id]);
      const output = exportProject(selected,result); writeFileSync(path('selected'),output); run(path('selected'),path('reopened'));
      const reopened = importProject('reopened.3mf',new Uint8Array(readFileSync(path('reopened'))).buffer);
      expect(reopened.plates).toHaveLength(1);
      expect(reopened.objects).toHaveLength(selected.objects.length);
      expect(reopened.objects.reduce((n,o) => n+o.parts.filter(p => p.name === 'Rolling brim').length,0)).toBe(1);
      const after = generateBrims(reopened,DEFAULT_BRIM);
      expect(boundsOf(after.objects[1]?.footprint || after.objects[0].footprint).minX).toBeCloseTo(boundsOf(result.objects[1]?.footprint || result.objects[0].footprint).minX,3);
      const exported = unzipSync(output), source = unzipSync(input);
      for (const [name,bytes] of Object.entries(exported)) if (/3D\/Objects\/.*\.model$/.test(name)) {
        const before = xml(strFromU8(source[name])), after = xml(strFromU8(bytes));
        expect(Array.from(after.getElementsByTagName('triangle')).map(t => t.toString())).toEqual(Array.from(before.getElementsByTagName('triangle')).map(t => t.toString()));
      }
      const nativeCfg = xml(strFromU8(unzipSync(readFileSync(path('reopened')))['Metadata/model_settings.config']));
      expect(children(nativeCfg.documentElement,'plate')).toHaveLength(1);
      const whole = exportProject(project,generateBrims(project,DEFAULT_BRIM,[project.objects[0].id,project.objects.at(-1)!.id]));
      writeFileSync(path('whole'),whole); run(path('whole'),path('whole-reopened'));
      const full = importProject('whole-reopened.3mf',new Uint8Array(readFileSync(path('whole-reopened'))).buffer);
      expect(full.plates).toEqual(project.plates);
      expect(full.objects.map(o => o.plateId)).toEqual(project.objects.map(o => o.plateId));
      expect(full.objects.reduce((n,o) => n+o.parts.filter(p => p.name === 'Rolling brim').length,0)).toBe(2);
      full.objects.forEach((o,i) => {
        const b = boundsOf(generateBrims({...full,objects:[{...o,parts:o.parts.filter(p => p.name !== 'Rolling brim')}]},DEFAULT_BRIM).objects[0].footprint);
        const old = boundsOf(generateBrims({...project,objects:[project.objects[i]]},DEFAULT_BRIM).objects[0].footprint);
        for (const key of ['minX','minY','maxX','maxY'] as const) expect(b[key]).toBeCloseTo(old[key],3);
      });
      const wholeFiles = unzipSync(whole);
      expect(wholeFiles['Metadata/project_settings.config']).toEqual(source['Metadata/project_settings.config']);
      expect(wholeFiles['Metadata/custom_gcode_per_layer.xml']).toEqual(source['Metadata/custom_gcode_per_layer.xml']);
    },120000);
  });
}
