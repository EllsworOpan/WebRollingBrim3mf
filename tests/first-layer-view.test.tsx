import { DOMParser } from '@xmldom/xmldom';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import FirstLayerView from '../src/components/FirstLayerView';
import { generateBrims } from '../src/core/brim';
import { intersectPolygons, totalArea } from '../src/core/geometry';
import { DEFAULT_BRIM } from '../src/core/types';
import { box, project } from './fixtures';

describe('overlapping objects in the footprint preview', () => {
  const result = generateBrims(project([box(),box(44,20)]),DEFAULT_BRIM);
  const paths = (reverse = false, showBrim = true, compare = true, selected: string | null = null) => {
    const markup = renderToStaticMarkup(<FirstLayerView result={{...result,objects:reverse ? [...result.objects].reverse() : result.objects}} bed={[]} showBrim={showBrim} compare={compare} probe={false} fitKey={0} selected={selected}/>);
    return Array.from(new DOMParser().parseFromString(markup,'text/html').getElementsByTagName('path'));
  };

  it.each([false,true])('keeps every model and comparison outline above all brims (reversed=%s)', reverse => {
    // Exercise a real intersection, where SVG paint order affects the visible model.
    expect(totalArea(intersectPolygons(result.objects[1].area,result.objects[0].footprint))).toBeGreaterThan(10);
    const rendered = paths(reverse);
    const brims = rendered.filter(p=>p.getAttribute('fill')==='#ffb454');
    const models = rendered.filter(p=>p.getAttribute('fill')==='#91a9af');
    const outlines = rendered.filter(p=>['#7ad5ff','#ec9de2'].includes(p.getAttribute('stroke') || ''));
    expect(brims).toHaveLength(2); expect(models).toHaveLength(2); expect(outlines).toHaveLength(4);
    expect(Math.max(...brims.map(p=>rendered.indexOf(p)))).toBeLessThan(Math.min(...models.map(p=>rendered.indexOf(p))));
    expect(Math.max(...models.map(p=>rendered.indexOf(p)))).toBeLessThan(Math.min(...outlines.map(p=>rendered.indexOf(p))));
  });

  it('keeps highlighting consistent across layers and can hide brims and outlines', () => {
    const visible = paths(false,true,true,'object-1').filter(p=>p.getAttribute('fill')==='#ffb454' || p.getAttribute('fill')==='#91a9af');
    expect(visible.map(p=>(p.parentNode as Element).getAttribute('opacity'))).toEqual(['0.3','1','0.3','1']);
    const hidden = paths(false,false,false);
    expect(hidden.filter(p=>p.getAttribute('fill')==='#91a9af')).toHaveLength(2);
    expect(hidden.some(p=>p.getAttribute('fill')==='#ffb454' || ['#7ad5ff','#ec9de2'].includes(p.getAttribute('stroke') || ''))).toBe(false);
  });
});
