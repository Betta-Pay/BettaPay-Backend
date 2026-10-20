#!/usr/bin/env node
/**
 * scripts/check-source-integrity.mjs
 *
 * Repository guard to enforce:
 * 1. No conflict-artifact tokens (e.g., upstream/main, merge conflict markers) in source files.
 * 2. No repeated/duplicated import specifiers within a single file.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const SCAN_DIRS = ['services', 'shared', 'src'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const CONFLICT_MARKER_REGEX = /^(<{7}|>{7}|={7})(?: |$)/;
const BRANCH_TOKEN_REGEX = /\bupstream\/main\b/;

export function findSourceFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === '.git' ||
        entry.name === '.pnpm'
      ) {
        continue;
      }
      findSourceFiles(fullPath, fileList);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (EXTENSIONS.has(ext)) {
        fileList.push(fullPath);
      }
    }
  }

  return fileList;
}

export function checkConflictArtifacts(filePath, content) {
  const isTest = filePath.includes('.test.') || filePath.includes('__tests__');
  if (filePath.endsWith('check-source-integrity.mjs') || filePath.includes('test/source-integrity')) {
    return [];
  }

  const errors = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (CONFLICT_MARKER_REGEX.test(trimmed)) {
      errors.push({
        file: filePath,
        line: i + 1,
        token: trimmed.slice(0, 7),
        content: line.trim(),
      });
    } else if (!isTest && BRANCH_TOKEN_REGEX.test(line)) {
      errors.push({
        file: filePath,
        line: i + 1,
        token: 'upstream/main',
        content: line.trim(),
      });
    }
  }

  return errors;
}

export function checkDuplicateImports(filePath, content) {
  const errors = [];
  const lines = content.split('\n');

  // Track all imported symbols per file
  const seenSpecifiers = new Map(); // symbol -> line number

  // Combine multiline import statements into single blocks while preserving line numbers
  let inImport = false;
  let importBuffer = '';
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!inImport) {
      if (trimmed.startsWith('import ') || trimmed.startsWith('import{')) {
        inImport = true;
        importBuffer = line;
        startLine = i + 1;
        if (line.includes(';') || line.includes("from '") || line.includes('from "')) {
          inImport = false;
          processImportBlock(importBuffer, startLine, filePath, seenSpecifiers, errors);
          importBuffer = '';
        }
      }
    } else {
      importBuffer += ' ' + line;
      if (line.includes(';') || line.includes("from '") || line.includes('from "')) {
        inImport = false;
        processImportBlock(importBuffer, startLine, filePath, seenSpecifiers, errors);
        importBuffer = '';
      }
    }
  }

  return errors;
}

function processImportBlock(importStmt, lineNum, filePath, seenSpecifiers, errors) {
  // Extract named imports inside { ... }
  const match = importStmt.match(/\{([^}]+)\}/);
  if (!match) return;

  const rawSpecifiers = match[1].split(',');
  for (const raw of rawSpecifiers) {
    const spec = raw.trim();
    if (!spec) continue;

    // Handle "type Foo" or "Foo as Bar"
    const cleaned = spec.replace(/^type\s+/, '').trim();
    const parts = cleaned.split(/\s+as\s+/);
    const importedName = parts[parts.length - 1].trim(); // Local binding name

    if (!importedName) continue;

    if (seenSpecifiers.has(importedName)) {
      errors.push({
        file: filePath,
        symbol: importedName,
        firstLine: seenSpecifiers.get(importedName),
        duplicateLine: lineNum,
      });
    } else {
      seenSpecifiers.set(importedName, lineNum);
    }
  }
}

export function runChecks(targetDirs = SCAN_DIRS, baseDir = rootDir) {
  const allFiles = [];
  for (const relDir of targetDirs) {
    const fullDir = path.resolve(baseDir, relDir);
    findSourceFiles(fullDir, allFiles);
  }

  const conflictErrors = [];
  const duplicateImportErrors = [];

  for (const file of allFiles) {
    const content = fs.readFileSync(file, 'utf8');

    const conflicts = checkConflictArtifacts(file, content);
    if (conflicts.length > 0) {
      conflictErrors.push(...conflicts);
    }

    const dupes = checkDuplicateImports(file, content);
    if (dupes.length > 0) {
      duplicateImportErrors.push(...dupes);
    }
  }

  return { conflictErrors, duplicateImportErrors };
}

// CLI runner
if (process.argv[1] && process.argv[1].endsWith('check-source-integrity.mjs')) {
  const { conflictErrors, duplicateImportErrors } = runChecks();

  let failed = false;

  if (conflictErrors.length > 0) {
    failed = true;
    console.error('::error::Conflict-artifact tokens found:');
    for (const err of conflictErrors) {
      console.error(`  ${err.file}:${err.line} - token "${err.token}": ${err.content}`);
    }
  }

  if (duplicateImportErrors.length > 0) {
    failed = true;
    console.error('::error::Duplicated import specifiers found:');
    for (const err of duplicateImportErrors) {
      console.error(
        `  ${err.file}:${err.duplicateLine} - symbol "${err.symbol}" already imported at line ${err.firstLine}`
      );
    }
  }

  if (failed) {
    process.exit(1);
  } else {
    console.log('Source integrity check passed: no conflict tokens or duplicate imports found.');
  }
}
