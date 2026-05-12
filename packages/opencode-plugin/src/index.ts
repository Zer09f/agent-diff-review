import { tool, type Plugin } from '@opencode-ai/plugin';

const DEFAULT_SESSION_PATH = '.agent-diff-review/session.json';
const DEFAULT_REPORT_PATH = '.agent-diff-review/report.html';

export const AgentDiffReviewPlugin: Plugin = async ({ $, client }) => {
  async function scanAndReport() {
    await $`adr scan --format json --out ${DEFAULT_SESSION_PATH}`;
    await $`adr report --session ${DEFAULT_SESSION_PATH} --out ${DEFAULT_REPORT_PATH}`;
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

