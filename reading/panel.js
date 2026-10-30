// 读书看报面板：当前在读、进度、书架，以及读书/看报时产生的想法。
// 由 Aurabot 面板执行：React、h、ui、call 由面板注入。
const { useState, useEffect } = React

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'book', label: '读书' },
  { id: 'news', label: '看报' },
]

function fmtNum(n) {
  return new Intl.NumberFormat('zh-CN').format(Number(n) || 0)
}

function fmtTime(t) {
  if (!t) return '—'
  const d = new Date(t)
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function cleanQuote(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 110)
}

function thoughtLines(s) {
  return String(s || '')
    .split(/\s*\|\|\|\s*/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function Progress({ pct, color }) {
  return h('div', { style: { height: 8, borderRadius: 999, background: '#e8eef5', overflow: 'hidden' } },
    h('i', {
      style: {
        display: 'block', height: '100%', width: Math.max(2, Math.min(100, Number(pct) || 0)) + '%',
        background: color || '#6aa9cf', borderRadius: 999,
      },
    })
  )
}

return function ReadingPanel({ toast }) {
  const [data, setData] = useState(null)
  const [filter, setFilter] = useState('all')

  const load = async () => {
    const r = await call('/panel/state')
    if (!r || r.ok === false) {
      toast((r && r.message) || '加载失败', 'err')
      return
    }
    setData(r)
  }

  useEffect(() => {
    load()
    const timer = setInterval(load, 60_000)
    return () => clearInterval(timer)
  }, [])

  if (!data) {
    return h(ui.Card, { title: '读书看报' }, h('div', { className: 'ab-muted' }, '加载中…'))
  }

  const c = data.current
  const stats = data.stats || {}
  const books = data.books || []
  const notes = (data.notes || []).filter((n) => filter === 'all' || n.type === filter)
  const btn = (text, onClick, kind) => h(ui.Btn, { small: true, kind: kind || 'ghost', onClick }, text)
  const meta = (text) => h('span', { className: 'ab-muted ab-small' }, text)

  return h('div', { style: { display: 'grid', gap: 12 } },
    h(ui.Card, {
      title: '现在在看',
      desc: '进度和想法都来自读书模块的真实记录，不是另存的摘要。',
      right: btn('刷新', load),
    },
      c
        ? h('div', null,
            h('div', { className: 'ab-flex', style: { justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
              h('div', { style: { fontSize: 18, fontWeight: 650 } }, c.title),
              h('div', { className: 'ab-muted ab-small' }, c.finished ? '已读完' : '在读 · ' + c.pct + '%'),
            ),
            h('div', { style: { marginTop: 10 } }, h(Progress, { pct: c.pct })),
            h('div', { className: 'ab-flex', style: { gap: 14, flexWrap: 'wrap', marginTop: 6 } },
              meta('进度 ' + c.pct + '%'),
              meta('已读 ' + fmtNum(c.offset) + ' / ' + fmtNum(c.chars)),
              meta('想法 ' + (c.noteCount || 0) + ' 条'),
              meta('上次读 ' + fmtTime(c.lastReadAt)),
            ),
            h('div', { className: 'ab-flex', style: { gap: 14, flexWrap: 'wrap', marginTop: 10, paddingTop: 10, borderTop: '1px solid #eef1f5' } },
              meta('今天自动读 ' + (stats.sessions || 0) + ' 次'),
              meta('主动分享 ' + (stats.shares || 0) + ' 次'),
              meta('看报 ' + (stats.newsSessions || 0) + ' 次'),
              meta('下次阅读 ' + (stats.nextReadAt ? fmtTime(stats.nextReadAt) : '未安排')),
            ),
          )
        : h('div', { className: 'ab-muted' }, '书架是空的。可以在私聊里发 txt，或者让她用 reading_find 找一本。'),
    ),

    h(ui.Card, {
      title: '想法',
      desc: '读书时她会记下一两句读后感；看报时也会对标题和摘要反应。收书时的第一反应也在里面。',
      right: h('div', { className: 'ab-flex' }, FILTERS.map((f) => btn(f.label, () => setFilter(f.id), filter === f.id ? 'primary' : 'ghost'))),
    },
      notes.length === 0
        ? h('div', { className: 'ab-muted' }, filter === 'news' ? '还没有看报的想法。' : '还没有读书的想法。')
        : notes.map((n, i) => {
            const isNews = n.type === 'news'
            const label = isNews ? '看报' : (n.kind === 'arrival' ? '收书' : '读书')
            const lines = thoughtLines(n.thought)
            return h('div', {
              key: (n.at || 0) + '-' + i,
              style: { padding: '10px 0', borderBottom: i === notes.length - 1 ? 'none' : '1px solid #eef1f5' },
            },
              h('div', { className: 'ab-flex', style: { gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
                h('span', { style: { fontSize: 11, fontWeight: 650, color: '#4b93b8' } }, label),
                h('span', { className: 'ab-muted ab-small' }, fmtTime(n.at)),
                h('span', { className: 'ab-muted ab-small' }, isNews ? (n.source || '新闻') : (n.book || '')),
              ),
              isNews && n.title ? h('div', { style: { fontWeight: 600, marginTop: 4, lineHeight: 1.45 } }, n.title) : null,
              n.quote ? h('div', { className: 'ab-muted ab-small', style: { marginTop: 4, lineHeight: 1.5 } }, '「' + cleanQuote(n.quote) + '」') : null,
              lines.length
                ? h('div', { style: { marginTop: 5, lineHeight: 1.65 } }, lines.map((line, j) => h('div', { key: j }, '· ' + line)))
                : h('div', { className: 'ab-muted ab-small', style: { marginTop: 4 } }, '（没有留下文字）'),
            )
          }),
    ),

    h(ui.Card, { title: '书架', desc: '按最近读过的顺序排列；带 ▶ 的是当前这本。' },
      books.length === 0
        ? h('div', { className: 'ab-muted' }, '书架还是空的。')
        : books.map((b) => h('div', {
            key: b.id,
            style: { padding: '8px 0', borderBottom: '1px solid #f1f4f8' },
          },
            h('div', { className: 'ab-flex', style: { justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' } },
              h('div', { style: { fontWeight: 600 } }, (b.id === (c && c.id) ? '▶ ' : '') + b.title + (b.finished ? '（读完）' : '')),
              h('div', { className: 'ab-muted ab-small' }, b.pct + '% · 想法 ' + b.noteCount + ' 条'),
            ),
            h('div', { style: { marginTop: 5 } }, h(Progress, { pct: b.pct, color: b.finished ? '#9fb3c8' : '#6aa9cf' })),
          )),
    ),
  )
}
