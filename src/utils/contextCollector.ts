import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';

export interface ProjectContext {
  framework:    string;
  language:     string;
  database:     string;
  authSystem:   string;
  packageName:  string;
  dependencies: string[];
  devDeps:      string[];
  scripts:      string[];
  envVars:      string[];
  openFiles:    string[];
  rootPath:     string;
}

export interface FileContext {
  fileName:     string;
  filePath:     string;
  language:     string;
  fullContent:  string;
  selectedCode: string;
  imports:      string[];
  cursorLine:   number;
  cursorCol:    number;
  lineCount:    number;
}

export interface CodebaseFile {
  path:     string;       // relative path from workspace root
  absPath:  string;       // absolute path
  name:     string;       // basename
  language: string;
  size:     number;
}

export interface CodebaseIndex {
  files:     CodebaseFile[];
  rootPath:  string;
  indexedAt: number;
}

// ── File extension → language ─────────────────────────────────────────────────
const EXT_LANG: Record<string, string> = {
  '.ts':   'typescript',  '.tsx':  'typescriptreact',
  '.js':   'javascript',  '.jsx':  'javascriptreact',
  '.py':   'python',      '.go':   'go',
  '.rs':   'rust',        '.java': 'java',
  '.cpp':  'cpp',         '.c':    'c',
  '.cs':   'csharp',      '.rb':   'ruby',
  '.php':  'php',         '.swift':'swift',
  '.kt':   'kotlin',      '.md':   'markdown',
  '.json': 'json',        '.yaml': 'yaml',
  '.yml':  'yaml',        '.sql':  'sql',
  '.html': 'html',        '.css':  'css',
  '.scss': 'scss',        '.sh':   'shellscript',
  '.env':  'dotenv',      '.toml': 'toml',
};

// Directories to ignore during indexing
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', 'env', '.env', 'vendor', 'target',
  'coverage', '.nyc_output', '.cache', '.parcel-cache', 'tmp', 'temp',
  '.turbo', '.vercel', '.netlify', 'storybook-static',
]);

// ── Scan workspace for all code files ────────────────────────────────────────
export function indexWorkspace(rootPath: string, maxFiles = 500): CodebaseFile[] {
  const results: CodebaseFile[] = [];

  function walk(dir: string, depth: number) {
    if (depth > 8) return;
    if (results.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const name = entry.name;

      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(name) && !name.startsWith('.')) {
          walk(path.join(dir, name), depth + 1);
        }
        continue;
      }

      if (!entry.isFile()) continue;
      const ext  = path.extname(name).toLowerCase();
      const lang = EXT_LANG[ext];
      if (!lang) continue;

      const absPath = path.join(dir, name);
      const relPath = path.relative(rootPath, absPath).replace(/\\/g, '/');
      let size = 0;
      try { size = fs.statSync(absPath).size; } catch {}
      if (size > 500_000) continue; // skip files > 500KB

      results.push({ path: relPath, absPath, name, language: lang, size });
    }
  }

  walk(rootPath, 0);
  return results;
}

// ── Read content of a specific file safely ────────────────────────────────────
export function readFileContent(absPath: string): string {
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > 200_000) {
      return fs.readFileSync(absPath, 'utf8').slice(0, 200_000) + '\n// [truncated — file too large]';
    }
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
}

// ── Detect framework from package.json ────────────────────────────────────────
function detectFramework(deps: string[]): string {
  if (deps.includes('next'))             return 'Next.js';
  if (deps.includes('react'))            return 'React';
  if (deps.includes('vue'))              return 'Vue.js';
  if (deps.includes('nuxt'))             return 'Nuxt.js';
  if (deps.includes('@angular/core'))    return 'Angular';
  if (deps.includes('svelte'))           return 'Svelte';
  if (deps.includes('astro'))            return 'Astro';
  if (deps.includes('express'))          return 'Express.js';
  if (deps.includes('fastify'))          return 'Fastify';
  if (deps.includes('@nestjs/core'))     return 'NestJS';
  if (deps.includes('hono'))             return 'Hono';
  if (deps.includes('django'))           return 'Django';
  if (deps.includes('flask'))            return 'Flask';
  if (deps.includes('fastapi'))          return 'FastAPI';
  if (deps.includes('laravel'))          return 'Laravel';
  if (deps.includes('rails'))            return 'Rails';
  return 'Node.js';
}

function detectDatabase(deps: string[]): string {
  if (deps.includes('mongoose') || deps.includes('mongodb'))       return 'MongoDB';
  if (deps.includes('pg') || deps.includes('postgres'))            return 'PostgreSQL';
  if (deps.includes('mysql') || deps.includes('mysql2'))           return 'MySQL';
  if (deps.includes('sqlite3') || deps.includes('better-sqlite3')) return 'SQLite';
  if (deps.includes('prisma') || deps.includes('@prisma/client'))  return 'Prisma';
  if (deps.includes('typeorm'))                                     return 'TypeORM';
  if (deps.includes('drizzle-orm'))                                 return 'Drizzle';
  if (deps.includes('sequelize'))                                   return 'Sequelize';
  if (deps.includes('redis') || deps.includes('ioredis'))          return 'Redis';
  return 'none';
}

