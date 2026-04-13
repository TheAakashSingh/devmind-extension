import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import { CodebaseFile, CodebaseIndex, indexWorkspace, readFileContent } from './contextCollector';

/**
 * CodebaseIndexer
 * - Scans entire workspace on activation
 * - Re-indexes on file create/delete/rename
 * - Provides fast file search for @ mentions
 * - Reads file contents for context injection
 */
export class CodebaseIndexer {
  private index:   CodebaseIndex | null = null;
  private watchers: vscode.Disposable[] = [];
  private indexing = false;

  constructor(private context: vscode.ExtensionContext) {}

  // ── Start indexing ─────────────────────────────────────────────────────────
  async start() {
    await this.rebuild();

    // Watch for file system changes
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.watchers.push(
      watcher.onDidCreate(() => this.rebuild()),
      watcher.onDidDelete(() => this.rebuild()),
      watcher,
    );
  }

  dispose() {
    this.watchers.forEach(w => w.dispose());
    this.watchers = [];
  }

  // ── Rebuild index ──────────────────────────────────────────────────────────
  async rebuild() {
    if (this.indexing) return;
    this.indexing = true;
    try {
      const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!rootPath) { this.index = null; return; }
      const files = await new Promise<CodebaseFile[]>((resolve) => {
        // Run in next tick to avoid blocking
        setImmediate(() => resolve(indexWorkspace(rootPath, 1000)));
      });
      this.index = { files, rootPath, indexedAt: Date.now() };
    } catch (e) {
      console.error('[DevMind] Index error:', e);
    } finally {
      this.indexing = false;
    }
  }

  // ── Get all indexed files ──────────────────────────────────────────────────
  getFiles(): CodebaseFile[] {
    return this.index?.files || [];
  }

  getRootPath(): string {
    return this.index?.rootPath || '';
  }

  // ── Search files by name/path (for @ mention autocomplete) ────────────────
  searchFiles(query: string, limit = 20): CodebaseFile[] {
    if (!this.index) return [];
    const q = query.toLowerCase().trim();
    if (!q) {
      // Return most relevant files (recent open files first)
      const openPaths = new Set(
        vscode.workspace.textDocuments
          .filter(d => !d.isUntitled)
          .map(d => path.relative(this.index!.rootPath, d.fileName).replace(/\\/g, '/'))
      );
      const sorted = [...this.index.files].sort((a, b) => {
        const aOpen = openPaths.has(a.path) ? -1 : 0;
        const bOpen = openPaths.has(b.path) ? -1 : 0;
        return aOpen - bOpen;
      });
      return sorted.slice(0, limit);
    }

    // Score each file
    const scored = this.index.files
      .map(f => {
        const pathLower = f.path.toLowerCase();
        const nameLower = f.name.toLowerCase();
        let score = 0;
        const normalizedQ = q.replace(/^@/, '');
        if (nameLower === q)                            score += 100;
        if (nameLower.startsWith(q))                   score += 50;
        if (nameLower.includes(q))                     score += 30;
        if (pathLower.includes(q))                     score += 10;
        if (pathLower.startsWith(normalizedQ))         score += 80;
        if (pathLower.startsWith(`${normalizedQ}/`))   score += 85;
        if (pathLower.includes(`/${normalizedQ}/`))    score += 45;
        // Boost source files
        if (f.path.startsWith('src/'))                 score += 5;
        if (f.language === 'typescript')               score += 2;
        return { file: f, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(x => x.file);

    return scored;
  }

  // ── Read a file by relative path ───────────────────────────────────────────
  readFile(relPath: string): { name: string; content: string; language: string } | null {
    if (!this.index) return null;
    const file = this.index.files.find(f => f.path === relPath || f.name === relPath);
    if (!file) return null;
    const content = readFileContent(file.absPath);
    return { name: file.name, content, language: file.language };
  }

  // ── Read multiple files by relative paths ─────────────────────────────────
  readFiles(relPaths: string[]): Array<{ name: string; content: string; language: string }> {
    return relPaths.map(p => this.readFile(p)).filter(Boolean) as any;
  }

  // ── Get file tree summary ──────────────────────────────────────────────────
  getTreeSummary(maxLines = 80): string {
    if (!this.index || !this.index.files.length) return 'No workspace indexed.';

    const byDir = new Map<string, string[]>();
    for (const f of this.index.files) {
      const dir = path.dirname(f.path) || '.';
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir)!.push(f.name);
    }

    const lines: string[] = [`Workspace: ${path.basename(this.index.rootPath)} (${this.index.files.length} files)\n`];
    let lineCount = 0;

    const sortedDirs = [...byDir.keys()].sort();
    for (const dir of sortedDirs) {
      if (lineCount >= maxLines) { lines.push(`... (more files not shown)`); break; }
      lines.push(`${dir}/`);
      lineCount++;
      const names = byDir.get(dir)!;
      const shown = names.slice(0, 12);
      lines.push(`  ${shown.join('  ')}`);
      if (names.length > 12) lines.push(`  ... +${names.length - 12} more`);
      lineCount++;
    }

    return lines.join('\n');
  }

  // ── Apply code edit to a file (for accept/reject flow) ────────────────────
  async applyEdit(relPath: string, newContent: string): Promise<boolean> {
    if (!this.index) return false;
    const file = this.index.files.find(f => f.path === relPath);
    const absPath = file?.absPath || path.join(this.index.rootPath, relPath);
    try {
      const uri = vscode.Uri.file(absPath);
      const edit = new vscode.WorkspaceEdit();
      const doc  = await vscode.workspace.openTextDocument(uri);
      const full = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length)
      );
      edit.replace(uri, full, newContent);
      await vscode.workspace.applyEdit(edit);
      return true;
    } catch {
      return false;
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
let _indexer: CodebaseIndexer | null = null;

export function getIndexer(): CodebaseIndexer | null {
  return _indexer;
}

export function initIndexer(context: vscode.ExtensionContext): CodebaseIndexer {
  _indexer = new CodebaseIndexer(context);
  return _indexer;
}
