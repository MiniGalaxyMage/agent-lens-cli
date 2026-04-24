#!/usr/bin/env node
import minimist from 'minimist';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { v4 as uuidv4 } from 'uuid';
// @ts-ignore
import Database from 'better-sqlite3';

const HOME = homedir();

interface Execution {
  id: string;
  project: string;
  agent: string;
  timestamp: string;
  status: 'success' | 'error' | 'running';
  prompt: string;
  context_files: string[];
  skills_used: string[];
  tools_used: string[];
  stdout: string;
  stderr: string;
  exit_code: number;
}

const EXEC_DIR = join(homedir(), '.agent-lens');
const EXEC_FILE = join(EXEC_DIR, 'executions.jsonl');

const AGENT_LENS_MARKER = '<!-- agent-lens:start -->';
const AGENT_LENS_BLOCK = `
${AGENT_LENS_MARKER}
<!-- Managed by agent-lens (agent-lens-cli) -->
<!-- After completing a task, execute: agent-lens log --prompt "<task>" --context "<files>" --project <project> --agent <agent> --exit 0 -->
<!-- See: ~/.agent-lens/agent-lens.md or https://github.com/MiniGalaxyMage/agent-lens -->
<!-- agent-lens:end -->
`;
const AGENT_LENS_SKILL = `---
name: agent-lens
description: Log agent execution context to ~/.agent-lens/executions.jsonl
---
# Agent Lens

After completing ANY task, execute:
\`\`\`bash
agent-lens log \\
  --prompt "<the task>" \\
  --context "<files_read>" \\
  --project <project> \\
  --agent <agent> \\
  --exit 0
\`\`\`
`;

// Generic tool detector — parses stdout/stderr to infer which tools/commands were used
// Works for any agent that produces shell-like output
const TOOL_PATTERNS = [
  // Git
  /\bgit\s+(commit|push|pull|checkout|branch|merge|clone|add|status|diff|log|fetch|reset|rebase|stash)/gi,
  // npm/yarn/pnpm
  /\b(npm|yarn|pnpm)\s+(install|run|build|test|dev|start|lint|format|check)/gi,
  // Docker
  /\bdocker\s+(build|run|pull|push|compose|exec|logs)/gi,
  // File ops
  /\b(cat|head|tail|grep|sed|awk)\s+/gi,
  /\b(touch|mkdir|rm|cp|mv|ln|chmod|chown)\s+/gi,
  /\b(curl|wget)\s+/gi,
  // Compilers/builders
  /\b(tsc|npm|node|python3?|cargo|go|rustc|make|cmake|bundle|pip)\b/gi,
  // Claude Code / AI agents
  /\b(claude|codex|copilot|gemini|minimax)\b/gi,
  // Editors
  /\b(vim?|nano|emacs|code\.?\w*)\s+/gi,
  // SSH/shell
  /\b(ssh|scp|rsync)\s+/gi,
  // Env/config
  /\b(export|source|env|launchctl|brew)\s+/gi,
];

function detectTools(stdout: string, stderr: string): string[] {
  const combined = stdout + '\n' + stderr;
  const tools = new Set<string>();

  for (const pattern of TOOL_PATTERNS) {
    const matches = combined.match(pattern);
    if (matches) {
      for (const match of matches) {
        const parts = match.trim().split(/\s+/);
        const tool = parts[0].toLowerCase();
        if (tool.length > 1) tools.add(tool);
      }
    }
  }

  return Array.from(tools).slice(0, 20);
}

