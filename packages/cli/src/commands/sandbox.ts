import { spawn } from 'node:child_process';
import { LOCAL_DEV_IMAGE, sandboxDockerDir } from '@chimera/sandbox';

export interface SandboxBuildResult {
  exitCode: number;
}

export async function runSandboxBuild(): Promise<SandboxBuildResult> {
  const dir = sandboxDockerDir();
  process.stderr.write(`building ${LOCAL_DEV_IMAGE} from ${dir}\n`);
  const code = await new Promise<number>((resolve) => {
    const child = spawn('docker', ['build', '-t', LOCAL_DEV_IMAGE, dir], {
      stdio: 'inherit',
    });
    child.on('close', (c) => resolve(c ?? 1));
    child.on('error', (err) => {
      process.stderr.write(`docker build failed to start: ${err.message}\n`);
      resolve(127);
    });
  });
  if (code === 0) {
    process.stdout.write(`${LOCAL_DEV_IMAGE}\n`);
  }
  return { exitCode: code };
}
