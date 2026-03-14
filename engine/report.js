const { getLLM } = require('../llm');

const DIMENSIONS = ['market', 'tech', 'finance', 'legal', 'competition', 'team'];
const DIM_LABELS = {
  market: 'Market Demand',
  tech: 'Tech Feasibility',
  finance: 'Financial Model',
  legal: 'Regulatory Risk',
  competition: 'Competitive Moat',
  team: 'Team Execution',
};

// Use Claude to classify assumptions into 6 dimensions
async function classifyAssumptions(assumptions) {
  const claude = getLLM('claude');
  const list = assumptions.map((a, i) => `${i + 1}. ${a}`).join('\n');

  const response = await claude.chat(
    'You are a business analysis expert.',
    `Classify the following assumptions into six dimensions: market (Market Demand), tech (Tech Feasibility), finance (Financial Model), legal (Regulatory Risk), competition (Competitive Moat), team (Team Execution).\n\n${list}\n\nRespond in JSON format where keys are assumption numbers (starting from 1) and values are dimension names. Example:\n{"1": "market", "2": "tech", "3": "finance"}\n\nRespond with JSON only, no other text.`,
    { max_tokens: 500 }
  );

  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const mapping = {};
      for (const [key, dim] of Object.entries(parsed)) {
        const idx = parseInt(key) - 1;
        if (idx >= 0 && idx < assumptions.length && DIMENSIONS.includes(dim)) {
          mapping[idx] = dim;
        }
      }
      return mapping;
    }
  } catch (e) {
    console.error('[report] Failed to parse classification:', e.message);
  }

  // Fallback: distribute evenly
  const mapping = {};
  assumptions.forEach((_, i) => {
    mapping[i] = DIMENSIONS[i % DIMENSIONS.length];
  });
  return mapping;
}

// Generate debate summary
async function generateDebateSummary(debates) {
  const claude = getLLM('claude');

  const debateTexts = debates
    .filter(d => !d.error)
    .map((d, i) => {
      const roundTexts = d.rounds.map(r =>
        `[${r.role.toUpperCase()} - ${r.model}] ${r.content.slice(0, 300)}...`
      ).join('\n');
      return `[Session ${i + 1} Debate]\n${roundTexts}`;
    })
    .join('\n\n');

  const response = await claude.chat(
    'You are an expert at summarizing meeting notes and debates.',
    `Here are the transcripts of three debate sessions:\n\n${debateTexts}\n\nPlease summarize the key conclusions and turning points in 3-5 bullet points. One sentence per bullet point.\n\nRespond in JSON format:\n{"summary": ["Point 1", "Point 2", ...]}\n\nRespond with JSON only.`,
    { max_tokens: 500 }
  );

  try {
    const jsonMatch = response.match(/\{[\s\S]*"summary"[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]).summary || [];
    }
  } catch (e) {
    console.error('[report] Failed to parse debate summary:', e.message);
  }

  return ['Debate summary generation failed'];
}

// Main report generation
async function generateReport(debateResult, stressTestResult, proposal, startTime) {
  console.log('[report] Generating report...');

  const { assumptions } = debateResult;
  const { results: stressResults } = stressTestResult;

  // 1. Classify assumptions into dimensions
  let dimMapping;
  try {
    dimMapping = await classifyAssumptions(assumptions);
  } catch (e) {
    console.error('[report] Classification failed, using fallback:', e.message);
    dimMapping = {};
    assumptions.forEach((_, i) => {
      dimMapping[i] = DIMENSIONS[i % DIMENSIONS.length];
    });
  }

  // 2. Build assumption details with dimensions
  const assumptionDetails = stressResults.map((sr, i) => ({
    text: sr.assumption,
    passRate: sr.passRate,
    dimension: dimMapping[i] || 'market',
    topPassReasons: sr.passReasons.map(r => r.reason),
    topFailReasons: sr.failReasons.map(r => r.reason),
    pass: sr.pass,
    fail: sr.fail,
  }));

  // 3. Calculate radar scores (average passRate per dimension)
  const radar = {};
  for (const dim of DIMENSIONS) {
    const dimAssumptions = assumptionDetails.filter(a => a.dimension === dim);
    if (dimAssumptions.length > 0) {
      const avg = dimAssumptions.reduce((sum, a) => sum + a.passRate, 0) / dimAssumptions.length;
      radar[dim] = Math.round(avg * 100);
    } else {
      radar[dim] = 50;
    }
  }

  // 4. Survival score (weighted average of all passRates)
  const survivalScore = stressResults.length > 0
    ? Math.round(stressResults.reduce((sum, r) => sum + r.passRate, 0) / stressResults.length * 100)
    : 0;

  // 5. Top 3 risks (lowest passRate)
  const sorted = [...assumptionDetails].sort((a, b) => a.passRate - b.passRate);
  const topRisks = sorted.slice(0, 3).map(a => ({
    assumption: a.text,
    passRate: a.passRate,
    topFailReason: a.topFailReasons[0] || 'Unknown',
    suggestion: `Recommend deeper market validation for "${a.text.slice(0, 40)}..."`,
  }));

  // 6. Strongest moat (highest passRate)
  const moatAssumption = sorted[sorted.length - 1];
  const moat = moatAssumption ? {
    assumption: moatAssumption.text,
    passRate: moatAssumption.passRate,
    analysis: `This assumption held true in ${Math.round(moatAssumption.passRate * 100)}% of scenarios, demonstrating strong resilience`,
  } : null;

  // 7. Debate summary
  let debateSummary;
  try {
    debateSummary = await generateDebateSummary(debateResult.debates);
  } catch (e) {
    console.error('[report] Debate summary failed:', e.message);
    debateSummary = ['Debate summary generation failed'];
  }

  const duration = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;

  const report = {
    survivalScore,
    radar,
    topRisks,
    moat,
    debateSummary,
    assumptions: assumptionDetails,
    metadata: {
      totalSimulations: stressResults.reduce((sum, r) => sum + r.total, 0),
      debateRounds: 15,
      llmsUsed: ['claude', 'kimi', 'minimax'],
      durationSeconds: duration,
    },
  };

  console.log(`[report] Done. Survival score: ${survivalScore}/100`);
  return report;
}

module.exports = { generateReport, DIM_LABELS };
