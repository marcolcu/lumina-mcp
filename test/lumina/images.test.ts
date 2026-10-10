import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { imagePathFromPaste } from '../../src/lumina/tui/images.js';
import { KeyParser } from '../../src/lumina/tui/keys.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-img-'));
const png = path.join(dir, 'my shot.png');
fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
fs.writeFileSync(path.join(dir, 'empty.png'), '');

describe('image paste detection', () => {
  it('recognises a pasted image path in the forms terminals produce', () => {
    expect(imagePathFromPaste(png, '/')).toBe(png);
    expect(imagePathFromPaste(`'${png}'`, '/')).toBe(png);
    expect(imagePathFromPaste(png.replace(/ /g, '\\ '), '/')).toBe(png); // drag & drop escapes spaces
    expect(imagePathFromPaste(`file://${encodeURI(png)}`, '/')).toBe(png);
    expect(imagePathFromPaste('my shot.png', dir)).toBe(png); // relative to the session cwd
    expect(imagePathFromPaste(`  ${png}\n`, '/')).toBe(png);
  });
  it('anything else stays ordinary text', () => {
    for (const t of [path.join(dir, 'notes.txt'), path.join(dir, 'missing.png'), path.join(dir, 'empty.png'), `${png}\nsecond line`, 'look at this.png please', '']) expect(imagePathFromPaste(t, '/'), t).toBeUndefined();
  });
});

describe('keys', () => {
  it('Ctrl+V (and Cmd+V when the terminal reports it) request an image paste', () => {
    expect(new KeyParser().feed('\x16')).toEqual([{ t: 'key', name: 'paste-image' }]);
    expect(new KeyParser().feed('\x1b[118;5u')).toEqual([{ t: 'key', name: 'paste-image' }]);
    expect(new KeyParser().feed('\x1b[118;9u')).toEqual([{ t: 'key', name: 'paste-image' }]);
  });
});
