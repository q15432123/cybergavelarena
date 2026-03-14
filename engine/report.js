const { getLLM } = require('../llm');

const DIMENSIONS = ['market', 'tech', 'finance', 'legal', 'competition', 'team'];
const DIM_LABELS = {
  market: '市場需求',
  tech: '技術可行性',
  finance: '財務模型',
  legal: '法規風險',
  competition: '競爭壁壘',
  team: '團隊執行力',
};

// Use Claude to classify assumptions into 6 dimensions
async function classifyAssumptions(assumptions) {
  const claude = getLLM('claude');
  const list = assumptions.map((a, i) => `${i + 1}. ${a}`).join('\n');

  const response = await claude.chat(
    '你是一個商業分析專家。',
    `把以下假設分類到六個維度：market（市場需求）、tech（技術可行性）、finance（財務模型）、legal（法規風險）、competition（競爭壁壘）、team（團隊執行力）。\n\n${list}\n\n用 JSON 格式回覆，key 是假設的序號（從 1 開始），value 是維度名稱。例如：\n{"1": "market", "2": "tech", "3": "finance"}\n\n只回覆 JSON，不要其他文字。`,
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

// Generate debate summary using Claude
async function generateDebateSummary(debates) {
  const claude = getLLM('claude');

  const debateTexts = debates
    .filter(d => !d.error)
    .map((d, i) => {
      const roundTexts = d.rounds.map(r =>
        `[${r.role.toUpperCase()} - ${r.model}] ${r.content.slice(0, 300)}...`
      ).join('\n');
      return `【第 ${i + 1} 場辯論】\n${roundTexts}`;
    })
    .join('\n\n');

  const response = await claude.chat(
    '你是一個會議記錄摘要專家。',
    `以下是三場辯論的記錄：\n\n${debateTexts}\n\n請用 3-5 個要點總結辯論的關鍵結論和轉折點。每個要點一句話。\n\n用 JSON 格式回覆：\n{"summary": ["要點1", "要點2", ...]}\n\n只回覆 JSON。`,
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

  return ['辯論摘要生成失敗'];
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
      radar[dim] = 50; // default if no assumptions in this dimension
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
    topFailReason: a.topFailReasons[0] || '未知',
    suggestion: `建議針對「${a.text.slice(0, 20)}...」進行更深入的市場驗證`,
  }));

  // 6. Strongest moat (highest passRate)
  const moatAssumption = sorted[sorted.length - 1];
  const moat = moatAssumption ? {
    assumption: moatAssumption.text,
    passRate: moatAssumption.passRate,
    analysis: `此假設在 ${Math.round(moatAssumption.passRate * 100)}% 的情境中成立，顯示出較強的韌性`,
  } : null;

  // 7. Debate summary
  let debateSummary;
  try {
    debateSummary = await generateDebateSummary(debateResult.debates);
  } catch (e) {
    console.error('[report] Debate summary failed:', e.message);
    debateSummary = ['辯論摘要生成失敗'];
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
