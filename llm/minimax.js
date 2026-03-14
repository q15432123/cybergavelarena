const https = require('https');

const API_KEY = process.env.MINIMAX_API_KEY || '';
const MODEL = 'abab6.5s-chat';

async function chat(systemPrompt, userMessage, opts = {}) {
  const maxRetries = opts.retries || 3;
  const timeout = opts.timeout || 30000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await _call(systemPrompt, userMessage, opts, timeout);
      return result;
    } catch (err) {
      console.log(`[minimax] attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

function _call(systemPrompt, userMessage, opts, timeout) {
  const body = JSON.stringify({
    model: opts.model || MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    max_tokens: opts.max_tokens || 4096,
    temperature: opts.temperature || 0.7,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.minimax.chat',
      path: '/v1/text/chatcompletion_v2',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.base_resp?.status_code !== 0 && json.base_resp) {
            return reject(new Error(`Minimax API: ${json.base_resp.status_msg || 'error'}`));
          }
          resolve(json.choices?.[0]?.message?.content || '');
        } catch (e) { reject(e); }
      });
    });

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('Minimax API timeout'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { chat, name: 'minimax' };
