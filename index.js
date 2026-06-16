const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/send-dm', async (req, res) => {
  const { token, userId, message } = req.body;
  if (!token || !userId || !message) {
    return res.status(400).json({ error: 'Missing token, userId, or message' });
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
    const msgRes = await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message })
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
