const express = require('express')

const app = express()

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

app.get('/test', (req, res) => {
  res.json({ message: 'server works' })
})

const PORT = process.env.PORT || 3001
app.listen(PORT, '0.0.0.0', () => {
  console.log('SERVER STARTED ON PORT', PORT)
})