function detectAuth(deps: string[]): string {
  if (deps.includes('next-auth') || deps.includes('@auth/core'))   return 'NextAuth';
  if (deps.includes('passport') || deps.includes('passport-jwt'))  return 'Passport.js';
  if (deps.includes('jsonwebtoken'))                                return 'JWT';
  if (deps.includes('firebase-admin'))                              return 'Firebase Auth';
  if (deps.includes('@supabase/supabase-js'))                       return 'Supabase Auth';
  if (deps.includes('clerk'))                                       return 'Clerk';
  if (deps.includes('auth0'))                                       return 'Auth0';
  if (deps.includes('lucia'))                                       return 'Lucia';
  return 'none';
}

// ── Read .env keys ────────────────────────────────────────────────────────────
function readEnvKeys(rootPath: string): string[] {
  const envFiles = ['.env', '.env.local', '.env.example', '.env.development'];
  const keys: string[] = [];
  for (const f of envFiles) {
    const p = path.join(rootPath, f);
    if (fs.existsSync(p)) {
      try {
        for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
          const m = l.match(/^([A-Z_][A-Z0-9_]*)=/);
          if (m) keys.push(m[1]);
        }
      } catch {}
    }
  }
  return [...new Set(keys)];
}

// ── Extract ES / CJS imports ──────────────────────────────────────────────────
export function extractImports(content: string): string[] {
  const imports: string[] = [];
  for (const m of content.matchAll(/^import\s+(?:.+\s+from\s+)?['"]([^'"]+)['"]/gm)) imports.push(m[1]);
  for (const m of content.matchAll(/require\(['"]([^'"]+)['"]\)/g)) imports.push(m[1]);
  return [...new Set(imports)];
}

// ── Collect project context ───────────────────────────────────────────────────
export function collectProjectContext(): ProjectContext {
  const wsFolder   = vscode.workspace.workspaceFolders?.[0];
  const rootPath   = wsFolder?.uri.fsPath || '';
  const pkgPath    = rootPath ? path.join(rootPath, 'package.json') : '';

  let packageName  = '';
  let dependencies: string[] = [];
  let devDeps:      string[] = [];
  let scripts:      string[] = [];

  if (pkgPath && fs.existsSync(pkgPath)) {
    try {
      const pkg  = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      packageName  = pkg.name || '';
      dependencies = Object.keys(pkg.dependencies  || {});
      devDeps      = Object.keys(pkg.devDependencies || {});
      scripts      = Object.keys(pkg.scripts || {});
    } catch {}
  }

  const allDeps    = [...dependencies, ...devDeps];
  const openFiles  = vscode.workspace.textDocuments
    .filter(d => !d.isUntitled && !d.uri.path.includes('node_modules'))
    .slice(0, 10)
    .map(d => path.relative(rootPath, d.fileName).replace(/\\/g, '/') || path.basename(d.fileName));

  return {
    framework:    detectFramework(allDeps),
    language:     vscode.window.activeTextEditor?.document.languageId || 'typescript',
    database:     detectDatabase(allDeps),
    authSystem:   detectAuth(allDeps),
    packageName,
    dependencies: dependencies.slice(0, 30),
    devDeps:      devDeps.slice(0, 20),
    scripts,
    envVars:      readEnvKeys(rootPath),
    openFiles,
    rootPath,
  };
}

// ── Collect active file context ───────────────────────────────────────────────
export function collectFileContext(): FileContext | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;

  const doc      = editor.document;
  const selected = !editor.selection.isEmpty ? doc.getText(editor.selection) : '';

  return {
    fileName:     path.basename(doc.fileName),
    filePath:     doc.fileName,
    language:     doc.languageId,
    fullContent:  doc.getText(),
    selectedCode: selected,
    imports:      extractImports(doc.getText()),
    cursorLine:   editor.selection.active.line + 1,
    cursorCol:    editor.selection.active.character + 1,
    lineCount:    doc.lineCount,
  };
}

