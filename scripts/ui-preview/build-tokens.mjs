/**
 * 从本机已安装的 DSH 主题包里抽出真实的 CSS 变量块，写成 tokens.css。
 *
 * 为什么要抽而不是手写：#dsh-cluster-ui 的样式全靠 `--dsw-alias-*` 这套 token
 * 取色，手抄一份就等于换了皮肤——截出来的"改前/改后"对比就不再是同一个主题下
 * 的对比了。这里按源码顺序原样取出 body / body[data-ds-dark-theme] 里所有含
 * `--dsw-` 的规则块，暗色块天然排在浅色块之后，层叠关系与真实页面一致。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const THEME = 'S:/deepseek_harness/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'

const src = readFileSync(THEME, 'utf8')

/** 取 src 中每个 `selector{ ... }` 块（大括号配平），筛出含 --dsw- 的。 */
function blocks(source) {
  const out = []
  const re = /body\[data-ds-dark-theme\]|:root|body/g
  let m
  while ((m = re.exec(source))) {
    const selEnd = m.index + m[0].length
    if (source[selEnd] !== '{') continue
    // 只接收独立选择器，不能把平台限定复合选择器中的 body 提升成全局 body。
    if (m.index > 0 && !/[}\s`"']/.test(source[m.index - 1])) continue
    const prefix = source.slice(Math.max(0, m.index - 100), m.index)
    if (/[^{}]*\]\s*$/.test(prefix)) continue
    let depth = 0
    let i = selEnd
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const block = source.slice(m.index, i + 1)
    if (block.includes('--dsw-')) out.push(block)
  }
  return out
}

const css = [
  '/* 由 scripts/ui-preview/build-tokens.mjs 从 DSH 主题包生成，勿手改。 */',
  '/* 只取画面上真会用到的那部分：alias token + 字体族 + 静态色板。 */',
  ...blocks(src),
  // 面板根节点在真实布局里由外层容器给高度；这里补一条等价的基线。
  'html,body{margin:0;height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}',
].join('\n\n')

const target = join(here, 'tokens.css')
writeFileSync(target, css, 'utf8')
console.log(`tokens.css: ${css.length} bytes, ${blocks(src).length} blocks`)
