const express = require('express')
const cors = require('cors')
const qrcode = require('qrcode')
const path = require('path')
const fs = require('fs')
const pino = require('pino')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

// ── State ────────────────────────────────────────────────────────────────────
let sock = null
let status = 'disconnected' // 'connecting' | 'qr_pending' | 'connected' | 'disconnected'
let currentQr = null
let isInitializing = false

const AUTH_DIR = '/tmp/baileys_auth'

// ── Init WhatsApp ─────────────────────────────────────────────────────────────
async function initWhatsApp() {
  if (isInitializing || status === 'connected') return
  isInitializing = true
  status = 'connecting'

  try {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeInMemoryStore,
    } = await import('@whiskeysockets/baileys')

    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      generateHighQualityLinkPreview: false,
      browser: ['Yassen Academy', 'Chrome', '1.0.0'],
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        status = 'qr_pending'
        currentQr = await qrcode.toDataURL(qr)
        console.log('[WA] QR code ready — scan it')
      }

      if (connection === 'open') {
        status = 'connected'
        currentQr = null
        isInitializing = false
        console.log('[WA] Connected!')
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = code !== DisconnectReason.loggedOut
        console.log('[WA] Disconnected. Code:', code, '— reconnect:', shouldReconnect)
        status = 'disconnected'
        currentQr = null
        sock = null
        isInitializing = false
        if (shouldReconnect) {
          setTimeout(() => initWhatsApp(), 3000)
        }
      }
    })
  } catch (err) {
    console.error('[WA] Init error:', err.message)
    status = 'disconnected'
    currentQr = null
    sock = null
    isInitializing = false
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true }))

app.get('/status', async (req, res) => {
  if (status === 'disconnected' && !isInitializing) {
    initWhatsApp().catch(console.error)
  }
  res.json({ status, qr: currentQr })
})

app.post('/send', async (req, res) => {
  if (status !== 'connected' || !sock) {
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

    const phone = to.replace(/\D/g, '')
    const jid = `${phone}@s.whatsapp.net`

    try {
      // Send text
      await sock.sendMessage(jid, { text })

      // Send PDF if provided
      if (pdfBase64) {
        const buffer = Buffer.from(pdfBase64, 'base64')
        await sock.sendMessage(jid, {
          document: buffer,
          mimetype: 'application/pdf',
          fileName: filename ?? 'avis-paiement.pdf',
        })
      }

      results.push({ to, success: true })
    } catch (err) {
      const errMsg = err.message ?? 'send_failed'
      const isNotOnWA = errMsg.includes('not-authorized') || errMsg.includes('not found')
      results.push({ to, success: false, error: isNotOnWA ? 'not_on_whatsapp' : errMsg })
    }
  }

  res.json({ results })
})

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`)
  // Start WhatsApp immediately on boot
  initWhatsApp().catch(console.error)
})
