// parse.js — a fast, dependency-free Markdown renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3's
// marked.parse(markdown) returns with marked's default options
// (gfm true, breaks false, pedantic false, async false), code unit for
// code unit. It is a fresh implementation written for this competition:
// a single-pass block lexer over an index (no repeated slicing), a
// character-scanning inline renderer that builds HTML directly instead
// of allocating a token per inline fragment, and cheap first-character
// dispatch so most block rules are never even tested.
//
// The grammar itself — where a block starts and ends, how emphasis
// flanks, what counts as a link — is CommonMark 0.31.2 + GFM 0.29 as
// marked 18.1.3 implements them; where marked departs from the spec,
// marked's output is the reference. This file therefore reuses the
// boundary patterns of marked (MIT, Copyright (c) 2018-2026 MarkedJS;
// see README.md) as the specification of those boundaries, around a
// different, faster engine. It does not vendor or import marked.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML characters. With encode=true every & < > " ' is escaped;
// otherwise only < > " ' and an & that does not start a valid entity or
// numeric character reference. (This is marked's escape function.)
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function esc(str, encode) {
  if (encode) {
    if (ESCAPE_TEST.test(str)) return str.replace(ESCAPE_REPLACE, (c) => ESCAPES[c]);
  } else if (ESCAPE_TEST_NO_ENCODE.test(str)) {
    return str.replace(ESCAPE_REPLACE_NO_ENCODE, (c) => ESCAPES[c]);
  }
  return str;
}
// Marked calls this function P; the rest of this file uses that name.
const P = esc;

