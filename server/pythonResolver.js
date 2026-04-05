import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function findPythonCandidatesFromWhere() {
  const discovered = [];

  if (process.platform === 'win32') {
    for (const command of ['python', 'py']) {
      try {
        const { stdout } = await execFileAsync('where.exe', [command], {
          cwd: process.cwd(),
          timeout: 5000,
        });
        discovered.push(
          ...String(stdout ?? '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => !line.includes('WindowsApps')),
        );
      } catch {
        // Ignore discovery failures and continue with static candidates.
      }
    }
    return discovered;
  }

  for (const command of ['python3', 'python']) {
    try {
      const { stdout } = await execFileAsync('which', [command], {
        cwd: process.cwd(),
        timeout: 5000,
      });
      discovered.push(
        ...String(stdout ?? '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      );
    } catch {
      // Ignore discovery failures and continue with static candidates.
    }
  }

  return discovered;
}

export async function assertPythonCommand(candidate) {
  if (candidate.endsWith('.exe')) {
    await fs.access(candidate);
  }

  const args = candidate.toLowerCase().endsWith('py.exe') || candidate === 'py'
    ? ['-3', '--version']
    : ['--version'];

  await execFileAsync(candidate, args, {
    cwd: process.cwd(),
    timeout: 5000,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
    },
  });
}

export function formatPythonAttempt(candidate, error) {
  const reason = error instanceof Error ? error.message : String(error);
  return `${candidate} (${reason})`;
}