// ── Build system prompt with full context ─────────────────────────────────────
export function buildContextPrompt(
  proj: ProjectContext,
  file: FileContext | null,
  mentionedFiles?: Array<{ name: string; content: string }>
): string {
  let ctx = `You are DevMind AI, an expert coding assistant embedded in VS Code.

=== PROJECT ===
Framework: ${proj.framework}  |  Language: ${proj.language}  |  DB: ${proj.database}  |  Auth: ${proj.authSystem}
Package: ${proj.packageName || 'unnamed'}
Dependencies: ${proj.dependencies.slice(0, 15).join(', ') || 'none'}
Scripts: ${proj.scripts.join(', ') || 'none'}
Env vars: ${proj.envVars.slice(0, 8).join(', ') || 'none'}
Open files: ${proj.openFiles.slice(0, 6).join(', ') || 'none'}
`;

  if (file) {
    ctx += `
=== ACTIVE FILE: ${file.fileName} (${file.language}) ===
Path: ${file.filePath}
Lines: ${file.lineCount}  |  Cursor: L${file.cursorLine}:C${file.cursorCol}
Imports: ${file.imports.slice(0, 10).join(', ') || 'none'}
`;
    if (file.selectedCode) {
      ctx += `\n=== SELECTED CODE ===\n\`\`\`${file.language}\n${file.selectedCode}\n\`\`\`\n`;
    } else if (file.fullContent.length < 10000) {
      ctx += `\n=== FILE CONTENT ===\n\`\`\`${file.language}\n${file.fullContent}\n\`\`\`\n`;
    } else {
      // For large files, send first 4KB + last 1KB
      const head = file.fullContent.slice(0, 4000);
      const tail = file.fullContent.slice(-1000);
      ctx += `\n=== FILE CONTENT (partial — ${file.lineCount} lines) ===\n\`\`\`${file.language}\n${head}\n// ... [middle truncated] ...\n${tail}\n\`\`\`\n`;
    }
  }

  // Mentioned files via @ mention
  if (mentionedFiles && mentionedFiles.length > 0) {
    for (const mf of mentionedFiles) {
      ctx += `\n=== MENTIONED FILE: ${mf.name} ===\n\`\`\`\n${mf.content.slice(0, 8000)}\n\`\`\`\n`;
    }
  }

  ctx += `
=== RULES ===
- Use ${proj.framework} conventions and patterns throughout
- Use ${proj.database !== 'none' ? proj.database : 'the project database'} for data
- Use ${proj.authSystem !== 'none' ? proj.authSystem : 'project auth'} for auth
- Match existing code style exactly (spacing, naming, imports)
- Generate production-ready, type-safe, error-handled code
`;
  return ctx;
}

// ── Build a compact codebase summary for large-project context ────────────────
export function buildCodebaseSummary(files: CodebaseFile[], rootPath: string): string {
  // Group by directory
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const dir = path.dirname(f.path) || '.';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(f.name);
  }

  let summary = `=== CODEBASE STRUCTURE (${files.length} files) ===\n`;
  for (const [dir, names] of byDir) {
    summary += `${dir}/\n  ${names.slice(0, 15).join(', ')}${names.length > 15 ? ` (+${names.length - 15} more)` : ''}\n`;
  }
  return summary;
}

// ── Prompt optimization ───────────────────────────────────────────────────────
export function optimizePrompt(rawPrompt: string, proj: ProjectContext): string {
  const fw   = proj.framework;
  const db   = proj.database !== 'none' ? proj.database : '';
  const auth = proj.authSystem !== 'none' ? proj.authSystem : '';
  const lang = proj.language;

  const expansions: Array<[RegExp, string]> = [
    [/\bcreate login\b/i,    `Generate a complete login endpoint for ${fw} using ${auth || 'JWT'} with input validation and error handling`],
    [/\bcreate auth\b/i,     `Generate a full auth system for ${fw} using ${auth || 'JWT'}: register, login, logout, refresh, middleware`],
    [/\bcreate crud\b/i,     `Generate a complete CRUD module for ${fw} with ${db || 'the project DB'}: model, controller, routes, validation`],
    [/\bcreate api\b/i,      `Generate a REST API endpoint for ${fw} with validation, error handling, and ${db || 'DB'} integration`],
    [/\bwrite tests?\b/i,    `Generate comprehensive unit tests for this ${lang} code: happy path, edge cases, error scenarios, mocks`],
    [/\boptimize\b/i,        `Analyze and optimize this ${lang} code for performance, memory, and ${fw} best practices`],
    [/\brefactor\b/i,        `Refactor this ${lang} code for ${fw} conventions, readability, type safety, and maintainability`],
    [/\bexplain\b/i,         `Explain this ${lang} code: purpose, inputs/outputs, dependencies, complexity, issues, suggestions`],
    [/\bschema\b/i,          `Generate a ${db || 'database'} schema with proper types, indexes, and relationships`],
    [/\bmiddleware\b/i,      `Generate ${fw} middleware with proper error handling and TypeScript types`],
    [/\bgenerate tests?\b/i, `Write thorough Jest tests for this ${lang} code with mocking and edge cases`],
  ];

  for (const [pattern, expansion] of expansions) {
    if (pattern.test(rawPrompt)) {
      return `${expansion}. User request: "${rawPrompt}"`;
    }
  }

  return `${rawPrompt}\n[Context: ${fw}${db ? ', ' + db : ''}${auth ? ', ' + auth : ''}, ${lang}. Write production-ready code.]`;
}
