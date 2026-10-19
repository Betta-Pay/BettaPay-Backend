#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

/**
 * Workspace linter for BettaPay backend packages (#830).
 * Recursively checks TypeScript and JavaScript source files across workspace packages
 * for forbidden language constructs (debugger, direct eval, var declarations),
 * code quality invariants, and syntax conventions. Exits non-zero (1) on violations.
 */

const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();

function collectFiles(dir) {
  let files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === '.git' ||
        entry.name === 'scripts'
      ) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files = files.concat(collectFiles(fullPath));
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))
      ) {
        files.push(fullPath);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return files;
}

const files = collectFiles(targetDir);
let violations = 0;

for (const file of files) {
  const relPath = path.relative(process.cwd(), file);
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    const lineNum = index + 1;
    const trimmed = line.trim();

    // Skip comment lines
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      return;
    }

    // Check: Debugger statement
    if (/\bdebugger\b;?/.test(line)) {
      console.error(`[LINT] ${relPath}:${lineNum}: 'debugger' statement is forbidden in production code`);
      violations++;
    }

    // Check: Direct global eval() invocation (not object property or method declaration)
    if (/(?:^|[=(;,+!&|?]\s*)\beval\s*\(/.test(line)) {
      console.error(`[LINT] ${relPath}:${lineNum}: Direct 'eval()' invocation is forbidden`);
      violations++;
    }

    // Check: Deprecated 'var ' declarations (must use const or let)
    if (/^\s*var\s+[a-zA-Z0-9_$]+/.test(line)) {
      console.error(`[LINT] ${relPath}:${lineNum}: 'var' is forbidden, use 'const' or 'let'`);
      violations++;
    }
  });
}

if (violations > 0) {
  console.error(`\n[LINT] Failed: ${violations} violation(s) found in ${files.length} file(s).`);
  process.exit(1);
} else {
  console.log(`[LINT] Passed: ${files.length} file(s) checked with 0 violations.`);
  process.exit(0);
}
