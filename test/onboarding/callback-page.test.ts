import { describe, expect, test } from 'bun:test';
import { renderKilnCallbackPage } from '../../src/onboarding/callback-page';
import { OAuthCallbackFlow } from '@oh-my-pi/pi-ai/oauth/callback-server';
import type { OAuthController, OAuthCredentials } from '@oh-my-pi/pi-ai/oauth/types';
import { AuthStore } from '../../src/providers/auth';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class SyntheticFlow extends OAuthCallbackFlow {
  exchanges: string[] = [];
  async generateAuthUrl(state: string, redirectUri: string) { return { url: `https://provider.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}` }; }
  async exchangeToken(code: string): Promise<OAuthCredentials> { this.exchanges.push(code); return { access: 'access-private', refresh: 'refresh-private', expires: Date.now() + 60000 }; }
  generateState() { return 'state-private'; }
}
async function fixture(renderCallbackPage?: OAuthController['renderCallbackPage']) {
  const ready = Promise.withResolvers<{ url: string; launchUrl?: string }>();
  const ctrl = new AbortController();
  const flow = new SyntheticFlow({ onAuth: info => ready.resolve(info), signal: ctrl.signal, renderCallbackPage }, { preferredPort: 0, callbackHostname: '127.0.0.1' });
  const running = flow.login(); void running.catch(() => {});
  const info = await ready.promise;
  const redirect = new URL(info.url).searchParams.get('redirect_uri')!;
  return { flow, running, info, redirect, ctrl };
}
describe('Kiln local callback page', () => {
  test('receipt copy is accurate and self contained', () => {
    const html = renderKilnCallbackPage({ ok: true });
    expect(html).toContain('KILN'); expect(html).toContain('Authorization received'); expect(html).toContain('terminal will confirm');
    expect(html).not.toContain('Authentication Successful'); expect(html).not.toContain('<script'); expect(html).not.toMatch(/(?:src|href)=["']https?:/);
    expect(html).toContain("default-src 'none'"); expect(html).not.toContain('oh my pi');
  });
  test('error content is escaped and bounded', () => {
    const html = renderKilnCallbackPage({ ok: false, error: '<script>alert("x")</script>' + 'z'.repeat(400) });
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('z'.repeat(301));
  });
  test('actual callback sends only sanitized receipt to renderer and keeps launch route', async () => {
    const received: unknown[] = [];
    const f = await fixture(status => { received.push(status); return renderKilnCallbackPage(status); });
    try {
      const launch = await fetch(f.info.launchUrl!, { redirect: 'manual' }); expect(launch.status).toBe(302); expect(launch.headers.get('location')).toBe(f.info.url);
      const response = await fetch(`${f.redirect}?code=code-private&state=state-private`); const html = await response.text();
      expect(response.status).toBe(200); expect(received).toEqual([{ ok: true }]);
      for (const secret of ['code-private', 'state-private', 'access-private', 'refresh-private']) expect(html).not.toContain(secret);
      expect(html).toContain('KILN'); expect(await f.running).toMatchObject({ access: 'access-private' }); expect(f.flow.exchanges).toEqual(['code-private']);
    } finally { f.ctrl.abort(); await f.running.catch(() => {}); }
  });
  test('state mismatch still rejects callback without exchanging or settling valid flow', async () => {
    const f = await fixture(renderKilnCallbackPage);
    try {
      const bad = await fetch(`${f.redirect}?code=code-private&state=wrong-private`); expect(bad.status).toBe(500); expect(await bad.text()).not.toContain('wrong-private'); expect(f.flow.exchanges).toEqual([]);
      const good = await fetch(`${f.redirect}?code=valid-code&state=state-private`); expect(good.status).toBe(200); await good.text(); await f.running;
      expect(f.flow.exchanges).toEqual(['valid-code']);
    } finally { f.ctrl.abort(); await f.running.catch(() => {}); }
  });
  test('provider errors passed to page are generic without reflected secret values', async () => {
    const received: unknown[] = []; const f = await fixture(status => { received.push(status); return renderKilnCallbackPage(status); });
    try {
      const response = await fetch(`${f.redirect}?error=denied&error_description=token-private&state=wrong-private`);
      const html = await response.text(); expect(response.status).toBe(500); expect(html).not.toContain('token-private'); expect(html).not.toContain('wrong-private'); expect(received).toEqual([{ ok: false, error: 'Authorization was not completed.' }]); expect(f.flow.exchanges).toEqual([]);
    } finally { f.ctrl.abort(); await f.running.catch(() => {}); }
  });
  test('default upstream page remains available when hook omitted', async () => {
    const f = await fixture();
    try { const response = await fetch(`${f.redirect}?code=synthetic&state=state-private`); const html = await response.text(); expect(response.status).toBe(200); expect(html).toMatch(/<title>omp · authentication<\/title>/); expect(html).not.toContain('Kiln'); await f.running; }
    finally { f.ctrl.abort(); await f.running.catch(() => {}); }
  });
  test('receipt remains pending while token exchange is unfinished', async () => {
    const f = await fixture(renderKilnCallbackPage);
    const exchange = Promise.withResolvers<OAuthCredentials>();
    f.flow.exchangeToken = async () => exchange.promise;
    let finished = false; void f.running.then(() => { finished = true; });
    try {
      const response = await fetch(`${f.redirect}?code=synthetic&state=state-private`);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      const html = await response.text(); expect(html).toContain('Authorization received'); expect(html).not.toContain('connected'); expect(finished).toBe(false);
    } finally { exchange.resolve({ access: 'a', refresh: 'r', expires: Date.now() + 60000 }); await f.running; f.ctrl.abort(); }
  });
  test('renderer failure cannot prevent exchange or echo callback secrets', async () => {
    const f = await fixture(() => { throw new Error('renderer-private'); });
    try {
      const response = await fetch(`${f.redirect}?code=code-private&state=state-private`); const html = await response.text();
      expect(response.status).toBe(200); expect(html).toContain('Return to your terminal');
      for (const secret of ['code-private', 'state-private', 'renderer-private']) expect(html).not.toContain(secret);
      await f.running; expect(f.flow.exchanges).toEqual(['code-private']);
    } finally { f.ctrl.abort(); await f.running.catch(() => {}); }
  });
  test('AuthStore forwards Kiln page without changing manual fallback or provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiln-callback-')); let manual = 0;
    try {
      const auth = new AuthStore(join(dir, 'auth.json'), { getDefinition: provider => {
        expect(provider).toBe('openai-codex');
        return { login: async callbacks => {
          expect(callbacks.renderCallbackPage?.({ ok: true })).toContain('KILN');
          expect(await callbacks.onManualCodeInput?.()).toBe('manual-private');
          return { access: 'access', refresh: 'refresh', expires: Date.now() + 60000 };
        } };
      } });
      await auth.login('openai-codex', { onAuth: () => {}, onPrompt: async () => '', onManualCodeInput: async () => { manual++; return 'manual-private'; } });
      expect(manual).toBe(1);
    } finally { rmSync(dir, { recursive: true }); }
  });
});
