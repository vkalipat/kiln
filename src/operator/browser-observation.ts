import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const source = readFileSync(new URL("../../vendor/jev-ultrafast/snapshot.js", import.meta.url), "utf8");
if (createHash("sha256").update(source).digest("hex") !== "e50473501c8fb8e70f3b21866d987393e3f2315c639d638bd477d170e81ed78d") throw new Error("Pinned browser snapshot integrity failure");
/** The upstream collector remains byte-for-byte vendored; only its private cache name changes. */
export function browserSnapshotScript(cacheKey: string): string {
  return `(() => { if (!document.body || typeof document.body.checkVisibility !== 'function') return {unsupported:'DOM visibility support unavailable'};
const visible=e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
if ([...document.querySelectorAll('iframe,frame')].some(visible)) return {unsupported:'Visible frames require native browser handling'};
if ([...document.querySelectorAll('*')].some(e=>e.shadowRoot && visible(e))) return {unsupported:'Shadow DOM requires native browser handling'};
return ${source.replace('window.__jevFast', `window[${JSON.stringify(cacheKey)}]`)}; })()`;
}
export function browserGuardScript(cacheKey: string, snapshotScript: string, action: unknown, snapshot: unknown, token: string): string {
  return `(() => { const a=${JSON.stringify(action)}, s=${JSON.stringify(snapshot)}, cache=window[${JSON.stringify(cacheKey)}];
if(!cache) return 'stale';
const stable=v=>JSON.stringify(v,(_,item)=>item && !Array.isArray(item) && typeof item==='object'?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
const fresh=${snapshotScript}; if(!fresh || fresh.unsupported || stable(fresh.marker)!==stable(s.marker)) return 'stale';
if(a.kind==='scroll') return 'ready';
const e=cache.nodes.get(a.node); if(!e?.isConnected || e.matches(':disabled') || e.closest('[inert],[aria-disabled="true"]') || e.readOnly || !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return 'stale';
if(stable(cache.guard(e))!==stable(s.guards[a.node])) return 'stale';
const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
if(r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight || !e.contains(document.elementFromPoint(x,y))) return 'stale';
if(a.kind==='fill' && !['INPUT','TEXTAREA'].includes(e.tagName)) return 'unsupported';
if(a.kind==='select' && (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===a.value && !o.disabled && !o.closest('optgroup[disabled]')))) return 'unsupported';
e.setAttribute('data-kiln-browser-ref',${JSON.stringify(token)}); return 'ready'; })()`;
}
export function browserVerificationScript(snapshotScript: string, checks: unknown): string {
  return `(() => { const s=${snapshotScript}, checks=${JSON.stringify(checks)};
if(!s || s.unsupported || s.omitted_actions) throw new Error('Fresh verification unavailable');
return {observation:{url:s.url,title:s.title.slice(0,1000),text:s.text.slice(0,6000)},checks:checks.map((c,index)=>({index,kind:c.kind,passed:c.kind==='url_equals'?s.url===c.value:c.kind==='text_includes'?s.text.includes(c.value):(()=>{const fields=s.actions.filter(a=>a.kind==='fill' && a.label===c.label);return fields.length===1 && fields[0].value===c.value})()}))}; })()`;
}
