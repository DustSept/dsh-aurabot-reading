// Aurabot 扩展模块：读书看报。
// 放在 Aurabot 数据目录 modules/reading/ 里，插件升级不会动它。
// 功能：书架、随机读一段、记录进度和感想、主动分享、看 RSS 热点、收主人发的 txt、去公共版权书库找书。

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, extname, join } from 'node:path'

const TEXT_EXT = new Set(['.txt', '.md', '.markdown'])
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 AurabotReading/0.1'
const MAX_TEXT_CHARS = 8_000_000

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'reading',
  name: '读书看报',
  version: '1.1.0',
  api: 1,
  panel: 'panel.js',
  description: '书架、随机阅读、进度和感想、主动分享、RSS 热点、收 txt、公共版权书库找书',

  defaults: {
    enabled: false,
    shareChance: 0.35,
    shareMaxPerDay: 3,
    minGapMin: 60,
    maxGapMin: 180,
    maxPerDay: 8,
    awakeFrom: 8,
    awakeTo: 23,
    minChars: 600,
    maxChars: 1800,
    newsEnabled: true,
    newsShareChance: 0.3,
    newsRatio: 0.35,
    feeds: 'https://www.ithome.com/rss/\nhttps://sspai.com/feed\nhttps://www.chinanews.com.cn/rss/scroll-news.xml',
    maxUploadMB: 20,
  },

  settings: [
    { key: 'enabled', label: '开关', type: 'switch', hint: '关掉后不自动读，也不主动分享；手动 /读书 仍然可用' },
    { key: 'shareChance', label: '读后感主动分享概率', type: 'number', min: 0, max: 1, step: 0.05, hint: '0 到 1，例如 0.35 = 约三分之一的阅读会主动发给你' },
    { key: 'shareMaxPerDay', label: '每天最多主动分享几次', type: 'number', min: 0, max: 12, step: 1, hint: '0 = 不主动分享；只限主动分享，手动问不算' },
    { key: 'minGapMin', label: '两次阅读最短间隔（分钟）', type: 'number', min: 10, max: 720, step: 5 },
    { key: 'maxGapMin', label: '两次阅读最长间隔（分钟）', type: 'number', min: 10, max: 1440, step: 5 },
    { key: 'maxPerDay', label: '每天最多自动读几次', type: 'number', min: 0, max: 48, step: 1, hint: '0 = 不限；实际次数还受间隔和清醒时段限制' },
    { key: 'awakeFrom', label: '几点开始读', type: 'number', min: 0, max: 23, step: 1 },
    { key: 'awakeTo', label: '几点以后不读', type: 'number', min: 0, max: 23, step: 1 },
    { key: 'minChars', label: '每次最少读多少字', type: 'number', min: 100, max: 5000, step: 100 },
    { key: 'maxChars', label: '每次最多读多少字', type: 'number', min: 100, max: 8000, step: 100 },
    { key: 'newsEnabled', label: '看热点新闻', type: 'switch' },
    { key: 'newsRatio', label: '看新闻的比例', type: 'number', min: 0, max: 1, step: 0.05, hint: '0 = 只读书，1 = 只看新闻；没有书时会自动看新闻' },
    { key: 'newsShareChance', label: '新闻感想主动分享概率', type: 'number', min: 0, max: 1, step: 0.05 },
    { key: 'feeds', label: 'RSS 源（一行一个）', type: 'textarea', hint: '默认 IT之家、少数派、中国新闻网；可以换成你自己常看的 RSS' },
    { key: 'maxUploadMB', label: '接收的 txt 最大 MB', type: 'number', min: 1, max: 100, step: 1 },
  ],

  setup(api) {
    const root = api.dataDir()
    const booksDir = api.dataDir('books')
    const stateFile = join(root, 'state.json')
    mkdirSync(booksDir, { recursive: true })

    const S = () => api.settings()
    const owner = () => String(api.config().ownerQQ || '')
    const ownerChat = () => 'private:' + owner()
    let busy = false

    let state = loadState()

    function defaults() {
      return {
        books: {},
        currentId: '',
        nextReadAt: 0,
        lastReadAt: 0,
        day: '',
        sessions: 0,
        shares: 0,
        newsSessions: 0,
        news: { lastAt: 0, notes: [] },
      }
    }

    function loadState() {
      try {
        const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
        const d = defaults()
        return {
          ...d,
          ...raw,
          books: raw.books && typeof raw.books === 'object' ? raw.books : {},
          news: { ...d.news, ...(raw.news || {}) },
        }
      } catch (error) {
        return defaults()
      }
    }

    function saveState() {
      try {
        const tmp = stateFile + '.tmp'
        writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
        renameSync(tmp, stateFile)
      } catch (error) {
        api.log.warn('读书：保存状态失败：' + error.message)
      }
    }

    function localDay() {
      const d = new Date()
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    }

    function rollDay() {
      const day = localDay()
      if (state.day !== day) {
        state.day = day
        state.sessions = 0
        state.shares = 0
        state.newsSessions = 0
        saveState()
      }
    }

    function decodeText(buf) {
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/^\uFEFF/, '')
      }
      if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        try {
          return new TextDecoder('utf-16le', { fatal: false }).decode(buf).replace(/^\uFEFF/, '')
        } catch (error) {}
      }
      if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        try {
          return new TextDecoder('utf-16be', { fatal: false }).decode(buf).replace(/^\uFEFF/, '')
        } catch (error) {}
      }
      const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/^\uFEFF/, '')
      const badUtf8 = (utf8.match(/\uFFFD/g) || []).length
      const suspicious = /锟斤拷|烫烫烫|屯屯屯|\uFFFD|Ã|Â|â€|ï¿½/.test(utf8)
      if (!badUtf8 && !suspicious) return utf8
      try {
        const gbk = new TextDecoder('gbk', { fatal: false }).decode(buf).replace(/^\uFEFF/, '')
        const badGbk = (gbk.match(/\uFFFD/g) || []).length
        if (suspicious || badGbk < badUtf8) return gbk
        return utf8
      } catch (error) {
        return utf8
      }
    }

    function normalizeTitle(text) {
      return String(text || '')
        .replace(/\.[^.]+$/, '')
        .replace(/\((?:z-library|z-lib\.org|zlib|1lib)\)/ig, '')
        .replace(/\[(?:z-library|z-lib\.org|zlib|1lib)\]/ig, '')
        .replace(/z-library|z-lib\.org/ig, '')
        .replace(/[_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || '未命名'
    }

    function safeFile(title, ext = '.md') {
      const base = String(title || 'book')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || 'book'
      return base + (TEXT_EXT.has(ext.toLowerCase()) ? ext.toLowerCase() : '.md')
    }

    function uniquePath(name) {
      let out = join(booksDir, name)
      if (!existsSync(out)) return out
      const ext = extname(name)
      const stem = name.slice(0, -ext.length)
      for (let i = 2; i < 1000; i++) {
        out = join(booksDir, stem + '-' + i + ext)
        if (!existsSync(out)) return out
      }
      return join(booksDir, stem + '-' + Date.now() + ext)
    }

    function addBookFromText(title, text, source, ext = '.md') {
      const name = safeFile(title || 'book', ext)
      const file = uniquePath(name)
      const body = String(text || '').trim()
      if (!body) throw new Error('内容是空的')
      writeFileSync(file, body + '\n', 'utf8')
      const fileName = basename(file)
      const id = createHash('sha1').update(fileName).digest('hex').slice(0, 10)
      state.books[id] = {
        id,
        file: fileName,
        title: normalizeTitle(title || fileName),
        chars: body.length,
        offset: 0,
        addedAt: Date.now(),
        lastReadAt: 0,
        source: source || '',
        notes: [],
        finished: false,
      }
      if (!state.currentId) state.currentId = id
      saveState()
      return state.books[id]
    }

    function addBookFromBuffer(title, buffer, source, ext = '.txt') {
      const name = safeFile(title || 'book', ext)
      const file = uniquePath(name)
      writeFileSync(file, buffer)
      const fileName = basename(file)
      const id = createHash('sha1').update(fileName).digest('hex').slice(0, 10)
      state.books[id] = {
        id,
        file: fileName,
        title: normalizeTitle(title || fileName),
        chars: 0,
        offset: 0,
        addedAt: Date.now(),
        lastReadAt: 0,
        source: source || '',
        notes: [],
        finished: false,
      }
      if (!state.currentId) state.currentId = id
      saveState()
      return state.books[id]
    }

    function scanBooks() {
      let changed = false
      try {
        for (const name of readdirSync(booksDir)) {
          if (!TEXT_EXT.has(extname(name).toLowerCase())) continue
          const file = join(booksDir, name)
          let st
          try { st = statSync(file) } catch (error) { continue }
          if (!st.isFile()) continue
          const id = createHash('sha1').update(name).digest('hex').slice(0, 10)
          if (!state.books[id]) {
            state.books[id] = {
              id,
              file: name,
              title: normalizeTitle(name),
              chars: st.size,
              offset: 0,
              addedAt: Date.now(),
              lastReadAt: 0,
              source: '书架',
              notes: [],
              finished: false,
            }
            changed = true
          }
        }
      } catch (error) {
        api.log.debug('读书：扫描书架失败：' + error.message)
      }
      for (const b of Object.values(state.books)) {
        const t = normalizeTitle(b.title || b.file)
        if (t && t !== b.title) {
          b.title = t
          changed = true
        }
      }
      if (!state.currentId || !state.books[state.currentId]) {
        state.currentId = Object.keys(state.books)[0] || ''
        changed = true
      }
      if (changed) saveState()
    }

    function readBookText(book) {
      try {
        const file = join(booksDir, book.file)
        if (!existsSync(file)) return null
        const text = decodeText(readFileSync(file)).replace(/\r\n?/g, '\n')
        if (book.chars !== text.length) book.chars = text.length
        if (text.length > MAX_TEXT_CHARS) return text.slice(0, MAX_TEXT_CHARS)
        return text
      } catch (error) {
        api.log.debug('读书：读文件失败：' + error.message)
        return null
      }
    }

    function currentBook() {
      scanBooks()
      const b = state.currentId ? state.books[state.currentId] : null
      return b && existsSync(join(booksDir, b.file)) ? b : null
    }

    function findBook(query) {
      const q = String(query || '').trim().toLowerCase()
      if (!q) return null
      const list = Object.values(state.books)
      return list.find((b) => b.id === q) ||
        list.find((b) => b.title.toLowerCase() === q) ||
        list.find((b) => b.title.toLowerCase().includes(q)) ||
        null
    }

    function unfinishedBooks() {
      return Object.values(state.books).filter((b) => !b.finished && existsSync(join(booksDir, b.file)))
    }

    function randomInt(min, max) {
      const a = Math.ceil(Math.min(min, max))
      const b = Math.floor(Math.max(min, max))
      if (b <= a) return a
      return a + Math.floor(Math.random() * (b - a + 1))
    }

    function readLen() {
      const s = S()
      const a = Math.max(100, Number(s.minChars) || 600)
      const b = Math.max(a, Number(s.maxChars) || 1800)
      return randomInt(a, b)
    }

    function takeChunk(book, len) {
      const text = readBookText(book)
      if (!text) return null
      let start = Math.min(Math.max(0, Number(book.offset) || 0), text.length)
      let end = Math.min(start + Math.max(100, len), text.length)
      if (end < text.length) {
        const nl = text.indexOf('\n', end)
        if (nl !== -1 && nl - end < 260) end = nl
      }
      while (start < end && /\s/.test(text[start])) start++
      const passage = text.slice(start, end).trim()
      book.offset = end
      book.chars = text.length
      book.lastReadAt = Date.now()
      if (end >= text.length) book.finished = true
      saveState()
      if (!passage) return null
      return {
        text: passage,
        pct: Math.round((end / Math.max(1, text.length)) * 100),
        start,
        end,
      }
    }

    function pctOf(book) {
      if (!book) return 0
      const chars = Number(book.chars) || 0
      return Math.min(100, Math.round((Number(book.offset) || 0) / Math.max(1, chars) * 100))
    }

    function shelfText() {
      scanBooks()
      const list = Object.values(state.books)
      if (!list.length) {
        return '书架还是空的。主人发我 txt，或者让我用 reading_find 去公共版权书库找一本。'
      }
      const lines = list.map((b) => {
        const mark = b.id === state.currentId ? '▶ ' : '  '
        const done = b.finished ? '（读完）' : '（' + pctOf(b) + '%）'
        return mark + '《' + b.title + '》' + done
      })
      return '书架：\n' + lines.join('\n')
    }

    function clampCount(v, def = 6, max = 10) {
      const n = Number(v)
      return Math.max(1, Math.min(max, Number.isFinite(n) ? Math.round(n) : def))
    }

    function cleanThought(text) {
      return String(text || '')
        .replace(/\[沉默\]/g, '')
        .replace(/^["“]|["”]$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 320)
    }

    function cleanXml(value) {
      return String(value || '')
        .replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
          try { return String.fromCodePoint(parseInt(h, 16)) } catch (error) { return '' }
        })
        .replace(/&#(\d+);/g, (_, d) => {
          try { return String.fromCodePoint(Number(d)) } catch (error) { return '' }
        })
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    }

    function tagOf(xml, name) {
      const m = String(xml || '').match(new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i'))
      return m ? cleanXml(m[1]) : ''
    }

    async function fetchText(url, timeoutMs = 20000, maxChars = 2_000_000) {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const text = await res.text()
      return text.slice(0, maxChars)
    }

    async function fetchBuffer(url, timeoutMs = 30000) {
      const res = await fetch(url, {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const buf = Buffer.from(await res.arrayBuffer())
      return buf
    }

    async function fetchJson(url, timeoutMs = 20000) {
      const text = await fetchText(url, timeoutMs, 1_000_000)
      return JSON.parse(text)
    }

    function isPublicUrl(raw) {
      try {
        const u = new URL(String(raw))
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
        const h = u.hostname.toLowerCase()
        if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return false
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|169\.254\.)/.test(h)) return false
        if (/^\[?::1\]?$/.test(h)) return false
        return true
      } catch (error) {
        return false
      }
    }

    function parseRss(xml, feedUrl) {
      const feedTitle = tagOf(xml, 'title') || new URL(feedUrl).hostname
      const items = []
      const blocks = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || []
      for (const block of blocks.slice(0, 12)) {
        const title = tagOf(block, 'title')
        if (!title) continue
        let link = tagOf(block, 'link')
        if (!link) {
          const m = block.match(/<link\b[^>]*href=["']([^"']+)["']/i)
          if (m) link = m[1]
        }
        const summary = tagOf(block, 'description').slice(0, 200)
        const date = tagOf(block, 'pubDate')
        items.push({ title, link, summary, source: feedTitle, date })
      }
      return items
    }

    async function fetchNews(limit = 6) {
      scanBooks()
      const feeds = String(S().feeds || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 8)
      const all = []
      for (const feed of feeds) {
        try {
          const xml = await fetchText(feed, 15000, 800_000)
          all.push(...parseRss(xml, feed))
        } catch (error) {
          api.log.debug('读书：RSS 失败 ' + feed + '：' + error.message)
        }
      }
      const seen = new Set()
      const out = []
      for (const item of all) {
        const key = String(item.title).toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(item)
        if (out.length >= clampCount(limit, 6, 10)) break
      }
      state.news.lastAt = Date.now()
      saveState()
      return out
    }

    async function fetchArticle(url) {
      if (!isPublicUrl(url)) throw new Error('不是公开的 http/https 网址')
      const html = await fetchText(url, 20000, 3_000_000)
      const title = tagOf(html, 'title') || ''
      let body = html
      const article = html.match(/<article\b[\s\S]*?<\/article>/i) || html.match(/<main\b[\s\S]*?<\/main>/i)
      if (article) body = article[0]
      body = String(body)
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
      const text = cleanXml(body)
      if (text.length < 80) throw new Error('没从页面里读到正文')
      return { title: title || new URL(url).hostname, text: text.slice(0, 20000) }
    }

    async function findWikisource(query) {
      const url = 'https://zh.wikisource.org/w/api.php?action=query&generator=search&gsrsearch=' +
        encodeURIComponent(query) + '&gsrlimit=1&prop=extracts&explaintext=1&format=json&origin=*'
      const j = await fetchJson(url)
      const pages = j && j.query && j.query.pages ? Object.values(j.query.pages) : []
      const page = pages[0]
      if (!page || !page.extract || String(page.extract).length < 300) return null
      return { title: page.title || query, text: String(page.extract), source: '维基文库' }
    }

    async function findGutenberg(query) {
      if (/[\u4e00-\u9fff]/.test(String(query || ''))) return null
      const searchUrl = 'https://www.gutenberg.org/ebooks/search/?query=' + encodeURIComponent(query)
      const html = await fetchText(searchUrl, 20000, 1_000_000)
      const m = html.match(/href=["']\/ebooks\/(\d+)["']/i)
      if (!m) return null
      const id = m[1]
      const txt = await fetchText('https://www.gutenberg.org/ebooks/' + id + '.txt.utf-8', 30000, 3_000_000)
      if (!txt || txt.length < 500) return null
      const tm = html.match(/<span class=["']title["']>([\s\S]*?)<\/span>/i)
      const am = html.match(/<span class=["']subtitle["']>([\s\S]*?)<\/span>/i)
      let title = tm ? cleanXml(tm[1]) : ''
      const author = am ? cleanXml(am[1]) : ''
      if (author && title) title += ' — ' + author
      if (!title) title = 'Gutenberg #' + id
      return { title, text: txt, source: 'Project Gutenberg #' + id }
    }

    async function findPublicText(query) {
      const q = String(query || '').trim()
      if (!q) throw new Error('要给一个书名或关键词')
      const chinese = /[\u4e00-\u9fff]/.test(q)
      if (chinese) {
        try {
          const r = await findWikisource(q)
          if (r && r.text && r.text.length > 300) return r
          throw new Error('维基文库没返回正文')
        } catch (error) {
          throw new Error('中文书暂时找不到可下载的公共版权来源（这台机器连维基文库不稳）。直接把 txt 发我，或换成英文书名用 Project Gutenberg。')
        }
      }
      try {
        const r = await findGutenberg(q)
        if (r && r.text && r.text.length > 300) return r
      } catch (error) {
        throw new Error('Project Gutenberg 没找到：' + error.message)
      }
      throw new Error('Project Gutenberg 没找到这本书')
    }

    async function thinkBook(book, passage) {
      const prompt = '你正在读《' + book.title + '》。刚读到这一段：\n' +
        passage.slice(0, 1600) +
        '\n\n按你平时的口气说一两句真实的读后感，最多三句。'
      try {
        return cleanThought(await api.think(prompt, { title: '读书', timeoutMs: 120000 }))
      } catch (error) {
        api.log.debug('读书：读后感生成失败：' + error.message)
        return ''
      }
    }

    async function arrivalReaction(book) {
      let sample = ''
      try { sample = String(readBookText(book) || '').replace(/\s+/g, ' ').slice(0, 500) } catch (error) {}
      const others = Object.values(state.books)
        .filter((b) => b.id !== book.id)
        .slice(-6)
        .map((b) => '《' + b.title + '》')
        .join('、')
      const notes = Object.values(state.books)
        .flatMap((b) => (b.notes || []).slice(0, 1).map((n) => String(n.thought || '').slice(0, 80)))
        .filter(Boolean)
        .slice(0, 3)
        .join('；')
      const prompt = '主人刚把一本书发给你，你还没开始读。\n' +
        '书名：' + book.title + '\n' +
        '长度：' + book.chars + ' 字（不要报具体数字）\n' +
        (sample ? '开头几行：' + sample + '\n' : '') +
        '按你收到书时的自然反应说一两句，最多三句。\n' +
        (others ? '你书架上还有：' + others + '。\n' : '') +
        (notes ? '你最近的读书感想：' + notes + '。\n' : '')
      try {
        const out = cleanThought(await api.think(prompt, { title: '收到书', timeoutMs: 90000 }))
        if (out) return out
      } catch (error) {
        api.log.debug('读书：收到书的反应生成失败：' + error.message)
      }
      return '诶，《' + book.title + '》？我先翻两页看看。'
    }

    async function thinkNews(item, body) {
      const prompt = '你刚刷到一条新闻：\n标题：' + item.title +
        (item.summary ? '\n摘要：' + item.summary : '') +
        (body ? '\n正文节选：' + String(body).slice(0, 1200) : '') +
        '\n\n按你平时的口气说一两句反应。'
      try {
        return cleanThought(await api.think(prompt, { title: '看报', timeoutMs: 120000 }))
      } catch (error) {
        api.log.debug('读书：新闻感想生成失败：' + error.message)
        return ''
      }
    }

    async function maybeShare(text, chance) {
      const msg = String(text || '').trim()
      if (!msg) return false
      if (Math.random() > Math.max(0, Math.min(1, Number(chance) || 0))) return false
      rollDay()
      const maxShares = Number(S().shareMaxPerDay)
      if (Number.isFinite(maxShares) && maxShares <= 0) return false
      if (Number.isFinite(maxShares) && state.shares >= maxShares) return false
      const last = Number(api.core.hub.lastOwnerChatAt) || 0
      if (last && Date.now() - last < 20 * 60_000) return false
      const chatId = ownerChat()
      try {
        if (api.core.mutes && api.core.mutes.muted(chatId)) return false
      } catch (error) {}
      try {
        await api.send(chatId, msg)
        state.shares++
        saveState()
        api.log.info('读书：主动分享了一条（今天第 ' + state.shares + ' 条）')
        return true
      } catch (error) {
        api.log.warn('读书：主动分享失败：' + error.message)
        return false
      }
    }

    function bookShareText(book, passage, thought) {
      const quote = String(passage || '').replace(/\s+/g, ' ').trim().slice(0, 90)
      const head = quote ? '刚看了会儿《' + book.title + '》，看到一句「' + quote + '」' : '刚看了会儿《' + book.title + '》'
      return head + (thought ? '\n' + thought : '')
    }

    function newsShareText(item, thought) {
      return '刚刷到一条：' + item.title + (thought ? '\n' + thought : '')
    }

    async function bookSession() {
      const books = unfinishedBooks()
      if (!books.length) return false
      const book = books[randomInt(0, books.length - 1)]
      state.currentId = book.id
      const chunk = takeChunk(book, readLen())
      if (!chunk) return false
      const thought = await thinkBook(book, chunk.text)
      if (thought) {
        book.notes.unshift({ at: Date.now(), quote: chunk.text.slice(0, 120), thought })
        book.notes = book.notes.slice(0, 50)
      }
      saveState()
      await maybeShare(bookShareText(book, chunk.text, thought), S().shareChance)
      return true
    }

    async function newsSession() {
      if (!S().newsEnabled) return false
      const items = await fetchNews(8)
      if (!items.length) return false
      const item = items[randomInt(0, Math.min(items.length, 8) - 1)]
      let body = ''
      if (item.link && isPublicUrl(item.link)) {
        try { body = (await fetchArticle(item.link)).text } catch (error) {}
      }
      const thought = await thinkNews(item, body)
      if (thought) {
        state.news.notes.unshift({ at: Date.now(), title: item.title, source: item.source, thought })
        state.news.notes = state.news.notes.slice(0, 30)
      }
      saveState()
      await maybeShare(newsShareText(item, thought), S().newsShareChance)
      return true
    }

    function isAwake() {
      const s = S()
      const a = Math.max(0, Math.min(23, Number(s.awakeFrom)))
      const b = Math.max(0, Math.min(23, Number(s.awakeTo)))
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return true
      const h = new Date().getHours()
      return a < b ? h >= a && h < b : h >= a || h < b
    }

    function nextAwakeAt() {
      const s = S()
      const a = Math.max(0, Math.min(23, Number(s.awakeFrom)))
      const d = new Date()
      d.setMinutes(0, 0, 0)
      if (d.getHours() >= a) d.setDate(d.getDate() + 1)
      d.setHours(a)
      return d.getTime() + randomInt(0, 20) * 60_000
    }

    function nextDayAt() {
      const s = S()
      const a = Math.max(0, Math.min(23, Number(s.awakeFrom)))
      const d = new Date()
      d.setDate(d.getDate() + 1)
      d.setHours(a, 0, 0, 0)
      return d.getTime() + randomInt(0, 20) * 60_000
    }

    function scheduleNext() {
      const s = S()
      let a = Math.max(10, Number(s.minGapMin) || 60)
      let b = Math.max(10, Number(s.maxGapMin) || 180)
      if (b < a) b = a
      state.nextReadAt = Date.now() + randomInt(a, b) * 60_000
      saveState()
    }

    async function tick() {
      if (busy) return
      if (!S().enabled) return
      rollDay()
      const now = Date.now()
      if (!state.nextReadAt) {
        state.nextReadAt = now + randomInt(10, 25) * 60_000
        saveState()
        return
      }
      if (now < state.nextReadAt) return
      if (!isAwake()) {
        state.nextReadAt = nextAwakeAt()
        saveState()
        return
      }
      const max = Number(S().maxPerDay) || 0
      if (max > 0 && state.sessions >= max) {
        state.nextReadAt = nextDayAt()
        saveState()
        return
      }
      busy = true
      let did = false
      let didNews = false
      try {
        scanBooks()
        const books = unfinishedBooks()
        const newsOn = Boolean(S().newsEnabled)
        const ratioRaw = Number(S().newsRatio)
        const ratio = Number.isFinite(ratioRaw) ? Math.max(0, Math.min(1, ratioRaw)) : 0.35
        const useNews = newsOn && (!books.length || Math.random() < ratio)
        if (useNews) {
          did = await newsSession()
          didNews = did
          if (!did && books.length) did = await bookSession()
        } else if (books.length) {
          did = await bookSession()
        } else if (newsOn) {
          did = await newsSession()
          didNews = did
        }
        if (did) {
          state.sessions++
          if (didNews) state.newsSessions++
          saveState()
        }
      } catch (error) {
        api.log.warn('读书：这一轮失败：' + error.message)
      } finally {
        busy = false
        state.lastReadAt = Date.now()
        scheduleNext()
      }
    }

    async function ingestFile(data, chatId) {
      const rawName = String((data && (data.file_name || data.name || data.file)) || 'book.txt')
      const name = basename(rawName.replace(/\\/g, '/'))
      const ext = extname(name).toLowerCase()
      if (!TEXT_EXT.has(ext)) {
        await api.send(chatId, '我只收 txt / md 文件；pdf、epub 先转成 txt 再发我。')
        return
      }
      const maxBytes = Math.max(1, Number(S().maxUploadMB) || 20) * 1024 * 1024
      let buf = null
      let lastError = null
      if (data && typeof data.url === 'string' && /^https?:/i.test(data.url)) {
        try { buf = await fetchBuffer(data.url) } catch (error) { lastError = error }
      }
      if (!buf && data && (data.file_id || data.file)) {
        try {
          const info = await api.onebot('get_private_file_url', {
            user_id: owner(),
            file_id: String(data.file_id || data.file),
            file_hash: String(data.file_hash || ''),
          })
          const i = (info && info.data) || info || {}
          const url = i.url || i.file || ''
          if (url && /^https?:/i.test(url)) buf = await fetchBuffer(url)
          else if (url && existsSync(url)) buf = readFileSync(url)
        } catch (error) {
          lastError = error
        }
      }
      if (!buf) {
        api.log.warn('读书：没拿到文件内容' + (lastError ? '：' + lastError.message : ''))
        await api.send(chatId, '我这边只拿到文件名，没拿到内容。你可以把 txt 放到：\n' + booksDir)
        return
      }
      if (buf.length > maxBytes) {
        await api.send(chatId, '这个文件太大了（' + Math.round(buf.length / 1024 / 1024) + ' MB），先发小一点的。')
        return
      }
      if (buf.length > MAX_TEXT_CHARS * 4) {
        await api.send(chatId, '文件太大，读起来会卡；先发个精简版吧。')
        return
      }
      const text = decodeText(buf).trim()
      if (!text || text.length < 20) {
        await api.send(chatId, '文件里没读到文字，可能是编码不对；另存为 UTF-8 的 txt 再发我。')
        return
      }
      const title = normalizeTitle(name)
      const book = addBookFromBuffer(title, buf, '主人发的文件', ext)
      const reaction = await arrivalReaction(book)
      book.notes.unshift({ at: Date.now(), quote: '', thought: reaction, kind: 'arrival' })
      book.notes = book.notes.slice(0, 50)
      saveState()
      await api.send(chatId, reaction)
    }

    // ---- 工具 ----
    api.tool((where) => {
      if (!where || where.level !== 'full' || !where.chat || where.chat.kind !== 'private') return []
      return [
        api.defineTool({
          name: 'reading_shelf',
          description: '看看书架上有哪些书、当前读到哪、进度多少。',
          properties: {},
          execute: async () => ({ ok: true, message: shelfText() }),
        }),
        api.defineTool({
          name: 'reading_open',
          description: '从书架上打开一本书，设为当前阅读。参数可以是书名的一部分或书籍 id。',
          properties: { book: { type: 'string', description: '书名或 id' } },
          required: ['book'],
          execute: async ({ book }) => {
            scanBooks()
            const b = findBook(book)
            if (!b) return { ok: false, message: '书架上没有这本：' + book }
            state.currentId = b.id
            saveState()
            return { ok: true, message: '打开了《' + b.title + '》，当前进度 ' + pctOf(b) + '%。' }
          },
        }),
        api.defineTool({
          name: 'reading_next',
          description: '读当前书（或指定书）的下一段，随机读几百到一千多字，更新进度。',
          properties: { book: { type: 'string', description: '可选：书名或 id；不填就是当前这本' } },
          execute: async ({ book }) => {
            scanBooks()
            const b = book ? findBook(book) : currentBook()
            if (!b) return { ok: false, message: '书架是空的，或者没有这本。' }
            const chunk = takeChunk(b, readLen())
            if (!chunk) return { ok: false, message: '《' + b.title + '》已经读完了。' }
            return {
              ok: true,
              message: '《' + b.title + '》 读到 ' + chunk.pct + '%\n\n' + chunk.text +
                '\n\n读完可以把你现在的感想用 reading_note 记下来。',
            }
          },
        }),
        api.defineTool({
          name: 'reading_note',
          description: '把刚才读到的感想或摘录记到当前书里；之后聊天会想起来。',
          properties: {
            text: { type: 'string', description: '你的感想，一两句话' },
            quote: { type: 'string', description: '可选：让你有感觉的那句原文' },
          },
          required: ['text'],
          execute: async ({ text, quote }) => {
            const b = currentBook()
            if (!b) return { ok: false, message: '还没有打开的书。' }
            const thought = String(text || '').trim().slice(0, 500)
            if (!thought) return { ok: false, message: '感想是空的。' }
            b.notes.unshift({
              at: Date.now(),
              quote: String(quote || '').trim().slice(0, 200),
              thought,
            })
            b.notes = b.notes.slice(0, 50)
            saveState()
            return { ok: true, message: '记在《' + b.title + '》的笔记里了。' }
          },
        }),
        api.defineTool({
          name: 'reading_news',
          description: '看几条热点新闻标题和摘要，用来和主人聊今天发生的事。',
          properties: { count: { type: 'number', description: '看几条，默认 6' } },
          execute: async ({ count }) => {
            const items = await fetchNews(count)
            if (!items.length) return { ok: false, message: 'RSS 源都没取到新闻，可能网络不通。' }
            const lines = items.map((x, i) => (i + 1) + '. [' + x.source + '] ' + x.title + (x.summary ? '\n   ' + x.summary : ''))
            return { ok: true, message: '热点新闻：\n' + lines.join('\n') }
          },
        }),
        api.defineTool({
          name: 'reading_add_url',
          description: '把一篇网页文章抓下来，放进书架慢慢读（只收公开 http/https 页面）。',
          properties: { url: { type: 'string', description: '文章网址' } },
          required: ['url'],
          execute: async ({ url }) => {
            const art = await fetchArticle(url)
            const b = addBookFromText(art.title, art.text, url, '.md')
            const sample = String(art.text || '').replace(/\s+/g, ' ').slice(0, 240)
            return {
              ok: true,
              message: '文章《' + b.title + '》已经收进书架。' +
                (sample ? '开头是：' + sample + '\n' : '') +
                '\n先别急着总结。用你平时的口气说说看到标题/开头的第一反应：好奇、联想、猜它会讲什么，或者评论一下标题。不要只回“收到/收好了/已放上书架”。',
            }
          },
        }),
        api.defineTool({
          name: 'reading_find',
          description: '去公共版权书库（Project Gutenberg / 维基文库）找一本可以合法下载的书，下载到书架。',
          properties: { query: { type: 'string', description: '书名、作者或关键词' } },
          required: ['query'],
          execute: async ({ query }) => {
            const found = await findPublicText(query)
            const b = addBookFromText(found.title, found.text, found.source, '.txt')
            const sample = String(found.text || '').replace(/\s+/g, ' ').slice(0, 240)
            return {
              ok: true,
              message: '找到了《' + b.title + '》（' + found.source + '）。' +
                (sample ? '开头是：' + sample + '\n' : '') +
                '\n先说说你看到这本书的第一反应：惊喜、好奇、猜体裁、联想到读过的书，或者评论一下书名/想象中的封面。不要只回“找到/收到/已放上书架”。',
            }
          },
        }),
      ]
    })

    api.rule((kind) => {
      if (kind !== 'private' || !S().enabled) return ''
      return '你会读书看报：需要看书架、读下一段、记感想、看新闻、收文章或找书时，分别用 reading_shelf / reading_next / reading_note / reading_news / reading_add_url / reading_find。按工具返回的真实进度说，不要编造。'
    })

    api.context(({ chat }) => {
      if (!S().enabled) return ''
      if (!chat || chat.kind !== 'private' || String(chat.userId) !== owner()) return ''
      const b = currentBook()
      const parts = []
      if (b) {
        const n = b.notes && b.notes[0]
        parts.push('【读书】你在读《' + b.title + '》，进度 ' + pctOf(b) + '%。' +
          (n && n.thought ? '上次感想：' + String(n.thought).slice(0, 120) : ''))
      }
      const recent = Object.values(state.books)
        .filter((x) => x.id !== (b && b.id) && (x.finished || (x.notes && x.notes.length)))
        .slice(-4)
        .map((x) => '《' + x.title + '》')
        .join('、')
      if (recent) parts.push('你书架上的其他书：' + recent + '。')
      const news = state.news.notes && state.news.notes[0]
      if (news && (!b || Date.now() - news.at < 12 * 3600_000)) {
        parts.push('【看报】最近看到：' + String(news.title).slice(0, 40) + '。' + String(news.thought || '').slice(0, 100))
      }
      return parts.join(' ')
    })

    api.command({
      name: '读书',
      aliases: ['read'],
      desc: '看看最近在读什么、进度到哪',
      run: async (arg) => {
        scanBooks()
        if (/^(next|下一|读一段)/i.test(String(arg || '').trim())) {
          const b = currentBook()
          if (!b) return '书架是空的。'
          const chunk = takeChunk(b, readLen())
          if (!chunk) return '《' + b.title + '》已经读完了。'
          return '《' + b.title + '》 读到 ' + chunk.pct + '%\n\n' + chunk.text
        }
        const b = currentBook()
        const last = b && b.notes && b.notes[0]
        rollDay()
        const max = Number(S().maxPerDay) || 0
        const stats = '今天自动读了 ' + state.sessions + ' 次' + (max ? '（上限 ' + max + '）' : '') + '，主动分享 ' + state.shares + ' 次'
        return shelfText() + (last && last.thought ? '\n\n上次感想：' + last.thought : '') + '\n\n' + stats
      },
    })

    api.command({
      name: '新闻',
      aliases: ['news'],
      desc: '看几条热点新闻',
      run: async () => {
        const items = await fetchNews(6)
        if (!items.length) return 'RSS 源都没取到新闻。'
        return items.map((x, i) => (i + 1) + '. [' + x.source + '] ' + x.title).join('\n')
      },
    })

    api.route('/panel/state', async () => {
      scanBooks()
      const current = currentBook()
      const books = Object.values(state.books).map((b) => ({
        id: b.id,
        title: b.title,
        pct: pctOf(b),
        finished: Boolean(b.finished),
        noteCount: (b.notes || []).length,
        offset: Number(b.offset) || 0,
        chars: Number(b.chars) || 0,
        lastReadAt: Number(b.lastReadAt) || 0,
        addedAt: Number(b.addedAt) || 0,
        source: b.source || '书架',
      })).sort((a, b) => (b.id === state.currentId) - (a.id === state.currentId) || b.lastReadAt - a.lastReadAt)
      const bookNotes = Object.values(state.books).flatMap((b) => (b.notes || []).map((n) => ({
        ...n,
        type: 'book',
        bookId: b.id,
        book: b.title,
      })))
      const newsNotes = (state.news.notes || []).map((n) => ({
        ...n,
        type: 'news',
      }))
      const notes = [...bookNotes, ...newsNotes]
        .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
        .slice(0, 120)
      return {
        ok: true,
        current: current ? { ...current, pct: pctOf(current), noteCount: (current.notes || []).length } : null,
        books,
        notes,
        stats: {
          day: state.day || '',
          sessions: Number(state.sessions) || 0,
          shares: Number(state.shares) || 0,
          newsSessions: Number(state.newsSessions) || 0,
          nextReadAt: Number(state.nextReadAt) || 0,
          lastReadAt: Number(state.lastReadAt) || 0,
          maxPerDay: Number(S().maxPerDay) || 0,
          shareMaxPerDay: Number(S().shareMaxPerDay) || 0,
        },
      }
    })

    api.route('/status', async () => {
      scanBooks()
      return {
        ok: true,
        enabled: Boolean(S().enabled),
        books: Object.values(state.books).map((b) => ({
          id: b.id,
          title: b.title,
          pct: pctOf(b),
          finished: Boolean(b.finished),
          notes: (b.notes || []).length,
        })),
        currentId: state.currentId,
        nextReadAt: state.nextReadAt,
        lastReadAt: state.lastReadAt,
        day: state.day,
        sessionsToday: state.sessions,
        sharesToday: state.shares,
        newsToday: state.newsSessions,
        maxPerDay: Number(S().maxPerDay) || 0,
        shareMaxPerDay: Number(S().shareMaxPerDay) || 0,
        newsRatio: Number(S().newsRatio),
        newsNotes: (state.news.notes || []).length,
        booksDir,
      }
    })

    api.route('/shelf', async () => ({ ok: true, message: shelfText() }))

    api.route('/news', async (req) => {
      const q = api.core.http.query(req)
      const items = await fetchNews(Number(q.count) || 6)
      return { ok: true, items }
    })

    // ---- 收主人发来的文件 ----
    api.on('message', async (msg) => {
      if (!msg || msg.kind !== 'private') return false
      if (String(msg.userId) !== owner()) return false
      const raw = msg.raw || {}
      const segs = Array.isArray(raw.message) ? raw.message : []
      const fileSeg = segs.find((s) => s && s.type === 'file')
      if (!fileSeg) return false
      try {
        await ingestFile(fileSeg.data || {}, msg.chatId)
      } catch (error) {
        api.log.warn('读书：接收文件失败：' + error.message)
        try { await api.send(msg.chatId, '文件没接住：' + error.message) } catch (e) {}
      }
      return true
    })

    // ---- 定时 ----
    api.every(60_000, tick, '读书看报')
    api.onDispose(() => saveState())

    scanBooks()
    if (!state.nextReadAt) {
      state.nextReadAt = Date.now() + randomInt(10, 25) * 60_000
      saveState()
    }

    api.log.info('读书看报模块已加载｜书架 ' + Object.keys(state.books).length + ' 本｜' + (S().enabled ? '自动阅读开' : '自动阅读关'))

    return {
      shelf: () => shelfText(),
      status: () => ({ books: Object.values(state.books), currentId: state.currentId }),
      tick,
    }
  },
}
