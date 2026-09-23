import { readFileSync, writeFileSync } from 'node:fs';

// Input: the unmodified --export-config-schema output of 3.0.0-alpha12.
// This records format facts, not slicer implementation code or preset values.
if (!process.argv[2]) throw new Error('Usage: node scripts/update-prusa3-schema.mjs <alpha12-schema.json>');
const full = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const names = {printer:'printer_settings', print:'print_settings', tool_print:'toolprint_settings', filament:'filament_settings'};
const output = {};
for (const [key, target] of Object.entries(names)) {
  const section = full[key];
  output[target] = Object.fromEntries([...section.items, ...section.overrides].map(item => [item.name, {
    type:item.type,
    ...(item.element_type ? {element:item.element_type} : {}),
    ...(item.enum_values ? {values:item.enum_values} : {}),
    ...(item.overrides_in?.length ? {overrides:item.overrides_in} : {}),
    ...(section.overrides.includes(item) ? {nullable:true} : {}),
  }]));
}
writeFileSync(new URL('../src/core/prusa3-schema.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
