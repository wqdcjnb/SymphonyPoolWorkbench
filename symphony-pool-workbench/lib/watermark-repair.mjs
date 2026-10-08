import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../tools/watermark_repair.py', import.meta.url));
export async function repairDolaVideo(source, output, { ratio, duration }, reuse) {
  try {
    await run(process.env.WORKBENCH_PYTHON || 'python', [script, '--input', source,
      '--output', output, '--ratio', ratio, '--duration', String(duration), ...(reuse ? ['--reuse', reuse] : [])],
    { timeout: 360_000, maxBuffer: 65_536, windowsHide: true });
  } catch (error) {
    let code;
    try { code = JSON.parse(error.stdout).code; } catch {}
    throw new Error(code === 'WATERMARK_REPAIR_UNSUPPORTED_LAYOUT' ? code : 'WATERMARK_REPAIR_FAILED');
  }
}
