import * as vscode from 'vscode';
import * as path   from 'path';
import { getIndexer } from '../utils/codebaseIndexer';

export interface PendingEdit {
  id:          string;
  filePath:    string;   // relative path
  fileName:    string;
  oldContent:  string;
  newContent:  string;
  description: string;
}

/**
 * DiffProvider — shows VS Code diff view and lets user accept/reject edits
 * Works like Augment/Cursor: AI proposes changes, user reviews diff, clicks accept/reject
 */
export class DiffProvider {
  private pending = new Map<string, PendingEdit>();

  // ── Queue an edit for review ───────────────────────────────────────────────
  async proposeSingleEdit(edit: PendingEdit): Promise<'accepted' | 'rejected' | 'skipped'> {
    const indexer = getIndexer();
    if (!indexer) return 'skipped';

    const root    = indexer.getRootPath();
    const absPath = path.isAbsolute(edit.filePath)
      ? edit.filePath
      : path.join(root, edit.filePath);

    // Write proposed content to a temp virtual document
    const originalUri = vscode.Uri.file(absPath);
    const proposedUri = originalUri.with({ scheme: 'devmind-proposed', path: absPath });

    // Register content provider for the proposed version
    const provider = vscode.workspace.registerTextDocumentContentProvider('devmind-proposed', {
      provideTextDocumentContent: () => edit.newContent,
    });

    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        proposedUri,
        `DevMind: ${edit.description} — ${edit.fileName}`,
        { preview: true }
      );

      // Ask user
      const choice = await vscode.window.showInformationMessage(
        `DevMind: Apply changes to ${edit.fileName}?`,
        { modal: false },
        'Accept',
        'Reject'
      );

      if (choice === 'Accept') {
        const applied = await indexer.applyEdit(edit.filePath, edit.newContent);
        if (applied) {
          vscode.window.showInformationMessage(`DevMind: Applied changes to ${edit.fileName}`);
          return 'accepted';
        }
      }
      return 'rejected';
    } finally {
      provider.dispose();
    }
  }

  // ── Propose multiple file edits ────────────────────────────────────────────
  async proposeMultiEdit(
    edits: PendingEdit[],
    summary: string
  ): Promise<{ accepted: number; rejected: number }> {
    if (!edits.length) return { accepted: 0, rejected: 0 };

    // Quick pick to preview which files change
    const items = edits.map(e => ({
      label:       `$(file-code) ${e.fileName}`,
      description: e.filePath,
      detail:      e.description,
      picked:      true,
      edit:        e,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      canPickMany:      true,
      title:            `DevMind: Apply changes? — ${summary}`,
      placeHolder:      'Select files to apply (uncheck to skip)',
    });

    if (!selected || !selected.length) {
      return { accepted: 0, rejected: edits.length };
    }

    let accepted = 0;
    let rejected = 0;

    for (const item of selected) {
      const result = await this.proposeSingleEdit(item.edit);
      if (result === 'accepted') accepted++;
      else rejected++;
    }

    return { accepted, rejected };
  }

  // ── Insert code at cursor with accept/reject ───────────────────────────────
  async insertWithDiff(code: string, description: string): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('DevMind: Open a file to insert code.');
      return false;
    }

    const doc        = editor.document;
    const selection  = editor.selection;
    const oldContent = doc.getText();
    const pos        = doc.offsetAt(selection.active);
    const newContent = oldContent.slice(0, pos) + '\n' + code + '\n' + oldContent.slice(pos);
    const relPath    = vscode.workspace.asRelativePath(doc.fileName);

    const edit: PendingEdit = {
      id:          Date.now().toString(),
      filePath:    relPath,
      fileName:    path.basename(doc.fileName),
      oldContent,
      newContent,
      description,
    };

    const result = await this.proposeSingleEdit(edit);
    return result === 'accepted';
  }

  // ── Apply code to a specific file with diff ────────────────────────────────
  async applyToFileWithDiff(
    filePath:    string,
    newContent:  string,
    description: string
  ): Promise<boolean> {
    const indexer   = getIndexer();
    const root      = indexer?.getRootPath() || '';
    const absPath   = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
    let   oldContent = '';
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
      oldContent = doc.getText();
    } catch { oldContent = ''; }

    const edit: PendingEdit = {
      id:          Date.now().toString(),
      filePath:    vscode.workspace.asRelativePath(absPath),
      fileName:    path.basename(absPath),
      oldContent,
      newContent,
      description,
    };

    const result = await this.proposeSingleEdit(edit);
    return result === 'accepted';
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
let _diffProvider: DiffProvider | null = null;
export function getDiffProvider(): DiffProvider {
  if (!_diffProvider) _diffProvider = new DiffProvider();
  return _diffProvider;
}
