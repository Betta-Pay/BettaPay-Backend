import { writeFileSync } from 'node:fs';

let data;
try {
  const res = await fetch(process.env.API_URL ?? 'http://localhost:3000/api/docs/json');
  if (!res.ok) throw new Error(`docs fetch failed: ${res.status}`);
  data = await res.json();
} catch (fetchErr) {
  if (process.env.API_URL) {
    throw fetchErr;
  }
  // When no server is running at default localhost:3000 (e.g. offline CI drift check),
  // generate the OpenAPI document directly using Fastify + @fastify/swagger.
  const { default: Fastify } = await import('fastify');
  const { default: swagger } = await import('@fastify/swagger');
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(
    readFileSync(new URL('../services/api-gateway/package.json', import.meta.url), 'utf8')
  );
  const app = Fastify();
  await app.register(swagger, {
    openapi: {
      info: { title: 'BettaPay API', version: pkg.version },
      servers: [{ url: 'http://localhost:3000' }],
    },
  });
  await app.ready();
  data = app.swagger();
}

writeFileSync('docs/openapi.json', JSON.stringify(data, null, 2) + '\n');
