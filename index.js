import 'dotenv/config'
import fs from 'fs'
import { Telegraf } from 'telegraf'

const bot = new Telegraf(process.env.BOT_TOKEN)

const DATA_FILE = './stats.json'
const ITEMS = ['طماط', 'ذرة', 'جزر', 'فلفل', 'سمك', 'روبيان', 'بقرة', 'ماعز', 'كتكوت']
const K = ITEMS.length
const ALPHA = 1

function safeDefault() {
  return { transitions: {}, last: {} }
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

function probsFromMap(mapRow) {
  const total = Object.values(mapRow || {}).reduce((s,v)=>s+v,0)
  const out = {}
  for (const it of ITEMS) {
    const c = (mapRow && mapRow[it]) ? mapRow[it] : 0
    out[it] = (c + ALPHA) / (total + ALPHA * K)
  }
  return out
}

function argmax(dist) {
  let best = null, bestP = -1
  for (const [k,p] of Object.entries(dist)) {
    if (p > bestP) { bestP = p; best = k }
  }
  return { item: best, p: bestP }
}

bot.command('items', (ctx) => {
  ctx.reply(`العناصر:\n- ${ITEMS.join('\n- ')}`)
})

bot.on('text', (ctx) => {
  const chatId = String(ctx.chat.id)
  const item = ITEMS.find(i => ctx.message.text.includes(i))
  if (!item) return

  const prev = data.last[chatId]
  if (prev) inc(data.transitions, prev, item)

  data.last[chatId] = item
  saveData()

  const P = probsFromMap(prev ? data.transitions[prev] : null)
  const best = argmax(P)
  const conf = Math.round(best.p * 100)

  ctx.reply(`اللي بعده: ${best.item} (${conf}%)`)
})

bot.launch()
console.log('Bot is running...')
