# DevMind AI — VS Code Extension

> **The AI coding assistant that actually reads your entire codebase.**  
> Built for Indian developers. Powered by DeepSeek. Better than Copilot.

---

## What Makes DevMind Different

| Feature | DevMind | GitHub Copilot | Cursor |
|---------|---------|---------------|--------|
| Full codebase indexing | ✅ Up to 1000 files | ❌ Context window only | ✅ |
| `@file` mention in chat | ✅ Any file from index | ❌ | ✅ |
| Accept / Reject diff view | ✅ Every code change | ❌ | ✅ |
| Project-aware scaffolding | ✅ Detects framework/DB/auth | ❌ | ❌ |
| One-command scaffolding | ✅ Auth, CRUD, API, Schema | ❌ | ❌ |
| Multi-file refactor | ✅ With diff preview | ❌ | ✅ |
| Gmail OTP login | ✅ Passwordless | ❌ | ❌ |
| Pricing in INR | ✅ ₹499/mo | ❌ ₹1800+/mo | ❌ ₹1600+/mo |

---

## Features

### 🔍 Full Codebase Indexing
DevMind scans your entire workspace on startup — up to **1000 files** — ignoring `node_modules`, `dist`, `.git`, and other build artifacts. The index updates automatically when files change.

Use the **file browser** (folder icon in toolbar) to see every indexed file and add them to chat context with one click.

### @ File Mentions
Type `@` in the chat input to instantly search your codebase. Arrow keys to navigate, Enter/Tab to select. The selected file is read and injected into the AI context automatically.

```
@userController    → searches and adds userController.ts to context
@schema            → finds all schema files
@auth              → finds auth-related files
```

### ✅ Accept / Reject Diff Flow
Every code change DevMind proposes — fixes, refactors, generations — is shown as a **side-by-side VS Code diff**. You decide what gets applied. Nothing is ever written to disk without your approval.

This is exactly how Augment and Cursor work. DevMind brings the same flow.

### 🏗 Project-Aware Intelligence
DevMind reads your `package.json`, `.env` files, and project structure to automatically detect:
- **Framework**: Next.js, React, Express, NestJS, Django, Flask, FastAPI, and more
- **Database**: MongoDB, PostgreSQL, MySQL, Prisma, TypeORM, Drizzle
- **Auth**: JWT, NextAuth, Passport, Firebase, Supabase, Clerk

Every AI response uses this context — no manual specification needed.

### ⚡ Scaffold Anything
Generate complete, production-ready modules in seconds:

| Command | What it generates |
|---------|-------------------|
| Create Auth System | Register, login, logout, JWT refresh, middleware |
| Create REST API | Full CRUD with validation and error handling |
| Create CRUD Module | Model, controller, routes, validation |
| Create DB Schema | Fields, types, indexes, relations |
| Create Admin Panel | Admin routes with role middleware |
| Create Express Server | Boilerplate with CORS, rate limiting, error handling |

All scaffold output respects your detected framework and database.

### 💬 AI Chat Sidebar
- **Streaming responses** — see the answer as it's generated
- **Full file context** — active file is always included automatically
- **Slash commands** — `/explain`, `/fix`, `/refactor`, `/test`, `/scaffold`, `/generate`
- **File attachments** — drag or click to attach any file
- **Context bar** — shows detected framework, database, and auth at a glance
- **Intent modes** — build, debug, refactor, optimize, secure
- **Multi-chat sessions** — previous chats list with switch/delete support
- **Persistent history** — chat state survives tab switches and reloads

### 🧠 AI Studio (Account-Level Controls)
From dashboard AI Studio, you can configure:
- Default intent mode (build/debug/refactor/optimize/secure)
- Project memory (architecture rules, conventions, constraints)
- Auto-verify preference for reliability workflows
- Preferred model temperature

These preferences are applied across the product and synced into extension chat behavior.

### 🔄 Multi-File Refactor
Rename a service, update an interface, change a pattern — across your entire project. DevMind shows you exactly which files change and what changes before applying anything.

### 🛡 Verification Loop (Lint/Test/Build)
Run a full reliability pass directly from DevMind:
- detects available `lint`, `test`, and `build` scripts across workspace packages
- executes checks sequentially
- generates a structured markdown verification report with pass/fail output
- can auto-run after AI edits when enabled in AI Studio

### ♻ Autonomous Auto-Heal Loop
DevMind can run a full **fix -> verify -> retry** cycle:
- first pass fix on selected code
- run workspace verification (`lint/test/build`)
- if checks fail, feed failures back for a second fix pass
- show final verification report

### 📦 PR-Ready Workflow
Generate a ready-to-edit PR draft with:
- branch status overview
- commit context snapshot
- diff highlights
- test-plan checklist for reviewers

### 📋 Risk-Aware Planning
Use DevMind to generate implementation plans before coding:
- goals and scope
- files likely to change
- risk assessment (low/medium/high)
- step-by-step execution plan
- verification checklist

