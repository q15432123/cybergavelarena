const https = require('https');

const API_KEY = process.env.MINIMAX_API_KEY || '';
const MODEL = 'MiniMax-M2.5';

async function chat(systemPrompt, userMessage, opts = {}) {
  const maxRetries = opts.retries || 3;
  const timeout = opts.timeout || 60000;

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
  // MiniMax Anthropic-compatible API (same format as Claude)
  const body = JSON.stringify({
    model: opts.model || MODEL,
    max_tokens: opts.max_tokens || 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.minimax.io',
      path: '/anthropic/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(`Minimax API: ${json.error.message}`));
          resolve(json.content?.[0]?.text || '');
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
