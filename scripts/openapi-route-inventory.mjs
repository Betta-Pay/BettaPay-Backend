import { readFileSync, writeFileSync } from 'node:fs';

const spec = JSON.parse(readFileSync('docs/openapi.json', 'utf8'));
const rows = Object.entries(spec.paths ?? {}).flatMap(([path, methods]) =>
  Object.entries(methods).filter(([method]) => ['get','post','put','patch','delete','options','head'].includes(method))
    .map(([method, operation]) => `| ${method.toUpperCase()} | \`${path}\` | ${operation.summary ?? operation.description ?? ''} |`),
);
const output = ['# API route inventory', '', `Generated from \`docs/openapi.json\` (OpenAPI ${spec.openapi}).`, '', '| Method | Path | Description |', '| --- | --- | --- |', ...(rows.length ? rows : ['| — | — | No routes are currently present in the generated OpenAPI document. |']), ''].join('\n');
writeFileSync('docs/route-inventory.md', output);
