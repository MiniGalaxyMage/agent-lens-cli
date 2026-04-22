#!/usr/bin/env node
import minimist from 'minimist';
import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { v4 as uuidv4 } from 'uuid';
// @ts-ignore
import Database from 'better-sqlite3';

interface Execution {
  id: string;
  project: string;
  agent: string;
  timestamp: string;
  status: 'success' | 'error' | 'running';
  prompt: string;
  context_files: string[];
  skills_used: string[];
  stdout: string;
  stderr: string;
  exit_code: number;
}

const EXEC_DIR = join(homedir(), '.agent-lens');
const EXEC_FILE = join(EXEC_DIR, 'executions.jsonl');

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
      stdout TEXT NOT NULL DEFAULT '',
      stderr TEXT NOT NULL DEFAULT '',
      exit_code INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_executions_timestamp ON executions(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_project ON executions(project);
  `);
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
      (id, project, agent, timestamp, status, prompt, context_files, skills_used, stdout, stderr, exit_code)
    VALUES
      (@id, @project, @agent, @timestamp, @status, @prompt, @context_files, @skills_used, @stdout, @stderr, @exit_code)
  `);

  const insertMany = db.transaction((execs: Execution[]) => {
    for (const exec of execs) {
      insert.run({
        ...exec,
        context_files: JSON.stringify(exec.context_files),
        skills_used: JSON.stringify(exec.skills_used),
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
  --stdout      Standard output
  --stderr      Standard error
  --exit        Exit code (default: 0)
  --id          Execution ID (auto-generated if not provided)
  --timestamp   ISO timestamp (auto-generated if not provided)

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
  const exitCode: number = typeof argv.exit === 'number' ? argv.exit : (parseInt(String(argv.exit || '0')) || 0);

  const exec: Execution = {
    id: String(argv.id || uuidv4()),
    project: String(argv.project || 'default'),
    agent: String(argv.agent || 'agent'),
    timestamp: String(argv.timestamp || new Date().toISOString()),
    status: String(argv.status || 'success') as Execution['status'],
    prompt: String(argv.prompt || ''),
    context_files: typeof ctx === 'string' ? ctx.split(',').map((f: string) => f.trim()).filter(Boolean) : [],
    skills_used: typeof ski === 'string' ? ski.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
    stdout: String(argv.stdout || ''),
    stderr: String(argv.stderr || ''),
    exit_code: exitCode,
  };

  saveToJsonl(exec);
  console.log(`Logged execution ${exec.id}`);
}

main();
