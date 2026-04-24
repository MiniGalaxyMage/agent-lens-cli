#!/usr/bin/env node
/**
 * agent-lens install
 * 
 * Detects installed agents (Percival, Forge, DaVinci, Fellowship, etc.)
 * and injects the agent-lens skill into their context so they auto-log
 * executions to ~/.agent-lens/executions.jsonl
 */
import { readFileSync, writeFileSync, existsSync, cpSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_SOURCE = join(__dirname, '..', '..', 'skills', 'agent-lens.md');

const SKILL_BLOCK = `
<!-- agent-lens:start -->
<!-- This block is managed by agent-lens. Do not edit manually. -->
<!-- skill:agent-lens -->
\`\`\`
<!-- agent-lens:end -->
`;

const LOG_INSTRUCTION = `
<!-- agent-lens:start -->
<!-- This block is managed by agent-lens. Do not edit manually. -->
<!-- After completing a task, execute: agent-lens log --prompt "<task>" --context "<files_read>" --project <project> --agent <agent> --exit 0 -->
<!-- See: ~/.agent-lens/agent-lens.md or https://github.com/MiniGalaxyMage/agent-lens -->
<!-- agent-lens:end -->
`;

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

function write(path: string, content: string): void {
  writeFileSync(path, content, 'utf-8');
}

function injectSkill(content: string, marker: string, block: string): string {
  if (content.includes('<!-- agent-lens:start -->')) {
    console.log(`  [SKIP] ${marker} — agent-lens already installed`);
    return content;
  }
  return content.trimEnd() + '\n' + block + '\n';
}

function installSkillFile(destPath: string): void {
  if (!existsSync(SKILL_SOURCE)) {
    console.log(`  [WARN] Skill source not found: ${SKILL_SOURCE}`);
    console.log(`  [INFO] Copy skill manually from: https://github.com/MiniGalaxyMage/agent-lens/blob/main/skills/agent-lens.md`);
    return;
  }
  const destDir = join(destPath);
  mkdirSync(destDir, { recursive: true });
  cpSync(SKILL_SOURCE, join(destDir, 'agent-lens.md'), { force: true });
  console.log(`  [OK] Skill installed → ${destDir}/agent-lens.md`);
}

function main() {
  console.log('\n🔍 Agent Lens Installer');
  console.log('========================\n');

  const home = homedir();
  let installed = 0;

  // 1. Percival (OpenClaw workspace)
  const percivalWorkspace = join(home, '.openclaw', 'workspace');
  const percivalSkills = join(percivalWorkspace, 'skills');
  if (existsSync(percivalWorkspace)) {
    console.log('[FOUND] Percival workspace');

    // Install skill file
    installSkillFile(percivalSkills);

    // Inject into AGENTS.md
    const agentsMd = join(percivalWorkspace, 'AGENTS.md');
    if (existsSync(agentsMd)) {
      const content = read(agentsMd);
      const updated = injectSkill(content, 'AGENTS.md', LOG_INSTRUCTION);
      if (!content.includes('<!-- agent-lens:start -->')) {
        write(agentsMd, updated);
        console.log(`  [OK] Skill injected into AGENTS.md`);
        installed++;
      } else {
        console.log(`  [SKIP] AGENTS.md already has agent-lens`);
      }
    }

    // Inject into SOUL.md if it exists and doesn't have it
    const soulMd = join(percivalWorkspace, 'SOUL.md');
    if (existsSync(soulMd)) {
      const content = read(soulMd);
      if (!content.includes('<!-- agent-lens:start -->')) {
        const updated = content.trimEnd() + '\n' + LOG_INSTRUCTION + '\n';
        write(soulMd, updated);
        console.log(`  [OK] Skill injected into SOUL.md`);
        installed++;
      } else {
        console.log(`  [SKIP] SOUL.md already has agent-lens`);
      }
    }
  } else {
    console.log('[MISS] Percival workspace not found');
  }

  console.log('');

  // 2. Forge (Claude Code, OASIS)
  const forgeProfile = join(home, 'openclaw', 'agentes', 'forge-profile.md');
  if (existsSync(forgeProfile)) {
    console.log('[FOUND] Forge profile');
    const content = read(forgeProfile);
    const updated = injectSkill(content, 'forge-profile.md', LOG_INSTRUCTION);
    if (!content.includes('<!-- agent-lens:start -->')) {
      write(forgeProfile, updated);
      console.log(`  [OK] Skill injected into forge-profile.md`);
      installed++;
    } else {
      console.log(`  [SKIP] forge-profile.md already has agent-lens`);
    }
  } else {
    console.log('[MISS] Forge profile not found');
  }

  // 3. DaVinci (Claude Code, OASIS)
  const davinciProfile = join(home, 'openclaw', 'agentes', 'davinci-profile.md');
  if (existsSync(davinciProfile)) {
    console.log('[FOUND] DaVinci profile');
    const content = read(davinciProfile);
    const updated = injectSkill(content, 'davinci-profile.md', LOG_INSTRUCTION);
    if (!content.includes('<!-- agent-lens:start -->')) {
      write(davinciProfile, updated);
      console.log(`  [OK] Skill injected into davinci-profile.md`);
      installed++;
    } else {
      console.log(`  [SKIP] davinci-profile.md already has agent-lens`);
    }
  } else {
    console.log('[MISS] DaVinci profile not found');
  }

  // 4. Fellowship CLI
  const fellowshipSkills = join(home, 'DEV', 'FDD', 'fellowship', 'skills');
  if (existsSync(fellowshipSkills)) {
    console.log('[FOUND] Fellowship skills dir');
    mkdirSync(join(fellowshipSkills, 'agent-lens'), { recursive: true });
    const destSkill = join(fellowshipSkills, 'agent-lens.md');
    if (existsSync(SKILL_SOURCE)) {
      cpSync(SKILL_SOURCE, destSkill, { force: true });
      console.log(`  [OK] Skill installed → ${destSkill}`);
      installed++;
    }
  }

  console.log('\n------------------------');
  if (installed > 0) {
    console.log(`✅ Done! ${installed} agent(s) configured.`);
    console.log('\nEach agent will now log executions to ~/.agent-lens/executions.jsonl');
    console.log('Import to Agent Lens app: agent-lens --import');
  } else {
    console.log('No changes made (agents already have agent-lens or none found).');
  }
  console.log('');
}

main();
