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
  language:     string;
  fullContent:  string;
  selectedCode: string;
  imports:      string[];
  cursorLine:   number;
  cursorCol:    number;
  lineCount:    number;
}

// ── Detect framework from package.json ────────────────────────────────────────
function detectFramework(deps: string[]): string {
  if (deps.includes('next'))           return 'Next.js';
  if (deps.includes('react'))          return 'React';
  if (deps.includes('vue'))            return 'Vue.js';
  if (deps.includes('nuxt'))           return 'Nuxt.js';
  if (deps.includes('@angular/core'))  return 'Angular';
  if (deps.includes('svelte'))         return 'Svelte';
  if (deps.includes('express'))        return 'Express.js';
  if (deps.includes('fastify'))        return 'Fastify';
  if (deps.includes('nestjs') || deps.includes('@nestjs/core')) return 'NestJS';
  if (deps.includes('hono'))           return 'Hono';
  if (deps.includes('django'))         return 'Django';
  if (deps.includes('flask'))          return 'Flask';
  if (deps.includes('fastapi'))        return 'FastAPI';
  return 'Node.js';
}

function detectDatabase(deps: string[]): string {
  if (deps.includes('mongoose') || deps.includes('mongodb'))  return 'MongoDB';
  if (deps.includes('pg') || deps.includes('postgres'))       return 'PostgreSQL';
  if (deps.includes('mysql') || deps.includes('mysql2'))      return 'MySQL';
  if (deps.includes('sqlite3') || deps.includes('better-sqlite3')) return 'SQLite';
  if (deps.includes('prisma') || deps.includes('@prisma/client'))  return 'Prisma';
  if (deps.includes('typeorm'))        return 'TypeORM';
  if (deps.includes('drizzle-orm'))    return 'Drizzle';
  if (deps.includes('redis') || deps.includes('ioredis'))     return 'Redis';
  return 'none';
}

function detectAuth(deps: string[]): string {
  if (deps.includes('next-auth') || deps.includes('@auth/core')) return 'NextAuth';
  if (deps.includes('passport') || deps.includes('passport-jwt')) return 'Passport.js';
  if (deps.includes('jsonwebtoken'))   return 'JWT';
  if (deps.includes('firebase') || deps.includes('firebase-admin')) return 'Firebase Auth';
  if (deps.includes('@supabase/supabase-js'))  return 'Supabase Auth';
  if (deps.includes('clerk'))          return 'Clerk';
  if (deps.includes('auth0'))          return 'Auth0';
  return 'none';
}

// ── Read .env file keys ───────────────────────────────────────────────────────
function readEnvKeys(rootPath: string): string[] {
  const envFiles = ['.env', '.env.local', '.env.example', '.env.development'];
  const keys: string[] = [];
  for (const f of envFiles) {
    const p = path.join(rootPath, f);
    if (fs.existsSync(p)) {
      try {
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        for (const l of lines) {
          const m = l.match(/^([A-Z_][A-Z0-9_]*)=/);
          if (m) { keys.push(m[1]); }
        }
      } catch {}
    }
  }
  return [...new Set(keys)];
}

// ── Extract imports from file content ─────────────────────────────────────────
function extractImports(content: string): string[] {
  const imports: string[] = [];
  // ES imports
  const esImports = content.matchAll(/^import\s+(?:.+\s+from\s+)?['"]([^'"]+)['"]/gm);
  for (const m of esImports) { imports.push(m[1]); }
  // require()
  const requires = content.matchAll(/require\(['"]([^'"]+)['"]\)/g);
  for (const m of requires) { imports.push(m[1]); }
  return [...new Set(imports)];
}

// ── Main: collect project context ─────────────────────────────────────────────
export function collectProjectContext(): ProjectContext {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  const rootPath = wsFolder?.uri.fsPath || '';
  const pkgPath  = rootPath ? path.join(rootPath, 'package.json') : '';

  let packageName  = '';
  let dependencies: string[] = [];
  let devDeps:      string[] = [];
  let scripts:      string[] = [];

  if (pkgPath && fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      packageName  = pkg.name || '';
      dependencies = Object.keys(pkg.dependencies  || {});
      devDeps      = Object.keys(pkg.devDependencies || {});
      scripts      = Object.keys(pkg.scripts || {});
    } catch {}
  }

  const allDeps = [...dependencies, ...devDeps];

  const openFiles = vscode.workspace.textDocuments
    .filter(d => !d.isUntitled && !d.uri.path.includes('node_modules'))
    .slice(0, 8)
    .map(d => path.basename(d.fileName));

  const activeLanguage = vscode.window.activeTextEditor?.document.languageId || 'typescript';

  return {
    framework:    detectFramework(allDeps),
    language:     activeLanguage,
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
  if (!editor) { return null; }

  const doc      = editor.document;
  const selected = !editor.selection.isEmpty
    ? doc.getText(editor.selection)
    : '';

  return {
    fileName:     path.basename(doc.fileName),
    language:     doc.languageId,
    fullContent:  doc.getText(),
    selectedCode: selected,
    imports:      extractImports(doc.getText()),
    cursorLine:   editor.selection.active.line + 1,
    cursorCol:    editor.selection.active.character + 1,
    lineCount:    doc.lineCount,
  };
}

