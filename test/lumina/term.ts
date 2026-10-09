/* eslint-disable no-control-regex */
/** Minimal terminal emulator for tests: applies the escape sequences Lumina emits and returns the visible rows. */
export function emulate(raw: string): string[] {
  const rows: string[] = [''];
  let r = 0;
  let c = 0;
  const put = (ch: string) => {
    while (rows.length <= r) rows.push('');
    const line = rows[r].padEnd(c, ' ');
    rows[r] = line.slice(0, c) + ch + line.slice(c + 1);
    c++;
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\x1b' && raw[i + 1] === '[') {
      const m = /^\x1b\[([0-9;?<>]*)([A-Za-z])/.exec(raw.slice(i))!;
      i += m[0].length - 1;
      const n = Number(m[1]) || 1;
      if (m[2] === 'A') r = Math.max(0, r - n);
      else if (m[2] === 'B') { r += n; while (rows.length <= r) rows.push(''); }
      else if (m[2] === 'G') c = n - 1;
      else if (m[2] === 'K') rows[r] = m[1] === '2' ? '' : (rows[r] ?? '').slice(0, c);
      else if (m[2] === 'J') { rows[r] = (rows[r] ?? '').slice(0, c); rows.length = r + 1; }
      continue;
    }
    if (ch === '\r') c = 0;
    else if (ch === '\n') { r++; c = 0; while (rows.length <= r) rows.push(''); }
    else put(ch);
  }
  while (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
  return rows.map((l) => l.replace(/\s+$/, ''));
}
