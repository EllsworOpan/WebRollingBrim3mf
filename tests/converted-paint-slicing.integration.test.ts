import { it } from 'vitest';
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { importProject, exportProject } from '../src/core/three-mf';
import { convertCleanProject } from '../src/core/convert-3mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';
import { box, stl } from './fixtures';
import { assertPrusaUsesPaint, canSlicePrusa } from './helpers/prusa-slice';

for (const [slot, paint] of [
  [17, 'EC'],
  [32, 'EFC'],
] as const)
  it.skipIf(!canSlicePrusa)(
    `Bambu slot ${slot} converted to Prusa produces extrusion with the matching tool`,
    () => {
      const seed = importProject('cube.stl', stl(box(20, 20, 4, 4, 2)));
      const files = unzipSync(exportProject(seed, generateBrims(seed, DEFAULT_BRIM), 'bambu'));
      // Paint every triangle, including the brim. Ignoring paint would use slot 1.
      for (const path of Object.keys(files).filter((p) => p.endsWith('.model')))
        files[path] = strToU8(
          strFromU8(files[path]).replace(/<triangle\s/g, `<triangle paint_color="${paint}" `),
        );
      const bytes = zipSync(files),
        source = importProject('bambu.3mf', bytes.slice().buffer);
      const converted = convertCleanProject(source, 'prusa');
      assertPrusaUsesPaint(zipSync(converted.source!.files), slot);
    },
    60000,
  );
