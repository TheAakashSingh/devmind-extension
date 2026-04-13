import axios, { AxiosInstance } from 'axios';

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
  private http: AxiosInstance;

  constructor(private serverUrl: string, private apiKey: string) {
    this.http = axios.create({
      baseURL: serverUrl,
      timeout: 180_000,  // 3 min for large requests
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    });
    this.http.interceptors.response.use(
      (res) => res,
      (err) => {
        const status = err?.response?.status;
        const msg = err?.response?.data?.error || err?.message || 'Request failed';
        if (!status) {
          throw new DevMindHttpError('Cannot reach DevMind server. Check internet or server URL.', 'NETWORK');
        }
        if (status === 401) {
          throw new DevMindHttpError('Authentication failed. Your API key is invalid or expired. Please set a valid key.', 'AUTH', status);
        }
        if (status === 429) {
          throw new DevMindHttpError(msg || 'Daily quota exceeded. Upgrade your plan.', 'QUOTA', status);
        }
        if (status >= 500) {
          throw new DevMindHttpError(msg || 'DevMind server error. Please retry shortly.', 'SERVER', status);
        }
        throw new DevMindHttpError(msg, 'UNKNOWN', status);
      }
    );
  }

  setKey(key: string) {
    this.apiKey = key;
    this.http.defaults.headers['x-api-key'] = key;
  }

  updateConfig(serverUrl: string, apiKey: string) {
    this.serverUrl = serverUrl;
    this.apiKey    = apiKey;
    this.http.defaults.baseURL              = serverUrl;
    this.http.defaults.headers['x-api-key'] = apiKey;
  }

  // ── Inline autocomplete ────────────────────────────────────────────────────
  async complete(params: {
    prefix:      string;
    suffix:      string;
    language:    string;
    fileName:    string;
    projectCtx?: string;
  }): Promise<string> {
    const res = await this.http.post('/v1/complete', {
      model:      MODELS.autocomplete,
      prefix:     params.prefix,
      suffix:     params.suffix,
      language:   params.language,
      fileName:   params.fileName,
      projectCtx: params.projectCtx,
    });
    return (res.data.completion ?? '').trim();
  }

  // ── Code actions (explain / fix / refactor) ────────────────────────────────
  async action(
    type:       'explain' | 'fix' | 'refactor',
    code:       string,
    language:   string,
    contextPrompt?: string
  ): Promise<string> {
    const res = await this.http.post('/v1/action', {
      model:    MODELS[type] || MODELS.explain,
      type,
      code,
      language,
      contextPrompt,
    });
    return (res.data.result ?? '').trim();
  }

  // ── Explain entire file ────────────────────────────────────────────────────
  async explainFile(
    content:   string,
    fileName:  string,
    language:  string,
    projectCtx?: string
  ): Promise<string> {
    const res = await this.http.post('/v1/explain-file', {
      model:      MODELS.explain,
      content,
      fileName,
      language,
      projectCtx,
    });
    return (res.data.result ?? '').trim();
  }

  // ── Generate from prompt ───────────────────────────────────────────────────
  async generate(
    prompt:     string,
    language:   string,
    projectCtx?: string
  ): Promise<string> {
    const res = await this.http.post('/v1/generate', {
      model:      MODELS.generate,
      prompt,
      language,
      projectCtx,
    });
    return (res.data.code ?? '').trim();
  }

  // ── Generate tests ────────────────────────────────────────────────────────
  async generateTests(
    code:       string,
    language:   string,
    fileName:   string,
    projectCtx?: string
  ): Promise<string> {
    const res = await this.http.post('/v1/generate-tests', {
      model:      MODELS.tests,
      code,
      language,
      fileName,
      projectCtx,
    });
    return (res.data.tests ?? '').trim();
  }

  // ── Scaffold (one-command generators) ────────────────────────────────────
  async scaffold(params: {
    type:       string;  // 'auth' | 'crud' | 'api' | 'schema' | 'admin' | 'custom'
    name:       string;  // e.g. "order", "user"
    language:   string;
    projectCtx: string;
  }): Promise<{ files: Array<{ path: string; content: string }> }> {
    const res = await this.http.post('/v1/scaffold', {
      model:      MODELS.scaffold,
      ...params,
    }, { timeout: 120_000 });  // 2 min timeout
    return res.data;
  }

  // ── Multi-file refactor ───────────────────────────────────────────────────
  async multiRefactor(params: {
    instruction: string;
    files:       Array<{ path: string; content: string }>;
    language:    string;
    projectCtx:  string;
  }): Promise<{ files: Array<{ path: string; content: string; summary: string }> }> {
    const res = await this.http.post('/v1/multi-refactor', {
      model: MODELS.refactor,
      ...params,
    });
    return res.data;
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
    const res = await this.http.post(
      '/v1/chat',
      { model: MODELS.chat, messages, language, stream: useStream, intent, projectMemory },
      { responseType: useStream ? 'stream' : 'json', timeout: 60_000 }
    );

    if (!useStream) { return (res.data.reply ?? '').trim(); }

    return new Promise<string>((resolve, reject) => {
      let full    = '';
      let partial = '';

      res.data.on('data', (chunk: Buffer) => {
        const raw = partial + chunk.toString();
        partial   = '';
        const lines = raw.split('\n');
        const last  = lines.pop() ?? '';
        if (last) { partial = last; }
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === ': ping' || trimmed === 'data: [DONE]') { continue; }
          if (trimmed.startsWith('data: ')) {
            try {
              const json  = JSON.parse(trimmed.slice(6));
              const token = json.choices?.[0]?.delta?.content ?? '';
              if (token && onToken) { full += token; onToken(token); }
            } catch {}
          }
        }
      });
      res.data.on('end',   () => resolve(full));
      res.data.on('error', (err: Error) => reject(err));
    });
  }

  // ── File utilities ─────────────────────────────────────────────────────────
  async readFile(filePath: string): Promise<string> {
    const res = await this.http.post('/v1/files/read', { path: filePath });
    return res.data.content ?? '';
  }

  async writeFile(filePath: string, content: string): Promise<{ success: boolean; message: string }> {
    const res = await this.http.post('/v1/files/write', { path: filePath, content });
    return res.data;
  }

  async searchFiles(query: string): Promise<Array<{ path: string; preview: string }>> {
    const res = await this.http.post('/v1/files/search', { query });
    return res.data.results ?? [];
  }

  // ── Validate API key ───────────────────────────────────────────────────────
  async validate(): Promise<{ valid: boolean; plan: string; remaining: number }> {
    try {
      const res = await this.http.get('/v1/auth/validate');
      return res.data;
    } catch {
      return { valid: false, plan: 'free', remaining: 0 };
    }
  }

  async health(): Promise<{ ok: boolean; status?: string; env?: string }> {
    try {
      const res = await this.http.get('/health');
      return { ok: true, status: res.data?.status, env: res.data?.env };
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
    const res = await this.http.get('/v1/preferences');
    return res.data;
  }
}
