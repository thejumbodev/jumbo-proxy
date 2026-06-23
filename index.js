/**
 * Strata Discord Proxy — Railway
 *
 * Required environment variables on Railway:
 *   DISCORD_BOT_TOKEN      Bot token from Developer Portal
 *   DISCORD_CLIENT_ID      Application/client ID
 *   DISCORD_CLIENT_SECRET  OAuth2 client secret
 *   DISCORD_REDIRECT_URI   Full URL of this server's /discord/callback endpoint
 *                          e.g. https://jumbo-proxy-production.up.railway.app/discord/callback
 *   DISCORD_PUBLIC_KEY     Ed25519 public key (from Developer Portal, for interactions)
 *   FRONTEND_URL           Your frontend URL, defaults to http://localhost:5173
 *                          e.g. https://ytstrata.com
 */

const express = require('express')
const cors    = require('cors')
const fetch   = require('node-fetch')
const nacl    = require('tweetnacl')

const app  = express()
const PORT = process.env.PORT || 3000

const BOT_TOKEN      = process.env.DISCORD_BOT_TOKEN
const CLIENT_ID      = process.env.DISCORD_CLIENT_ID
const CLIENT_SECRET  = process.env.DISCORD_CLIENT_SECRET
const REDIRECT_URI   = process.env.DISCORD_REDIRECT_URI
const PUBLIC_KEY     = process.env.DISCORD_PUBLIC_KEY
const FRONTEND_URL   = process.env.FRONTEND_URL || 'http://localhost:5173'

// ── In-memory RSVP store ─────────────────────────────────────────────
// Format: { [cardId]: { [workspaceMemberId]: 'accepted' | 'declined' } }
// Resets on server restart. For persistent storage, migrate to a DB.
const rsvpStore = {}

// ── CORS ─────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }))

// ── Body parsing ─────────────────────────────────────────────────────
// /interactions needs the raw body for signature verification.
// All other routes get JSON-parsed bodies.
app.use((req, res, next) => {
  if (req.path === '/interactions') {
    express.raw({ type: '*/*' })(req, res, next)
  } else {
    express.json()(req, res, next)
  }
})

// ── Discord API helpers ───────────────────────────────────────────────
const DISCORD = 'https://discord.com/api/v10'

async function dGet(path) {
  const r = await fetch(`${DISCORD}${path}`, {
    headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
  })
  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText)
    throw new Error(`Discord ${r.status}: ${text}`)
  }
  return r.json()
}

async function dPost(path, body) {
  const r = await fetch(`${DISCORD}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText)
    throw new Error(`Discord ${r.status}: ${text}`)
  }
  return r.json()
}

// ═════════════════════════════════════════════════════════════════════
// 1. GET /discord/invite-url
//    Returns the OAuth URL that adds the Strata bot to a server.
// ═════════════════════════════════════════════════════════════════════
app.get('/discord/invite-url', (req, res) => {
  const url =
    `https://discord.com/api/oauth2/authorize` +
    `?client_id=${CLIENT_ID}` +
    `&permissions=8` +
    `&scope=bot%20applications.commands` +
    (REDIRECT_URI ? `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` : '')

  res.json({ url })
})

