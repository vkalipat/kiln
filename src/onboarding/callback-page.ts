/** Local OAuth receipt only: token exchange and durable connection complete in the terminal. */
export interface CallbackPageStatus { ok: boolean; error?: string }
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function renderKilnCallbackPage(status: CallbackPageStatus): string {
  const title = status.ok ? 'Authorization received' : 'Authorization could not finish';
  const detail = status.ok
    ? 'Return to Kiln. Your terminal will confirm when the connection is ready.'
    : 'Return to Kiln to retry or use the manual sign-in option.';
  const error = !status.ok && status.error ? `<p class="detail">${escapeHtml(status.error.slice(0, 300))}</p>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Kiln · ${title}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#12110f;color:#f3eee5}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px}main{width:min(100%,540px)}
.brand{color:#e5a453;letter-spacing:.28em;font-size:14px;font-weight:700;margin-bottom:56px}.mark{width:44px;height:44px;border:1px solid #956329;display:grid;place-items:center;color:#edb973;margin-bottom:28px;font-size:23px}
h1{font-size:clamp(28px,6vw,40px);line-height:1.15;font-weight:500;letter-spacing:-.035em;margin:0 0 18px}p{font-size:17px;line-height:1.6;color:#c0b7a9;max-width:440px}.detail{font-size:14px;overflow-wrap:anywhere;color:#ddab83}
footer{border-top:1px solid #393025;margin-top:40px;padding-top:18px;font-size:12px;color:#8e8475}
</style></head><body><main><div class="brand">KILN</div><div class="mark" aria-hidden="true">${status.ok ? '↗' : '!'}</div><h1>${title}</h1><p>${detail}</p>${error}<footer>You can close this tab. Authentication is handled by your model provider.</footer></main></body></html>`;
}
