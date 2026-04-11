import axios, { AxiosInstance } from 'axios';

// ─── DeepSeek models ──────────────────────────────────────────────────────────
// deepseek-chat   → fast, cheap — $0.07/$0.28 per 1M tokens — use for everything
// deepseek-coder  → code-specific — same price — use for generate/fix
const MODEL_CHAT  = 'deepseek-chat';
const MODEL_CODER = 'deepseek-coder';

// ─── Prompt builders ──────────────────────────────────────────────────────────
function sysPrompt(lang: string, file = '') {
  return `You are an expert ${lang} developer assistant inside VS Code.${file ? ` File: ${file}` : ''}
Rules:
- Return ONLY code unless asked to explain
- No markdown fences (no triple backticks)
- Match existing code style exactly
- Be concise and production-ready`;
}

function completionPrompt(prefix: string, suffix: string, lang: string) {
  return `Continue this ${lang} code. Output ONLY the completion at <CURSOR>. No explanation, no fences.

${prefix}<CURSOR>${suffix}`;
}

function actionPrompt(action: string, code: string, lang: string) {
  const map: Record<string, string> = {
    explain:  `Explain this ${lang} code in plain English. Be concise:\n\n${code}`,
    fix:      `Fix all bugs in this ${lang} code. Return only the fixed code:\n\n${code}`,
    refactor: `Refactor this ${lang} code for clarity, performance and best practices. Return only the refactored code:\n\n${code}`,
  };
  return map[action] || code;
}

// ─── Main client ──────────────────────────────────────────────────────────────
export class DeepSeekClient {
  private http: AxiosInstance;

  constructor(private serverUrl: string, private apiKey: string) {
    // We call YOUR backend which holds the DeepSeek key — never expose it in extension
    this.http = axios.create({
      baseURL: serverUrl,
      timeout: 30_000,
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    });
  }

  setKey(key: string) {
    this.apiKey = key;
    this.http.defaults.headers['x-api-key'] = key;
  }

  updateConfig(serverUrl: string, apiKey: string) {
    this.serverUrl = serverUrl;
    this.apiKey    = apiKey;
    this.http.defaults.baseURL = serverUrl;
    this.http.defaults.headers['x-api-key'] = apiKey;
  }

  // ── Inline autocomplete ────────────────────────────────────────────────────
  async complete(params: {
    prefix: string;
    suffix: string;
    language: string;
    fileName: string;
  }): Promise<string> {
    const res = await this.http.post('/v1/complete', {
      model:    MODEL_CHAT,
      prefix:   params.prefix,
      suffix:   params.suffix,
      language: params.language,
      fileName: params.fileName,
    });
    return res.data.completion ?? '';
  }

  // ── Code actions ───────────────────────────────────────────────────────────
  async action(
    type: 'explain' | 'fix' | 'refactor',
    code: string,
    language: string
  ): Promise<string> {
    const res = await this.http.post('/v1/action', {
      model:    type === 'fix' ? MODEL_CODER : MODEL_CHAT,
      type,
      code,
      language,
    });
    return res.data.result ?? '';
  }

  // ── Generate from prompt ───────────────────────────────────────────────────
  async generate(prompt: string, language: string): Promise<string> {
    const res = await this.http.post('/v1/generate', {
      model: MODEL_CODER,
      prompt,
      language,
    });
    return res.data.code ?? '';
  }

  // ── Chat (sidebar) ─────────────────────────────────────────────────────────
  async chat(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    language: string,
    onToken?: (t: string) => void
  ): Promise<string> {
    const res = await this.http.post('/v1/chat', {
      model:    MODEL_CHAT,
      messages,
      language,
      stream:   !!onToken,
    }, {
      responseType: onToken ? 'stream' : 'json',
    });

    if (!onToken) return res.data.reply ?? '';

    return new Promise((resolve, reject) => {
      let full = '';
      res.data.on('data', (chunk: Buffer) => {
        chunk.toString().split('\n')
          .filter((l: string) => l.startsWith('data: '))
          .forEach((l: string) => {
            try {
              const j = JSON.parse(l.slice(6));
              const t = j.choices?.[0]?.delta?.content ?? '';
              full += t;
              onToken(t);
            } catch {}
          });
      });
      res.data.on('end',   () => resolve(full));
      res.data.on('error', reject);
    });
  }

  // ── Validate key ───────────────────────────────────────────────────────────
  async validate(): Promise<{ valid: boolean; plan: string; remaining: number }> {
    try {
      const res = await this.http.get('/v1/auth/validate');
      return res.data;
    } catch {
      return { valid: false, plan: 'free', remaining: 0 };
    }
  }
}
