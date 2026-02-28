import 'dotenv/config'
import fs from 'fs'
import { Telegraf } from 'telegraf'

const bot = new Telegraf(process.env.BOT_TOKEN)

const DATA_FILE = './stats.json'
const ITEMS = ['طماط', 'ذرة', 'جزر', 'فلفل', 'سمك', 'روبيان', 'بقرة', 'ماعز', 'كتكوت'] // عدّلها
const K = ITEMS.length
const ALPHA = 1
const DEFAULT_W = 0.75

// ✅ الافتراضي: توقيت السعودية (ما يحتاج تكتب /tz)
const DEFAULT_TZ = 'Asia/Riyadh'

// مرادفات/تصحيحات شائعة (عدّلها حسب لعبتك)
const ALIASES = {
  'ربيان': 'روبيان',
  'جمبري': 'روبيان',
  'طماطم': 'طماط',
  'طماطه': 'طماط',
  'طماطة': 'طماط',
  'طماطـ': 'طماط'
}

// ====== تحميل/حفظ ======
function safeDefault() {
  return { transitions: {}, minuteCounts: {}, last: {}, prev2: {}, tz: {} }
}
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return safeDefault()
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    return { ...safeDefault(), ...d }
  } catch {
    return safeDefault()
  }
}
const data = loadData()

// حفظ مؤجل لتقليل الكتابة على القرص
let saveTimer = null
function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8')
    } finally {
      saveTimer = null
    }
  }, 1500)
}

function norm(s = '') { return s.trim() }
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// استخراج العناصر بالترتيب من داخل الرسالة الواحدة (مع المرادفات)
const TOKENS = [...new Set([...ITEMS, ...Object.keys(ALIASES)])]
const TOKENS_SORTED = [...TOKENS].sort((a, b) => b.length - a.length)

function canonicalize(item) {
  return ALIASES[item] || item
}

// نطابق العنصر ككلمة مستقلة قدر الإمكان (بداية/نهاية/مسافة/فواصل)
function extractItemsInOrder(text = '') {
  const t = norm(text)
  const hits = []

  for (const tok of TOKENS_SORTED) {
    const tokEsc = escapeRegex(tok)
    const re = new RegExp(
      `(^|\\s|[\\.,،!؟:;\\-\\_{}"'«»])(${tokEsc})($|\\s|[\\.,،!؟:;\\-\\_{}"'«»])`,
      'g'
    )

    let m
    while ((m = re.exec(t)) !== null) {
      hits.push({ idx: m.index, item: canonicalize(tok) })
    }
  }

  hits.sort((a, b) => a.idx - b.idx)

  // فلترة بسيطة لتكرارات بنفس المكان
  const out = []
  for (const h of hits) {
    if (out.length === 0 || out[out.length - 1].idx !== h.idx) out.push(h)
  }

  // رجّع فقط العناصر اللي موجودة في ITEMS (بعد التحويل)
  return out.map(x => x.item).filter(x => ITEMS.includes(x))
}

// ====== الوقت ======
// ندعم نوعين:
// 1) tzName مثل Asia/Riyadh
// 2) offset بالدقائق مثل +03:00 => 180
function minuteOfHour(ctx, tzSetting) {
  const utcSec = ctx.message.date // UTC seconds
  const date = new Date(utcSec * 1000)

  // إذا رقم => offset
  if (typeof tzSetting === 'number') {
    const localMs = (utcSec * 1000) + (tzSetting * 60 * 1000)
    return new Date(localMs).getUTCMinutes()
  }

  const tzName = (typeof tzSetting === 'string' && tzSetting) ? tzSetting : DEFAULT_TZ

  // استخدام Intl (أدق)
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzName,
      minute: '2-digit'
    }).formatToParts(date)

    const mm = parts.find(p => p.type === 'minute')?.value
    if (mm != null) return parseInt(mm, 10)
  } catch {
    // لو فشل Intl لأي سبب، نرجع لطريقة offset الافتراضية +03:00
  }

  // fallback: +03:00
  const fallbackOffset = 180
  const localMs = (utcSec * 1000) + (fallbackOffset * 60 * 1000)
  return new Date(localMs).getUTCMinutes()
}

function inc(obj, a, b) {
  obj[a] ||= {}
  obj[a][b] ||= 0
  obj[a][b] += 1
}

function rowTotal(row) {
  return Object.values(row || {}).reduce((s, v) => s + v, 0)
}

function probsFromMap(mapRow) {
  const total = rowTotal(mapRow)
  const out = {}
  for (const it of ITEMS) {
    const c = (mapRow && mapRow[it]) ? mapRow[it] : 0
    out[it] = (c + ALPHA) / (total + ALPHA * K)
  }
  return out
}

function argmax(dist) {
  let best = null, bestP = -1
  for (const [k, p] of Object.entries(dist)) {
    if (p > bestP) { bestP = p; best = k }
  }
  return { item: best, p: bestP }
}

function topN(dist, n = 3) {
  return Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([item, p]) => ({ item, p }))
}

function normalizeDist(dist) {
  const s = Object.values(dist).reduce((a, v) => a + v, 0) || 1
  for (const k of Object.keys(dist)) dist[k] = dist[k] / s
  return dist
}