// ═════════════════════════════════════════════════════════════════════
// 2. GET /discord/callback?code=...&guild_id=...
//    Discord redirects here after the user adds the bot.
//    We exchange the code (optional — Discord sends guild_id directly)
//    then redirect back to the frontend with guild_id as a param.
// ═════════════════════════════════════════════════════════════════════
app.get('/discord/callback', async (req, res) => {
  const { code, guild_id } = req.query

  // Exchange the auth code if present (fire-and-forget; we don't use the user token)
  if (code && CLIENT_SECRET && REDIRECT_URI) {
    fetch(`${DISCORD}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  REDIRECT_URI,
      }),
    }).catch(e => console.error('Token exchange error:', e))
  }

  const dest = guild_id
    ? `${FRONTEND_URL}?guild_id=${encodeURIComponent(guild_id)}`
    : FRONTEND_URL

  res.redirect(dest)
})

// ═════════════════════════════════════════════════════════════════════
// 3. GET /discord/members?guildId=X
//    Uses the server-side bot token. Never exposed to the frontend.
// ═════════════════════════════════════════════════════════════════════
app.get('/discord/members', async (req, res) => {
  const { guildId } = req.query
  if (!guildId) return res.status(400).json({ error: 'Missing guildId' })

  try {
    const raw = await dGet(`/guilds/${guildId}/members?limit=100`)
    const members = raw
      .filter(m => !m.user?.bot)
      .map(m => ({
        id:          m.user.id,
        username:    m.user.username,
        displayName: m.nick || m.user.global_name || m.user.username,
        avatar:      m.user.avatar
          ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png`
          : null,
      }))
    res.json(members)
  } catch (e) {
    console.error('/discord/members error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ═════════════════════════════════════════════════════════════════════
// 4. POST /send-invite
//    Sends a rich DM invite with Accept/Decline buttons.
//    Body: { userId, cardId, memberId, channelName, title, unixTimestamp }
//    Token comes from environment — never from the request body.
// ═════════════════════════════════════════════════════════════════════
app.post('/send-invite', async (req, res) => {
  const { userId, cardId, memberId, channelName, title, unixTimestamp } = req.body

  if (!userId || !cardId) return res.status(400).json({ error: 'Missing userId or cardId' })

  // memberId is the workspace member UUID (used as the RSVP key)
  const rsvpKey = memberId || userId

  try {
    // Open (or reuse) a DM channel with this user
    const dm = await dPost('/users/@me/channels', { recipient_id: userId })

    const fields = []
    if (unixTimestamp) {
      fields.push({ name: 'Scheduled for', value: `<t:${unixTimestamp}:F>`, inline: false })
    }

    await dPost(`/channels/${dm.id}/messages`, {
      embeds: [{
        title:       'Recording Invite',
        description: `You have been invited to record **${title}**${channelName ? ` on **${channelName}**` : ''}.`,
        fields,
        color: 0x7c6af7,
        footer: { text: 'Strata — Video Production Planning' },
      }],
      components: [{
        type: 1,
        components: [
          {
            type: 2, style: 3, label: 'Accept',
            custom_id: `rsvp:${cardId}:${rsvpKey}:accepted`,
          },
          {
            type: 2, style: 4, label: 'Decline',
            custom_id: `rsvp:${cardId}:${rsvpKey}:declined`,
          },
        ],
      }],
    })

    res.json({ ok: true })
  } catch (e) {
    console.error('/send-invite error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ═════════════════════════════════════════════════════════════════════
// 5. POST /ping-alerts
//    Posts a message pinging confirmed attendees in an alerts channel.
//    Body: { channelId, userIds, title }
//    Token comes from environment.
// ═════════════════════════════════════════════════════════════════════
app.post('/ping-alerts', async (req, res) => {
  const { channelId, userIds, title } = req.body

  if (!channelId) return res.status(400).json({ error: 'Missing channelId' })

  try {
    const mentions = (userIds || []).map(id => `<@${id}>`).join(' ')
    const content  = `Recording for **${title}** is starting soon!${mentions ? ` ${mentions}` : ''}`.trim()

    await dPost(`/channels/${channelId}/messages`, { content })
    res.json({ ok: true })
  } catch (e) {
    console.error('/ping-alerts error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ═════════════════════════════════════════════════════════════════════
// 6. GET /rsvp-status?cardIds=id1,id2,...
//    Returns accumulated RSVP responses for the given card IDs.
//    Response: { [cardId]: { [memberId]: 'accepted' | 'declined' } }
// ═════════════════════════════════════════════════════════════════════
app.get('/rsvp-status', (req, res) => {
  const cardIds = (req.query.cardIds || '').split(',').filter(Boolean)
  const result  = {}
  for (const id of cardIds) result[id] = rsvpStore[id] || {}
  res.json(result)
})

// ═════════════════════════════════════════════════════════════════════
// 7. POST /interactions
//    Discord sends button interactions here.
//    Verifies the Ed25519 signature, stores RSVP, responds to Discord.
// ═════════════════════════════════════════════════════════════════════
app.post('/interactions', (req, res) => {
  const sig       = req.headers['x-signature-ed25519']
  const timestamp = req.headers['x-signature-timestamp']
  const rawBody   = req.body  // Buffer (because we used express.raw)

  // Verify signature if public key is configured
  if (PUBLIC_KEY) {
    try {
      const valid = nacl.sign.detached.verify(
        Buffer.from(timestamp + rawBody),
        Buffer.from(sig, 'hex'),
        Buffer.from(PUBLIC_KEY, 'hex')
      )
      if (!valid) return res.status(401).json({ error: 'Bad signature' })
    } catch {
      return res.status(401).json({ error: 'Signature verification failed' })
    }
  }

  let body
  try {
    body = JSON.parse(rawBody.toString())
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' })
  }

  // Discord ping
  if (body.type === 1) return res.json({ type: 1 })

  // Button component interaction
  if (body.type === 3) {
    const customId = body.data?.custom_id || ''

    if (customId.startsWith('rsvp:')) {
      // Format: rsvp:{cardId}:{memberId}:{accepted|declined}
      const parts = customId.split(':')
      if (parts.length === 4) {
        const [, cardId, memberId, response] = parts
        if (!rsvpStore[cardId]) rsvpStore[cardId] = {}
        rsvpStore[cardId][memberId] = response

        const message = response === 'accepted'
          ? 'You are confirmed for this recording!'
          : 'Got it — you will not be attending this recording.'

        return res.json({
          type: 4,
          data: { content: message, flags: 64 },  // 64 = ephemeral (only visible to the user)
        })
      }
    }
  }

  // Default acknowledge
  res.json({ type: 1 })
})

app.listen(PORT, () => {
  console.log(`Strata proxy running on :${PORT}`)
  console.log(`  Bot token: ${BOT_TOKEN ? 'set' : 'MISSING'}`)
  console.log(`  Client ID: ${CLIENT_ID || 'MISSING'}`)
  console.log(`  Public key: ${PUBLIC_KEY ? 'set' : 'not set'}`)
  console.log(`  Frontend URL: ${FRONTEND_URL}`)
})
