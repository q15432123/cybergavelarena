const { getLLM, randomLLM } = require('../llm');

// Scenario matrix per V2 spec
const SCENARIO_MATRIX = {
  market: ['Booming', 'Stable', 'Declining', 'Bubble', 'Black Swan'],
  competition: ['No Competition', 'Light Competition', 'Fierce Competition', 'Big Player Entry'],
  regulation: ['Supportive', 'Neutral', 'Cautious', 'Strict Regulation'],
  economy: ['Expansion', 'Peak', 'Contraction', 'Trough'],
  funding: ['Capital Abundant', 'Normal', 'Tightening', 'Funding Winter'],
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
    reason = text.replace(/^PASS\s*[|:]\s*/i, '').trim();
  } else if (upper.startsWith('FAIL')) {
    result = 'FAIL';
    reason = text.replace(/^FAIL\s*[|:]\s*/i, '').trim();
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
    const key = r.slice(0, 15);
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

  console.log(`[stress-test] Starting: ${assumptions.length} assumptions x ${testsPerAssumption} tests = ${total} total`);
  onProgress({ type: 'phase2_start', total });

  const results = [];

  for (const assumption of assumptions) {
    const testResults = [];
    const passReasons = [];
    const failReasons = [];

    const testPromises = [];
    for (let i = 0; i < testsPerAssumption; i++) {
      testPromises.push(
        limit(async () => {
          const scenario = generateScenario();
          const modelName = randomLLM();

          const prompt = `Determine whether the following business assumption holds true in this scenario.\nAssumption: ${assumption}\nScenario: Market=${scenario.market}, Competition=${scenario.competition}, Regulation=${scenario.regulation}, Economy=${scenario.economy}, Funding=${scenario.funding}\nAnswer only PASS or FAIL, followed by a one-sentence explanation.\nFormat: PASS|reason or FAIL|reason`;

          try {
            const response = await getLLM(modelName).chat(
              'You are a business scenario analyst. Determine whether a given assumption holds true in the specified scenario. Answer only PASS or FAIL with a one-sentence reason.',
              prompt,
              { max_tokens: 500, timeout: 30000, retries: 2 }
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

    console.log(`[stress-test] "${assumption.slice(0, 30)}..." -> ${pass}/${validTotal} pass (${Math.round((pass / Math.max(validTotal, 1)) * 100)}%)`);
  }

  onProgress({ type: 'phase2_done', results });
  console.log(`[stress-test] Complete. ${completed} tests, ${totalPasses} pass, ${totalFails} fail.`);

  return { results };
}

module.exports = { runStressTest, SCENARIO_MATRIX };
