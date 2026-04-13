// ── Model routing — right model for right task ────────────────────────────────
const MODELS = {
  autocomplete: 'deepseek-chat',    // fast, cheap
  chat:         'deepseek-chat',    // reasoning
  fix:          'deepseek-coder',   // code analysis
  generate:     'deepseek-coder',   // structured generation
  scaffold:     'deepseek-coder',   // large code generation
  tests:        'deepseek-coder',   // test generation
  refactor:     'deepseek-coder',   // code transformation
  explain:      'deepseek-chat',    // natural language
};

class DevMindHttpError extends Error {
  constructor(
    message: string,
    public readonly code: 'AUTH' | 'QUOTA' | 'NETWORK' | 'SERVER' | 'UNKNOWN',
    public readonly status?: number
  ) {
    super(message);
  }
}

export class DeepSeekClient {
  constructor(private serverUrl: string, private apiKey: string) {
  }

  setKey(key: string) {
    this.apiKey = key;
  }

  updateConfig(serverUrl: string, apiKey: string) {
    this.serverUrl = serverUrl;
    this.apiKey    = apiKey;
  }

  private buildUrl(route: string): string {
    return `${this.serverUrl.replace(/\/$/, '')}${route}`;
  }

  private async parseError(res: Response): Promise<never> {
    let msg = `Request failed (${res.status})`;
    try {
      const data = await res.json() as any;
      msg = data?.error || msg;
    } catch {}
    if (res.status === 401) {
      throw new DevMindHttpError('Authentication failed. Your API key is invalid or expired. Please set a valid key.', 'AUTH', res.status);
    }
    if (res.status === 429) {
      throw new DevMindHttpError(msg || 'Daily quota exceeded. Upgrade your plan.', 'QUOTA', res.status);
    }
    if (res.status >= 500) {
      throw new DevMindHttpError(msg || 'DevMind server error. Please retry shortly.', 'SERVER', res.status);
    }
    throw new DevMindHttpError(msg, 'UNKNOWN', res.status);
  }

