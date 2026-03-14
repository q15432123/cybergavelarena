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
      `Here is a business proposal. Please defend it and suggest improvements:\n\n${proposal}`
    );
    rounds.push({ round: 1, role: 'pro', model: seats.pro, content: r1 });

    // Round 2: Con receives pro's argument
    notify({ type: 'round', session: sessionIndex + 1, round: 2, role: 'con', model: seats.con });
    const r2 = await getLLM(seats.con).chat(
      conPrompt,
      `Here is a business proposal and the PRO side's argument:\n\n[PROPOSAL]\n${proposal}\n\n[PRO ARGUMENT]\n${r1}\n\nPlease present your challenges and rebuttals.`
    );
    rounds.push({ round: 2, role: 'con', model: seats.con, content: r2 });

    // Round 3: Pro responds to con's challenge
    notify({ type: 'round', session: sessionIndex + 1, round: 3, role: 'pro', model: seats.pro });
    const r3 = await getLLM(seats.pro).chat(
      proPrompt,
      `Here is the debate progress:\n\n[PROPOSAL]\n${proposal}\n\n[YOUR ROUND 1 ARGUMENT]\n${r1}\n\n[CON CHALLENGE]\n${r2}\n\nPlease respond to the CON side's challenges and strengthen your argument.`
    );
    rounds.push({ round: 3, role: 'pro', model: seats.pro, content: r3 });

    // Round 4: Con attacks further
    notify({ type: 'round', session: sessionIndex + 1, round: 4, role: 'con', model: seats.con });
    const r4 = await getLLM(seats.con).chat(
      conPrompt,
      `Here is the debate progress:\n\n[PROPOSAL]\n${proposal}\n\n[PRO ROUND 1]\n${r1}\n\n[YOUR ROUND 1 CHALLENGE]\n${r2}\n\n[PRO RESPONSE]\n${r3}\n\nPlease further attack the PRO side's weaknesses.`
    );
    rounds.push({ round: 4, role: 'con', model: seats.con, content: r4 });

    // Round 5: Judge verdicts
    notify({ type: 'round', session: sessionIndex + 1, round: 5, role: 'judge', model: seats.judge });
    const r5 = await getLLM(seats.judge).chat(
      judgePrompt,
      `Here is the complete debate transcript. Please deliver your verdict:\n\n[PROPOSAL]\n${proposal}\n\n[PRO ROUND 1]\n${r1}\n\n[CON ROUND 1]\n${r2}\n\n[PRO ROUND 2]\n${r3}\n\n[CON ROUND 2]\n${r4}\n\nPlease score according to the evaluation dimensions and deliver your verdict.`
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

// Extract assumptions using Claude
async function extractAssumptions(verdicts, proposal) {
  const claude = getLLM('claude');
  const verdictsText = verdicts
    .filter(v => v)
    .map((v, i) => `[Session ${i + 1} Verdict]\n${v}`)
    .join('\n\n');

  const response = await claude.chat(
    'You are a business analysis expert. Your job is to extract critical assumptions from debate verdicts.',
    `Here are the verdicts from three debate sessions:\n\n${verdictsText}\n\nOriginal proposal:\n${proposal}\n\nPlease extract 8-12 critical assumptions that must hold true for this proposal to survive. Describe each assumption in one sentence.\n\nRespond in the following JSON format (JSON only, no other text):\n{"assumptions": ["Assumption 1", "Assumption 2", ...]}`
  );

  try {
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
