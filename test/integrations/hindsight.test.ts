import { describe, expect, test } from 'bun:test';
import { HindsightMemory, memoryUrl } from '../../src/integrations/hindsight';
const opts = { url: 'http://127.0.0.1:8888', bank: 'project' };
const mock = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => ((url: unknown, init: RequestInit) => handler(String(url), init)) as typeof fetch;
describe('explicit Hindsight adapter', () => {
  test('recall uses official body and preserves untrusted provenance', async () => {
    const result = await new HindsightMemory({ ...opts, apiKey: 'secret', fetchImpl: mock((url, init) => {
      expect(url).toBe(`${opts.url}/v1/default/banks/project/memories/recall`);
      expect(init.redirect).toBe('error'); expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret');
      expect(JSON.parse(String(init.body))).toEqual({ query: 'decisions', budget: 'low', max_tokens: 123 });
      return Response.json({ results: [{ id: 'm1', text: 'data', document_id: 'd1', metadata: { sha256: 'abc' } }], source_facts: {} });
    }) }).recall('decisions', 123);
    expect(result.untrusted).toBe(true); expect(result.data.results).toEqual([{ id: 'm1', text: 'data', document_id: 'd1', metadata: { sha256: 'abc' } }]);
  });
  test('retain sends one curated item with content hash identity', async () => {
    await new HindsightMemory({ ...opts, fetchImpl: mock((url, init) => {
      expect(url).toBe(`${opts.url}/v1/default/banks/project/memories`);
      const body = JSON.parse(String(init.body)); expect(body.async).toBe(false); expect(body.items).toHaveLength(1);
      expect(body.items[0].metadata.source).toBe('notes.md'); expect(body.items[0].document_id).toBe(`kiln-curated-${Bun.CryptoHasher.hash('sha256', 'verified notes', 'hex')}`);
      return Response.json({ success: true, bank_id: 'project', items_count: 1, async: false });
    }) }).retain('verified notes', 'notes.md');
  });
  test('configuration and payload validation happen before network', async () => {
    for (const url of ['https://user:secret@example.com', 'https://example.com?key=secret', 'http://example.com', 'file:///tmp/x', 'bad']) expect(() => memoryUrl(url)).toThrow();
    expect(() => new HindsightMemory({ ...opts, bank: '../other' })).toThrow();
    expect(() => new HindsightMemory({ ...opts, timeoutMs: NaN })).toThrow();
    const client = new HindsightMemory({ ...opts, fetchImpl: mock(() => { throw Error('must not call'); }) });
    await expect(client.recall('')).rejects.toThrow('nonempty'); await expect(client.recall('q', Infinity)).rejects.toThrow('integer');
    await expect(client.retain('x'.repeat(262145), 'x')).rejects.toThrow('at most');
  });
  test('provider errors never echo secrets and do not retry', async () => {
    let calls = 0; const client = new HindsightMemory({ ...opts, fetchImpl: mock(() => { calls++; throw Error('secret endpoint'); }) });
    await expect(client.recall('q')).rejects.toThrow('Memory request failed'); expect(calls).toBe(1);
    await expect(new HindsightMemory({ ...opts, fetchImpl: mock(() => new Response('secret', { status: 503 })) }).recall('q')).rejects.toThrow('HTTP 503');
  });
  test('rejects malformed, oversized and false success responses', async () => {
    for (const response of [Response.json({}), Response.json({ results: [{}] }), new Response('not json'), new Response('x'.repeat(1048577))]) {
      await expect(new HindsightMemory({ ...opts, fetchImpl: mock(() => response) }).recall('q')).rejects.toThrow();
    }
    await expect(new HindsightMemory({ ...opts, fetchImpl: mock(() => Response.json({ success: true, bank_id: 'wrong', items_count: 1, async: false })) }).retain('x', 'x')).rejects.toThrow('did not confirm');
  });
  test('timeout bounds fetch and stalled response body', async () => {
    let signal: AbortSignal | undefined;
    await expect(new HindsightMemory({ ...opts, timeoutMs: 10, fetchImpl: mock(async (_, init) => { signal = init.signal!; return await new Promise<Response>(() => {}); }) }).recall('q')).rejects.toThrow('timed out'); expect(signal?.aborted).toBe(true);
    await expect(new HindsightMemory({ ...opts, timeoutMs: 10, fetchImpl: mock(() => new Response(new ReadableStream({ start() {} }))) }).recall('q')).rejects.toThrow('timed out');
  });
});
