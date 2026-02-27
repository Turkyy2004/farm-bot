import 'dotenv/config'
import { Telegraf } from 'telegraf'

const token = process.env.BOT_TOKEN
if (!token) {
  console.error('❌ Missing BOT_TOKEN. Create a .env file with: BOT_TOKEN=123456:ABC-DEF...')
  process.exit(1)
}

const bot = new Telegraf(token)

bot.start((ctx) => ctx.reply('👋 هلا! أنا بوت جاهز. ارسل أي رسالة وبأرد عليك.'))
bot.help((ctx) => ctx.reply('اكتب أي شيء وأنا أرد.'))

// Echo any text message
bot.on('text', (ctx) => {
  ctx.reply(`وصلتني رسالتك: ${ctx.message.text}`)
})

bot.launch()
console.log('✅ Bot is running...')

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
