import { h } from 'koishi';

import xh from './h/h';
import puppeteerUtile from './puppeteer/puppeteer';

import type { Context } from 'koishi';
import type Config from '../config';
/**
 * 将纯文本渲染为图片卡片（若可用），否则回落为文本
 * @param ctx 上下文
 * @param config
 * @param text
 * @param options
 * @returns
 */
export default async function maybeRenderAsImage(
  ctx: Context,
  config: Config,
  text: string,
  options?: { title?: string }
): Promise<any> {
  try {
    if (!config.render_as_image) return text
  // 未配置浏览器路径时跳过渲染，回退为文本
  if (!config.browser_path) return text
    const title = options?.title ?? '云黑结果'
    // 拆分为行，构造简单卡片（使用 h()，避免 .ts 中使用 JSX）
    const lines = String(text ?? '').split('\n')
    let url = ''
    const li = []
    for (const line of lines) {
      const zz = line.match(/(http|https):\/\/[^\s]+$/)
      if (zz) {
        // url = zz[0]
        url = line
      } else {
        li.push(xh('div', { style: { marginBottom: '8px' } }, line))
      }
    }

    const [startc, endc] = config.theme_color.split('/')
    const colorTx = colorT(config.theme_date, startc, endc)
    // koishi 的 h() 函数不支持传入css
    const vnode = xh(
      'div',
      {
        style: {
          width: '900px',
          padding: '32px',
          background: colorTx(true),
          color: colorTx(false),
          fontSize: '28px',
          fontFamily: 'Microsoft YaHei, Segoe UI, Arial, sans-serif',
          lineHeight: 1.6,
        },
      },
  xh('div', { style: { fontSize: '34px', fontWeight: '700', marginBottom: '16px' } }, title),
      xh('div', { style: { height: '2px', background: '#2a3340', marginBottom: '16px' } }),
      ...li.map((ln, i) =>
        xh(
          'div',
          { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
          ln || ' '
        )
      ),
      xh('div', { style: { marginTop: '16px', color: '#7b8794', fontSize: '22px' } }, '由 koishi-plugin-ysyunhei 生成')
    )
    const buf = await puppeteerUtile(config, vnode)
    if (!buf) return text
    return h('div',
      h.image('base64://' + buf.toString('base64')),
      url
    )
  } catch (e) {
    console.log('error', e)
    return text
  }
}

function colorT(date: string = '8/20', lightColor = '#e8edf2', darkColor = '#252525') : (f: boolean) => string {
  const [start, end] = date.split('/').map(Number);
  const currentHour = new Date().getHours();
  const dateBoolean = currentHour >= start && currentHour < end;
  return (f: boolean = true) => {
    return f ? dateBoolean ? lightColor : darkColor : dateBoolean ? darkColor : lightColor;
  }
}