### ✍ Inline Autocomplete
Real-time AI suggestions as you type. Tab to accept. Context-aware using your actual project's framework and patterns. Works across TypeScript, JavaScript, Python, Go, Rust, Java, and 10+ more languages.

### 🧪 Test Generation
Select any function or class, press `Ctrl+Shift+T` — DevMind writes comprehensive unit tests including happy path, edge cases, error scenarios, and mocks.

---

## Keyboard Shortcuts

| Action | Windows/Linux | Mac |
|--------|--------------|-----|
| Explain selected code | `Ctrl+Shift+E` | `Cmd+Shift+E` |
| Fix bugs | `Ctrl+Shift+F` | `Cmd+Shift+F` |
| Generate function | `Ctrl+Shift+G` | `Cmd+Shift+G` |
| Explain entire file | `Ctrl+Shift+D` | `Cmd+Shift+D` |
| Generate tests | `Ctrl+Shift+T` | `Cmd+Shift+T` |
| Scaffold module | `Ctrl+Shift+S` | `Cmd+Shift+S` |

Right-click any selected code for the full context menu.

---

## Getting Started

### 1. Install the Extension
Install from the VS Code Marketplace or run:
```bash
code --install-extension DevmindAi.devmind-ai
```

### 2. Sign Up (Free)
1. Open the extension — click the **DevMind icon** in the Activity Bar
2. Click **Open dashboard** to go to [app-devmind.singhjitech.com](https://app-devmind.singhjitech.com)
3. Enter your **Gmail address** — no password required
4. Enter the **6-digit OTP** sent to your Gmail
5. Copy your **API key** from the dashboard

### 3. Connect
In VS Code, open the Command Palette (`Ctrl+Shift+P`) and run:
```
DevMind: Set API Key
```
Paste your API key. The extension connects immediately and starts indexing your workspace.

---

## Plans & Pricing (International)

| Plan | INR | USD | Requests/Day | Best For |
|------|-----|-----|-------------|----------|
| Free | ₹0 | $0 | 20 | Try it out |
| Solo | ₹499/mo | $9/mo | 100 | Individual developers |
| Pro | ₹999/mo | $19/mo | 500 | Power users |
| Team | ₹799/seat/mo | $15/seat/mo | 2000 | Development teams |

All plans include full codebase indexing, @ mentions, diff view, scaffolding, and multi-file refactor.

---

## Slash Commands

Type `/` in the chat to see all commands:

| Command | Description |
|---------|-------------|
| `/explain` | Explain selected code |
| `/explainfile` | Explain the entire active file |
| `/fix` | Fix bugs in selected code |
| `/refactor` | Refactor selected code |
| `/test` | Generate unit tests |
| `/generate [description]` | Generate code from a description |
| `/scaffold` | Open the scaffolding picker |
| `/plan` | Create risk-aware implementation plan |
| `/verify` | Run lint/test/build verification loop |
| `/autoheal` | Run autonomous fix+verify+retry cycle |
| `/pr` | Generate PR-ready summary + test checklist |
| `/tree` | Refresh the file tree |
| `/index` | Re-index the codebase |
| `/clear` | Clear chat history |

---

## Privacy

- Your code is **never stored** on DevMind servers
- Requests are processed transiently and discarded
- DevMind never trains on your repositories
- Each session is fully isolated

---

## Marketplace Tags (Global SEO)

`ai code assistant`, `vscode ai`, `copilot alternative`, `cursor alternative`, `augment alternative`, `code generation`, `code refactor`, `debug assistant`, `unit test generator`, `autocomplete`, `software architect ai`, `full codebase context`, `project-aware ai`, `multi-file refactor`, `secure coding assistant`, `typescript ai`, `python ai`, `javascript ai`, `dev productivity`, `engineering workflow`.

---

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `devmind.apiKey` | — | Your DevMind API key |
| `devmind.enableInline` | `true` | Enable inline autocomplete |
| `devmind.inlineDelay` | `350` | Autocomplete trigger delay (ms) |
| `devmind.contextLines` | `60` | Lines of context for autocomplete |
| `devmind.projectAware` | `true` | Auto-detect framework/DB/auth |
| `devmind.serverUrl` | Production URL | Custom backend URL |

---

## Tech Stack

- **AI**: DeepSeek Chat + DeepSeek Coder (model routing per task)
- **Backend**: Node.js + Express + PostgreSQL
- **Auth**: Gmail OTP (passwordless, no passwords stored)
- **Payments**: Razorpay (INR + USD)
- **Extension**: TypeScript + VS Code API

---

## Built by SinghJitech

**Aakash Singh**, Founder · DevMind AI  
Made in India 🇮🇳  

Dashboard: [app-devmind.singhjitech.com](https://app-devmind.singhjitech.com)  
API: [api-devmind.singhjitech.com](https://api-devmind.singhjitech.com)  
Email: official@singhjitech.com
