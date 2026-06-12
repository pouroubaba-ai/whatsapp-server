const express = require('express')
const cors = require('cors')
const qrcode = require('qrcode')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

// ── State ────────────────────────────────────────────────────────────────────
let client = null
let status = 'disconnected' // 'initializing' | 'qr_pending' | 'connected' | 'disconnected'
let currentQr = null

// ── Initialize client on demand ──────────────────────────────────────────────
async function initClient() {
  if (status === 'connected' || status === 'initializing' || status === 'qr_pending') return

  const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js')
  status = 'initializing'

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/tmp/.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--mute-audio',
        '--no-default-browser-check',
      ],
    },
  })

  client.on('qr', async (qr) => {
    console.log('[WA] QR code generated')
    status = 'qr_pending'
    currentQr = await qrcode.toDataURL(qr)
  })

  client.on('ready', () => {
    console.log('[WA] Connected and ready')
    status = 'connected'
    currentQr = null
  })

  client.on('auth_failure', () => {
    console.log('[WA] Auth failure')
    status = 'disconnected'
    currentQr = null
    client = null
  })

  client.on('disconnected', (reason) => {
    console.log('[WA] Disconnected:', reason)
    status = 'disconnected'
    currentQr = null
    client = null
  })

  try {
    await client.initialize()
  } catch (err) {
    console.error('[WA] Init error:', err.message)
    status = 'disconnected'
    currentQr = null
    client = null
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true }))

// GET /status — returns connection status + QR if pending
// Also triggers initialization if disconnected
app.get('/status', async (req, res) => {
  if (status === 'disconnected') {
    initClient().catch(console.error)
  }
  res.json({ status, qr: currentQr })
})

// POST /send
app.post('/send', async (req, res) => {
  if (status !== 'connected' || !client) {
    return res.status(503).json({ error: 'WhatsApp not connected', status })
  }

  const { messages } = req.body
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' })
  }

  const { MessageMedia } = require('whatsapp-web.js')
  const results = []

  for (const msg of messages) {
    const { to, text, pdfBase64, filename } = msg
    if (!to || !text) {
      results.push({ to, success: false, error: 'missing to or text' })
      continue
    }

    const phone = to.replace(/\D/g, '')
    const chatId = `${phone}@c.us`

    try {
      const isRegistered = await client.isRegisteredUser(chatId)
      if (!isRegistered) {
        results.push({ to, success: false, error: 'not_on_whatsapp' })
        continue
      }

      await client.sendMessage(chatId, text)

      if (pdfBase64) {
        const media = new MessageMedia('application/pdf', pdfBase64, filename ?? 'avis-paiement.pdf')
        await client.sendMessage(chatId, media)
      }

      results.push({ to, success: true })
    } catch (err) {
      results.push({ to, success: false, error: err.message ?? 'send_failed' })
    }
  }

  res.json({ results })
})

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`)
  console.log('[SERVER] Ready — WhatsApp client will start on first /status request')
})
