import 'dotenv/config'
import fs from 'fs'
import { Telegraf } from 'telegraf'

const bot = new Telegraf(process.env.BOT_TOKEN)

const DATA_FILE = './stats.json'
const ITEMS = ['طماط', 'ذرة', 'جزر', 'فلفل', 'سمك', 'روبيان', 'بقرة', 'ماعز', 'كتكوت']
const K = ITEMS.length
const ALPHA = 1
const DEFAULT_W = 0.75

function safeDefault() {
  return { transitions: {}, minuteCounts: {}, last: {}, prev2: {}, tz: {} }
}
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return safeDefault()
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  } catch {
    return safeDefault()
  }
}
const data = loadData()

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8')
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

function normalizeDist(dist) {
  const s = Object.values(dist).reduce((a, v) => a + v, 0) || 1
  for (const k of Object.keys(dist)) dist[k] = dist[k] / s
  return dist
}

// يحسب دقيقة "وقت جوالك" بناءً على /tz
function minuteOfHour(ctx, tzMinutes) {
  const utcSec = ctx.message.date // Telegram timestamp (UTC) in seconds
  const localMs = (utcSec * 1000) + (tzMinutes * 60 * 1000)
  return new Date(localMs).getUTCMinutes()
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

  return Math.max(0.2, Math.min(0.9, w))
}

// ===== أوامر =====
bot.command('tz', (ctx) => {
  const parts = ctx.message.text.split(' ').filter(Boolean)
  if (parts.length < 2) return ctx.reply('اكتبها كذا: /tz +03:00')
  const m = parts[1].match(/^([+-])(\d{2}):(\d{2})$/)
  if (!m) return ctx.reply('صيغة غلط. مثال: /tz +03:00')

  const sign = m[1] === '-' ? -1 : 1
  const hh = parseInt(m[2], 10)
  const mm = parseInt(m[3], 10)
  const offset = sign * (hh * 60 + mm)

  data.tz[String(ctx.chat.id)] = offset
  saveData()
  ctx.reply(`✅ تم حفظ فرق التوقيت: ${parts[1]}`)
})

bot.command('items', (ctx) => {
  ctx.reply(`العناصر:\n- ${ITEMS.join('\n- ')}`)
})

// ===== استقبال الرسائل =====
bot.on('text', (ctx) => {
  const chatId = String(ctx.chat.id)
  const item = ITEMS.find(i => ctx.message.text.includes(i))
  if (!item) return

  const tzMinutes = data.tz[chatId]
  if (tzMinutes === undefined) {
    return ctx.reply('قبل ما نبدأ: اكتب فرق توقيتك مرة وحدة مثل: /tz +03:00')
  }

  const m = minuteOfHour(ctx, tzMinutes)

  const prev = data.last[chatId]
  const prevPrev = data.prev2[chatId]

  // تدريب
  if (prev) inc(data.transitions, prev, item)
  inc(data.minuteCounts, String(m), item)

  // تحديث آخر عنصرين
  data.prev2[chatId] = prev || null
  data.last[chatId] = item
  saveData()

  // توقع
  const prevRow = prev ? data.transitions[prev] : null
  const minuteRow = data.minuteCounts[String(m)] || null

  const P1 = probsFromMap(prevRow)           // التتابع
  const P2 = probsFromMap(minuteRow)         // الدقيقة

  const w = dynamicW(prevRow, minuteRow)
  const P = {}
  for (const it of ITEMS) P[it] = w * P1[it] + (1 - w) * P2[it]

  // تقليل تكرار نفس العنصر 3 مرات
  if (prev && prevPrev && prev === prevPrev) {
    P[prev] *= 0.85
  }

  normalizeDist(P)

  const best = argmax(P)
  const conf = Math.round(best.p * 100)

  ctx.reply(`اللي بعده: ${best.item} (${conf}%)\n(d=${m}, w=${w.toFixed(2)})`)
})

bot.launch()
console.log('✅ Bot is running...')

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
