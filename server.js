require('dotenv').config();
const express = require('express');
const path = require('path');
const { runDebate } = require('./engine/debate');
const { runStressTest } = require('./engine/stress-test');
const { generateReport } = require('./engine/report');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- x402 Payment Middleware ---
const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS;
const X402_NETWORK = process.env.X402_NETWORK || 'eip155:84532'; // Base Sepolia testnet
const FACILITATOR_URL = process.env.FACILITATOR_URL || 'https://x402.org/facilitator';

if (PAYMENT_ADDRESS) {
  const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
  const { HTTPFacilitatorClient } = require('@x402/core/server');
  const { ExactEvmScheme } = require('@x402/evm/exact/server');

  const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitatorClient);
  resourceServer.register(X402_NETWORK, new ExactEvmScheme());

  const routes = {
    'GET /api/analyze/:id/report': {
      accepts: {
        scheme: 'exact',
        price: '$5.00',
        network: X402_NETWORK,
        payTo: PAYMENT_ADDRESS,
        maxTimeoutSeconds: 120,
      },
      description: 'Unlock full CyberGavel Arena business validation report',
    },
  };

  app.use(paymentMiddleware(routes, resourceServer));
  console.log(`[x402] Payment protection enabled — $5 USDC on ${X402_NETWORK}`);
  console.log(`[x402] Receiving address: ${PAYMENT_ADDRESS}`);
} else {
  console.log('[x402] PAYMENT_ADDRESS not set — report endpoint is FREE (dev mode)');
}

// In-memory storage
const analyses = new Map();

// Rate limiting: 5 analyses per IP per hour
const rateLimits = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  if (!rateLimits.has(ip)) rateLimits.set(ip, []);
  const times = rateLimits.get(ip).filter(t => now - t < hour);
  rateLimits.set(ip, times);
  if (times.length >= 5) return false;
  times.push(now);
  return true;
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), analyses: analyses.size });
});

