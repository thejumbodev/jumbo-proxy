const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const nacl = require('tweetnacl');

const app = express();
app.use(cors());

// We need the raw body for Discord's signature verification on /interactions,
// so capture it before express.json() parses it.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// In-memory RSVP store: { [cardId]: { [discordUserId]: 'yes' | 'no' } }
const rsvpStore = {};

// ── Discord public key for verifying interaction requests ──
// Set this in Railway's environment variables (Settings -> Variables -> DISCORD_PUBLIC_KEY)
// Found on your bot's "General Information" page in the Developer Portal.
const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;

function verifyDiscordRequest(req) {
  const signature = req.get('X-Signature-Ed25519');
  const timestamp = req.get('X-Signature-Timestamp');
  if (!signature || !timestamp || !DISCORD_PUBLIC_KEY) return false;
  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + req.rawBody),
      Buffer.from(signature, 'hex'),
      Buffer.from(DISCORD_PUBLIC_KEY, 'hex')
    );
  } catch (e) { return false; }
}

// ── Send a recording invite DM with an embed + yes/no buttons ──
app.post('/send-invite', async (req, res) => {
  const { token, userId, cardId, channelName, title, unixTimestamp } = req.body;
  if (!token || !userId || !cardId || !title || !unixTimestamp) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: userId })
    });
    if (!dmRes.ok) {
      const err = await dmRes.json();
      return res.status(dmRes.status).json({ error: err });
    }
    const dm = await dmRes.json();

    const payload = {
      embeds: [{
        title: '🎬 Recording invite',
        description: `**${title}**${channelName ? `\nChannel: ${channelName}` : ''}`,
        color: 0x7c6af7,
        fields: [
          { name: 'When', value: `<t:${unixTimestamp}:F>\n(<t:${unixTimestamp}:R>)` }
        ],
        footer: { text: 'Tap a button below to RSVP' }
      }],
      components: [{
        type: 1,
        components: [
          {
            type: 2,
            style: 3, // green
            label: 'Yes, I\'m in',
            custom_id: `rsvp_yes_${cardId}`
          },
          {
            type: 2,
            style: 4, // red
            label: 'No, can\'t make it',
            custom_id: `rsvp_no_${cardId}`
          }
        ]
      }]
    };

    const msgRes = await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!msgRes.ok) {
      const err = await msgRes.json();
      return res.status(msgRes.status).json({ error: err });
    }
    const msg = await msgRes.json();
    res.json({ success: true, messageId: msg.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Discord interaction webhook — fires when someone clicks a button ──
app.post('/interactions', async (req, res) => {
  if (!verifyDiscordRequest(req)) {
    return res.status(401).send('Bad request signature');
  }

  const interaction = req.body;

  // Discord PING check (required for endpoint verification)
  if (interaction.type === 1) {
    return res.json({ type: 1 });
  }

  // Button click
  if (interaction.type === 3) {
    const customId = interaction.data.custom_id; // e.g. rsvp_yes_<cardId>
    const match = customId.match(/^rsvp_(yes|no)_(.+)$/);
    if (match) {
      const [, answer, cardId] = match;
      const userId = interaction.member?.user?.id || interaction.user?.id;
      if (userId) {
        if (!rsvpStore[cardId]) rsvpStore[cardId] = {};
        rsvpStore[cardId][userId] = answer;
      }

      // Update the original message to show the response, remove buttons
      return res.json({
        type: 7, // UPDATE_MESSAGE
        data: {
          embeds: [{
            ...interaction.message.embeds[0],
            color: answer === 'yes' ? 0x3ecf8e : 0xf06a6a,
            footer: { text: answer === 'yes' ? "You're in! See you there." : "Got it, marked as not attending." }
          }],
          components: []
        }
      });
    }
  }

  res.json({ type: 4, data: { content: 'Unrecognized interaction.' } });
});

// ── Site polls this to pick up RSVP changes ──
app.get('/rsvp-status', (req, res) => {
  const cardIds = (req.query.cardIds || '').split(',').filter(Boolean);
  const result = {};
  cardIds.forEach(id => { result[id] = rsvpStore[id] || {}; });
  res.json(result);
});

// ── Ping everyone who said yes, in the #alerts channel ──
app.post('/ping-alerts', async (req, res) => {
  const { token, channelId, userIds, title } = req.body;
  if (!token || !channelId || !userIds || !userIds.length) {
    return res.status(400).json({ error: 'Missing token, channelId, or userIds' });
  }
  try {
    const mentions = userIds.map(id => `<@${id}>`).join(' ');
    const msgRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `📣 ${mentions} — recording for **${title}** is starting now!`,
        allowed_mentions: { parse: ['users'] }
      })
    });
    if (!msgRes.ok) {
      const err = await msgRes.json();
      return res.status(msgRes.status).json({ error: err });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('Jumbo proxy running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
