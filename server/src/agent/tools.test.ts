import { vi, describe, it, expect, beforeEach } from 'vitest';

type ExecCb = (err: Error | null, stdout: string | Buffer, stderr: string) => void;
const execFileMock = vi.fn();
vi.mock('child_process', () => ({ execFile: (...a: unknown[]) => execFileMock(...a) }));
vi.mock('@code-insights/cli/db/client', () => ({ getDb: () => { throw new Error('no db'); } }));

const { execMcpCli } = await import('./tools.js');

function fakeChild() {
  return { stdin: { write: vi.fn(), end: vi.fn() } };
}

describe('execMcpCli', () => {
  beforeEach(() => { execFileMock.mockReset(); vi.spyOn(console, 'error').mockImplementation(() => {}); });

  it('invokes the MCP cli with a 120s timeout and writes args as JSON to stdin', async () => {
    const child = fakeChild();
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
      queueMicrotask(() => cb(null, Buffer.from('ok-output'), ''));
      return child;
    });
    const out = await execMcpCli('get_architecture', { project: 'p' });
    expect(out).toBe('ok-output');
    const [cmd, args, opts] = execFileMock.mock.calls[0];
    expect(cmd).toBe('codebase-memory-mcp');
    expect(args).toEqual(['cli', 'get_architecture']);
    expect(opts).toMatchObject({ timeout: 120000 });
    expect(child.stdin.write).toHaveBeenCalledWith(JSON.stringify({ project: 'p' }));
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it('resolves a JSON {error} (never rejects) when the command fails or times out', async () => {
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: ExecCb) => {
      queueMicrotask(() => cb(Object.assign(new Error('spawn ENOENT'), { killed: true }), '', 'stderr text'));
      return fakeChild();
    });
    const out = await execMcpCli('list_projects', {});
    expect(JSON.parse(out)).toEqual({ error: 'stderr text' });

    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: ExecCb) => {
      queueMicrotask(() => cb(new Error('Command timed out'), '', ''));
      return fakeChild();
    });
    expect(JSON.parse(await execMcpCli('list_projects', {}))).toEqual({ error: 'Command timed out' });
  });
});
