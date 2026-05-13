import { tool, type Plugin } from '@opencode-ai/plugin';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SESSION_PATH = '.agent-diff-review/session.json';
const DEFAULT_REPORT_PATH = '.agent-diff-review/report.html';
const __dirname = dirname(fileURLToPath(import.meta.url));

export const AgentDiffReviewPlugin: Plugin = async ({ $, client }) => {
  async function scanAndReport() {
    const adr = resolveAdrPath();
    await $`${adr} scan --format json --out ${DEFAULT_SESSION_PATH}`;
    await $`${adr} report --session ${DEFAULT_SESSION_PATH} --out ${DEFAULT_REPORT_PATH}`;
    await client.app.log({
      body: {
        service: 'agent-diff-review',
        level: 'info',
        message: `Wrote ${DEFAULT_REPORT_PATH}`
      }
    });
    return `agent-diff-review report written to ${DEFAULT_REPORT_PATH}`;
  }

  return {
    event: async ({ event }) => {
      if (event.type === 'session.idle' || event.type === 'session.diff') {
        try {
          await scanAndReport();
        } catch (error) {
          await client.app.log({
            body: {
              service: 'agent-diff-review',
              level: 'warn',
              message: error instanceof Error ? error.message : String(error)
            }
          });
        }
      }
    },
    tool: {
      adr_review: tool({
        description: 'Scan the current Git worktree and generate an agent-diff-review HTML report.',
        args: {},
        async execute() {
          return scanAndReport();
        }
      })
    }
  };
};

function resolveAdrPath() {
  const configured = process.env.ADR_PATH?.trim();
  if (configured) {
    return configured;
  }

  const bundled = bundledAdrPath();
  return bundled ?? 'adr';
}

function bundledAdrPath() {
  const platform = platformKey();
  if (!platform) {
    return undefined;
  }

  const executable = process.platform === 'win32' ? 'adr.exe' : 'adr';
  const candidate = join(__dirname, '..', 'bin', platform, executable);
  return existsSync(candidate) ? candidate : undefined;
}

function platformKey() {
  const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined;
  if (!arch) {
    return undefined;
  }

  switch (process.platform) {
    case 'win32':
      return `win32-${arch}`;
    case 'linux':
      return `linux-${arch}`;
    case 'darwin':
      return `darwin-${arch}`;
    default:
      return undefined;
  }
}
