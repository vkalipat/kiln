import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../../src/providers/auth";
import { resolveIntegrationCredential, integrationCredentialSource } from "../../src/integrations/credentials";

test.each([['typesafe', 'TYPESAFE_API_KEY'], ['hindsight', 'HINDSIGHT_API_KEY']] as const)("%s credentials use trimmed environment then stored key without OAuth", (provider, name) => {
  const auth = new AuthStore(join(mkdtempSync(join(tmpdir(), 'kiln-integration-credentials-')), 'auth.json'));
  expect(resolveIntegrationCredential(auth, provider, {})).toBeUndefined();
  auth.setApiKey(provider, 'stored-secret');
  expect(resolveIntegrationCredential(auth, provider, { [name]: ' env-secret ' })).toBe('env-secret');
  expect(integrationCredentialSource(auth, provider, { [name]: 'env-secret' })).toBe('env');
  expect(resolveIntegrationCredential(auth, provider, { [name]: '   ' })).toBe('stored-secret');
  expect(integrationCredentialSource(auth, provider, {})).toBe('stored');
  auth.remove(provider);
  expect(integrationCredentialSource(auth, provider, {})).toBe('none');
});

test('integration discovery never accepts or refreshes an OAuth entry', () => {
  const auth = { get: () => ({ type: 'oauth', access: 'must-not-be-used' }), apiKeyFor: () => { throw new Error('must not refresh'); } } as unknown as AuthStore;
  expect(resolveIntegrationCredential(auth, 'typesafe', {})).toBeUndefined();
  expect(integrationCredentialSource(auth, 'typesafe', {})).toBe('none');
});