  private async postJson<T>(route: string, body: unknown, timeoutMs = 180_000): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.buildUrl(route), {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) await this.parseError(res);
      return await res.json() as T;
    } catch (err: any) {
      if (err instanceof DevMindHttpError) throw err;
      throw new DevMindHttpError('Cannot reach DevMind server. Check internet or server URL.', 'NETWORK');
    } finally {
      clearTimeout(timer);
    }
  }

  private async getJson<T>(route: string, timeoutMs = 60_000): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.buildUrl(route), {
        method: 'GET',
        headers: { 'x-api-key': this.apiKey },
        signal: ctrl.signal,
      });
      if (!res.ok) await this.parseError(res);
      return await res.json() as T;
    } catch (err: any) {
      if (err instanceof DevMindHttpError) throw err;
      throw new DevMindHttpError('Cannot reach DevMind server. Check internet or server URL.', 'NETWORK');
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Inline autocomplete ────────────────────────────────────────────────────
  async complete(params: {
    prefix:      string;
    suffix:      string;
    language:    string;
    fileName:    string;
    projectCtx?: string;
  }): Promise<string> {
    const res = await this.postJson<any>('/v1/complete', {
      model:      MODELS.autocomplete,
      prefix:     params.prefix,
      suffix:     params.suffix,
      language:   params.language,
      fileName:   params.fileName,
      projectCtx: params.projectCtx,
    });
    return (res.completion ?? '').trim();
  }

  // ── Code actions (explain / fix / refactor) ────────────────────────────────
  async action(
    type:       'explain' | 'fix' | 'refactor',
    code:       string,
    language:   string,
    contextPrompt?: string
  ): Promise<string> {
    const res = await this.postJson<any>('/v1/action', {
      model:    MODELS[type] || MODELS.explain,
      type,
      code,
      language,
      contextPrompt,
    });
    return (res.result ?? '').trim();
  }

  // ── Explain entire file ────────────────────────────────────────────────────
  async explainFile(
    content:   string,
    fileName:  string,
    language:  string,
    projectCtx?: string
  ): Promise<string> {
    const res = await this.postJson<any>('/v1/explain-file', {
      model:      MODELS.explain,
      content,
      fileName,
      language,
      projectCtx,
    });
    return (res.result ?? '').trim();
  }

  // ── Generate from prompt ───────────────────────────────────────────────────
  async generate(
    prompt:     string,
    language:   string,
    projectCtx?: string
  ): Promise<string> {
    const res = await this.postJson<any>('/v1/generate', {
      model:      MODELS.generate,
      prompt,
      language,
      projectCtx,
    });
    return (res.code ?? '').trim();
  }

  // ── Generate tests ────────────────────────────────────────────────────────
  async generateTests(
    code:       string,
    language:   string,
    fileName:   string,
    projectCtx?: string
  ): Promise<string> {
    const res = await this.postJson<any>('/v1/generate-tests', {
      model:      MODELS.tests,
      code,
      language,
      fileName,
      projectCtx,
    });
    return (res.tests ?? '').trim();
  }

  // ── Scaffold (one-command generators) ────────────────────────────────────
  async scaffold(params: {
    type:       string;  // 'auth' | 'crud' | 'api' | 'schema' | 'admin' | 'custom'
    name:       string;  // e.g. "order", "user"
    language:   string;
    projectCtx: string;
  }): Promise<{ files: Array<{ path: string; content: string }> }> {
    const res = await this.postJson<{ files: Array<{ path: string; content: string }> }>('/v1/scaffold', {
      model:      MODELS.scaffold,
      ...params,
    }, 120_000);  // 2 min timeout
    return res;
  }

  // ── Multi-file refactor ───────────────────────────────────────────────────
  async multiRefactor(params: {
    instruction: string;
    files:       Array<{ path: string; content: string }>;
    language:    string;
    projectCtx:  string;
  }): Promise<{ files: Array<{ path: string; content: string; summary: string }> }> {
    const res = await this.postJson<{ files: Array<{ path: string; content: string; summary: string }> }>('/v1/multi-refactor', {
      model: MODELS.refactor,
      ...params,
    });
    return res;
  }

  // ── Chat — streaming or JSON ───────────────────────────────────────────────
  async chat(
    messages:    Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    language:    string,
    onToken?:    (t: string) => void,
    intent:      'build' | 'debug' | 'refactor' | 'optimize' | 'secure' = 'build',
    projectMemory = ''
  ): Promise<string> {
    const useStream = Boolean(onToken);
    if (!useStream) {
      const res = await this.postJson<any>('/v1/chat', { model: MODELS.chat, messages, language, stream: false, intent, projectMemory }, 60_000);
      return (res.reply ?? '').trim();
    }

    return new Promise<string>((resolve, reject) => {
      let full    = '';
      let partial = '';
      fetch(this.buildUrl('/v1/chat'), {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODELS.chat, messages, language, stream: true, intent, projectMemory }),
      }).then(async (res) => {
        if (!res.ok) await this.parseError(res);
        if (!res.body) throw new Error('Empty response stream');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const raw = partial + decoder.decode(value, { stream: true });
          partial = '';
          const lines = raw.split('\n');
          const last = lines.pop() ?? '';
          if (last) partial = last;
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === ': ping' || trimmed === 'data: [DONE]') continue;
            if (trimmed.startsWith('data: ')) {
              try {
                const json = JSON.parse(trimmed.slice(6));
                const token = json.choices?.[0]?.delta?.content ?? '';
                if (token && onToken) { full += token; onToken(token); }
              } catch {}
            }
          }
        }
        resolve(full);
      }).catch((err) => reject(err));
    });
  }

  // ── File utilities ─────────────────────────────────────────────────────────
  async readFile(filePath: string): Promise<string> {
    const res = await this.postJson<any>('/v1/files/read', { path: filePath });
    return res.content ?? '';
  }

  async writeFile(filePath: string, content: string): Promise<{ success: boolean; message: string }> {
    return await this.postJson<{ success: boolean; message: string }>('/v1/files/write', { path: filePath, content });
  }

  async searchFiles(query: string): Promise<Array<{ path: string; preview: string }>> {
    const res = await this.postJson<any>('/v1/files/search', { query });
    return res.results ?? [];
  }

  // ── Validate API key ───────────────────────────────────────────────────────
  async validate(): Promise<{ valid: boolean; plan: string; remaining: number }> {
    try {
      return await this.getJson<{ valid: boolean; plan: string; remaining: number }>('/v1/auth/validate');
    } catch {
      return { valid: false, plan: 'free', remaining: 0 };
    }
  }

  async health(): Promise<{ ok: boolean; status?: string; env?: string }> {
    try {
      const res = await this.getJson<any>('/health');
      return { ok: true, status: res?.status, env: res?.env };
    } catch {
      return { ok: false };
    }
  }

  async getPreferences(): Promise<{
    userId: string;
    defaultIntent: 'build' | 'debug' | 'refactor' | 'optimize' | 'secure';
    autoVerify: boolean;
    projectMemory: string;
    preferredTemperature: number;
  }> {
    return await this.getJson<{
      userId: string;
      defaultIntent: 'build' | 'debug' | 'refactor' | 'optimize' | 'secure';
      autoVerify: boolean;
      projectMemory: string;
      preferredTemperature: number;
    }>('/v1/preferences');
  }
}