function getDb(): any {
  if (!existsSync(EXEC_DIR)) {
    mkdirSync(EXEC_DIR, { recursive: true });
  }
  const db = new Database(join(EXEC_DIR, 'agent-lens.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      agent TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL,
      context_files TEXT NOT NULL DEFAULT '[]',
      skills_used TEXT NOT NULL DEFAULT '[]',
      tools_used TEXT NOT NULL DEFAULT '[]',
      stdout TEXT NOT NULL DEFAULT '',
      stderr TEXT NOT NULL DEFAULT '',
      exit_code INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_executions_timestamp ON executions(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_project ON executions(project);
  `);
  // Migrate old schema (pre-tools_used)
  try { db.exec("ALTER TABLE executions ADD COLUMN tools_used TEXT NOT NULL DEFAULT '[]'"); } catch { /* column already exists */ }
  return db;
}

function saveToJsonl(exec: Execution): void {
  if (!existsSync(EXEC_DIR)) {
    mkdirSync(EXEC_DIR, { recursive: true });
  }
  appendFileSync(EXEC_FILE, JSON.stringify(exec) + '\n');
}

function importToDb(): void {
  if (!existsSync(EXEC_FILE)) {
    console.log('No executions.jsonl found');
    return;
  }

  const db = getDb();
  const content = readFileSync(EXEC_FILE, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const insert: any = db.prepare(`
    INSERT OR REPLACE INTO executions
      (id, project, agent, timestamp, status, prompt, context_files, skills_used, tools_used, stdout, stderr, exit_code)
    VALUES
      (@id, @project, @agent, @timestamp, @status, @prompt, @context_files, @skills_used, @tools_used, @stdout, @stderr, @exit_code)
  `);

  const insertMany = db.transaction((execs: Execution[]) => {
    for (const exec of execs) {
      insert.run({
        ...exec,
        context_files: JSON.stringify(exec.context_files),
        skills_used: JSON.stringify(exec.skills_used),
        tools_used: JSON.stringify(exec.tools_used),
      });
    }
  });

  const parsed: Execution[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as Execution);
    } catch {
      // skip invalid lines
    }
  }

  insertMany(parsed);
  console.log(`Imported ${parsed.length} executions to SQLite`);
}

async function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['prompt', 'project', 'agent', 'status', 'stdout', 'stderr', 'id', 'timestamp', 'context', 'skills', 'exit'],
    boolean: ['import', 'install', 'help'],
    default: { status: 'success', project: 'default', agent: 'agent' },
  });

  if (argv.help) {
    console.log(`
Agent Lens CLI — Log agent executions

Usage:
  agent-lens log [options]          Log a new execution
  agent-lens --import              Import from executions.jsonl to SQLite
  agent-lens --install             Detect agents and inject agent-lens skill

Options:
  --prompt      The prompt/request sent to the agent
  --project     Project name (default: "default")
  --agent       Agent name (default: "agent")
  --status      success | error | running (default: success)
  --context     Comma-separated list of context files read
  --skills      Comma-separated list of skills used
  --stdout      Standard output (tools auto-detected)
  --stderr      Standard error
  --exit        Exit code (default: 0)
  --id          Execution ID (auto-generated if not provided)
  --timestamp   ISO timestamp (auto-generated if not provided)

Tools are auto-detected from stdout/stderr output (git, npm, docker, etc.)
No need to pass --tools explicitly.

Examples:
  agent-lens log --prompt "Fix UTC bug" --context "SOUL.md,MEMORY.md" --exit 0
  agent-lens --import
`);
    process.exit(0);
  }

  if (argv.import) {
    importToDb();
    return;
  }

  if (argv.install) {
    doInstall();
    return;
  }

// ── Agent install ───────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function inject(content: string): string {
  if (content.includes(AGENT_LENS_MARKER)) return content;
  return content.trimEnd() + '\n' + AGENT_LENS_BLOCK;
}

function injectInto(path: string, label: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) { console.log(`  [SKIP] ${label} — is a directory`); return false; }
  } catch { return false; }
  const c = readFileSync(path, 'utf-8');
  if (c.includes(AGENT_LENS_MARKER)) { console.log(`  [SKIP] ${label} — already has agent-lens`); return false; }
  writeFileSync(path, inject(c));
  console.log(`  [OK]   ${label}`);
  return true;
}

function scanForAgentFiles(root: string, maxDepth = 3): string[] {
  const results: string[] = [];
  const names = ['CLAUDE.md', '.claude.md', 'AGENTS.md', 'PERCIVAL.md', 'AGENT.md', '.agent.md'];
  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    try {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'target') continue;
        const full = join(dir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) walk(full, depth + 1);
          else if (names.includes(entry)) results.push(full);
        } catch {}
      }
    } catch {}
  }
  walk(root, 0);
  return results;
}

function doInstall(): void {
  console.log('\n🔍 Agent Lens Installer\n========================\n');

  let installed = 0;
  const skillDir = join(HOME, '.agent-lens');
  const skillPath = join(skillDir, 'agent-lens.md');
  const SKILL_SOURCE = join(HOME, 'DEV', 'FDD', 'fellowship', 'skills', 'agent-lens.md');

  ensureDir(skillDir);
  if (!existsSync(skillPath) || !readFileSync(skillPath, 'utf-8').includes('agent-lens')) {
    const content = existsSync(SKILL_SOURCE) ? readFileSync(SKILL_SOURCE, 'utf-8') : AGENT_LENS_SKILL;
    writeFileSync(skillPath, content);
    console.log(`  [OK]   ~/.agent-lens/agent-lens.md`);
    installed++;
  } else {
    console.log(`  [SKIP] ~/.agent-lens/agent-lens.md — already exists`);
  }

  // Known agent config paths
  const targets: Array<{ label: string; path: string }> = [
    // Percival
    { label: 'SOUL.md', path: join(HOME, '.openclaw', 'workspace', 'SOUL.md') },
    { label: 'AGENTS.md', path: join(HOME, '.openclaw', 'workspace', 'AGENTS.md') },
    { label: 'Percival skills', path: join(HOME, '.openclaw', 'workspace', 'skills', 'agent-lens.md') },
    // OASIS
    { label: 'forge-profile', path: join(HOME, 'openclaw', 'agentes', 'forge-profile.md') },
    { label: 'davinci-profile', path: join(HOME, 'openclaw', 'agentes', 'davinci-profile.md') },
    { label: 'sprite-profile', path: join(HOME, 'openclaw', 'agentes', 'sprite-profile.md') },
    { label: 'hawk-profile', path: join(HOME, 'openclaw', 'agentes', 'hawk-profile.md') },
    // Fellowship
    { label: 'Fellowship', path: join(HOME, 'DEV', 'FDD', 'fellowship', 'skills', 'agent-lens.md') },
    // Claude Code global
    { label: 'Claude Code global', path: join(HOME, '.claude', 'CLAUDE.md') },
    { label: 'Claude Code home', path: join(HOME, 'CLAUDE.md') },
    // Codex
    { label: 'Codex config', path: join(HOME, '.codex', 'config') },
    { label: 'CODEX.md', path: join(HOME, 'CODEX.md') },
    // Cursor
    { label: 'Cursor rules', path: join(HOME, '.cursor', 'rules', 'agent-lens.mdc') },
    // Gemini CLI
    { label: 'Gemini CLI', path: join(HOME, '.gemini', 'CLAUDE.md') },
    // Windsurf
    { label: 'Windsurf rules', path: join(HOME, '.windsurf', 'rules', 'agent-lens.mdc') },
  ];

  console.log('\n[Agent configs]');
  for (const { label, path } of targets) {
    const dir = dirname(path);
    ensureDir(dir);
    if (existsSync(SKILL_SOURCE) && path === join(HOME, 'DEV', 'FDD', 'fellowship', 'skills', 'agent-lens.md')) {
      // Fellowship — copy skill
      if (!existsSync(path) || !readFileSync(path, 'utf-8').includes('agent-lens')) {
        cpSync(SKILL_SOURCE, path, { force: true });
        console.log(`  [OK]   ${label}`);
        installed++;
      } else {
        console.log(`  [SKIP] ${label} — already has agent-lens`);
      }
    } else if (injectInto(path, label)) {
      installed++;
    }
  }

  // Scan DEV and Documents for CLAUDE.md / AGENTS.md
  console.log('\n[Scanning ~/DEV and ~/Documents]');
  const found = [...scanForAgentFiles(join(HOME, 'DEV')), ...scanForAgentFiles(join(HOME, 'Documents'))];
  if (found.length === 0) {
    console.log('  (none found)');
  } else {
    for (const p of found) {
      const label = basename(dirname(p)) + '/' + basename(p);
      if (injectInto(p, label)) installed++;
    }
  }

  console.log('\n------------------------');
  console.log(installed > 0 ? `✅ Done! ${installed} location(s) configured.` : '✅ Already up to date.');
  console.log('\n  Log: ~/.agent-lens/executions.jsonl\n');
}

  const ctx = argv.context || '';
  const ski = argv.skills || '';
  const stdoutVal = String(argv.stdout || '');
  const stderrVal = String(argv.stderr || '');
  const exitCode: number = typeof argv.exit === 'number' ? argv.exit : (parseInt(String(argv.exit || '0')) || 0);

  const tools = detectTools(stdoutVal, stderrVal);

  const exec: Execution = {
    id: String(argv.id || uuidv4()),
    project: String(argv.project || 'default'),
    agent: String(argv.agent || 'agent'),
    timestamp: String(argv.timestamp || new Date().toISOString()),
    status: String(argv.status || 'success') as Execution['status'],
    prompt: String(argv.prompt || ''),
    context_files: typeof ctx === 'string' ? ctx.split(',').map((f: string) => f.trim()).filter(Boolean) : [],
    skills_used: typeof ski === 'string' ? ski.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
    tools_used: tools,
    stdout: stdoutVal,
    stderr: stderrVal,
    exit_code: exitCode,
  };

  saveToJsonl(exec);
  importToDb(); // Auto-import so it's immediately visible in Agent Lens app
  console.log(`Logged execution ${exec.id}${tools.length > 0 ? ` (${tools.length} tools detected: ${tools.join(', ')})` : ''}`);
}

main();