// ── Build system prompt with full project context ─────────────────────────────
export function buildContextPrompt(proj: ProjectContext, file: FileContext | null): string {
  let ctx = `You are DevMind AI, an expert coding assistant embedded in VS Code.

=== PROJECT CONTEXT ===
Framework:   ${proj.framework}
Language:    ${proj.language}
Database:    ${proj.database}
Auth:        ${proj.authSystem}
Package:     ${proj.packageName || 'unnamed'}
Scripts:     ${proj.scripts.join(', ') || 'none'}
Dependencies:${proj.dependencies.slice(0, 15).join(', ') || 'none'}
Env vars:    ${proj.envVars.slice(0, 10).join(', ') || 'none detected'}
Open files:  ${proj.openFiles.join(', ') || 'none'}
`;

  if (file) {
    ctx += `
=== ACTIVE FILE: ${file.fileName} (${file.language}) ===
Lines:  ${file.lineCount}
Cursor: Line ${file.cursorLine}, Col ${file.cursorCol}
Imports: ${file.imports.slice(0, 10).join(', ') || 'none'}
`;
    if (file.selectedCode) {
      ctx += `
=== SELECTED CODE ===
\`\`\`${file.language}
${file.selectedCode}
\`\`\`
`;
    } else if (file.fullContent.length < 8000) {
      ctx += `
=== FILE CONTENT ===
\`\`\`${file.language}
${file.fullContent}
\`\`\`
`;
    }
  }

  ctx += `
=== RULES ===
- Use ${proj.framework} patterns and conventions
- Use ${proj.database !== 'none' ? proj.database : 'the project database'} for data operations
- Use ${proj.authSystem !== 'none' ? proj.authSystem : 'appropriate auth'} for authentication
- Match the existing code style exactly
- Return production-ready, working code
`;
  return ctx;
}

// ── Prompt Optimization Engine ────────────────────────────────────────────────
export function optimizePrompt(rawPrompt: string, proj: ProjectContext): string {
  const fw   = proj.framework;
  const db   = proj.database !== 'none' ? proj.database : '';
  const auth = proj.authSystem !== 'none' ? proj.authSystem : '';
  const lang = proj.language;

  // Expand common short prompts into detailed instructions
  const expansions: Array<[RegExp, string]> = [
    [/\bcreate login\b/i,       `Generate a complete login controller in ${fw} with ${auth || 'JWT'} authentication, input validation, and error handling`],
    [/\bcreate auth\b/i,        `Generate a full authentication system for ${fw} using ${auth || 'JWT'}, including register, login, logout, and token refresh endpoints`],
    [/\bcreate crud\b/i,        `Generate a complete CRUD module for ${fw} with ${db || 'the project database'}, including model, controller, routes, and validation`],
    [/\bcreate api\b/i,         `Generate a REST API endpoint in ${fw} with proper error handling, input validation, and ${db || 'database'} integration`],
    [/\bwrite tests?\b/i,       `Generate comprehensive unit tests for the provided ${lang} code using Jest/Vitest, covering happy path, edge cases, and error scenarios`],
    [/\boptimize\b/i,           `Analyze and optimize this ${lang} code for performance, memory usage, and ${fw} best practices`],
    [/\brefactor\b/i,           `Refactor this ${lang} code following ${fw} conventions, improving readability, type safety, and maintainability`],
    [/\bfix\b/i,                `Find and fix all bugs in this ${lang} code, explaining each fix`],
    [/\bexplain\b/i,            `Explain this ${lang} code in detail: purpose, inputs/outputs, dependencies, complexity, and potential issues`],
    [/\bschema\b/i,             `Generate a ${db || 'database'} schema with proper types, indexes, and relationships`],
    [/\bmiddleware\b/i,         `Generate ${fw} middleware with proper error handling and type safety`],
  ];

  for (const [pattern, expansion] of expansions) {
    if (pattern.test(rawPrompt)) {
      return `${expansion}. Additional context: ${rawPrompt}`;
    }
  }

  // Generic enhancement
  return `${rawPrompt}\n\nContext: ${fw} project${db ? `, ${db} database` : ''}${auth ? `, ${auth} authentication` : ''}, ${lang} language. Generate production-ready code following project conventions.`;
}