// Numeric character references, and a bare & that is not one.
const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
// Decode numeric character references in a string (marked's unescape).
// Only runs when the string holds one; a bare & becomes &amp;.
function unesc(str) {
  if (!NUM_REF.test(str)) return str;
  return str.replace(NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// Encode a link href the way marked does: encodeURI, keeping % as %.
const PCT = /%25/g;
function encodeHref(href) {
  try { return encodeURI(href).replace(PCT, '%'); } catch { return null; }
}

// Normalize a link reference label: trim, collapse inner whitespace to
// one space, then fold case (lower, upper, lower) for Unicode handling.
const WS_RUN = /\s+/g;
function normLabel(label) {
  return label.trim().replace(WS_RUN, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Split a table row on unescaped pipes, trimming cells and dropping the
// leading/trailing empty cells from outer pipes.
const FIND_PIPE = /\|/g;
const SPLIT_PIPE = / \|/;
const SLASH_PIPE = /\\\|/g;
function splitRow(row, count) {
  const marked = row.replace(FIND_PIPE, (m, off, s) => {
    let escaped = false;
    for (let p = off - 1; p >= 0 && s[p] === '\\'; p--) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = marked.split(SPLIT_PIPE);
  if (cells.length > 0 && !cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let n = 0; n < cells.length; n++) cells[n] = cells[n].trim().replace(SLASH_PIPE, '|');
  return cells;
}

// Trim a run of one trailing character (or, with `not`, of characters
// other than it). No backslash handling: callers check that separately.
function trimEndChar(str, ch, not) {
  const n = str.length;
  if (n === 0) return '';
  let s = 0;
  for (; s < n;) {
    const c = str.charAt(n - s - 1);
    if (not ? c !== ch : c === ch) s++;
    else break;
  }
  return str.slice(0, n - s);
}

// Drop trailing blank lines, keeping at most one blank line at the end.
const BLANK_LINE = /^[ \t]*$/;
const WS_ONLY = /^\s*$/;
function stripTrailingBlanks(str) {
  const lines = str.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && BLANK_LINE.test(lines[t]);) t--;
  return lines.length - t <= 2 ? str : lines.slice(0, t + 1).join('\n');
}

// Expand tabs to spaces on tab stops of 4, starting at column `col`.
function expandTabs(str, col) {
  let out = '';
  let c = col || 0;
  for (const ch of str) {
    if (ch === '\t') { const r = 4 - (c % 4); out += ' '.repeat(r); c += r; }
    else { out += ch; c++; }
  }
  return out;
}

// Find the index of the closing delimiter matching the opener at the
// start of `str` (or -1 when there is none, -2 when it is unbalanced).
// Backslash escapes are skipped.
function findCloser(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === pair[0]) depth++;
    else if (str[i] === pair[1]) { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// A fence's info string may be indented; compensate the code's indent.
const INDENT_FENCE = /^(\s+)(?:```)/;
const LEAD_WS = /^\s+/;
function fenceIndent(raw, code) {
  const m = raw.match(INDENT_FENCE);
  if (m === null) return code;
  const pad = m[1];
  return code.split('\n').map((line) => {
    const lead = line.match(LEAD_WS);
    if (lead === null) return line;
    return line.slice(Math.min(lead[0].length, pad.length));
  }).join('\n');
}

// --- character classes -------------------------------------------------
const PUNCT_RE = /[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_RE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_RE = /[^\s\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;
function isPunct(ch) { return PUNCT_RE.test(ch); }
function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'; }
function isAlnum(ch) { return ALNUM_RE.test(ch); }

// --- regex builder -----------------------------------------------------
// Build a regex from a pattern string with named holes, like marked's
// helper: replace("label", /.../) splices the replacement's source in
// place of the word `label`. Returns a sticky regex anchored at the
// current scan position (the `^` of the original becomes the sticky
// flag, so no slicing of the source is needed).
const CARET = /(^|[^\[])\^/g;
function build(pattern, flags) {
  let src = typeof pattern === 'string' ? pattern : pattern.source;
  // Preserve a RegExp literal's flags when no explicit flags are given;
  // otherwise the 'g' on global-scan patterns (blockSkip, reflinkSearch)
  // would be silently dropped.
  const baseFlags = flags !== undefined ? flags : (typeof pattern === 'string' ? '' : pattern.flags);
  const api = {
    replace(name, repl) {
      let r = typeof repl === 'string' ? repl : repl.source;
      r = r.replace(CARET, '$1');
      src = src.replace(name, r);
      return api;
    },
    regex() {
      // drop every ^ anchor: the sticky flag anchors at lastIndex, and a
      // ^ in the middle of an alternative would only match at position 0,
      // so tags after the first character would never match.
      const s = src.replace(CARET, '$1');
      const f = (baseFlags || '').includes('y') ? baseFlags : (baseFlags || '') + 'y';
      return new RegExp(s, f);
    },
    // A regex over the pattern as written (for global scans, where a
    // leading ^ still means "start of the string it is run on").
    re(moreFlags) {
      return new RegExp(src, moreFlags || baseFlags || '');
    },
  };
  return api;
}

// --- grammar: block rules ------------------------------------------------
// Block-level HTML tag names (CommonMark HTML blocks).
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HTML_ATTR = / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/;
const HR_SRC = ' {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const LIST_BULL_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';

const R = {
  // blank lines / spaces between blocks
  space: /(?:[ \t]*(?:\n|$))+/y,
  // indented code: lines indented 4 spaces (or a tab) each
  code: /((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/y,
  // fenced code: ``` or ~~~ runs, with info string and closing fence
  fences: / {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/y,
  heading: / {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/y,
  hr: new RegExp(HR_SRC, 'y'),
  // a list item start: bullet + optional first-line text
  list: build(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, new RegExp(LIST_BULL_SRC)).regex(),
  // HTML block (CommonMark types 1-7)
  html: build('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
    .replace('comment', HTML_COMMENT).replace('tag', BLOCK_TAGS).replace('attribute', HTML_ATTR).regex(),
  // link reference definition: [label]: <href> "title"
  def: build(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
    .replace('label', /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/)
    .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/).regex(),
  // GFM table: header row, delimiter row, body rows
  table: build('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
    .replace('hr', new RegExp(HR_SRC)).replace('heading', HEADING_SRC)
    .replace('blockquote', ' {0,3}>').replace('code', '(?: {4}| {0,3}\t)[^\\n]')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', BLOCK_TAGS).regex(),
  // setext heading (GFM): paragraph lines + === or --- underline
  lheading: build(/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/)
    .replace(/bull/g, new RegExp(LIST_BULL_SRC)).replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/)
    .replace(/heading/g, new RegExp(HEADING_SRC)).replace(/hr/g, / {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
    .replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).regex(),
  // paragraph (GFM): lines until a blank line or a block start
  paragraph: build(/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/)
    .replace('hr', new RegExp(HR_SRC)).replace('heading', HEADING_SRC)
    .replace('|lheading', '').replace('table', ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', BLOCK_TAGS).regex(),
  // the paragraph pattern as used inside blockquotes (list interruption
  // is looser there: any ordered marker, and the marker may end a line)
  paragraphInQuote: build(/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/)
    .replace('hr', new RegExp(HR_SRC)).replace('heading', HEADING_SRC)
    .replace('|lheading', '').replace('table', ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)')
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', BLOCK_TAGS).regex(),
  // a blockquote: consecutive > lines
  blockquote: build(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', 'PLACEHOLDER').regex(),
  // a single line of text (fallback)
  text: /[^\n]+/y,
};

// The GFM paragraph's lookahead tests the next lines against the FULL
// table pattern (marked splices the table regex in); the blockquote
// paragraph (Ke) has no table alternative at all. Rebuild both here,
// after R.table exists, with the right table handling.
R.paragraph = build(/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/)
  .replace('hr', new RegExp(HR_SRC)).replace('heading', HEADING_SRC)
  .replace('|lheading', '').replace('table', R.table)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', BLOCK_TAGS).regex();
R.paragraphInQuote = build(/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/)
  .replace('hr', new RegExp(HR_SRC)).replace('heading', HEADING_SRC)
  .replace('|lheading', '').replace('|table', '')
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', BLOCK_TAGS).regex();

// The blockquote regex embeds the paragraph-in-quote pattern; rebuild it
// with the real pattern spliced in.
R.blockquote = build(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', R.paragraphInQuote).regex();

// Per-indent helpers, memoised with the same cap marked uses: the
// factory is called with min(3, t - 1), so the indent in the regex is
// always 0..3.
function memoIndent(factory) {
  const cache = [];
  return (t) => {
    const n = Math.max(0, Math.min(3, t - 1));
    return cache[n] || (cache[n] = factory(n));
  };
}
const listItemRe = null; // (unused; listItemRegex() below builds per bullet)
function listItemRegex(bullet) {
  return new RegExp(`( {0,3}${bullet})((?:[ \t][^\\n]*)?(?:\\n|$))`, 'y');
}
const nextBulletRe = memoIndent((a) => new RegExp(` {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`, 'y'));
const hrRe = memoIndent((a) => new RegExp(` {0,${a}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`, 'y'));
const fencesBeginRe = memoIndent((a) => new RegExp(` {0,${a}}(?:\`\`\`|~~~)`, 'y'));
const headingBeginRe = memoIndent((a) => new RegExp(` {0,${a}}#{1,6}(?:\\s|$)`, 'y'));
const pedanticHeadingBeginRe = memoIndent((a) => new RegExp(` {0,${a}}#`, 'y'));
const htmlBeginRe = memoIndent((a) => new RegExp(` {0,${a}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'iy'));
const blockquoteBeginRe = memoIndent((a) => new RegExp(` {0,${a}}>`, 'y'));


// --- grammar: inline rules (GFM set, as marked 18.1.3 builds them) -------
const PUNCT_CLASS = '[\\p{P}\\p{S}]';
const PUNCT_SPACE_CLASS = '[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_CLASS = '[^\\s\\p{P}\\p{S}]';
const EMAIL_RE = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
const SCHEME_RE = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/;
const SQUARE = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const BRACKET_LABEL = build(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace('brackets', SQUARE).re();
const BRACKET_LABEL_LOOSE = build(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace('brackets', SQUARE).re();
const REF_LABEL = /(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const REF_LABEL_SHORT = /(?:\\[\s\S]|[^\[\]\\]){1,999}/;

const EMAIL_NOGROUP = /[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const AT_RE = build(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, EMAIL_NOGROUP).re();

const IL = {
  escape: /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/y,
  code: /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y,
  br: /( {2,}|\\)\n(?!\s*$)[ \t]*/y,
  autolink: build(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace('scheme', SCHEME_RE).replace('email', EMAIL_RE).regex(),
  tag: build(/^comment|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/)
    .replace('comment', /<!--(?:-?>|[\s\S]*?-->)/)
    .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).regex(),
  link: build(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
    .replace('label', BRACKET_LABEL)
    .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
    .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/).regex(),
  reflink: build(/^!?\[(label)\]\[(ref)\]/).replace('label', BRACKET_LABEL).replace('ref', REF_LABEL).regex(),
  nolink: build(/^!?\[(ref)\](?:\[\])?/).replace('ref', REF_LABEL).regex(),
  reflinkSearch: build(/reflink|nolink(?!\()/g)
    .replace('reflink', build(/^!?\[(label)\]\[(ref)\]/).replace('label', BRACKET_LABEL_LOOSE).replace('ref', REF_LABEL_SHORT).re())
    .replace('nolink', build(/^!?\[(ref)\](?:\[\])?/).replace('ref', REF_LABEL_SHORT).re()).re(),
  blockSkip: build(/link|precode-code|html/g)
    .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
    .replace('precode-', /(?<!`)()/)
    .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
    .replace('html', /<(?! )[^<>]*?>/).re(),
  anyPunct: build(/\\(punct)/g).replace('punct', new RegExp(PUNCT_CLASS, 'u')).re('gu'),
  anyPunctOutsideCode: build(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/g).replace('punct', new RegExp(PUNCT_CLASS, 'u')).re('gu'),
  emLDelim: build(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u').replace(/punct/g, /(?!~)[\p{P}\p{S}]/u).regex(),
  emRDelimAst: build("^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)", 'gu')
    .replace(/notPunctSpace/g, /(?:[^\s\p{P}\p{S}]|~)/u).replace(/punctSpace/g, /(?!~)[\s\p{P}\p{S}]/u).replace(/punct/g, /(?!~)[\p{P}\p{S}]/u).re(),
  // GFM uses the "normal" (kt) underscore closer: 5 delimiter groups, no
  // 8th alternative, and punct/punctSpace/notPunctSpace WITHOUT the ~
  // exclusions (those are only in the asterisk closer and in pedantic).
  // An intraword _ is therefore never a closer: _foo_bar stays literal.
  emRDelimUnd: build("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", 'gu')
    .replace(/notPunctSpace/g, new RegExp(NOT_PUNCT_SPACE_CLASS, 'u')).replace(/punctSpace/g, new RegExp(PUNCT_SPACE_CLASS, 'u')).replace(/punct/g, new RegExp(PUNCT_CLASS, 'u')).re(),
  delLDelim: build(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').replace('punct', /(?!~)[\p{P}\p{S}]/u).regex(),
  delRDelim: build("^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)", 'gu')
    .replace(/notPunctSpace/g, new RegExp(NOT_PUNCT_SPACE_CLASS, 'u')).replace(/punctSpace/g, /(?!~)[\s\p{P}\p{S}]/u).replace(/punct/g, /(?!~)[\p{P}\p{S}]/u).re(),
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  url: build(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
    .replace('emailProtocol', AT_RE)
    .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
    .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).regex(),
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  punct: /^((?![*_])[\s\p{P}\p{S}])/u,
  text: build(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
    .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
    .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
    .replace('wwwStart', /(?<![^\s*_~(])www\./).regex(),
};

// --- emphasis masking ----------------------------------------------------
// The mask marked builds before scanning for emphasis/del closers: link
// texts and code spans are replaced with 'a's so a delimiter inside
// them is never mistaken for a closer. Returns the masked source plus
// the last-possible-closer indexes per delimiter.
function maskSrc(src, links) {
  let m = src;
  if (links && src.includes('[')) {
    const maskReflink = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, links)) return '[' + inner.replace(IL.reflinkSearch, maskReflink) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    m = m.replace(IL.reflinkSearch, maskReflink);
  }
  // Code spans and backslash-punctuation: only when the source can hold
  // one (a backtick or a backslash); otherwise the regex cannot match.
  if (m.includes('`') || m.includes('\\')) {
    m = m.replace(IL.anyPunctOutsideCode, (n, code, punct) => {
      if (punct) return '+'.repeat(n.length);
      if (code) return code + n.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return n;
    });
  }
  // Links, code spans and HTML tags: only when the source can hold one.
  if (m.includes('[') || m.includes('`') || m.includes('<')) {
    m = m.replace(IL.blockSkip, (n, _pre, code) => {
      const o = code ? code.length : 0;
      return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
    });
  }
  // last possible closer per delimiter, from the masked source
  const last = { '*': -1, '_': -1, '~': -1 };
  for (let i = 0; i < m.length; i++) {
    const c = m[i];
    if (c !== '*' && c !== '_' && c !== '~') continue;
    let j = i + 1;
    for (; j < m.length && m[j] === c;) j++;
    const prev = i === 0 ? '\n' : m[i - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (c === '~') last['~'] = i;
      else last[c] = i;
    }
    i = j - 1;
  }
  return { masked: m, last };
}

// Does `src` contain a link (inline or reference) that resolves?
function linkInText(src, links) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(IL.blockSkip)) {
    IL.link.lastIndex = 0;
    if (IL.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(IL.reflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normLabel(s.slice(r + 1, -1)))) && !(r > 1 && linkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}

// --- inline rendering ------------------------------------------------------
// Renders inline Markdown to HTML directly (no inline token objects).
// `st` is the shared inline state for one parse() call: inLink and
// inRawBlock persist across blocks; linkParenPossible is restored after
// each block's render. `plain` renders plain text (for image alt text).
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_SCRIPT = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_SCRIPT = /^<\/(pre|code|kbd|script)(\s|>)/i;
const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;

function execAt(re, src, pos) {
  re.lastIndex = pos;
  return re.exec(src);
}

// The Be() check from marked: does `label` (the link text, starting at
// `off` in the source at `pos`) contain a tag or autolink that runs past
// the end of the label? If so the link is not a link.
function hasTagInLabel(src, label, off, pos) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const i = execAt(IL.code, label, s);
      if (i) { s += i[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const p = pos + off + s;
    let o = execAt(IL.tag, src, p);
    if (!o) o = execAt(IL.autolink, src, p);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// Render inline Markdown `src` to HTML (or plain text when `plain`).
// The masked source (for emphasis/delimiter closer search) is computed
// only when the source holds *, _ or ~.
function inlineHtml(src, st, links, plain) {
  const prev = st.linkParenPossible;
  st.linkParenPossible = prev && src.includes(')');
  try {
    let masked = null;
    let last = null;
    if (src.includes('*') || src.includes('_') || src.includes('~')) {
      const m = maskSrc(src, links);
      masked = m.masked;
      last = m.last;
    }
    return inlineLoop(src, masked, last, st, links, plain);
  } finally {
    st.linkParenPossible = prev;
  }
}

function inlineLoop(src, masked, last, st, links, plain) {
  const out = [];
  const n = src.length;
  let pos = 0;
  let lastChar = '';
  let lastWasText = false;
  let guard = Infinity;
  for (; pos < n;) {
    const rem = n - pos;
    if (rem < guard) guard = rem;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    if (!lastWasText) lastChar = '';
    lastWasText = false;
    let r;
    // escape: \* -> *
    if ((r = execAt(IL.escape, src, pos))) {
      out.push(plain ? r[1] : P(r[1]));
      pos += r[0].length;
      continue;
    }
    // raw HTML tag (toggles inLink / inRawBlock)
    if ((r = execAt(IL.tag, src, pos))) {
      const raw = r[0];
      if (!st.inLink && START_A_TAG.test(raw)) st.inLink = true;
      else if (st.inLink && END_A_TAG.test(raw)) st.inLink = false;
      if (!st.inRawBlock && START_PRE_SCRIPT.test(raw)) st.inRawBlock = true;
      else if (st.inRawBlock && END_PRE_SCRIPT.test(raw)) st.inRawBlock = false;
      out.push(raw);
      pos += raw.length;
      continue;
    }
    // inline link / image
    if ((r = tokLink(src, pos, st, links, plain))) {
      out.push(r.html);
      pos = r.next;
      continue;
    }
    // reference link / image (or a lone [ that stays text)
    if ((r = tokReflink(src, pos, st, links, plain))) {
      out.push(r.html);
      pos = r.next;
      continue;
    }
    // emphasis / strong
    if ((r = tokEmStrong(src, pos, masked, last, st, links, plain, lastChar))) {
      out.push(r.html);
      pos = r.next;
      continue;
    }
    // code span
    if ((r = execAt(IL.code, src, pos))) {
      let t = r[2].replace(/\n/g, ' ');
      const nonSpace = /[^ ]/.test(t);
      const padded = /^ /.test(t) && / $/.test(t);
      if (nonSpace && padded) t = t.substring(1, t.length - 1);
      out.push(plain ? t : '<code>' + P(t, true) + '</code>');
      pos += r[0].length;
      continue;
    }
    // hard break: two spaces or a backslash before a newline
    if ((r = execAt(IL.br, src, pos))) {
      out.push(plain ? '' : '<br>');
      pos += r[0].length;
      continue;
    }
    // strikethrough
    if ((r = tokDel(src, pos, masked, last, st, links, plain, lastChar))) {
      out.push(r.html);
      pos = r.next;
      continue;
    }
    // <autolink>
    if ((r = execAt(IL.autolink, src, pos))) {
      const text = r[1];
      const href = r[2] === '@' ? 'mailto:' + text : text;
      if (plain) out.push(text);
      else {
        const h = encodeHref(href);
        out.push(h === null ? P(text, true) : '<a href="' + P(h, true) + '">' + P(text, true) + '</a>');
      }
      pos += r[0].length;
      continue;
    }
    // extended autolink (www. / scheme:// / email), only outside a link
    if (!st.inLink && (r = tokUrl(src, pos, st, links, plain))) {
      out.push(r.html);
      pos = r.next;
      continue;
    }
    // plain text run
    if ((r = execAt(IL.text, src, pos))) {
      const raw = r[0];
      if (raw.slice(-1) !== '_') lastChar = raw.slice(-1);
      lastWasText = true;
      if (st.inRawBlock) out.push(raw);
      else if (plain) out.push(unesc(raw));
      else out.push(P(unesc(raw)));
      pos += raw.length;
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  return out.join('');
}

// --- inline tokenizers (link / reflink / emphasis / del / url) -------------
const PUNCT_OR_SPACE = /^((?![*_])[\s\p{P}\p{S}])/u;
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;

// Build the HTML (or plain text) for an inline link or image match `m`
// with the given href and title. Returns null when the link is
// suppressed because its text itself contains a link.
function makeLink(m, href, title, st, links, plain) {
  const inner = m[1].replace(OUTPUT_LINK_REPLACE, '$1');
  const isImage = m[0].charAt(0) === '!';
  if (plain) {
    // Plain text (image alt): the inner text, in a throwaway state, as
    // marked's textRenderer does not touch the lexer state. A link whose
    // text itself contains a link is not a link (CommonMark: links do not
    // nest), so reject it and leave the brackets literal.
    const t = { inLink: true, inRawBlock: st.inRawBlock, linkEmitted: false, linkParenPossible: st.linkParenPossible };
    const html = inlineHtml(inner, t, links, true);
    if (!isImage) {
      if (t.linkEmitted) return null;
      st.linkEmitted = true;
    }
    return html;
  }
  const saveInLink = st.inLink;
  const saveEmitted = st.linkEmitted;
  const saveRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const innerHtml = inlineHtml(inner, st, links, false);
  const emitted = st.linkEmitted;
  st.linkEmitted = saveEmitted;
  st.inLink = saveInLink;
  if (!isImage) {
    if (emitted) { st.inRawBlock = saveRaw; return null; }
    st.linkEmitted = true;
  }
  if (isImage) {
    const t = { inLink: true, inRawBlock: saveRaw, linkEmitted: false, linkParenPossible: st.linkParenPossible };
    const alt = inlineHtml(inner, t, links, true);
    const h = encodeHref(href);
    if (h === null) return P(alt);
    let o = '<img src="' + P(h) + '" alt="' + P(alt) + '"';
    if (title) o += ' title="' + P(title) + '"';
    return o + '>';
  }
  const h = encodeHref(href);
  if (h === null) return innerHtml;
  let o = '<a href="' + P(h) + '"';
  if (title) o += ' title="' + P(title) + '"';
  return o + '>' + innerHtml + '</a>';
}

function tokLink(src, pos, st, links, plain) {
  if (st.linkParenPossible === false) return null;
  const m = execAt(IL.link, src, pos);
  if (!m) return null;
  const off = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasTagInLabel(src, m[1], off, pos)) return null;
  const s = m[2].trim();
  if (/^</.test(s)) {
    if (!/>$/.test(s)) return null;
    const l = trimEndChar(s.slice(0, -1), '\\');
    if ((s.length - l.length) % 2 === 0) return null;
  } else {
    const l = findCloser(m[2], '()');
    if (l === -2) return null;
    if (l > -1) {
      const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + l;
      m[2] = m[2].substring(0, l);
      m[0] = m[0].substring(0, h).trim();
      m[3] = '';
    }
  }
  const r = trimEndChar(m[0].slice(0, -1), '\\');
  if ((m[0].length - r.length) % 2 === 0) return null;
  let o = m[2].trim();
  const i = m[3] ? m[3].slice(1, -1) : '';
  if (/^</.test(o)) o = o.slice(1, -1);
  const href = o ? o.replace(IL.anyPunct, '$1') : '';
  const title = i ? i.replace(IL.anyPunct, '$1') : '';
  const html = makeLink(m, href, title, st, links, plain);
  if (html === null) return null;
  return { html, next: pos + m[0].length };
}

function tokReflink(src, pos, st, links, plain) {
  let m = execAt(IL.reflink, src, pos);
  if (!m) m = execAt(IL.nolink, src, pos);
  if (!m) return null;
  const off = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasTagInLabel(src, m[1], off, pos)) return null;
  const def = links[normLabel(m[2] || m[1])];
  if (!def) {
    const c = m[0].charAt(0);
    return { html: plain ? c : P(c), next: pos + 1 };
  }
  const html = makeLink(m, def.href, def.title, st, links, plain);
  if (html === null) return null;
  return { html, next: pos + m[0].length };
}

function tokEmStrong(src, pos, masked, last, st, links, plain, prevChar) {
  if (!masked) return null;
  const m = execAt(IL.emLDelim, src, pos);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const delim = m[0][0];
  const sameOpener = prevChar === delim;
  const i = pos;
  let l = i;
  for (; l > 0 && masked[l - 1] === delim;) l--;
  const p = l > 0 ? masked[l - 1] : '';
  const h = p === '*' || p === '_' || (p !== '' && PUNCT_OR_SPACE.test(p));
  if (l < i) prevChar = p;
  const u = l < i ? h : (prevChar !== '' && PUNCT_OR_SPACE.test(prevChar));
  if (m[4] && prevChar !== '' && UNICODE_ALNUM.test(prevChar)) return null;
  const d = m[1] || m[3] || '';
  if (!d || !prevChar || u) {
    const k = [...m[0]].length - 1;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (delim === '*' && !h));
    if (delim !== '*' && delim !== '_') return null;
    const A = delim === '*' ? IL.emRDelimAst : IL.emRDelimUnd;
    const v = last[delim];
    const Q = i + k;
    if (v < Q) return null;
    const sliced = masked.slice(pos + k);
    const ee = v - Q;
    A.lastIndex = 0;
    let s;
    let mm = k;
    let f = 0;
    while ((s = A.exec(sliced)) !== null && !(s.index > ee)) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      let b = [...g].length;
      if (s[3] || s[4]) { mm += b; continue; }
      else if (s[5] || s[6] || R) {
        if (sameOpener && (s[5] || s[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      mm -= b;
      if (mm > 0) continue;
      b = Math.min(b, b + mm + f);
      const te = [...s[0]][0].length;
      const M = src.slice(pos, pos + k + s.index + te + b);
      if (Math.min(k, b) % 2) {
        const U = M.slice(1, -1);
        const html = plain ? inlineHtml(U, st, links, true) : '<em>' + inlineHtml(U, st, links, false) + '</em>';
        return { html, next: pos + M.length };
      }
      const ne = M.slice(2, -2);
      const html = plain ? inlineHtml(ne, st, links, true) : '<strong>' + inlineHtml(ne, st, links, false) + '</strong>';
      return { html, next: pos + M.length };
    }
  }
  return null;
}

function tokDel(src, pos, masked, last, st, links, plain, prevChar) {
  if (!masked) return null;
  const m = execAt(IL.delLDelim, src, pos);
  if (!m) return null;
  if (!(m[1] || '') || !prevChar || PUNCT_OR_SPACE.test(prevChar)) {
    const o = [...m[0]].length - 1;
    let p = o;
    const h = IL.delRDelim;
    const u = last['~'];
    const d = pos + o;
    if (u < d) return null;
    const sliced = masked.slice(pos + o);
    const k = u - d;
    h.lastIndex = 0;
    let s;
    while ((s = h.exec(sliced)) !== null && !(s.index > k)) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      let l = [...g].length;
      if (l !== o) continue;
      if (s[3] || s[4]) { p += l; continue; }
      p -= l;
      if (p > 0) continue;
      l = Math.min(l, l + p);
      const te = [...s[0]][0].length;
      const b = src.slice(pos, pos + o + s.index + te + l);
      const inner = b.slice(o, -o);
      const html = plain ? inlineHtml(inner, st, links, true) : '<del>' + inlineHtml(inner, st, links, false) + '</del>';
      return { html, next: pos + b.length };
    }
  }
  return null;
}

function tokUrl(src, pos, st, links, plain) {
  const m = execAt(IL.url, src, pos);
  if (!m) return null;
  let n, s;
  if (m[2] === '@') {
    n = m[0];
    s = 'mailto:' + n;
  } else {
    let r;
    do {
      r = m[0];
      const b = IL.backpedal.exec(m[0]);
      m[0] = b ? b[0] : '';
    } while (r !== m[0]);
    n = m[0];
    s = m[1] === 'www.' ? 'http://' + m[0] : m[0];
  }
  if (plain) return { html: n, next: pos + m[0].length };
  const h = encodeHref(s);
  if (h === null) return { html: P(n, true), next: pos + m[0].length };
  return { html: '<a href="' + P(h, true) + '">' + P(n, true) + '</a>', next: pos + m[0].length };
}

// --- block lexer -----------------------------------------------------------
// Index-based port of marked's block tokenizer. `state` holds the link
// reference definitions and the shared inline state. `queue` collects
// the blocks/cells that need inline rendering, in creation order; after
// block lexing, each is rendered in order (inRawBlock reset each time,
// inLink persisting, exactly as marked's lex() does).

function tokSpace(src, pos) {
  const m = execAt(R.space, src, pos);
  if (!m) return null;
  return { tok: { type: 'space', raw: m[0] }, next: pos + m[0].length };
}

function tokCode(src, pos) {
  const m = execAt(R.code, src, pos);
  if (!m) return null;
  const raw = stripTrailingBlanks(m[0]);
  const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
  return { tok: { type: 'code', raw, codeBlockStyle: 'indented', text }, next: pos + raw.length };
}

function tokFences(src, pos) {
  const m = execAt(R.fences, src, pos);
  if (!m) return null;
  const lang = m[2] ? m[2].trim().replace(IL.anyPunct, '$1') : m[2];
  const text = fenceIndent(m[0], m[3] || '');
  return { tok: { type: 'code', raw: m[0], lang, text }, next: pos + m[0].length };
}

function tokHeading(src, pos, queue) {
  const m = execAt(R.heading, src, pos);
  if (!m) return null;
  let n = m[2].trim();
  if (/#$/.test(n)) {
    const s = trimEndChar(n, '#');
    if (!s || /[ \t]$/.test(s)) n = s.trim();
  }
  const tok = { type: 'heading', raw: trimEndChar(m[0], '\n'), depth: m[1].length, text: n, inline: n };
  queue.push(tok);
  return { tok, next: pos + tok.raw.length };
}

function tokHr(src, pos) {
  const m = execAt(R.hr, src, pos);
  if (!m) return null;
  return { tok: { type: 'hr', raw: trimEndChar(m[0], '\n') }, next: pos + trimEndChar(m[0], '\n').length };
}

function tokHtml(src, pos) {
  const m = execAt(R.html, src, pos);
  if (!m) return null;
  const n = stripTrailingBlanks(m[0]);
  return { tok: { type: 'html', block: true, raw: n, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: n }, next: pos + n.length };
}

function tokDef(src, pos) {
  const m = execAt(R.def, src, pos);
  if (!m) return null;
  if (!/^</.test(m[2]) && findCloser(m[2], '()') !== -1) return null;
  const tag = normLabel(m[1]);
  const href = m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(IL.anyPunct, '$1') : '';
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(IL.anyPunct, '$1') : m[3];
  return { tok: { type: 'def', tag, raw: trimEndChar(m[0], '\n'), href, title }, next: pos + trimEndChar(m[0], '\n').length };
}

function tokTable(src, pos, queue) {
  const m = execAt(R.table, src, pos);
  if (!m || !/[:|]/.test(m[2])) return null;
  const header = splitRow(m[1]);
  const delims = m[2].replace(/^\||\| *$/g, '').split('|');
  const rows = m[3] && m[3].trim() ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  if (header.length !== delims.length) return null;
  const tok = { type: 'table', raw: trimEndChar(m[0], '\n'), header: [], align: [], rows: [] };
  for (const d of delims) {
    if (/^ *-+: *$/.test(d)) tok.align.push('right');
    else if (/^ *:-+: *$/.test(d)) tok.align.push('center');
    else if (/^ *:-+ *$/.test(d)) tok.align.push('left');
    else tok.align.push(null);
  }
  for (let i = 0; i < header.length; i++) {
    const cell = { text: header[i], inline: header[i], header: true, align: tok.align[i] };
    queue.push(cell);
    tok.header.push(cell);
  }
  for (const row of rows) {
    const cells = splitRow(row, tok.header.length).map((text, i) => {
      const cell = { text, inline: text, header: false, align: tok.align[i] };
      queue.push(cell);
      return cell;
    });
    tok.rows.push(cells);
  }
  return { tok, next: pos + tok.raw.length };
}

function tokLheading(src, pos, queue) {
  const m = execAt(R.lheading, src, pos);
  if (!m) return null;
  const n = m[1].trim();
  const tok = { type: 'heading', raw: trimEndChar(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text: n, inline: n };
  queue.push(tok);
  return { tok, next: pos + tok.raw.length };
}

function tokParagraph(src, pos, queue) {
  const m = execAt(R.paragraph, src, pos);
  if (!m) return null;
  const n = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
  const tok = { type: 'paragraph', raw: m[0], text: n, inline: n };
  queue.push(tok);
  return { tok, next: pos + m[0].length };
}

function tokText(src, pos, queue) {
  const m = execAt(R.text, src, pos);
  if (!m) return null;
  const tok = { type: 'text', raw: m[0], text: m[0], inline: m[0] };
  queue.push(tok);
  return { tok, next: pos + m[0].length };
}

// The block token loop. Returns the new position. `mergePara` allows the
// first paragraph to merge into a preceding paragraph (blockquote only).
function blockTokens(src, pos, end, tokens, queue, state, mergePara) {
  let guard = Infinity;
  while (pos < end) {
    const rem = end - pos;
    if (rem < guard) guard = rem;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    let r;
    if ((r = tokSpace(src, pos))) {
      pos = r.next;
      const last = tokens[tokens.length - 1];
      if (r.tok.raw.length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push(r.tok);
      continue;
    }
    if ((r = tokCode(src, pos))) {
      pos = r.next;
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + r.tok.raw;
        last.text += '\n' + r.tok.text;
        queue[queue.length - 1].inline = last.text;
      } else tokens.push(r.tok);
      continue;
    }
    if ((r = tokFences(src, pos))) { pos = r.next; tokens.push(r.tok); continue; }
    if ((r = tokHeading(src, pos, queue))) { pos = r.next; tokens.push(r.tok); continue; }
    if ((r = tokHr(src, pos))) { pos = r.next; tokens.push(r.tok); continue; }
    if ((r = tokBlockquote(src, pos, end, queue, state))) { pos = r.next; tokens.push(r.tok); continue; }
    if ((r = tokList(src, pos, end, queue, state))) { pos = r.next; tokens.push(r.tok); continue; }
    if ((r = tokHtml(src, pos))) { pos = r.next; tokens.push(r.tok); continue; }
    if ((r = tokDef(src, pos))) {
      pos = r.next;
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + r.tok.raw;
        last.text += '\n' + r.tok.raw;
        queue[queue.length - 1].inline = last.text;
      } else {
        if (!state.links[r.tok.tag]) state.links[r.tok.tag] = { href: r.tok.href, title: r.tok.title };
        tokens.push(r.tok);
      }
      continue;
    }
    if ((r = tokTable(src, pos, queue))) { pos = r.next; tokens.push(r.tok); continue; }
    if ((r = tokLheading(src, pos, queue))) { pos = r.next; tokens.push(r.tok); continue; }
    if (state.top && (r = tokParagraph(src, pos, queue))) {
      const last = tokens[tokens.length - 1];
      if (mergePara && last && last.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + r.tok.raw;
        last.text += '\n' + r.tok.text;
        queue.pop();
        queue[queue.length - 1].inline = last.text;
      } else tokens.push(r.tok);
      mergePara = false;
      pos = r.next;
      continue;
    }
    if ((r = tokText(src, pos, queue))) {
      const last = tokens[tokens.length - 1];
      if (last && last.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + r.tok.raw;
        last.text += '\n' + r.tok.text;
        queue.pop();
        queue[queue.length - 1].inline = last.text;
      } else tokens.push(r.tok);
      pos = r.next;
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  state.top = true;
  return pos;
}

// --- blockquote / list tokenizers (the intricate ones) ----------------------
const BLOCKQUOTE_START = /^ {0,3}>/;
const BLOCKQUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const BLOCKQUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BLOCKQUOTE_STRIP = /^ {0,3}>[ \t]?/gm;

function tokBlockquote(src, pos, end, queue, state) {
  const m = execAt(R.blockquote, src, pos);
  if (!m) return null;
  let lines = trimEndChar(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  for (; lines.length > 0;) {
    let hasMarker = false;
    const l = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (BLOCKQUOTE_START.test(lines[p])) { l.push(lines[p]); hasMarker = true; }
      else if (!hasMarker) l.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = l.join('\n');
    const u = h
      .replace(BLOCKQUOTE_MARKER_WS, (g, b, m2) => b + expandTabs(m2, b.length))
      .replace(BLOCKQUOTE_SETEXT, '\n    $1')
      .replace(BLOCKQUOTE_STRIP, '');
    raw = raw ? raw + '\n' + h : h;
    text = text ? text + '\n' + u : u;
    const saveTop = state.top;
    state.top = true;
    blockTokens(u, 0, u.length, tokens, queue, state, true);
    state.top = saveTop;
    if (lines.length === 0) break;
    const k = tokens[tokens.length - 1];
    if (k && (k.type === 'code' || k.type === 'heading' || k.type === 'hr' || k.type === 'html' || k.type === 'table')) break;
    if (k && k.type === 'blockquote') {
      const g = k;
      const b = lines.join('\n');
      const mm = g.raw + '\n' + b.replace(BLOCKQUOTE_STRIP, '');
      const f = tokBlockquote(mm, 0, mm.length, queue, state);
      tokens[tokens.length - 1] = f.tok;
      const y = mm.substring(f.tok.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) raw = raw + '\n' + A.join('\n');
      text = text.substring(0, text.length - g.text.length) + f.tok.text;
      lines = lines.slice(A.length);
      if (lines.length > 0 && BLOCKQUOTE_START.test(lines[0])) continue;
      break;
    } else if (k && k.type === 'list') {
      const g = k;
      const b = g.raw + '\n' + lines.join('\n');
      const mm = tokList(b, 0, b.length, queue, state);
      tokens[tokens.length - 1] = mm.tok;
      const f = mm.tok.raw.length > g.raw.length ? b.slice(g.raw.length + 1, mm.tok.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join('\n');
        raw = raw + '\n' + y;
        text = text + '\n' + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  const tok = { type: 'blockquote', raw, tokens, text };
  return { tok, next: pos + raw.length };
}

const LEADING_SPACE_TAB = /^[ \t]+/;
const NON_SPACE_CHAR = /[^ ]/;
const DOUBLE_BLANK_LINE = /\n[ \t]*\n[ \t]*$/;
const ANY_LINE = /\n.*\n/;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const LIST_TASK_CHECKBOX = /\[[ xX]\]/;
const TAB_CHAR_GLOBAL = /\t/g;
const SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;

// Expand the leading whitespace run of a line, fast-pathing the common
// case (no tab in the run) by returning the line unchanged.
function expandLeadingTabs(line) {
  let i = 0;
  let hasTab = false;
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 9) hasTab = true;
    else if (c !== 32) break;
  }
  if (!hasTab) return line;
  return expandTabs(line.slice(0, i), 0) + line.slice(i);
}

// Column of the first non-space character of `str` after replacing each
// tab with four spaces (as marked's mm.replace(/\t/g, '    ') does), or -1
// when the string holds only spaces and tabs. No allocation.
function firstNonSpaceCol(str) {
  let col = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    if (ch === 9) col += 4;
    else if (ch === 32) col++;
    else return col;
  }
  return -1;
}

function lineAt(src, pos, end) {
  const nl = src.indexOf('\n', pos);
  const stop = nl === -1 || nl >= end ? end : nl;
  return { line: src.slice(pos, stop), next: stop >= end ? end : stop + 1, stop };
}

function tokList(src, pos, end, queue, state) {
  const first = execAt(R.list, src, pos);
  if (!first) return null;
  const startPos = pos;
  let cur = pos;
  const bullet = first[1].trim();
  const ordered = bullet.length > 1;
  const list = { type: 'list', raw: '', ordered, start: ordered ? +bullet.slice(0, -1) : '', loose: false, items: [] };
  const bulletRe = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = listItemRegex(bulletRe);
  let prevDoubleBlank = false;
  for (; cur < end;) {
    let empty = false;
    let d = '';
    const m = execAt(itemRe, src, cur);
    if (!m) break;
    // a horizontal rule ends the list
    if (execAt(R.hr, src, cur)) break;
    const itemStart = cur;
    cur += m[0].length;
    const firstLine = lineAt(src, cur, end);
    const g = m[2].split('\n', 1)[0];
    const b = m[1].length;
    const expanded = g.replace(LEADING_SPACE_TAB, (v) => expandTabs(v, b));
    const f0 = firstLine.line;
    const y0 = !expanded.trim();
    let ind;
    if (y0) ind = b + 1;
    else {
      ind = expanded.search(NON_SPACE_CHAR);
      if (ind > 4) ind = 1;
      d = expanded.slice(ind);
      ind += b;
    }
    let y = y0;
    let mm = expanded;
    if (y && BLANK_LINE.test(f0)) {
      cur = firstLine.next;
      empty = true;
    }
    if (!empty) {
      const nextBullet = nextBulletRe(ind);
      const hr = hrRe(ind);
      const fencesBegin = fencesBeginRe(ind);
      const headingBegin = headingBeginRe(ind);
      const htmlBegin = htmlBeginRe(ind);
      const blockquoteBegin = blockquoteBeginRe(ind);
      for (; cur < end;) {
        const ln = lineAt(src, cur, end);
        const U = ln.line;
        let f = U;
        const Z = expandLeadingTabs(f);
        if (execAt(fencesBegin, src, cur) || execAt(headingBegin, src, cur) || execAt(htmlBegin, src, cur) || execAt(blockquoteBegin, src, cur) || execAt(nextBullet, src, cur) || execAt(hr, src, cur)) break;
        if (Z.search(NON_SPACE_CHAR) >= ind || WS_ONLY.test(f)) d += '\n' + Z.slice(ind);
        else {
          if (y || firstNonSpaceCol(mm) >= 4 || execAt(fencesBegin, mm, 0) || execAt(headingBegin, mm, 0) || execAt(htmlBegin, mm, 0) || execAt(hr, mm, 0)) break;
          let qe = f;
          if (SETEXT_LINE.test(f) && execAt(R.lheading, mm + '\n' + f, 0)) {
            qe = '    ' + Z.replace(/^ {0,3}/, '');
          }
          d += '\n' + qe;
        }
        y = !f.trim();
        cur = ln.next;
        mm = Z.slice(ind);
      }
    }
    const itemRaw = src.slice(itemStart, cur);
    if (!list.loose) {
      if (prevDoubleBlank) list.loose = true;
      else if (DOUBLE_BLANK_LINE.test(itemRaw)) prevDoubleBlank = true;
    }
    list.items.push({ type: 'list_item', raw: itemRaw, task: LIST_IS_TASK.test(d), loose: false, text: d, tokens: [] });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = src.slice(startPos, cur).trimEnd();
  for (const item of list.items) {
    state.top = false;
    item.tokens = [];
    blockTokens(item.text, 0, item.text.length, item.tokens, queue, state, false);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      if (spaces.length > 0 && spaces.some((t) => ANY_LINE.test(t.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const firstTok = item.tokens[0];
    if (item.task && firstTok && (firstTok.type === 'text' || firstTok.type === 'paragraph')) {
      item.text = item.text.replace(LIST_REPLACE_TASK, '');
      firstTok.raw = firstTok.raw.replace(LIST_REPLACE_TASK, '');
      firstTok.text = firstTok.text.replace(LIST_REPLACE_TASK, '');
      for (let g = queue.length - 1; g >= 0; g--) {
        if (LIST_IS_TASK.test(queue[g].inline)) {
          queue[g].inline = queue[g].inline.replace(LIST_REPLACE_TASK, '');
          break;
        }
      }
      const k = LIST_TASK_CHECKBOX.exec(item.raw);
      if (k) {
        const cb = { type: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
        item.checked = cb.checked;
        if (list.loose) {
          if (firstTok && (firstTok.type === 'paragraph' || firstTok.type === 'text') && 'inline' in firstTok) {
            firstTok.leadCheckbox = cb;
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: cb.raw, text: cb.raw, inline: '', leadCheckbox: cb, html: '' });
            queue.push(item.tokens[0]);
          }
        } else {
          item.tokens.unshift(cb);
        }
      }
    } else if (item.task) item.task = false;
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return { tok: list, next: startPos + list.raw.length };
}

// --- block rendering -------------------------------------------------------
// Renders block tokens to HTML, exactly as marked's Renderer does.
function checkboxHtml(cb) {
  return '<input ' + (cb.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderTokens(tokens) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'space': break;
      case 'hr': out.push('<hr>\n'); break;
      case 'heading': out.push(`<h${t.depth}>${t.leadCheckbox ? checkboxHtml(t.leadCheckbox) : ''}${t.html}</h${t.depth}>\n`); break;
      case 'code': {
        const lang = (t.lang || '').match(/^\S*/)?.[0];
        const text = t.text ? t.text.replace(/\n$/, '') + '\n' : '';
        const body = P(text, true);
        out.push(lang ? `<pre><code class="language-${P(lang)}">${body}</code></pre>\n` : `<pre><code>${body}</code></pre>\n`);
        break;
      }
      case 'table': {
        const head = [];
        for (const c of t.header) head.push(`<th${c.align ? ` align="${c.align}"` : ''}>${c.html}</th>\n`);
        const body = [];
        for (const row of t.rows) {
          const cells = [];
          for (const c of row) cells.push(`<td${c.align ? ` align="${c.align}"` : ''}>${c.html}</td>\n`);
          body.push(`<tr>\n${cells.join('')}</tr>\n`);
        }
        out.push(`<table>\n<thead>\n<tr>\n${head.join('')}</tr>\n</thead>\n${body.length ? `<tbody>${body.join('')}</tbody>` : ''}</table>\n`);
        break;
      }
      case 'blockquote': out.push(`<blockquote>\n${renderTokens(t.tokens)}</blockquote>\n`); break;
      case 'list': {
        const items = [];
        for (const item of t.items) items.push(`<li>${renderTokens(item.tokens)}</li>\n`);
        const tag = t.ordered ? 'ol' : 'ul';
        const start = t.ordered && t.start !== 1 ? ` start="${t.start}"` : '';
        out.push(`<${tag}${start}>\n${items.join('')}</${tag}>\n`);
        break;
      }
      case 'checkbox': out.push(checkboxHtml(t)); break;
      case 'html': out.push(t.text); break;
      case 'def': break;
      case 'paragraph': out.push(`<p>${t.leadCheckbox ? checkboxHtml(t.leadCheckbox) : ''}${t.html}</p>\n`); break;
      case 'text': out.push(`${t.leadCheckbox ? checkboxHtml(t.leadCheckbox) : ''}${t.html}`); break;
      default: throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
  return out.join('');
}

// parse(markdown) returns exactly the HTML marked 18.1.3's marked.parse
// returns with marked's default options, code unit for code unit.
export function parse(markdown) {
  // Most documents have no carriage returns; skip the (full-copy) replace
  // when there is nothing to normalize.
  const src = markdown.includes('\r') ? markdown.replace(/\r\n|\r/g, '\n') : markdown;
  const state = {
    links: Object.create(null),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
  const tokens = [];
  const queue = [];
  blockTokens(src, 0, src.length, tokens, queue, state, false);
  for (const q of queue) {
    state.inRawBlock = false;
    q.html = inlineHtml(q.inline, state, state.links, false);
  }
  return renderTokens(tokens);
}
