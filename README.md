# DevMind AI by SinghJitech

AI-powered coding assistant for VS Code with inline autocomplete, chat, code generation, bug fixing, and refactoring.

## Why DevMind AI

DevMind AI helps you move faster while staying inside your editor. Use it to:

- Complete code inline as you type
- Explain selected code in plain English
- Fix bugs in the current selection
- Refactor code for clarity and best practices
- Generate functions from a natural-language prompt
- Chat with an AI assistant in the sidebar
- Connect your DevMind dashboard and manage your API key

## Features

### Inline autocomplete

Get fast code suggestions directly in the editor while you type. DevMind AI uses your current file context to generate relevant completions.

### Code actions

Select code and run:

- `DevMind: Explain Code`
- `DevMind: Fix Bug`
- `DevMind: Refactor Code`

### Code generation

Use `DevMind: Generate Function` to describe what you want and insert the generated code into the current editor.

### Sidebar chat

Open the DevMind chat panel from the activity bar and ask questions about your code, your file, or your next implementation step.

### Dashboard connection

Sign in through the DevMind dashboard, verify your account, and paste your API key into the extension to unlock the AI features.

### Usage tracking

The status bar shows your daily request balance and plan so you can keep track of usage at a glance.

## Getting Started

1. Install the extension in VS Code.
2. Open the DevMind dashboard and sign in with your Gmail account.
3. Verify the OTP sent by email.
4. Copy your API key from the dashboard.
5. Run `DevMind: Set API Key` and paste the key.
6. Start using autocomplete, chat, and code actions.

## Commands

- `DevMind: Explain Code`
- `DevMind: Fix Bug`
- `DevMind: Generate Function`
- `DevMind: Refactor Code`
- `DevMind: Open Chat`
- `DevMind: Set API Key`
- `DevMind: Open Dashboard`
- `DevMind: Sign In`
- `DevMind: Sign Out`

## Keyboard Shortcuts

- `Ctrl+Shift+E` / `Cmd+Shift+E` - Explain selected code
- `Ctrl+Shift+F` / `Cmd+Shift+F` - Fix selected code
- `Ctrl+Shift+G` / `Cmd+Shift+G` - Generate code

## Settings

You can customize DevMind AI from VS Code settings:

- `devmind.apiKey` - Your DevMind API key
- `devmind.serverUrl` - Backend server URL
- `devmind.dashboardUrl` - Dashboard URL
- `devmind.enableInline` - Enable or disable inline autocomplete
- `devmind.inlineDelay` - Delay before autocomplete triggers

## Tips

- Select code before using explain, fix, or refactor.
- Use the sidebar chat when you want step-by-step help or iterative coding.
- If autocomplete feels too eager, increase `devmind.inlineDelay`.
- If the extension is not responding, verify your API key in the dashboard.

## Privacy and Security

- Your API key is stored locally in VS Code settings.
- Requests are sent to your configured DevMind backend server.
- The extension is designed to keep the DeepSeek key on the server side.

## Support

If you need help, open the dashboard or contact SinghJitech through the DevMind project channels.
