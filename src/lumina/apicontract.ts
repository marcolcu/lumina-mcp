import fs from 'node:fs';
import path from 'node:path';
import { mask } from './graph.js';
import { listFiles } from './repomap.js';

/**
 * API contract intelligence. Backend contracts come from (in order of authority) OpenAPI/Swagger specs, Go Fiber
 * routes with their handlers' JSON structs, and Next.js API routes; frontend consumers from fetch/axios-style calls in
 * TS/JS with the types they declare. Everything is read statically with its evidence (file:line); nothing is executed
 * or rewritten, no model is called. A mismatch is VERIFIED only when both sides are explicit declarations matched on
 * the exact method and path; anything inferred, fuzzy or guessed (renames) is reported as POSSIBLE.
 */
export type SType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'unknown';
export interface Schema { type: SType; props?: Record<string, { schema: Schema; required: boolean }>; items?: Schema; nullable?: boolean; name?: string; open?: boolean }
export type Source = 'openapi' | 'fiber' | 'next';
export interface Endpoint {
  /** Workspace repository name when compared across repositories. */
  repo?: string;
  method: string; path: string; source: Source; file: string; line: number; params: string[];
  request?: Schema; response?: Schema; auth?: string; explicit: boolean; handler?: string;
}
export interface Consumer {
  repo?: string;
  method: string; path: string; raw: string; file: string; line: number; client: string;
  /** false when part of the URL could not be resolved (e.g. a base URL from the environment). */
  exactPath: boolean; expects?: Schema; sends?: Schema; typeName?: string;
}
export interface Finding {
  endpoint: string; kind: 'missing field' | 'renamed field' | 'type mismatch' | 'nullable field' | 'removed endpoint' | 'method changed' | 'request payload' | 'version mismatch';
  status: 'verified' | 'possible'; field?: string; backend?: string; frontend?: string; detail: string; evidence: string[];
}
export interface ContractReport {
  endpoints: Endpoint[]; consumers: Consumer[]; findings: Finding[]; matched: number; unsupported: string[]; sources: Record<Source, number>; scope?: string;
}

const MAX_FILES = 5000;
const MAX_BYTES = 512 * 1024;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const U: Schema = { type: 'unknown' };
const lineOf = (src: string, off: number) => src.slice(0, off).split('\n').length;

