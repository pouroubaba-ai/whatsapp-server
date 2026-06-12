const express = require('express')
const cors = require('cors')
const qrcode = require('qrcode')
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

// ── WhatsApp client ──────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '/data/.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
  },
})

let status = 'disconnected' // 'qr_pending' | 'connected' | 'disconnected'
let currentQr = null

client.on('qr', async (qr) => {
  status = 'qr_pending'
  currentQr = await qrcode.toDataURL(qr)
  console.log('[WA] QR code generated — scan it via the app')
})

client.on('ready', () => {
  status = 'connected'
  currentQr = null
  console.log('[WA] Client connected and ready')
})

client.on('disconnected', (reason) => {
  status = 'disconnected'
  currentQr = null
  console.log('[WA] Disconnected:', reason)
  // Auto-reconnect after 5s
  setTimeout(() => client.initialize(), 5000)
})

client.initialize()

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /status — returns connection status + QR data URL if pending
app.get('/status', (req, res) => {
  res.json({ status, qr: currentQr })
})

/**
 * POST /send
 * Body: { messages: Array<{ to: string, text: string, pdfBase64?: string, filename?: string }> }
 * Returns: { results: Array<{ to, success, error? }> }
 */
app.post('/send', async (req, res) => {
  if (status !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp not connected', status })
  }

  const { messages } = req.body
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' })
  }

  const results = []

  for (const msg of messages) {
    const { to, text, pdfBase64, filename } = msg
    if (!to || !text) {
      results.push({ to, success: false, error: 'missing to or text' })
      continue
    }

    // Normalize phone: strip non-digits, ensure no leading +
    const phone = to.replace(/\D/g, '')
    const chatId = `${phone}@c.us`

    try {
      // Check if number exists on WhatsApp
      const isRegistered = await client.isRegisteredUser(chatId)
      if (!isRegistered) {
        results.push({ to, success: false, error: 'not_on_whatsapp' })
        continue
      }

      // Send text message
      await client.sendMessage(chatId, text)

      // Attach PDF if provided
      if (pdfBase64) {
        const media = new MessageMedia(
          'application/pdf',
          pdfBase64,
          filename ?? 'avis-paiement.pdf'
        )
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
app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`))
