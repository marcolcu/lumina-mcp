export type KeyName =
  | 'submit' | 'newline' | 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'backspace' | 'delete'
  | 'interrupt' | 'eof' | 'escape' | 'tab' | 'paste-image' | 'kill-line-start' | 'kill-line-end' | 'kill-word' | 'word-left' | 'word-right';
export type Key = { t: 'text'; s: string } | { t: 'paste'; s: string } | { t: 'key'; name: KeyName };

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const key = (name: KeyName): Key => ({ t: 'key', name });
/** Pasted text: CR/CRLF → LF, tabs → 2 spaces, other control characters dropped. Indentation is preserved. */
const normPaste = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ''); // eslint-disable-line no-control-regex

/** Maps a (code, modifier-bitmask) pair from CSI-u / modifyOtherKeys reports to a key. */
function fromCode(code: number, mods: number): Key | undefined {
  const shift = (mods & 1) !== 0, alt = (mods & 2) !== 0, ctrl = (mods & 4) !== 0;
  if (code === 13) return key(shift || alt ? 'newline' : 'submit'); // Shift/Option+Enter = newline, Ctrl+Enter = submit
  if (code === 127) return key(alt ? 'kill-word' : 'backspace');
  if (code === 9) return key('tab');
  if (code === 27) return key('escape');
  if ((mods & 8) !== 0 && code === 118) return key('paste-image'); // Cmd+V, when the terminal reports it (kitty protocol)
  if (ctrl) {
    const m: Record<string, KeyName> = { c: 'interrupt', d: 'eof', a: 'home', e: 'end', k: 'kill-line-end', u: 'kill-line-start', w: 'kill-word', j: 'newline', v: 'paste-image' };
    return m[String.fromCharCode(code)] ? key(m[String.fromCharCode(code)]) : undefined;
  }
  if (alt) return code === 98 ? key('word-left') : code === 102 ? key('word-right') : undefined;
  return code >= 32 && code !== 127 ? { t: 'text', s: String.fromCodePoint(code) } : undefined;
}

/**
 * Incremental terminal input decoder. Handles bracketed paste, CSI-u (kitty) and modifyOtherKeys reports,
 * split escape sequences across chunks, and a paste heuristic for terminals without bracketed paste.
 * lineMode (non-TTY): every CR/LF submits, no escape handling.
 */
export class KeyParser {
  private pending = '';
  private inPaste = false;
  private paste = '';
  constructor(private readonly lineMode = false) {}

  feed(chunk: string): Key[] {
    const out: Key[] = [];
    const s = this.pending + chunk;
    this.pending = '';
    if (this.lineMode) {
      let buf = '';
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') { if (buf) out.push({ t: 'text', s: buf }); buf = ''; out.push(key('submit')); }
        else if (ch >= ' ') buf += ch;
      }
      if (buf) out.push({ t: 'text', s: buf });
      return out;
    }
    // No bracketed paste: a chunk with a newline followed by more content is a paste, never several submits.
    if (!this.inPaste && !s.includes('\x1b') && /[\r\n][^]/.test(s)) return [{ t: 'paste', s: normPaste(s) }];

    let i = 0;
    while (i < s.length) {
      if (this.inPaste) {
        const end = s.indexOf(PASTE_END, i);
        if (end < 0) {
          // keep a possibly split end marker (e.g. "\x1b[2" | "01~") for the next chunk
          const tail = s.slice(i);
          let keep = 0;
          for (let k = Math.min(tail.length, PASTE_END.length - 1); k > 0; k--) if (PASTE_END.startsWith(tail.slice(-k))) { keep = k; break; }
          this.paste += tail.slice(0, tail.length - keep);
          if (keep) this.pending = tail.slice(-keep);
          break;
        }
        out.push({ t: 'paste', s: normPaste(this.paste + s.slice(i, end)) });
        this.inPaste = false; this.paste = '';
        i = end + PASTE_END.length;
        continue;
      }
      const ch = s[i];
      if (ch === '\x1b') {
        const rest = s.slice(i);
        if (rest.startsWith(PASTE_START)) { this.inPaste = true; i += PASTE_START.length; continue; }
        let m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest); // eslint-disable-line no-control-regex
        if (m) {
          i += m[0].length;
          const k = this.csi(m[1], m[2]);
          if (k) out.push(k);
          continue;
        }
        if ((m = /^\x1bO([A-Za-z])/.exec(rest))) { // eslint-disable-line no-control-regex
          i += 2 + 1;
          const k = ({ A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' } as Record<string, KeyName>)[m[1]];
          if (k) out.push(key(k));
          continue;
        }
        if (/^\x1b(\[[0-9;]*|O)?$/.test(rest) && rest.length > 1) { this.pending = rest; break; } // eslint-disable-line no-control-regex
        if (rest.length === 1) { if (s.length === 1) out.push(key('escape')); i++; continue; } // lone Escape key
        const alt = rest[1];
        i += 2;
        if (alt === '\r' || alt === '\n') out.push(key('newline')); // Option+Enter on terminals sending ESC CR
        else if (alt === '\x7f') out.push(key('kill-word'));
        else { const k = fromCode(alt.charCodeAt(0), 3); if (k) out.push(k); }
        continue;
      }
      if (ch === '\r') out.push(key('submit'));
      else if (ch === '\n') out.push(key('newline')); // Ctrl+J: reliable newline everywhere
      else if (ch === '\t') out.push(key('tab'));
      else if (ch === '\x7f' || ch === '\b') out.push(key('backspace'));
      else if (ch < ' ') {
        const k = fromCode(ch.charCodeAt(0) + 96, 4); // Ctrl+<letter>
        if (k) out.push(k);
      } else {
        const run = /^[^\x00-\x1f\x7f]+/.exec(s.slice(i))![0]; // eslint-disable-line no-control-regex
        out.push({ t: 'text', s: run });
        i += run.length;
        continue;
      }
      i++;
    }
    return out;
  }

  private csi(params: string, final: string): Key | undefined {
    const p = params.split(';');
    const mods = Math.max(0, Number(p[1] || 1) - 1);
    const ctrlOrAlt = (mods & 6) !== 0;
    switch (final) {
      case 'A': return key('up');
      case 'B': return key('down');
      case 'C': return key(ctrlOrAlt ? 'word-right' : 'right');
      case 'D': return key(ctrlOrAlt ? 'word-left' : 'left');
      case 'H': return key('home');
      case 'F': return key('end');
      case 'u': return fromCode(Number(p[0]), mods);
      case '~':
        if (p[0] === '27') return fromCode(Number(p[2]), mods); // xterm modifyOtherKeys
        return ({ 1: 'home', 7: 'home', 4: 'end', 8: 'end', 3: 'delete' } as Record<string, KeyName>)[p[0]] ? key(({ 1: 'home', 7: 'home', 4: 'end', 8: 'end', 3: 'delete' } as Record<string, KeyName>)[p[0]]) : undefined;
      default: return undefined;
    }
  }
}
