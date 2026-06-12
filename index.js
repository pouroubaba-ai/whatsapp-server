import express from 'express'
import cors from 'cors'
import qrcode from 'qrcode'
import fs from 'fs'
import pino from 'pino'

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

// ── State ─────────────────────────────────────────────────────────────────────
let sock = null
let status = 'disconnected'
let currentQr = null
let isInitializing = false
let lastError = null

const AUTH_DIR = '/tmp/baileys_auth'

// ── Init WhatsApp ─────────────────────────────────────────────────────────────
async function initWhatsApp() {
  if (isInitializing || status === 'connected') return
  isInitializing = true
  status = 'connecting'
  currentQr = null

  try {
    console.log('[WA] Importing baileys...')
    const baileys = await import('@whiskeysockets/baileys')
    const makeWASocket = baileys.default
    const { useMultiFileAuthState, DisconnectReason } = baileys
    console.log('[WA] Baileys imported OK')

    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    console.log('[WA] Auth loaded, creating socket...')

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
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
        console.log('[WA] QR ready — scan it')
      }

      if (connection === 'open') {
        status = 'connected'
        currentQr = null
        isInitializing = false
        lastError = null
        console.log('[WA] Connected!')
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = code !== DisconnectReason.loggedOut
        console.log('[WA] Closed. Code:', code)
        status = 'disconnected'
        currentQr = null
        sock = null
        isInitializing = false
        if (shouldReconnect) setTimeout(() => initWhatsApp().catch(console.error), 5000)
      }
    })
  } catch (err) {
    console.error('[WA] Error:', err.message)
    lastError = err.message
    status = 'disconnected'
    currentQr = null
    sock = null
    isInitializing = false
    setTimeout(() => initWhatsApp().catch(console.error), 15000)
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true }))

app.get('/status', (req, res) => {
  if (status === 'disconnected' && !isInitializing) {
    initWhatsApp().catch(console.error)
  }
  res.json({ status, qr: currentQr, error: lastError })
})

app.post('/send', async (req, res) => {
  if (status !== 'connected' || !sock) {
    return res.status(503).json({ error: 'WhatsApp not connected', status })
  }

  const { messages } = req.body
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' })
  }

  const results = []

  for (const msg of messages) {
    const { to, text, pdfBase64, filename } = msg
    if (!to || !text) {
      results.push({ to, success: false, error: 'missing to or text' })
      continue
    }

    const jid = `${to.replace(/\D/g, '')}@s.whatsapp.net`

    try {
      await sock.sendMessage(jid, { text })
      if (pdfBase64) {
        await sock.sendMessage(jid, {
          document: Buffer.from(pdfBase64, 'base64'),
          mimetype: 'application/pdf',
          fileName: filename ?? 'avis-paiement.pdf',
        })
      }
      results.push({ to, success: true })
    } catch (err) {
      results.push({ to, success: false, error: err.message ?? 'send_failed' })
    }
  }

  res.json({ results })
})

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`)
  // Don't auto-init on boot — wait for first /status call
  // This ensures the server responds even if baileys fails
})
