import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { importProject, exportProject, selectPlate } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';
import { archive, box, meshXml, project } from './fixtures';

// Original geometry plus the markers published in Prusa's alpha12 serializer.
// These deliberately incomplete files exercise detection before any legacy fallback.
function fixture(metadata: Record<string, string> = {}, application?: string, legacy = false) {
  const files = unzipSync(new Uint8Array(archive(`<object id="1">${meshXml(box())}</object>`, '<item objectid="1"/>')));
  if (!legacy) delete files['Metadata/Slic3r_PE_model.config'];
  for (const [path, value] of Object.entries(metadata)) files[path] = strToU8(value);
  if (application) files['3D/3dmodel.model'] = strToU8(strFromU8(files['3D/3dmodel.model']).replace('<resources>', `<metadata name="Application">${application}</metadata><resources>`));
  return zipSync(files).slice().buffer;
}

describe('3MF dialect routing', () => {
  it.each([
    'Metadata/PrusaSlicer3_project.json',
    'Metadata/Slic3r_facets_annotation.json',
    'metadata/prusaslicer3_project.json',
  ])('rejects %s instead of silently reading generic geometry', path => {
    expect(() => importProject('future.3mf', fixture({[path]:'{}'}))).toThrow(/Unsupported PrusaSlicer 3\.0 project/);
  });

  it.each(['PrusaSlicer-3.0.0-alpha12', 'PrusaSlicer-3.0.0', 'PrusaSlicer-4.1.0'])('detects %s even without its project JSON', application => {
    expect(() => importProject('future.3mf', fixture({}, application))).toThrow(/Unsupported PrusaSlicer 3\.0 project/);
  });

  it('checks new-format markers before legacy or Bambu/Orca fallback, including malformed JSON', () => {
    const input = fixture({'Metadata/PrusaSlicer3_project.json':'not JSON', 'Metadata/model_settings.config':'<config/>'}, 'PrusaSlicer-2.9.6', true);
    expect(() => importProject('hybrid.3mf', input)).toThrow(/Unsupported PrusaSlicer 3\.0 project/);
  });

  it.each(['PrusaSlicer-2.9.6', 'ThirdPartyTool-3.0.0'])('keeps supported input from %s working', application => {
    const p = importProject('supported.3mf', fixture({}, application, application.startsWith('Prusa')));
    expect(p.format).toBe(application.startsWith('Prusa') ? 'prusa' : 'generic');
    expect(importProject('roundtrip.3mf', exportProject(p, generateBrims(p, DEFAULT_BRIM)).slice().buffer).objects[0].parts).toHaveLength(2);
  });

  it('cannot export or select a plate from a source checkpoint containing unsupported metadata', () => {
    const p = project([box()]), result = generateBrims(p, DEFAULT_BRIM);
    p.source = {files:unzipSync(new Uint8Array(fixture({'Metadata/PrusaSlicer3_project.json':'{}'}))), modelPath:'3D/3dmodel.model'};
    const before = structuredClone(p.source);
    for (const format of ['prusa','bambu','orca'] as const) expect(() => exportProject(p, result, format)).toThrow(/PrusaSlicer 3\.0/);
    expect(() => selectPlate(p, '1')).toThrow(/PrusaSlicer 3\.0/);
    expect(p.source).toEqual(before);
  });

  it('rejects plate selection for a legacy project without inventing bed assignments', () => {
    const p = importProject('legacy.3mf', fixture({}, 'PrusaSlicer-2.9.6', true));
    expect(() => selectPlate(p, '1')).toThrow(/does not contain selectable plates/);
  });
});
