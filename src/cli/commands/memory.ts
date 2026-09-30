import { AuthStore } from '../../providers/auth';
import { kilnHome } from '../../core/paths';
import { resolveIntegrationCredential, integrationCredentialSource } from '../../integrations/credentials';
import { open, constants } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { HindsightMemory, MEMORY_INPUT_BYTES, MemoryInputError, MemoryServiceError, memoryBank, memoryInteger, memoryUrl } from '../../integrations/hindsight';
import type { CliIo } from '../main';
export interface MemoryCommandDeps { authStoreFactory?: (path: string) => AuthStore; fetchImpl?: typeof fetch; env?: Record<string, string | undefined> }
const USAGE = 'usage: kiln memory status | recall <query> | retain --file PATH [--url URL] [--bank ID] [--timeout-ms N] [--max-tokens N] [--json]\n';
export async function memoryCommand(cmd: string[], flags: Record<string, string | boolean>, io: CliIo, deps: MemoryCommandDeps = {}): Promise<number> {
  const err = io.error ?? io.write; const env = deps.env ?? process.env;
  try {
    const action = cmd[0];
    if (!['status', 'recall', 'retain'].includes(action ?? '')) throw new MemoryInputError(USAGE.trim());
    const allowed = new Set(['home', 'url', 'bank', 'timeout-ms', 'json', ...(action === 'recall' ? ['max-tokens'] : []), ...(action === 'retain' ? ['file'] : [])]);
    if (Object.keys(flags).some(k => !allowed.has(k))) throw new MemoryInputError('Unknown or inapplicable memory flag');
    if (flags.json !== undefined && flags.json !== true) throw new MemoryInputError('--json does not take a value');
    const flag = (name: string, fallback?: string) => { const v = flags[name]; if (typeof v === 'boolean' || v === '') throw new MemoryInputError(`--${name} requires a value`); return v ?? fallback; };
    const home = flag('home') ?? env.KILN_HOME ?? kilnHome();
    const auth = deps.authStoreFactory?.(join(home, 'auth.json')) ?? new AuthStore(join(home, 'auth.json'));
    const apiKey = resolveIntegrationCredential(auth, 'hindsight', env);
    const url = flag('url', env.KILN_HINDSIGHT_URL); const bank = flag('bank', env.KILN_HINDSIGHT_BANK);
    const timeoutMs = memoryInteger(Number(flag('timeout-ms') ?? 10000), 'timeout-ms', 120000);
    if (action === 'status') {
      if (cmd.length !== 1) throw new MemoryInputError(USAGE.trim());
      const status = { provider: 'hindsight', configured: Boolean(url && bank), endpoint: url ? memoryUrl(url) : null, bank: bank ? memoryBank(bank) : null, credentialConfigured: Boolean(apiKey), credentialSource: integrationCredentialSource(auth, 'hindsight', env), serviceChecked: false, automaticRetention: false };
      io.write(`${JSON.stringify(status, null, 2)}\n`); return 0;
    }
    if (!url || !bank) throw new MemoryInputError('Set --url and --bank or KILN_HINDSIGHT_URL and KILN_HINDSIGHT_BANK; no memory service is provisioned automatically');
    const client = new HindsightMemory({ url, bank, timeoutMs, apiKey, fetchImpl: deps.fetchImpl });
    let result: unknown;
    if (action === 'recall') result = await client.recall(cmd.slice(1).join(' '), memoryInteger(Number(flag('max-tokens') ?? 2048), 'max-tokens', 16384));
    else {
      const file = flag('file'); if (!file || cmd.length !== 1) throw new MemoryInputError(USAGE.trim());
      let handle;
      try {
        handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MEMORY_INPUT_BYTES) throw new MemoryInputError('Curated memory file must be a regular file of at most 262144 bytes');
        const bytes = Buffer.alloc(MEMORY_INPUT_BYTES + 1); let length = 0;
        while (length < bytes.length) { const r = await handle.read(bytes, length, bytes.length - length, null); if (!r.bytesRead) break; length += r.bytesRead; }
        if (length > MEMORY_INPUT_BYTES) throw new MemoryInputError('Curated memory file exceeds size limit');
        let content: string; try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); } catch { throw new MemoryInputError('Curated memory file must be UTF-8 text'); }
        result = await client.retain(content, basename(file));
      } catch (error) { if (error instanceof MemoryInputError || error instanceof MemoryServiceError) throw error; throw new MemoryInputError('Unable to read curated memory file'); }
      finally { await handle?.close(); }
    }
    // JSON escaping prevents retrieved terminal control bytes from becoming instructions to the terminal.
    io.write(`${JSON.stringify(result, null, 2)}\n`); return 0;
  } catch (error) {
    err(`${error instanceof MemoryInputError || error instanceof MemoryServiceError ? error.message : 'Memory operation failed'}\n`);
    return error instanceof MemoryInputError ? 2 : 1;
  }
}
