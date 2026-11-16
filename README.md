# Make Markdown Rendering Faster

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/theyschool/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/theyschool/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free, single-file Markdown renderer (`parse.js`) whose
`parse(markdown)` returns exactly the HTML that marked 18.1.3's
`marked.parse` returns with its default options — code unit for code unit —
on all 720 practice cases (680 CommonMark/GFM spec examples plus 40
generated README-like documents), while running faster than marked itself.

`main.ts` is the driver: it reads `/input/cases.json`, renders each case
alone with `parse()`, and writes `/output/html.json`.

## Run it

```sh
node main.ts
```

`MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and
`/output` outside a container.

## How it works

`parse.js` is a from-scratch port of marked's block lexer, inline
character scanner, and renderer, written in its own words:

- Block level: indented and fenced code, ATX and setext headings, thematic
  breaks, blockquotes, lists (including task checkboxes and loose/tight
  detection), HTML blocks, link reference definitions, and GFM tables.
- Inline level: escapes, code spans, hard breaks, autolinks, bare URLs,
  emphasis/strong (with the CommonMark flanking rules and the rule of
  three), strikethrough, links and images (inline and reference, including
  the no-nested-links rule), and raw HTML tags.
- A two-pass design: the block pass collects block tokens and queues the
  inline sources (paragraphs, headings, table cells); a second pass renders
  each inline source once, in document order.

Speed comes from the large documents: the block lexer works on the source
with sticky regular expressions and positional scans instead of repeatedly
slicing strings, the inline scanner masks code spans and links before the
emphasis pass, and the common paths (plain text runs, simple paragraphs)
avoid building token objects they never need.
