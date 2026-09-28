/** Optional explicit Hindsight adapter. HTTP contract: https://hindsight.vectorize.io/openapi.json */
export const MEMORY_INPUT_BYTES = 256 * 1024;
const RESPONSE_BYTES = 1024 * 1024;
export class MemoryInputError extends Error {}
export class MemoryServiceError extends Error {}
export interface HindsightOptions { url: string; bank: string; apiKey?: string; timeoutMs?: number; fetchImpl?: typeof fetch }
export function memoryUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new MemoryInputError('Invalid memory URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash)
    throw new MemoryInputError('Memory URL requires HTTPS (or loopback HTTP), without credentials, query, or fragment');
  return url.toString().replace(/\/+$/, '');
}
export function memoryInteger(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new MemoryInputError(`${name} must be an integer from 1 to ${max}`);
  return value;
}
export function memoryBank(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new MemoryInputError('Memory bank must be a 1-128 character project identifier');
  return value;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function textInput(value: string, max: number): void {
  if (!value.trim() || value.includes('\0') || Buffer.byteLength(value) > max) throw new MemoryInputError(`Memory input must be nonempty text of at most ${max} bytes`);
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > RESPONSE_BYTES) throw new MemoryServiceError('Memory response exceeds size limit');
  if (!response.body) throw new MemoryServiceError('Memory response is empty');
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > RESPONSE_BYTES) throw new MemoryServiceError('Memory response exceeds size limit');
      parts.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw new MemoryServiceError('Memory service returned invalid JSON'); }
  } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}
export class HindsightMemory {
  readonly url: string; readonly bank: string; private timeout: number;
  constructor(private options: HindsightOptions) {
    this.url = memoryUrl(options.url); this.bank = memoryBank(options.bank);
    this.timeout = memoryInteger(options.timeoutMs ?? 10000, 'timeout-ms', 120000);
    if (options.apiKey && /[\r\n]/.test(options.apiKey)) throw new MemoryInputError('Invalid memory API key');
  }
  private async post(suffix: string, body: object): Promise<unknown> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new MemoryServiceError('Memory request timed out; retain outcome may be unknown')); }, this.timeout); });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await (this.options.fetchImpl ?? fetch)(`${this.url}/v1/default/banks/${encodeURIComponent(this.bank)}/memories${suffix}`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) }, body: JSON.stringify(body),
        });
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new MemoryServiceError(`Memory service returned HTTP ${response.status}`); }
        return await readJson(response, controller.signal);
      })()]);
    } catch (error) {
      if (error instanceof MemoryServiceError) throw error;
      throw new MemoryServiceError('Memory request failed; retain outcome may be unknown');
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async recall(query: string, maxTokens = 2048) {
    textInput(query, 16384); memoryInteger(maxTokens, 'max-tokens', 16384);
    const data = await this.post('/recall', { query, budget: 'low', max_tokens: maxTokens });
    if (!object(data) || !Array.isArray(data.results) || data.results.some(r => !object(r) || typeof r.id !== 'string' || typeof r.text !== 'string'))
      throw new MemoryServiceError('Memory service returned invalid recall results');
    return { provider: 'hindsight' as const, untrusted: true as const, bank: this.bank, endpoint: this.url, retrievedAt: new Date().toISOString(), data };
  }
  async retain(content: string, source: string) {
    textInput(content, MEMORY_INPUT_BYTES); textInput(source, 512);
    const hash = Bun.CryptoHasher.hash('sha256', content, 'hex'); const documentId = `kiln-curated-${hash}`;
    const data = await this.post('', { async: false, items: [{ content, document_id: documentId, context: 'operator-curated project memory', metadata: { source, sha256: hash, producer: 'kiln-explicit-retain' } }] });
    if (!object(data) || data.success !== true || data.bank_id !== this.bank || data.items_count !== 1 || data.async !== false)
      throw new MemoryServiceError('Memory service did not confirm synchronous retention');
    return { provider: 'hindsight', bank: this.bank, documentId, source, sha256: hash, confirmed: true };
  }
}
