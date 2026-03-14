const { getLLM, randomLLM } = require('../llm');

// Scenario matrix per V2 spec
const SCENARIO_MATRIX = {
  market: ['繁榮', '穩定', '衰退', '泡沫', '黑天鵝'],
  competition: ['無競爭', '少量競爭', '激烈競爭', '巨頭進場'],
  regulation: ['鼓勵', '中立', '觀望', '嚴格管制'],
  economy: ['擴張期', '頂峰', '收縮期', '谷底'],
  funding: ['資金充裕', '正常', '緊縮', '融資寒冬'],
};

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateScenario() {
  return {
    market: randomPick(SCENARIO_MATRIX.market),
    competition: randomPick(SCENARIO_MATRIX.competition),
    regulation: randomPick(SCENARIO_MATRIX.regulation),
    economy: randomPick(SCENARIO_MATRIX.economy),
    funding: randomPick(SCENARIO_MATRIX.funding),
  };
}

// Simple concurrency limiter
function createLimiter(concurrency) {
  let running = 0;
  const queue = [];

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        running++;
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        } finally {
          running--;
          if (queue.length > 0) queue.shift()();
        }
      };

      if (running < concurrency) {
        run();
      } else {
        queue.push(run);
      }
    });
  };
}

// Parse PASS/FAIL from LLM response
function parseResult(response) {
  const text = response.trim();
  const upper = text.toUpperCase();

  let result = 'ERROR';
  let reason = text;

  if (upper.startsWith('PASS')) {
    result = 'PASS';
    reason = text.replace(/^PASS\s*[|:：]\s*/i, '').trim();
  } else if (upper.startsWith('FAIL')) {
    result = 'FAIL';
    reason = text.replace(/^FAIL\s*[|:：]\s*/i, '').trim();
  } else if (upper.includes('PASS')) {
    result = 'PASS';
    reason = text;
  } else if (upper.includes('FAIL')) {
    result = 'FAIL';
    reason = text;
  }

  return { result, reason: reason.slice(0, 200) };
}

// Aggregate similar reasons by simple prefix matching
function aggregateReasons(reasons) {
  const groups = new Map();

  for (const r of reasons) {
    const key = r.slice(0, 15); // rough grouping by prefix
    if (groups.has(key)) {
      groups.get(key).count++;
    } else {
      groups.set(key, { reason: r, count: 1 });
    }
  }

  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

// Run stress test for all assumptions
async function runStressTest(assumptions, options = {}) {
  const testsPerAssumption = options.testsPerAssumption || 100;
  const onProgress = options.onProgress || (() => {});
  const maxConcurrency = options.concurrency || 10;

  const limit = createLimiter(maxConcurrency);
  const total = assumptions.length * testsPerAssumption;
  let completed = 0;
  let totalPasses = 0;
  let totalFails = 0;

  console.log(`[stress-test] Starting: ${assumptions.length} assumptions × ${testsPerAssumption} tests = ${total} total`);
  onProgress({ type: 'phase2_start', total });

  const results = [];

  for (const assumption of assumptions) {
    const testResults = [];
    const passReasons = [];
    const failReasons = [];

    // Create all test promises for this assumption
    const testPromises = [];
    for (let i = 0; i < testsPerAssumption; i++) {
      testPromises.push(
        limit(async () => {
          const scenario = generateScenario();
          const modelName = randomLLM();

          const prompt = `判斷以下創業假設在此情境下是否成立。\n假設：${assumption}\n情境：市場=${scenario.market}, 競爭=${scenario.competition}, 法規=${scenario.regulation}, 經濟=${scenario.economy}, 資金=${scenario.funding}\n只回答 PASS 或 FAIL，然後用一句話說明原因。\n格式：PASS|原因 或 FAIL|原因`;

          try {
            const response = await getLLM(modelName).chat(
              '你是一個商業情境分析師。根據給定情境判斷假設是否成立。只回答 PASS 或 FAIL 加一句原因。',
              prompt,
              { max_tokens: 100, timeout: 15000, retries: 2 }
            );

            const { result, reason } = parseResult(response);
            testResults.push({ result, reason, model: modelName, scenario });

            if (result === 'PASS') {
              passReasons.push(reason);
              totalPasses++;
            } else if (result === 'FAIL') {
              failReasons.push(reason);
              totalFails++;
            }
          } catch (err) {
            console.log(`[stress-test] Test failed for "${assumption.slice(0, 30)}...": ${err.message}`);
            testResults.push({ result: 'ERROR', reason: err.message, model: modelName, scenario });
          }

          completed++;
          if (completed % 10 === 0 || completed === total) {
            onProgress({
              type: 'phase2_progress',
              current: completed,
              total,
              passes: totalPasses,
              fails: totalFails,
            });
          }
        })
      );
    }

    await Promise.all(testPromises);

    const pass = testResults.filter(t => t.result === 'PASS').length;
    const fail = testResults.filter(t => t.result === 'FAIL').length;
    const errors = testResults.filter(t => t.result === 'ERROR').length;
    const validTotal = pass + fail;

    results.push({
      assumption,
      total: testsPerAssumption,
      pass,
      fail,
      errors,
      passRate: validTotal > 0 ? pass / validTotal : 0,
      failReasons: aggregateReasons(failReasons),
      passReasons: aggregateReasons(passReasons),
    });

    console.log(`[stress-test] "${assumption.slice(0, 30)}..." → ${pass}/${validTotal} pass (${Math.round((pass / Math.max(validTotal, 1)) * 100)}%)`);
  }

  onProgress({ type: 'phase2_done', results });
  console.log(`[stress-test] Complete. ${completed} tests, ${totalPasses} pass, ${totalFails} fail.`);

  return { results };
}

module.exports = { runStressTest, SCENARIO_MATRIX };
