const fs = require('fs');
const path = require('path');
const { getLLM } = require('../llm');

// Load prompts
const PROMPTS = {};
function loadPrompt(role) {
  if (PROMPTS[role]) return PROMPTS[role];
  const fileMap = { pro: 'proposer.md', con: 'critic.md', judge: 'judge.md' };
  const filePath = path.join(__dirname, '..', 'prompts', fileMap[role]);
  PROMPTS[role] = fs.readFileSync(filePath, 'utf-8');
  return PROMPTS[role];
}

// Fixed seat arrangements for 3 sessions
const SEAT_ARRANGEMENTS = [
  { judge: 'kimi', pro: 'claude', con: 'minimax' },
  { judge: 'claude', pro: 'minimax', con: 'kimi' },
  { judge: 'minimax', pro: 'kimi', con: 'claude' },
];

// Run a single debate session (5 rounds per V2 spec)
// R1: pro gets proposal, proposes
// R2: con gets pro's argument, challenges
// R3: pro gets con's challenge, responds
// R4: con gets pro's response, attacks further
// R5: judge gets all transcript, verdicts
async function runSession(sessionIndex, proposal, onProgress) {
  const seats = SEAT_ARRANGEMENTS[sessionIndex];
  const proPrompt = loadPrompt('pro');
  const conPrompt = loadPrompt('con');
  const judgePrompt = loadPrompt('judge');

  const rounds = [];
  const notify = (msg) => {
    if (onProgress) onProgress(msg);
  };

  notify({ type: 'session_start', session: sessionIndex + 1, seats });

  try {
    // Round 1: Pro receives proposal
    notify({ type: 'round', session: sessionIndex + 1, round: 1, role: 'pro', model: seats.pro });
    const r1 = await getLLM(seats.pro).chat(
      proPrompt,
      `以下是一個創業提案，請為它辯護並提出優化方案：\n\n${proposal}`
    );
    rounds.push({ round: 1, role: 'pro', model: seats.pro, content: r1 });

    // Round 2: Con receives pro's argument
    notify({ type: 'round', session: sessionIndex + 1, round: 2, role: 'con', model: seats.con });
    const r2 = await getLLM(seats.con).chat(
      conPrompt,
      `以下是一個創業提案和正方的論述：\n\n【提案】\n${proposal}\n\n【正方論述】\n${r1}\n\n請提出你的質疑和反駁。`
    );
    rounds.push({ round: 2, role: 'con', model: seats.con, content: r2 });

    // Round 3: Pro responds to con's challenge
    notify({ type: 'round', session: sessionIndex + 1, round: 3, role: 'pro', model: seats.pro });
    const r3 = await getLLM(seats.pro).chat(
      proPrompt,
      `以下是辯論進展：\n\n【提案】\n${proposal}\n\n【你的第一輪論述】\n${r1}\n\n【反方質疑】\n${r2}\n\n請回應反方的質疑並強化你的論點。`
    );
    rounds.push({ round: 3, role: 'pro', model: seats.pro, content: r3 });

    // Round 4: Con attacks further
    notify({ type: 'round', session: sessionIndex + 1, round: 4, role: 'con', model: seats.con });
    const r4 = await getLLM(seats.con).chat(
      conPrompt,
      `以下是辯論進展：\n\n【提案】\n${proposal}\n\n【正方第一輪】\n${r1}\n\n【你的第一輪質疑】\n${r2}\n\n【正方回應】\n${r3}\n\n請進一步攻擊正方的弱點。`
    );
    rounds.push({ round: 4, role: 'con', model: seats.con, content: r4 });

    // Round 5: Judge verdicts
    notify({ type: 'round', session: sessionIndex + 1, round: 5, role: 'judge', model: seats.judge });
    const r5 = await getLLM(seats.judge).chat(
      judgePrompt,
      `以下是一場完整辯論的記錄，請做出裁決：\n\n【提案】\n${proposal}\n\n【正方第一輪】\n${r1}\n\n【反方第一輪】\n${r2}\n\n【正方第二輪】\n${r3}\n\n【反方第二輪】\n${r4}\n\n請根據評分維度給出裁決。`
    );
    rounds.push({ round: 5, role: 'judge', model: seats.judge, content: r5 });

    notify({ type: 'session_done', session: sessionIndex + 1 });

    return {
      session: sessionIndex + 1,
      seats,
      rounds,
      verdict: r5,
      error: null,
    };
  } catch (err) {
    console.error(`[debate] Session ${sessionIndex + 1} failed:`, err.message);
    notify({ type: 'session_error', session: sessionIndex + 1, error: err.message });
    return {
      session: sessionIndex + 1,
      seats,
      rounds,
      verdict: null,
      error: err.message,
    };
  }
}

// Extract assumptions using Claude Sonnet
async function extractAssumptions(verdicts, proposal) {
  const claude = getLLM('claude');
  const verdictsText = verdicts
    .filter(v => v)
    .map((v, i) => `【第 ${i + 1} 場裁決】\n${v}`)
    .join('\n\n');

  const response = await claude.chat(
    '你是一個商業分析專家。你的工作是從辯論裁決中提取核心假設。',
    `以下是三場辯論的裁決結果：\n\n${verdictsText}\n\n原始提案：\n${proposal}\n\n請從這些裁決中拆出 8-12 個此提案存活必須成立的核心假設（Critical Assumptions）。每個假設用一句話描述。\n\n請用以下 JSON 格式回覆（只回覆 JSON，不要其他文字）：\n{"assumptions": ["假設1", "假設2", ...]}`
  );

  try {
    // Try to parse JSON from response
    const jsonMatch = response.match(/\{[\s\S]*"assumptions"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.assumptions || [];
    }
  } catch (e) {
    console.error('[debate] Failed to parse assumptions JSON:', e.message);
  }

  // Fallback: split by lines
  return response
    .split('\n')
    .map(l => l.replace(/^[-*\d.]+\s*/, '').trim())
    .filter(l => l.length > 5 && l.length < 200);
}

// Main entry: run full debate phase
async function runDebate(proposal, options = {}) {
  const onProgress = options.onProgress || (() => {});

  console.log('[debate] Starting 3 parallel debate sessions...');
  onProgress({ type: 'phase1_start' });

  // Run 3 sessions in parallel
  const results = await Promise.all([
    runSession(0, proposal, onProgress),
    runSession(1, proposal, onProgress),
    runSession(2, proposal, onProgress),
  ]);

  // Collect verdicts for assumption extraction
  const verdicts = results.map(r => r.verdict);
  const validVerdicts = verdicts.filter(Boolean);

  let assumptions = [];
  if (validVerdicts.length > 0) {
    console.log('[debate] Extracting assumptions from verdicts...');
    onProgress({ type: 'extracting_assumptions' });
    try {
      assumptions = await extractAssumptions(verdicts, proposal);
    } catch (err) {
      console.error('[debate] Assumption extraction failed:', err.message);
    }
  }

  console.log(`[debate] Done. ${assumptions.length} assumptions extracted.`);
  onProgress({ type: 'phase1_done', assumptionCount: assumptions.length });

  return {
    debates: results,
    assumptions,
  };
}

module.exports = { runDebate };