// ---- minimal YAML (the subset OpenAPI files use: block maps/sequences, flow lists/maps, scalars, block strings) -----
export function parseYaml(text: string): unknown {
  const lines = text.split('\n').map((raw) => ({ raw, indent: raw.search(/\S/), body: raw.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '').trimEnd() })).filter((l) => l.body.trim() && l.indent >= 0 && !/^---|^\.\.\./.test(l.body.trim()));
  let i = 0;
  const scalar = (v: string): unknown => {
    const s = v.trim();
    if (/^".*"$/.test(s)) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
    if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
    if (s.startsWith('[') || s.startsWith('{')) return flow(s);
    if (s === 'true' || s === 'false') return s === 'true';
    if (s === 'null' || s === '~' || s === '') return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
  };
  const flow = (s: string): unknown => {
    const inner = s.slice(1, -1).trim();
    const parts: string[] = [];
    let depth = 0; let cur = ''; let q = '';
    for (const ch of inner) {
      if (q) { cur += ch; if (ch === q) q = ''; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '[' || ch === '{') depth++;
      if (ch === ']' || ch === '}') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    if (s.startsWith('[')) return parts.map(scalar);
    return Object.fromEntries(parts.map((p) => { const k = p.indexOf(':'); return [String(scalar(p.slice(0, k))), scalar(p.slice(k + 1))]; }));
  };
  const block = (indent: number): unknown => {
    if (i >= lines.length) return null;
    const seq = lines[i].body.trim().startsWith('- ') || lines[i].body.trim() === '-';
    if (seq) {
      const arr: unknown[] = [];
      while (i < lines.length && lines[i].indent === indent && /^-( |$)/.test(lines[i].body.trim())) {
        const rest = lines[i].body.trim().slice(1).trim();
        if (!rest) { i++; arr.push(i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null); continue; }
        if (/^[^'"[{][^:]*:(\s|$)/.test(rest) || /^["'][^"']+["']\s*:(\s|$)/.test(rest)) { // "- key: v" starts a map item
          const dash = lines[i].raw.indexOf('-');
          const pos = dash + 1 + lines[i].raw.slice(dash + 1).search(/\S/);
          lines[i] = { ...lines[i], indent: pos, body: rest };
          arr.push(block(pos));
          continue;
        }
        i++; arr.push(scalar(rest));
      }
      return arr;
    }
    const obj: Record<string, unknown> = {};
    while (i < lines.length && lines[i].indent === indent) {
      const t = lines[i].body.trim();
      const m = /^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/.exec(t);
      if (!m) { i++; continue; }
      const key = String(scalar(m[1]));
      const val = m[2];
      i++;
      if (val === undefined || val === '') obj[key] = i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : i < lines.length && lines[i].indent === indent && lines[i].body.trim().startsWith('- ') ? block(indent) : null;
      else if (/^[|>][-+]?$/.test(val)) { const parts: string[] = []; while (i < lines.length && lines[i].indent > indent) parts.push(lines[i++].body.trim()); obj[key] = parts.join(val.startsWith('|') ? '\n' : ' '); }
      else obj[key] = scalar(val);
    }
    return obj;
  };
  return lines.length ? block(lines[0].indent) : null;
}

// ---- OpenAPI ----------------------------------------------------------------------------------------------------
type J = Record<string, unknown>;
function oaSchema(s: unknown, doc: J, depth = 0): Schema {
  if (!s || typeof s !== 'object' || depth > 12) return U;
  let x = s as J;
  if (typeof x.$ref === 'string') {
    const ref = x.$ref;
    const target = ref.startsWith('#/') ? ref.slice(2).split('/').reduce<unknown>((o, k) => (o as J | undefined)?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc) : undefined;
    const r = oaSchema(target, doc, depth + 1);
    return { ...r, name: ref.split('/').pop() };
  }
  if (Array.isArray(x.allOf)) {
    const parts = x.allOf.map((p) => oaSchema(p, doc, depth + 1));
    return { type: 'object', props: Object.assign({}, ...parts.map((p) => p.props ?? {})), nullable: x.nullable === true };
  }
  if (Array.isArray(x.oneOf) || Array.isArray(x.anyOf)) {
    const alts = ((x.oneOf ?? x.anyOf) as unknown[]).map((p) => oaSchema(p, doc, depth + 1));
    const real = alts.filter((a) => a.type !== 'null');
    if (real.length === 1) return { ...real[0], nullable: true };
    return U; // a union of shapes: not compared field by field
  }
  let type = x.type as string | string[] | undefined;
  let nullable = x.nullable === true;
  if (Array.isArray(type)) { nullable = type.includes('null'); type = type.find((t) => t !== 'null'); }
  if (!type && x.properties) type = 'object';
  if (type === 'object' || x.properties) {
    const req = new Set(Array.isArray(x.required) ? x.required as string[] : []);
    const props: Schema['props'] = {};
    for (const [k, v] of Object.entries((x.properties ?? {}) as J)) props[k] = { schema: oaSchema(v, doc, depth + 1), required: req.has(k) };
    return { type: 'object', props, nullable, open: !x.properties };
  }
  if (type === 'array') return { type: 'array', items: oaSchema(x.items, doc, depth + 1), nullable };
  x = x as J;
  return { type: (['string', 'number', 'integer', 'boolean'].includes(type as string) ? type : 'unknown') as SType, nullable };
}

function openapi(file: string, text: string): Endpoint[] {
  let doc: J;
  try { doc = (file.endsWith('.json') ? JSON.parse(text) : parseYaml(text)) as J; } catch { return []; }
  if (!doc || typeof doc !== 'object' || !(doc.openapi || doc.swagger) || typeof doc.paths !== 'object') return [];
  const servers = Array.isArray(doc.servers) ? (doc.servers as J[]).map((s) => String(s.url ?? '')) : [];
  const base = typeof doc.basePath === 'string' ? doc.basePath : servers.length ? (servers[0].replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\{[^}]+\}/g, '') || '') : '';
  const globalSec = Array.isArray(doc.security) && (doc.security as unknown[]).length ? Object.keys((doc.security as J[])[0] ?? {}).join(', ') : undefined;
  const out: Endpoint[] = [];
  for (const [p, item] of Object.entries(doc.paths as J)) {
    for (const [m, opRaw] of Object.entries((item ?? {}) as J)) {
      if (!METHODS.includes(m.toUpperCase())) continue;
      const op = (opRaw ?? {}) as J;
      const params = [...((item as J).parameters as J[] ?? []), ...(op.parameters as J[] ?? [])].map((x) => (typeof x.$ref === 'string' ? String(x.$ref).split('/').pop()! : `${x.in}:${x.name}`));
      const content = (o: unknown) => { const c = (o as J | undefined)?.content as J | undefined; return c ? (c['application/json'] ?? c['application/vnd.api+json'] ?? Object.values(c)[0]) as J : o as J | undefined; };
      const ok = Object.entries((op.responses ?? {}) as J).find(([code]) => /^2\d\d$/.test(code));
      const resp = ok ? content(ok[1]) : undefined;
      const swaggerBody = (op.parameters as J[] ?? []).find((x) => x.in === 'body');
      const reqBody = op.requestBody ? content(op.requestBody) : swaggerBody;
      const sec = Array.isArray(op.security) ? ((op.security as J[]).length ? Object.keys((op.security as J[])[0] ?? {}).join(', ') : undefined) : globalSec;
      const line = lineOf(text, Math.max(0, text.indexOf(file.endsWith('.json') ? `"${p}"` : `${p}:`)));
      out.push({ method: m.toUpperCase(), path: `${base.replace(/\/$/, '')}${p}`, source: 'openapi', file, line, params, explicit: true, auth: sec,
        response: resp?.schema ? oaSchema(resp.schema, doc) : undefined, request: reqBody?.schema ? oaSchema(reqBody.schema, doc) : undefined });
    }
  }
  return out;
}