// Phase 0: Chat (proposal conversation)
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    const { getLLM } = require('./llm');
    const claude = getLLM('claude');

    // Use last user message
    const userMsg = messages.filter(m => m.role === 'user').pop();
    const context = messages.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join('\n');

    const response = await claude.chat(
      `You are a friendly startup consultant. The user is describing a business idea, and you need to help them flesh it out.
Ask only 1-2 questions at a time — keep it conversational, not like a survey.
Topics to explore: who they're selling to, how they'll sell, what makes them different, how they'll make money, what resources they have.
At the end of each reply, provide 3-4 quick-answer options in [TAG] format.
Respond in English.`,
      context,
      { max_tokens: 500 }
    );

    // Parse tags from response
    const tagRegex = /\[([^\]]+)\]/g;
    const tags = [];
    let match;
    while ((match = tagRegex.exec(response)) !== null) {
      tags.push(match[1]);
    }

    // Rough token estimate (Chinese: ~2 tokens per char)
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0) + response.length;
    const estimatedTokens = totalChars * 2;

    res.json({ response, tags, estimatedTokens });
  } catch (err) {
    console.error('[chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Phase 0: Summarize conversation into structured proposal
app.post('/api/chat/summarize', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    const { getLLM } = require('./llm');
    const claude = getLLM('claude');

    const context = messages.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join('\n');

    const response = await claude.chat(
      'You are a business analysis expert. Summarize the conversation into a structured proposal.',
      `Here is the conversation between the user and AI:\n\n${context}\n\nPlease summarize into a structured proposal using the following JSON format:\n{"oneLiner": "One-sentence description", "market": "Target market and audience", "product": "Product/service description", "businessModel": "Business model and pricing", "differentiation": "Competitive differentiator", "resources": "Known resources and constraints"}\n\nRespond with JSON only.`,
      { max_tokens: 800 }
    );

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        res.json(JSON.parse(jsonMatch[0]));
        return;
      }
    } catch (e) {}

    res.json({ oneLiner: response.slice(0, 100), market: '', product: '', businessModel: '', differentiation: '', resources: '' });
  } catch (err) {
    console.error('[summarize]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Start analysis
app.post('/api/analyze', (req, res) => {
  const { proposal } = req.body;
  if (!proposal || typeof proposal !== 'string' || proposal.trim().length < 5) {
    return res.status(400).json({ error: 'proposal required (min 5 chars)' });
  }

  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit: max 5 analyses per hour' });
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const analysis = {
    id,
    proposal: proposal.trim(),
    status: 'debating',
    createdAt: Date.now(),
    startTime: Date.now(),
    phase1Progress: { current: 0, total: 15, lastMessage: '' },
    phase2Progress: { current: 0, total: 0, passes: 0, fails: 0 },
    phase3Progress: { status: 'pending' },
    pauseReason: null,
    checkpoint: null,
    debateResult: null,
    stressResult: null,
    report: null,
  };

  analyses.set(id, analysis);
  res.json({ id });

  // Run analysis in background
  runAnalysis(analysis).catch(err => {
    console.error(`[analyze] Fatal error for ${id}:`, err.message);
    analysis.status = 'error';
    analysis.pauseReason = err.message;
  });
});

async function runAnalysis(analysis) {
  const { id, proposal } = analysis;

  // Phase 1: Debate
  console.log(`[${id}] Phase 1: Starting debates...`);
  try {
    analysis.debateResult = await runDebate(proposal, {
      onProgress: (event) => {
        if (event.type === 'round') {
          analysis.phase1Progress.current++;
          analysis.phase1Progress.lastMessage = `${event.role === 'pro' ? 'PRO' : event.role === 'con' ? 'CON' : 'JUDGE'} (${event.model}) Round ${event.round}`;
        }
      },
    });
  } catch (err) {
    console.error(`[${id}] Phase 1 failed:`, err.message);
    analysis.status = 'paused';
    analysis.pauseReason = `Debate failed: ${err.message}`;
    analysis.checkpoint = 'Phase 1 debate interrupted';
    saveCheckpoint(analysis);
    return;
  }

  if (!analysis.debateResult.assumptions.length) {
    analysis.status = 'error';
    analysis.pauseReason = 'Failed to extract assumptions from debate';
    return;
  }

  // Phase 2: Stress test
  console.log(`[${id}] Phase 2: Starting stress tests...`);
  analysis.status = 'stress-testing';
  const testCount = analysis.debateResult.assumptions.length * 100;
  analysis.phase2Progress.total = testCount;

  try {
    analysis.stressResult = await runStressTest(analysis.debateResult.assumptions, {
      testsPerAssumption: 100,
      onProgress: (event) => {
        if (event.type === 'phase2_progress') {
          analysis.phase2Progress.current = event.current;
          analysis.phase2Progress.passes = event.passes;
          analysis.phase2Progress.fails = event.fails;
        }
      },
    });
  } catch (err) {
    console.error(`[${id}] Phase 2 failed:`, err.message);
    analysis.status = 'paused';
    analysis.pauseReason = `Stress test failed: ${err.message}`;
    analysis.checkpoint = `Phase 2 stress test at iteration ${analysis.phase2Progress.current}`;
    saveCheckpoint(analysis);
    return;
  }

  // Phase 3: Report generation
  console.log(`[${id}] Phase 3: Generating report...`);
  analysis.status = 'generating';
  analysis.phase3Progress.status = 'running';

  try {
    analysis.report = await generateReport(
      analysis.debateResult,
      analysis.stressResult,
      proposal,
      analysis.startTime
    );
    analysis.phase3Progress.status = 'done';
    analysis.status = 'done';
    console.log(`[${id}] Analysis complete! Score: ${analysis.report.survivalScore}/100`);
  } catch (err) {
    console.error(`[${id}] Phase 3 failed:`, err.message);
    analysis.status = 'paused';
    analysis.pauseReason = `Report generation failed: ${err.message}`;
    analysis.checkpoint = 'Phase 3 report generation interrupted';
    saveCheckpoint(analysis);
  }
}

// Save checkpoint to file
function saveCheckpoint(analysis) {
  const fs = require('fs');
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${analysis.id}-checkpoint.json`);
  fs.writeFileSync(file, JSON.stringify({
    id: analysis.id,
    proposal: analysis.proposal,
    status: analysis.status,
    pauseReason: analysis.pauseReason,
    checkpoint: analysis.checkpoint,
    phase1Progress: analysis.phase1Progress,
    phase2Progress: analysis.phase2Progress,
    debateResult: analysis.debateResult,
    stressResult: analysis.stressResult,
  }, null, 2));
  console.log(`[${analysis.id}] Checkpoint saved to ${file}`);
}

// Get analysis status (polled every 2s by frontend)
app.get('/api/analyze/:id/status', (req, res) => {
  const analysis = analyses.get(req.params.id);
  if (!analysis) return res.status(404).json({ error: 'not found' });

  res.json({
    status: analysis.status,
    phase1Progress: analysis.phase1Progress,
    phase2Progress: analysis.phase2Progress,
    phase3Progress: analysis.phase3Progress,
    pauseReason: analysis.pauseReason,
    checkpoint: analysis.checkpoint,
  });
});

// Resume from pause
app.post('/api/analyze/:id/resume', (req, res) => {
  const analysis = analyses.get(req.params.id);
  if (!analysis) return res.status(404).json({ error: 'not found' });
  if (analysis.status !== 'paused') return res.status(400).json({ error: 'not paused' });

  analysis.status = analysis.debateResult ? 'stress-testing' : 'debating';
  analysis.pauseReason = null;
  res.json({ status: 'resumed' });

  // Continue from checkpoint
  runAnalysis(analysis).catch(err => {
    analysis.status = 'error';
    analysis.pauseReason = err.message;
  });
});

// Get report
app.get('/api/analyze/:id/report', (req, res) => {
  const analysis = analyses.get(req.params.id);
  if (!analysis) return res.status(404).json({ error: 'not found' });
  if (analysis.status !== 'done') return res.status(400).json({ error: 'analysis not complete' });

  res.json({
    id: analysis.id,
    proposal: analysis.proposal,
    report: analysis.report,
  });
});

// PDF download (placeholder)
app.get('/api/report/:id/pdf', (req, res) => {
  const analysis = analyses.get(req.params.id);
  if (!analysis || !analysis.report) {
    return res.status(404).json({ error: 'report not found' });
  }
  // TODO: implement PDF generation
  res.status(501).json({ error: 'PDF generation not yet implemented' });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`CyberGavel Arena running on http://localhost:${PORT}`);
});
