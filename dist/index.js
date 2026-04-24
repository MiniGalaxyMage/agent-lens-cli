#!/usr/bin/env node
import minimist from 'minimist';
import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { v4 as uuidv4 } from 'uuid';
// @ts-ignore
import Database from 'better-sqlite3';
const EXEC_DIR = join(homedir(), '.agent-lens');
const EXEC_FILE = join(EXEC_DIR, 'executions.jsonl');
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
function detectTools(stdout, stderr) {
    const combined = stdout + '\n' + stderr;
    const tools = new Set();
    for (const pattern of TOOL_PATTERNS) {
        const matches = combined.match(pattern);
        if (matches) {
            for (const match of matches) {
                const parts = match.trim().split(/\s+/);
                const tool = parts[0].toLowerCase();
                if (tool.length > 1)
                    tools.add(tool);
            }
        }
    }
    return Array.from(tools).slice(0, 20);
}
function getDb() {
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
    return db;
}
function saveToJsonl(exec) {
    if (!existsSync(EXEC_DIR)) {
        mkdirSync(EXEC_DIR, { recursive: true });
    }
    appendFileSync(EXEC_FILE, JSON.stringify(exec) + '\n');
}
function importToDb() {
    if (!existsSync(EXEC_FILE)) {
        console.log('No executions.jsonl found');
        return;
    }
    const db = getDb();
    const content = readFileSync(EXEC_FILE, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const insert = db.prepare(`
    INSERT OR REPLACE INTO executions
      (id, project, agent, timestamp, status, prompt, context_files, skills_used, tools_used, stdout, stderr, exit_code)
    VALUES
      (@id, @project, @agent, @timestamp, @status, @prompt, @context_files, @skills_used, @tools_used, @stdout, @stderr, @exit_code)
  `);
    const insertMany = db.transaction((execs) => {
        for (const exec of execs) {
            insert.run({
                ...exec,
                context_files: JSON.stringify(exec.context_files),
                skills_used: JSON.stringify(exec.skills_used),
                tools_used: JSON.stringify(exec.tools_used),
            });
        }
    });
    const parsed = [];
    for (const line of lines) {
        try {
            parsed.push(JSON.parse(line));
        }
        catch {
            // skip invalid lines
        }
    }
    insertMany(parsed);
    console.log(`Imported ${parsed.length} executions to SQLite`);
}
async function main() {
    const argv = minimist(process.argv.slice(2), {
        string: ['prompt', 'project', 'agent', 'status', 'stdout', 'stderr', 'id', 'timestamp', 'context', 'skills', 'exit'],
        boolean: ['import', 'help'],
        default: { status: 'success', project: 'default', agent: 'agent' },
    });
    if (argv.help) {
        console.log(`
Agent Lens CLI — Log agent executions

Usage:
  agent-lens log [options]          Log a new execution
  agent-lens --import              Import from executions.jsonl to SQLite

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
    const ctx = argv.context || '';
    const ski = argv.skills || '';
    const stdoutVal = String(argv.stdout || '');
    const stderrVal = String(argv.stderr || '');
    const exitCode = typeof argv.exit === 'number' ? argv.exit : (parseInt(String(argv.exit || '0')) || 0);
    const tools = detectTools(stdoutVal, stderrVal);
    const exec = {
        id: String(argv.id || uuidv4()),
        project: String(argv.project || 'default'),
        agent: String(argv.agent || 'agent'),
        timestamp: String(argv.timestamp || new Date().toISOString()),
        status: String(argv.status || 'success'),
        prompt: String(argv.prompt || ''),
        context_files: typeof ctx === 'string' ? ctx.split(',').map((f) => f.trim()).filter(Boolean) : [],
        skills_used: typeof ski === 'string' ? ski.split(',').map((s) => s.trim()).filter(Boolean) : [],
        tools_used: tools,
        stdout: stdoutVal,
        stderr: stderrVal,
        exit_code: exitCode,
    };
    saveToJsonl(exec);
    console.log(`Logged execution ${exec.id}${tools.length > 0 ? ` (${tools.length} tools detected: ${tools.join(', ')})` : ''}`);
}
main();
