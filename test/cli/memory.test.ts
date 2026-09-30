import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryCommand } from '../../src/cli/commands/memory';
const flags = { url: 'https://memory.example', bank: 'project' };
function output() { const out: string[] = [], err: string[] = []; return { out, err, io: { write: (s: string) => { out.push(s); }, error: (s: string) => { err.push(s); } } }; }
const mock = (fn: (init: RequestInit) => Response) => ((_url: unknown, init: RequestInit) => Promise.resolve(fn(init))) as typeof fetch;
describe('memory CLI', () => {
  test('status is offline and never exposes credential', async () => {
    const s = output(); expect(await memoryCommand(['status'], {}, s.io, { env: { HINDSIGHT_API_KEY: 'secret' }, fetchImpl: mock(() => { throw Error('no network'); }) })).toBe(0);
    expect(JSON.parse(s.out.join(''))).toMatchObject({ configured: false, serviceChecked: false, automaticRetention: false, credentialConfigured: true }); expect(s.out.join('')).not.toContain('secret');
  });
  test('missing config, invalid flags, url credentials and malformed arguments fail closed', async () => {
    for (const [cmd, opts] of [[['recall', 'q'], {}], [['retain'], flags], [['status'], { url: 'https://user:secret@example.com' }], [['recall', 'q'], { ...flags, 'max-tokens': 'wat' }], [['status'], { key: 'secret' }]] as [string[], Record<string, string>][]) {
      const s = output(); expect(await memoryCommand(cmd, opts, s.io, { env: {}, fetchImpl: mock(() => { throw Error('no network'); }) })).toBe(2); expect(s.err.join('')).not.toContain('secret');
    }
  });
  test('recall honors env and escapes terminal control characters', async () => {
    const s = output(); expect(await memoryCommand(['recall', 'prior', 'decision'], { json: true }, s.io, { env: { KILN_HINDSIGHT_URL: flags.url, KILN_HINDSIGHT_BANK: flags.bank }, fetchImpl: mock(init => {
      expect(JSON.parse(String(init.body)).query).toBe('prior decision'); return Response.json({ results: [{ id: '1', text: '\u001b[2Jexternal instructions', document_id: 'source' }] });
    }) })).toBe(0); expect(s.out.join('')).not.toContain('\u001b'); expect(JSON.parse(s.out.join('')).untrusted).toBe(true);
  });
  test('retain reads only specified regular UTF8 file, carries basename and confirms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiln-memory-')); const file = join(dir, 'curated.md'); writeFileSync(file, 'verified result'); const s = output();
    try {
      expect(await memoryCommand(['retain'], { ...flags, file }, s.io, { env: {}, fetchImpl: mock(init => {
        const item = JSON.parse(String(init.body)).items[0]; expect(item.content).toBe('verified result'); expect(item.metadata.source).toBe('curated.md');
        return Response.json({ success: true, bank_id: 'project', items_count: 1, async: false });
      }) })).toBe(0); expect(JSON.parse(s.out.join('')).confirmed).toBe(true);
      expect(await memoryCommand(['retain'], { ...flags, file: dir }, s.io, { env: {} })).toBe(2);
      writeFileSync(file, Buffer.from([0xff])); expect(await memoryCommand(['retain'], { ...flags, file }, s.io, { env: {} })).toBe(2);
    } finally { rmSync(dir, { recursive: true }); }
  });
  test('outage is nonzero and does not claim completion', async () => {
    const s = output(); expect(await memoryCommand(['recall', 'q'], flags, s.io, { env: {}, fetchImpl: mock(() => new Response('private', { status: 502 })) })).toBe(1); expect(s.out).toEqual([]); expect(s.err.join('')).toContain('502'); expect(s.err.join('')).not.toContain('private');
  });
});

test('stored Hindsight credential authenticates recall and status only reports source', async () => {
  const { AuthStore } = await import('../../src/providers/auth');
  const home = mkdtempSync(join(tmpdir(), 'kiln-memory-key-'));
  const auth = new AuthStore(join(home, 'auth.json')); auth.setApiKey('hindsight', 'fake-memory-secret');
  const s = output();
  expect(await memoryCommand(['status'], { home, ...flags }, s.io, { env: {} })).toBe(0);
  expect(JSON.parse(s.out.join(''))).toMatchObject({ credentialConfigured: true, credentialSource: 'stored', serviceChecked: false });
  expect(s.out.join('')).not.toContain('fake-memory-secret');
  expect(await memoryCommand(['recall', 'query'], { home, ...flags }, output().io, { env: {}, fetchImpl: mock(init => {
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer fake-memory-secret');
    return Response.json({ results: [] });
  }) })).toBe(0);
});