// ---- Go: structs and Fiber routes ----------------------------------------------------------------------------------
function goType(t: string, structs: Map<string, string>, depth: number): Schema {
  t = t.trim();
  if (t.startsWith('*')) return { ...goType(t.slice(1), structs, depth), nullable: true };
  if (t.startsWith('[]')) return { type: 'array', items: goType(t.slice(2), structs, depth) };
  if (t.startsWith('map[')) return { type: 'object', open: true };
  if (t === 'string' || t === 'time.Time' || t === 'uuid.UUID') return { type: 'string' };
  if (/^u?int\d*$/.test(t)) return { type: 'integer' };
  if (/^float\d+$/.test(t)) return { type: 'number' };
  if (t === 'bool') return { type: 'boolean' };
  const name = t.split('.').pop()!;
  return structs.has(name) && depth < 8 ? goStruct(name, structs, depth + 1) : U;
}
function goStruct(name: string, structs: Map<string, string>, depth = 0): Schema {
  const body = structs.get(name);
  if (body === undefined) return U;
  const props: NonNullable<Schema['props']> = {};
  for (const raw of body.split('\n')) {
    const l = raw.replace(/\/\/.*$/, '').trim();
    if (!l) continue;
    const m = /^([A-Za-z_]\w*)\s+([^`]+?)\s*(?:`([^`]*)`)?$/.exec(l);
    const embedded = /^\*?([A-Za-z_][\w.]*)\s*(?:`[^`]*`)?$/.exec(l);
    if (!m && embedded) { const e = goType(embedded[1], structs, depth); Object.assign(props, e.props ?? {}); continue; }
    if (!m || !/^[A-Z]/.test(m[1])) continue; // unexported fields are not serialized
    const tag = /json:"([^"]*)"/.exec(m[3] ?? '')?.[1];
    if (tag === '-') continue;
    const [jsonName, ...opts] = (tag ?? '').split(',');
    props[jsonName || m[1]] = { schema: goType(m[2], structs, depth), required: !opts.includes('omitempty') && !m[2].trim().startsWith('*') };
  }
  return { type: 'object', props, name };
}

function fiber(files: Map<string, string>, structs: Map<string, string>, unsupported: string[]): Endpoint[] {
  const out: Endpoint[] = [];
  // handler bodies by name: "List" (functions) and "Recv.List" (methods)
  const bodies = new Map<string, { file: string; body: string }>();
  for (const [file, src] of files) {
    if (!file.endsWith('.go')) continue;
    const code = mask(src, 'go').code;
    for (const m of code.matchAll(/^func\s+(?:\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)\s*\)\s*)?([A-Za-z_]\w*)\s*\([^)]*\)[^{\n]*\{/gm)) {
      let depth = 0; let end = m.index! + m[0].length - 1;
      for (; end < code.length; end++) { if (code[end] === '{') depth++; else if (code[end] === '}' && --depth === 0) break; }
      const body = src.slice(m.index!, end + 1);
      bodies.set(m[2], { file, body });
      if (m[1]) bodies.set(`${m[1]}.${m[2]}`, { file, body });
    }
  }
  const schemaOfExpr = (expr: string, body: string): Schema | undefined => {
    const e = expr.trim();
    if (/^fiber\.Map\s*\{/.test(e) || /^map\[string\](interface\{\}|any)\s*\{/.test(e)) {
      const props: NonNullable<Schema['props']> = {};
      for (const kv of e.matchAll(/"([^"]+)"\s*:\s*([^,}\n]+)/g)) props[kv[1]] = { schema: literal(kv[2], body), required: true };
      return { type: 'object', props, open: false, name: 'fiber.Map' };
    }
    const comp = /^&?(\[\])?([A-Za-z_][\w.]*)\s*\{/.exec(e);
    if (comp) { const s = goType(comp[2], structs, 0); return comp[1] ? { type: 'array', items: s } : s; }
    if (/^[A-Za-z_]\w*$/.test(e)) {
      const v = new RegExp(`\\b${e}\\s*:?=\\s*&?(\\[\\])?([A-Za-z_][\\w.]*)\\s*\\{|\\bvar\\s+${e}\\s+(\\[\\])?\\*?([A-Za-z_][\\w.]*)|\\b${e}\\s*:?=\\s*make\\(\\s*\\[\\]\\*?([A-Za-z_][\\w.]*)`).exec(body);
      if (v) { const name = v[2] ?? v[4] ?? v[5]; const arr = Boolean(v[1] ?? v[3] ?? v[5]); const s = goType(name, structs, 0); return s.type === 'unknown' ? undefined : arr ? { type: 'array', items: s } : s; }
    }
    return undefined;
  };
  const literal = (v: string, body: string): Schema => {
    const t = v.trim();
    if (/^"/.test(t)) return { type: 'string' };
    if (/^-?\d+$/.test(t)) return { type: 'integer' };
    if (/^-?\d+\.\d+$/.test(t)) return { type: 'number' };
    if (t === 'true' || t === 'false') return { type: 'boolean' };
    if (t === 'nil') return { type: 'null' };
    return schemaOfExpr(t, body) ?? U;
  };
  for (const [file, src] of files) {
    if (!file.endsWith('.go') || !/\b(fiber|Group|\.Get|\.Post)\b/.test(src)) continue;
    const code = mask(src, 'go').code;
    const prefix = new Map<string, string>();
    const auth = new Map<string, string>();
    for (const m of code.matchAll(/\b([A-Za-z_]\w*)\s*:?=\s*([A-Za-z_]\w*)\.Group\(\s*"([^"]*)"/g)) {
      prefix.set(m[1], `${prefix.get(m[2]) ?? ''}${m[3]}`);
      const args = splitTop(callText(code, code.indexOf('(', m.index!)), ',').slice(1);
      const mw = args.map((x) => x.trim()).find((x) => /auth|jwt|protect|guard|session/i.test(x));
      if (mw || auth.has(m[2])) auth.set(m[1], mw ?? auth.get(m[2])!);
    }
    for (const m of code.matchAll(/\b([A-Za-z_]\w*)\.Use\(([^)]*)\)/g)) { const mw = m[2].split(',').map((x) => x.trim()).find((x) => /auth|jwt|protect|guard|session/i.test(x)); if (mw) auth.set(m[1], mw); }
    for (const m of code.matchAll(/\b([A-Za-z_]\w*)\.(Get|Post|Put|Patch|Delete|All)\(\s*([^,)]+)\s*,([^)]*(?:\([^)]*\)[^)]*)*)\)/g)) {
      const line = lineOf(src, m.index!);
      if (!/^"[^"]*"$/.test(m[3].trim())) { unsupported.push(`dynamic Fiber route at ${file}:${line} (path is not a string literal)`); continue; }
      const p = `${prefix.get(m[1]) ?? ''}${m[3].trim().slice(1, -1)}`.replace(/:([A-Za-z_]\w*)\??/g, '{$1}').replace(/\/+/g, '/');
      const args = m[4].split(',').map((x) => x.trim()).filter(Boolean);
      const handler = args.at(-1) ?? '';
      const mw = args.slice(0, -1).find((x) => /auth|jwt|protect|guard|session/i.test(x)) ?? auth.get(m[1]);
      const key = handler.replace(/^[a-z]\w*\./, (x) => (bodies.has(handler.split('.').pop()!) ? '' : x));
      const h = bodies.get(handler.split('.').pop()!) ?? bodies.get(key);
      let response: Schema | undefined;
      let request: Schema | undefined;
      if (h) {
        const json = /\.JSON\(\s*([\s\S]*?)\)\s*$/m.exec(h.body.split('\n').filter((l) => /\.JSON\(/.test(l) && !/Status\(\s*(fiber\.)?(Status)?(4|5)\d\d/.test(l) && !/StatusBadRequest|StatusNotFound|StatusInternal|StatusUnauthorized|StatusForbidden|Status(4|5)\d\d|err/.test(l)).at(-1) ?? '');
        if (json) response = schemaOfExpr(json[1].replace(/\)\s*$/, ''), h.body);
        const bp = /BodyParser\(\s*&?([A-Za-z_]\w*)\s*\)/.exec(h.body);
        if (bp) request = schemaOfExpr(bp[1], h.body);
      }
      const methods = m[2] === 'All' ? ['ALL'] : [m[2].toUpperCase()];
      for (const method of methods) out.push({ method, path: p || '/', source: 'fiber', file, line, params: [...p.matchAll(/\{(\w+)\}/g)].map((x) => `path:${x[1]}`), explicit: Boolean(response && response.name && response.name !== 'fiber.Map'), handler, response, request, auth: mw });
    }
  }
  return out;
}

// ---- TypeScript types ---------------------------------------------------------------------------------------------
function tsType(t: string, types: Map<string, string>, depth: number): Schema {
  t = t.trim().replace(/;$/, '');
  const parts = splitTop(t, '|').map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) {
    const real = parts.filter((p) => p !== 'null' && p !== 'undefined');
    const nullable = real.length < parts.length;
    if (real.every((p) => /^['"`]/.test(p))) return { type: 'string', nullable };
    if (real.length === 1) return { ...tsType(real[0], types, depth), nullable: nullable || undefined };
    return { type: 'unknown', nullable };
  }
  if (t.endsWith('[]')) return { type: 'array', items: tsType(t.slice(0, -2), types, depth) };
  const arr = /^(?:Array|ReadonlyArray)<(.+)>$/.exec(t);
  if (arr) return { type: 'array', items: tsType(arr[1], types, depth) };
  if (t.startsWith('{')) return tsObject(t.slice(1, t.lastIndexOf('}')), types, depth);
  if (t === 'string' || /^['"`]/.test(t)) return { type: 'string' };
  if (t === 'number' || /^-?\d/.test(t)) return { type: 'number' };
  if (t === 'boolean' || t === 'true' || t === 'false') return { type: 'boolean' };
  if (t === 'null') return { type: 'null' };
  if (/^(Date)$/.test(t)) return { type: 'string' };
  if (/^Record</.test(t)) return { type: 'object', open: true };
  const name = t.replace(/<.*$/, '');
  return types.has(name) && depth < 8 ? { ...tsNamed(name, types, depth + 1), name } : U;
}
function splitTop(s: string, sep: string): string[] {
  const out: string[] = []; let depth = 0; let cur = ''; let q = '';
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') q = ch;
    if ('{[(<'.includes(ch)) depth++;
    if ('}])>'.includes(ch)) depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function tsObject(body: string, types: Map<string, string>, depth: number): Schema {
  const props: NonNullable<Schema['props']> = {};
  for (const member of splitTop(body.replace(/\n/g, ';'), ';').flatMap((x) => splitTop(x, ','))) {
    const m = /^\s*(?:readonly\s+)?["']?([A-Za-z_$][\w$-]*)["']?(\?)?\s*:\s*([\s\S]+)$/.exec(member);
    if (m) props[m[1]] = { schema: tsType(m[3], types, depth), required: !m[2] };
  }
  return { type: 'object', props };
}
function tsNamed(name: string, types: Map<string, string>, depth = 0): Schema {
  const def = types.get(name)!;
  const ext = /^extends\s+([\w\s,<>]+?)\s*\{/.exec(def);
  const body = def.slice(def.indexOf('{') + 1, def.lastIndexOf('}'));
  const own = def.trim().startsWith('{') || ext ? tsObject(body, types, depth) : tsType(def, types, depth);
  if (ext) for (const base of ext[1].split(',')) { const b = tsType(base.trim(), types, depth); own.props = { ...(b.props ?? {}), ...(own.props ?? {}) }; }
  return own;
}

// ---- Next.js API routes and TS consumers ----------------------------------------------------------------------------
function literalSchema(expr: string, types: Map<string, string>): Schema | undefined {
  const e = expr.trim();
  const cast = /\b(?:as|satisfies)\s+([A-Za-z_$][\w$<>[\]]*)\s*$/.exec(e);
  if (cast) return tsType(cast[1], types, 0);
  if (!e.startsWith('{')) return undefined;
  const props: NonNullable<Schema['props']> = {};
  const body = e.slice(1, e.lastIndexOf('}'));
  for (const part of splitTop(body, ',')) {
    const m = /^\s*["']?([A-Za-z_$][\w$-]*)["']?\s*(?::\s*([\s\S]+))?$/.exec(part);
    if (!m) { if (/^\s*\.\.\./.test(part)) return { type: 'object', props, open: true }; continue; }
    const v = (m[2] ?? '').trim();
    const s: Schema = /^['"`]/.test(v) ? { type: 'string' } : /^-?\d+(\.\d+)?$/.test(v) ? { type: 'number' } : /^(true|false)$/.test(v) ? { type: 'boolean' } : v === 'null' ? { type: 'null' } : v.startsWith('[') ? { type: 'array', items: U } : v.startsWith('{') ? literalSchema(v, types) ?? U : U;
    props[m[1]] = { schema: s, required: true };
  }
  return { type: 'object', props };
}

/** The string/template literal starting at `at` in the original source (template expressions kept as written). */
function readLiteral(src: string, at: number): string | undefined {
  const q = src[at];
  if (q !== '"' && q !== "'" && q !== '`') return undefined;
  let depth = 0;
  for (let i = at + 1; i < src.length && i < at + 2000; i++) {
    const ch = src[i];
    if (ch === '\\') { i++; continue; }
    if (q === '`' && ch === '$' && src[i + 1] === '{') { depth++; i++; continue; }
    if (depth && ch === '}') { depth--; continue; }
    if (!depth && ch === q) return src.slice(at + 1, i);
    if (ch === '\n' && q !== '`') return undefined;
  }
  return undefined;
}

/** Text of the call starting at `open` (index of "(") up to its matching ")". */
function callText(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length && i < open + 4000; i++) { if (code[i] === '(') depth++; else if (code[i] === ')' && --depth === 0) return code.slice(open + 1, i); }
  return code.slice(open + 1, open + 400);
}

function nextRoutes(files: Map<string, string>, types: Map<string, string>, unsupported: string[]): Endpoint[] {
  const out: Endpoint[] = [];
  for (const [file, src] of files) {
    const pages = /(^|\/)pages\/api\/(.+)\.(t|j)sx?$/.exec(file);
    const app = /(^|\/)app\/(.*?)\/?route\.(t|j)s$/.exec(file);
    if (!pages && !app) continue;
    const segs = (pages ? `api/${pages[2]}` : app![2]).split('/').filter((s) => s && !/^\(.*\)$/.test(s) && s !== 'index');
    if (segs.some((s) => s.startsWith('[...') || s.startsWith('[[...'))) { unsupported.push(`catch-all API route ${file} (dynamic path; not compared)`); continue; }
    const p = `/${segs.map((s) => s.replace(/^\[(\w+)\]$/, '{$1}')).join('/')}`;
    const code = mask(src, 'ts').code;
    const methods = app ? [...code.matchAll(/export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => ({ method: m[1], at: m.index! }))
      : [...new Set([...code.matchAll(/req\.method\s*===?\s*['"](\w+)['"]/g)].map((m) => m[1].toUpperCase()))].map((method) => ({ method, at: 0 }));
    if (!methods.length) methods.push({ method: 'ANY', at: 0 });
    for (const { method, at } of methods) {
      const region = app ? code.slice(at, (methods.find((x) => x.at > at)?.at) ?? code.length) : code;
      const call = /(?:NextResponse|Response)\.json\(|res\.(?:status\(\s*2\d\d\s*\)\.)?json\(/.exec(region);
      const response = call ? literalSchema(splitTop(callText(region, call.index! + call[0].length - 1), ',')[0], types) : undefined;
      out.push({ method, path: p, source: 'next', file, line: lineOf(src, at), params: [...p.matchAll(/\{(\w+)\}/g)].map((x) => `path:${x[1]}`), explicit: Boolean(response?.name), response });
    }
  }
  return out;
}

function consumers(files: Map<string, string>, types: Map<string, string>, consts: Map<string, string>, skip: Set<string>): Consumer[] {
  const out: Consumer[] = [];
  for (const [file, src] of files) {
    if (!/\.(m|c)?[jt]sx?$/.test(file) || skip.has(file) || /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\./.test(file)) continue;
    if (!/\bfetch\(|\.(get|post|put|patch|delete)\s*[<(]/.test(src)) continue;
    const code = mask(src, 'ts').code;
    const bases = new Map<string, string | null>();
    for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*axios\.create\(\s*\{([^}]*)\}/g)) { const b = /baseURL\s*:\s*(['"`])([^'"`]*)\1/.exec(m[2]); bases.set(m[1], b && !b[2].includes('${') ? b[2] : null); }
    const resolveUrl = (raw: string): { path: string; exact: boolean } => {
      let exact = true;
      let s = raw.replace(/\$\{\s*([A-Za-z_$][\w$.]*)\s*\}/g, (_m, id: string, off: number) => {
        if (off === 0 && consts.has(id)) return consts.get(id)!;
        if (off === 0) { exact = false; return ''; }
        return `{${id.split('.').pop()}}`;
      });
      if (/^https?:\/\//i.test(s)) { exact = false; s = s.replace(/^https?:\/\/[^/]+/i, ''); } // another origin: compared by path only
      s = s.split('?')[0];
      return { path: s.startsWith('/') ? s : `/${s}`, exact };
    };
    // enclosing function's declared return type: async function getOrders(): Promise<Order[]>
    const fnTypes = [...code.matchAll(/(?:function\s+\w+|\b\w+\s*[:=]\s*(?:async\s*)?(?:function)?)\s*\([^)]*\)\s*:\s*Promise<([^>{}]+(?:<[^>]*>)?[^>{}]*)>\s*(?:=>\s*)?\{/g)].map((m) => ({ at: m.index!, type: m[1] }));
    const typeAfter = (off: number, explicit?: string): { s?: Schema; name?: string } => {
      if (explicit) return { s: tsType(explicit, types, 0), name: explicit };
      const after = code.slice(off, off + 600);
      const cast = /\.json(?:<([^>]+)>)?\(\)\s*\)?\s*(?:as\s+(?:Promise<)?([A-Za-z_$][\w$[\]<>]*))?|:\s*([A-Za-z_$][\w$[\]<>]*)\s*=\s*await\s+\w+\.json\(\)/.exec(after);
      const name = cast?.[1] ?? cast?.[2] ?? cast?.[3] ?? [...fnTypes].reverse().find((f) => f.at < off)?.type;
      return name ? { s: tsType(name.replace(/>$/, ''), types, 0), name: name.replace(/>$/, '') } : {};
    };
    for (const m of code.matchAll(/\bfetch\(\s*(?=['"`])/g)) {
      const lit = readLiteral(src, m.index! + m[0].length);
      if (!lit) continue;
      const { path: p, exact } = resolveUrl(lit);
      const call = callText(code, m.index! + 5);
      const method = (/method\s*:\s*['"](\w+)['"]/.exec(call)?.[1] ?? 'GET').toUpperCase();
      const body = /body\s*:\s*JSON\.stringify\(\s*([\s\S]+?)\s*\)\s*[,}]/.exec(call);
      const t = typeAfter(m.index!);
      out.push({ method, path: p, raw: lit, file, line: lineOf(src, m.index!), client: 'fetch', exactPath: exact, expects: t.s, typeName: t.name, sends: body ? literalSchema(body[1], types) : undefined });
    }
    for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete)\s*(?:<([^>(]+(?:<[^>]*>)?)>)?\s*\(\s*(?=['"`])/g)) {
      const obj = m[1];
      const lit = readLiteral(src, m.index! + m[0].length);
      if (lit === undefined) continue;
      if (!bases.has(obj) && !/^(axios|api|http|client|apiClient|request|instance|\$http|ky)$/i.test(obj)) continue;
      const base = bases.get(obj);
      const r = resolveUrl(lit);
      const p = base === undefined ? r.path : base === null ? r.path : `${base.replace(/\/$/, '')}${r.path}`;
      const exact = r.exact && base !== null;
      const args = splitTop(callText(code, m.index! + m[0].lastIndexOf('(')), ',');
      const t = typeAfter(m.index!, m[3]);
      out.push({ method: m[2].toUpperCase(), path: p, raw: lit, file, line: lineOf(src, m.index!), client: obj, exactPath: exact, expects: t.s, typeName: t.name, sends: ['post', 'put', 'patch'].includes(m[2]) && args[1] ? literalSchema(args[1], types) : undefined });
    }
  }
  return out;
}

// ---- comparison ---------------------------------------------------------------------------------------------------
const norm = (p: string) => p.toLowerCase().replace(/\{[^}]*\}|:[a-z_]\w*|\[[^\]]+\]/gi, '{}').replace(/\/+$/, '') || '/';
const stripVersion = (p: string) => norm(p).replace(/^\/api(?=\/|$)/, '').replace(/^\/v\d+(?=\/|$)/, '') || '/';
const version = (p: string) => /\/v(\d+)(?=\/|$)/.exec(p)?.[1];
const describe = (s: Schema | undefined): string => (!s ? 'unknown' : s.type === 'array' ? `${describe(s.items)}[]` : `${s.type === 'object' && s.name ? s.name : s.type === 'integer' ? 'integer' : s.type}${s.nullable ? ' | null' : ''}`);
const compatible = (a: SType, b: SType) => a === b || (a === 'integer' && b === 'number') || (a === 'number' && b === 'integer') || a === 'unknown' || b === 'unknown';
const words = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\-\s]+/).filter(Boolean);
/** Plausible rename: same words except one id-like or synonym word (order_id ~ order_uuid, createdAt ~ created_at). */
function renameOf(field: string, candidates: string[]): string | undefined {
  const fw = words(field);
  const ID = new Set(['id', 'uuid', 'guid', 'key', 'code', 'ref', 'no', 'number', 'num']);
  return candidates.find((c) => {
    const cw = words(c);
    if (cw.join('_') === fw.join('_')) return true; // camelCase vs snake_case
    if (cw.length !== fw.length) return false;
    const diff = cw.filter((w, i) => w !== fw[i]);
    return diff.length === 1 && cw.length > 1 && ID.has(diff[0]) && ID.has(fw[cw.indexOf(diff[0])]);
  });
}

/** JSON:API ({data: {id, type, attributes}}) and {data: …} envelopes are unwrapped when the frontend expects the resource. */
function unwrap(actual: Schema, expected: Schema): { s: Schema; note?: string } {
  const data = actual.props?.data?.schema;
  if (!data || expected.props?.data) return { s: actual };
  const res = data.type === 'array' ? data.items : data;
  const attrs = res?.props?.attributes?.schema;
  if (attrs?.props) {
    const flat: Schema = { type: 'object', props: { ...(res!.props!.id ? { id: res!.props!.id } : {}), ...attrs.props } };
    return { s: data.type === 'array' ? { type: 'array', items: flat } : flat, note: 'JSON:API resource (data.attributes)' };
  }
  return { s: data, note: 'response wrapped in "data"' };
}

function compareSchemas(endpoint: string, expected: Schema, actual: Schema, strict: boolean, ev: string[], prefix = '', out: Finding[] = [], depth = 0): Finding[] {
  if (depth > 6 || expected.type === 'unknown' || actual.type === 'unknown') return out;
  if (expected.type === 'array' && actual.type === 'array' && expected.items && actual.items) return compareSchemas(endpoint, expected.items, actual.items, strict, ev, prefix ? `${prefix}[]` : '', out, depth + 1);
  if (!compatible(expected.type, actual.type) && !(actual.type === 'null' && expected.nullable)) {
    out.push({ endpoint, kind: 'type mismatch', status: strict ? 'verified' : 'possible', field: prefix || '(response)', backend: describe(actual), frontend: describe(expected), detail: `frontend expects ${describe(expected)}, backend returns ${describe(actual)}`, evidence: ev });
    return out;
  }
  if (expected.type !== 'object' || !expected.props || !actual.props) return out;
  for (const [k, f] of Object.entries(expected.props)) {
    const name = prefix ? `${prefix}.${k}` : k;
    const a = actual.props[k];
    if (!a) {
      if (!f.required) continue; // optional on the frontend: absence is fine
      const renamed = renameOf(k, Object.keys(actual.props).filter((x) => !(x in expected.props!)));
      if (renamed) out.push({ endpoint, kind: 'renamed field', status: 'possible', field: name, backend: `${prefix ? `${prefix}.` : ''}${renamed}: ${describe(actual.props[renamed].schema)}`, frontend: `${name}: ${describe(f.schema)}`, detail: `frontend reads ${name}; backend has ${renamed} instead (possible rename)`, evidence: ev });
      else if (!actual.open) out.push({ endpoint, kind: 'missing field', status: strict ? 'verified' : 'possible', field: name, frontend: `${name}: ${describe(f.schema)}`, detail: `frontend expects ${name}, which the backend response does not declare`, evidence: ev });
      continue;
    }
    if (a.schema.nullable && !f.schema.nullable && f.schema.type !== 'unknown') out.push({ endpoint, kind: 'nullable field', status: 'possible', field: name, backend: `${name}: ${describe(a.schema)}`, frontend: `${name}: ${describe(f.schema)}`, detail: `backend may return null for ${name}; the frontend type does not allow null`, evidence: ev });
    else if (!a.required && f.required && !f.schema.nullable && strict) out.push({ endpoint, kind: 'missing field', status: 'possible', field: name, backend: `${name}?: ${describe(a.schema)} (optional)`, frontend: `${name}: ${describe(f.schema)}`, detail: `backend may omit ${name}; the frontend treats it as always present`, evidence: ev });
    compareSchemas(endpoint, f.schema, a.schema, strict, ev, name, out, depth + 1);
  }
  return out;
}

/** Everything contract checking reads from one repository (no comparison yet). */
export interface ContractScan { endpoints: Endpoint[]; consumers: Consumer[]; unsupported: string[]; /** exported TS interfaces: name → sorted field names (for shared-type detection) */ typeShapes: Map<string, string> }

export async function scanContracts(root: string): Promise<ContractScan> {
  const listed = (await listFiles(root, { includeGenerated: true })).files.filter((f) => /\.(go|[cm]?[jt]sx?|json|ya?ml)$/.test(f)).slice(0, MAX_FILES);
  const files = new Map<string, string>();
  for (const f of listed) {
    try { const st = fs.lstatSync(path.join(root, f)); if (st.isFile() && st.size <= MAX_BYTES) files.set(f, fs.readFileSync(path.join(root, f), 'utf8')); } catch { /* gone */ }
  }
  const unsupported: string[] = [];
  // explicit specs first
  const endpoints: Endpoint[] = [];
  for (const [f, text] of files) if (/\.(json|ya?ml)$/.test(f) && /(openapi|swagger)/i.test(text.slice(0, 2000)) && /\bpaths\b/.test(text)) endpoints.push(...openapi(f, text));
  // indexes for code: Go structs, TS types (generated ones included), string constants
  const structs = new Map<string, string>();
  const types = new Map<string, string>();
  const consts = new Map<string, string>();
  for (const [f, src] of files) {
    if (f.endsWith('.go')) for (const m of src.matchAll(/^type\s+([A-Za-z_]\w*)\s+struct\s*\{/gm)) { let d = 0; let e = m.index! + m[0].length - 1; for (; e < src.length; e++) { if (src[e] === '{') d++; else if (src[e] === '}' && --d === 0) break; } structs.set(m[1], src.slice(m.index! + m[0].length, e)); }
    if (/\.[cm]?[jt]sx?$/.test(f)) {
      const code = mask(src, 'ts').code;
      for (const m of code.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(interface|type)\s+([A-Za-z_$][\w$]*)(?:<[^>]*>)?\s*(extends\s+[^{]+)?(=)?\s*/g)) {
        const start = m.index! + m[0].length;
        if (m[1] === 'interface' || code[start] === '{') { let d = 0; let e = start; for (; e < code.length; e++) { if (code[e] === '{') d++; else if (code[e] === '}' && --d === 0) break; } types.set(m[2], `${m[3] ? `${m[3]} ` : ''}${code.slice(start, e + 1)}`); }
        else if (m[4]) types.set(m[2], code.slice(start, code.indexOf(';', start) > 0 ? code.indexOf(';', start) : start + 200).replace(/\n\s*\n[\s\S]*$/, ''));
      }
      for (const m of code.matchAll(/\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])(\/[^'"`$]*)\2/g)) if (!consts.has(m[1])) consts.set(m[1], m[3]);
    }
  }
  const specPaths = new Set(endpoints.map((e) => `${e.method} ${norm(e.path)}`));
  const code: Endpoint[] = [...fiber(files, structs, unsupported), ...nextRoutes(files, types, unsupported)];
  // the spec is authoritative: code routes add only what the spec does not describe
  endpoints.push(...code.filter((e) => !specPaths.has(`${e.method} ${norm(e.path)}`)));
  const routeFiles = new Set(endpoints.filter((e) => e.source === 'next').map((e) => e.file));
  const cons = consumers(files, types, consts, routeFiles).filter((c) => c.path.startsWith('/') && !/^\/\/|^\/{}$/.test(c.path));
  const typeShapes = new Map<string, string>();
  for (const [name] of types) { const s = tsType(name, types, 0); if (s.props && Object.keys(s.props).length >= 2) typeShapes.set(name, Object.keys(s.props).sort().join(',')); }
  return { endpoints, consumers: cons, unsupported: [...new Set(unsupported)], typeShapes };
}

/** A frontend call matched to a backend endpoint. */
export interface Link { consumer: Consumer; endpoint: Endpoint; exact: boolean }

export async function checkContracts(root: string, scope?: string): Promise<ContractReport> {
  const scan = await scanContracts(root);
  let endpoints = scan.endpoints;
  let cons = scan.consumers;
  if (scope) {
    const s = scope.toLowerCase();
    endpoints = endpoints.filter((e) => e.path.toLowerCase().includes(s) || e.file.toLowerCase().includes(s));
    cons = cons.filter((c) => c.path.toLowerCase().includes(s) || c.file.toLowerCase().includes(s));
  }
  const { findings, links } = compareContracts(endpoints, cons);
  const sources = { openapi: 0, fiber: 0, next: 0 } as Record<Source, number>;
  for (const e of endpoints) sources[e.source]++;
  return { endpoints, consumers: cons, findings, matched: links.length, unsupported: scan.unsupported, sources, scope };
}

const where = (x: { repo?: string; file: string; line: number }) => `${x.repo ? `${x.repo}/` : ''}${x.file}:${x.line}`;

/** Matches calls to endpoints (exact path, else version/prefix-insensitive) and compares their contracts. */
export function compareContracts(endpoints: Endpoint[], cons: Consumer[]): { findings: Finding[]; links: Link[] } {
  const findings: Finding[] = [];
  const links: Link[] = [];
  const hasBackend = endpoints.length > 0;
  const specServes = (p: string) => endpoints.some((e) => e.source === 'openapi' && norm(p).split('/')[1] === norm(e.path).split('/')[1]);
  for (const c of cons) {
    const key = `${c.method} ${c.path}`;
    const ev = [`frontend ${where(c)}`];
    const same = endpoints.filter((e) => norm(e.path) === norm(c.path));
    const fuzzy = same.length ? [] : endpoints.filter((e) => stripVersion(e.path) === stripVersion(c.path) || (!c.exactPath && norm(e.path).endsWith(norm(c.path))));
    const cands = same.length ? same : fuzzy;
    if (!cands.length) {
      if (hasBackend) findings.push({ endpoint: key, kind: 'removed endpoint', status: c.exactPath && specServes(c.path) ? 'verified' : 'possible', detail: c.exactPath && specServes(c.path) ? 'not in the API specification' : 'no backend route found (it may be served elsewhere or registered dynamically)', evidence: ev });
      continue;
    }
    const byMethod = cands.filter((e) => e.method === c.method || e.method === 'ANY' || e.method === 'ALL');
    if (!byMethod.length) {
      findings.push({ endpoint: key, kind: 'method changed', status: same.length && c.exactPath ? 'verified' : 'possible', backend: [...new Set(cands.map((e) => e.method))].join(', '), frontend: c.method, detail: `frontend calls ${c.method}; backend serves ${[...new Set(cands.map((e) => e.method))].join(', ')}`, evidence: [...ev, ...cands.slice(0, 2).map((e) => `backend ${where(e)}`)] });
      continue;
    }
    const e = byMethod[0];
    links.push({ consumer: c, endpoint: e, exact: Boolean(same.length && c.exactPath) });
    const evs = [...ev, `backend ${where(e)} (${e.source})`];
    const ve = version(e.path); const vc = version(c.path);
    if (!same.length && ve && vc && ve !== vc) findings.push({ endpoint: `${c.method} ${e.path}`, kind: 'version mismatch', status: 'possible', backend: `v${ve}`, frontend: `v${vc}`, detail: `frontend calls ${c.path}; backend serves ${e.path}`, evidence: evs });
    // verified only for exact matches between explicit declarations
    const strict = Boolean(same.length && c.exactPath && e.explicit && c.typeName);
    if (c.expects && e.response) {
      const { s, note } = unwrap(e.response, c.expects);
      const before = findings.length;
      compareSchemas(`${e.method} ${e.path}`, c.expects, s, strict, evs, '', findings);
      if (note) for (const f of findings.slice(before)) f.detail += ` (${note})`;
    }
    if (c.sends && e.request?.props && c.sends.props && !c.sends.open) {
      for (const [k, f] of Object.entries(e.request.props)) if (f.required && !(k in c.sends.props)) findings.push({ endpoint: `${e.method} ${e.path}`, kind: 'request payload', status: same.length && c.exactPath && e.explicit ? 'verified' : 'possible', field: k, backend: `${k}: ${describe(f.schema)} (required)`, detail: `request body is missing required field ${k}`, evidence: evs });
      for (const k of Object.keys(c.sends.props)) if (!(k in e.request.props) && !e.request.open) { const r = renameOf(k, Object.keys(e.request.props)); findings.push({ endpoint: `${e.method} ${e.path}`, kind: 'request payload', status: 'possible', field: k, frontend: k, backend: r, detail: r ? `frontend sends ${k}; backend expects ${r} (possible rename)` : `frontend sends ${k}, which the backend request schema does not declare`, evidence: evs }); }
    }
  }
  return { findings, links };
}

/** /api-check output: each finding with backend vs frontend and evidence; verified separated from possible. */
export function formatContracts(r: ContractReport): string {
  const out = [`API Contract Check${r.scope ? ` · scope: ${r.scope}` : ''} · ${r.endpoints.length} endpoint${r.endpoints.length === 1 ? '' : 's'} (${Object.entries(r.sources).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none found'}) · ${r.consumers.length} frontend call${r.consumers.length === 1 ? '' : 's'}`];
  if (!r.endpoints.length) out.push('', 'No backend contract found (looked for OpenAPI/Swagger files, Go Fiber routes and Next.js API routes). Nothing can be verified.');
  else if (!r.sources.openapi) out.push('', 'No OpenAPI specification found: backend shapes come from code (Fiber handlers, Next.js routes) and are less certain.');
  const order = [...r.findings].sort((a, b) => (a.status === b.status ? 0 : a.status === 'verified' ? -1 : 1) || a.endpoint.localeCompare(b.endpoint));
  for (const f of order) {
    out.push('', `Endpoint: ${f.endpoint}`);
    if (f.backend) out.push(`  Backend:  ${f.backend}`);
    if (f.frontend) out.push(`  Frontend: ${f.frontend}`);
    out.push(`  Status: ${f.status === 'verified' ? '✗ Verified contract mismatch' : '? Potential contract mismatch'} — ${f.kind}: ${f.detail}`, `  Evidence: ${f.evidence.join(' · ')}`);
  }
  const v = r.findings.filter((f) => f.status === 'verified').length;
  out.push('', `Summary: ${v} verified, ${r.findings.length - v} possible · ${r.matched}/${r.consumers.length} frontend calls matched to a backend endpoint${r.findings.length ? '' : ' · no mismatches found'}`);
  if (r.unsupported.length) out.push(`Not analysed: ${r.unsupported.slice(0, 5).join('; ')}${r.unsupported.length > 5 ? ` (+${r.unsupported.length - 5})` : ''}`);
  out.push('Contracts are read statically; Lumina never rewrites them.');
  return out.join('\n');
}

/** Whether a change touches something contract checking reads (so verification runs it). */
export const API_RELEVANT = /(openapi|swagger)[^/]*\.(json|ya?ml)$|(^|\/)(api|routes?|handlers?|controllers?|dto|types?|models?|schemas?|clients?|services?)(\/|\.|$)|\.go$|route\.(t|j)s$/i;