// وزن ديناميكي
function dynamicW(prevRow, minuteRow) {
  const t1 = rowTotal(prevRow)
  const t2 = rowTotal(minuteRow)

  let w = DEFAULT_W

  if (t1 < 3) w -= 0.20
  if (t1 < 1) w -= 0.15

  if (t2 < 3) w += 0.10
  if (t2 < 1) w += 0.10

  w = Math.max(0.2, Math.min(0.9, w))
  return w
}

// ====== أوامر ======
bot.command('tz', (ctx) => {
  const chatId = String(ctx.chat.id)
  const parts = ctx.message.text.split(' ').filter(Boolean)

  // بدون باراميتر: اعرض الحالي
  if (parts.length < 2) {
    const cur = data.tz[chatId] ?? DEFAULT_TZ
    return ctx.reply(`توقيتك الحالي: ${cur}\nغيّره مثل: /tz Asia/Riyadh أو /tz +03:00`)
  }

  const val = parts[1].trim()

  // 1) offset بصيغة +03:00
  const m = val.match(/^([+-])(\d{2}):(\d{2})$/)
  if (m) {
    const sign = m[1] === '-' ? -1 : 1
    const hh = parseInt(m[2], 10)
    const mm = parseInt(m[3], 10)
    const offset = sign * (hh * 60 + mm)
    data.tz[chatId] = offset
    scheduleSave()
    return ctx.reply(`✅ تم حفظ فرق التوقيت: ${val}`)
  }

  // 2) اسم منطقة زمنية (IANA)
  // مثال: Asia/Riyadh
  data.tz[chatId] = val
  scheduleSave()
  ctx.reply(`✅ تم حفظ المنطقة الزمنية: ${val}`)
})

bot.command('items', (ctx) => {
  ctx.reply(`العناصر:\n- ${ITEMS.join('\n- ')}`)
})

bot.command('reset', (ctx) => {
  const chatId = String(ctx.chat.id)
  delete data.last[chatId]
  delete data.prev2[chatId]
  scheduleSave()
  ctx.reply('✅ تم تصفير سجل آخر عنصرين لهذي المحادثة.')
})

bot.command('top', (ctx) => {
  const chatId = String(ctx.chat.id)

  const prev = data.last[chatId]
  if (!prev) return ctx.reply('ما عندي آخر عنصر بعد. ارسل عنصر/سلسلة من العناصر أول.')

  const nowUtcSec = Math.floor(Date.now() / 1000)
  const fakeCtx = { message: { date: nowUtcSec } }
  const m = minuteOfHour(fakeCtx, data.tz[chatId] ?? DEFAULT_TZ)

  const prevRow = prev ? data.transitions[prev] : null
  const minuteRow = data.minuteCounts[String(m)] || null

  const P1 = probsFromMap(prevRow)
  const P2 = probsFromMap(minuteRow)
  const w = dynamicW(prevRow, minuteRow)

  const P = {}
  for (const it of ITEMS) P[it] = w * P1[it] + (1 - w) * P2[it]
  normalizeDist(P)

  const top = topN(P, 3)
  const msg = top.map((x, i) => `${i + 1}) ${x.item} (${Math.round(x.p * 100)}%)`).join('\n')
  ctx.reply(`أفضل 3 توقعات (دقيقة ${m}):\n${msg}\n\nw=${w.toFixed(2)}`)
})

// ====== الاستقبال ======
bot.on('text', (ctx) => {
  const chatId = String(ctx.chat.id)

  // ✅ ما عاد نطلب /tz — ناخذ الافتراضي إذا ما كان مضبوط
  const tzSetting = data.tz[chatId] ?? DEFAULT_TZ

  // ✅ تحليل كل العناصر داخل الرسالة (بترتيبها)
  const items = extractItemsInOrder(ctx.message.text)
  if (items.length === 0) return

  const m = minuteOfHour(ctx, tzSetting)

  // history من قبل الرسالة
  let prev = data.last[chatId] || null
  let prevPrev = data.prev2[chatId] || null

  // علّم الانتقالات داخل الرسالة وبالربط مع السابق
  for (const item of items) {
    if (prev) inc(data.transitions, prev, item)
    inc(data.minuteCounts, String(m), item)

    prevPrev = prev
    prev = item
  }

  // حدّث history بنهاية السلسلة
  data.prev2[chatId] = prevPrev
  data.last[chatId] = prev
  scheduleSave()

  // ======= نموذج التوقع =======
  const prevRow = prev ? data.transitions[prev] : null
  const minuteRow = data.minuteCounts[String(m)] || null

  const P1 = probsFromMap(prevRow)
  const P2 = probsFromMap(minuteRow)
  const w = dynamicW(prevRow, minuteRow)

  const P = {}
  for (const it of ITEMS) P[it] = w * P1[it] + (1 - w) * P2[it]

  // تقليل التكرار الثالث إذا آخر عنصرين متساويين
  if (prev && prevPrev && prev === prevPrev) {
    P[prev] *= 0.85
  }

  normalizeDist(P)

  const best = argmax(P)
  const conf = Math.round(best.p * 100)

  const top3 = topN(P, 3)
  const extra = top3.map((x, i) => `${i + 1}) ${x.item} ${Math.round(x.p * 100)}%`).join(' | ')

  ctx.reply(`اللي بعده: ${best.item} (${conf}%)\n${extra}\n(d=${m}, w=${w.toFixed(2)})`)
})

bot.launch()
console.log('✅ Bot is running...')

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
