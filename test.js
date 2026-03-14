require('dotenv').config();

const { runDebate } = require('./engine/debate');
const { runStressTest } = require('./engine/stress-test');
const { generateReport } = require('./engine/report');

const PROPOSAL = `用 AI 幫台灣中小企業自動生成月度財務報告，從銀行對帳單和發票自動分類記帳，月費 $30 美元。

目標市場：台灣 150 萬家中小企業
產品：SaaS 平台，上傳銀行對帳單 + 電子發票，自動分類記帳，生成月度報表
商業模式：月訂閱制 $30/月，進階版 $80/月含稅務申報
差異化：整合台灣電子發票系統 + 繁體中文介面 + 在地法規
資源：3 人技術團隊，1 位會計師顧問`;

async function main() {
  const startTime = Date.now();

  console.log('='.repeat(60));
  console.log('CyberGavel Arena — 測試流程');
  console.log('='.repeat(60));
  console.log();

  // Phase 1: Debate
  console.log('>>> Phase 1: 深度辯論 (3 場 × 5 回合)');
  console.log();

  const debateResult = await runDebate(PROPOSAL, {
    onProgress: (event) => {
      if (event.type === 'round') {
        console.log(`  [Session ${event.session}] Round ${event.round} — ${event.role} (${event.model})`);
      } else if (event.type === 'session_done') {
        console.log(`  [Session ${event.session}] Done!`);
      } else if (event.type === 'extracting_assumptions') {
        console.log('  Extracting assumptions...');
      } else if (event.type === 'phase1_done') {
        console.log(`  Phase 1 complete: ${event.assumptionCount} assumptions`);
      }
    },
  });

  console.log();
  console.log('Assumptions:');
  debateResult.assumptions.forEach((a, i) => console.log(`  ${i + 1}. ${a}`));
  console.log();

  // Phase 2: Stress Test (use 10 per assumption for testing)
  console.log('>>> Phase 2: 壓力測試');
  console.log(`  ${debateResult.assumptions.length} assumptions × 10 tests = ${debateResult.assumptions.length * 10} total`);
  console.log();

  const stressResult = await runStressTest(debateResult.assumptions, {
    testsPerAssumption: 10, // Use 10 for testing, 100 for production
    concurrency: 5,
    onProgress: (event) => {
      if (event.type === 'phase2_progress' && event.current % 20 === 0) {
        console.log(`  Progress: ${event.current}/${event.total} (${event.passes} pass, ${event.fails} fail)`);
      }
    },
  });

  console.log();

  // Phase 3: Report
  console.log('>>> Phase 3: 生成報告');
  console.log();

  const report = await generateReport(debateResult, stressResult, PROPOSAL, startTime);

  console.log();
  console.log('='.repeat(60));
  console.log('REPORT');
  console.log('='.repeat(60));
  console.log();
  console.log(`Survival Score: ${report.survivalScore}/100`);
  console.log();
  console.log('Radar:');
  Object.entries(report.radar).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log();
  console.log('Top Risks:');
  report.topRisks.forEach((r, i) => console.log(`  ${i + 1}. [${Math.round(r.passRate * 100)}%] ${r.assumption}`));
  console.log();
  if (report.moat) {
    console.log(`Moat: [${Math.round(report.moat.passRate * 100)}%] ${report.moat.assumption}`);
  }
  console.log();
  console.log('Debate Summary:');
  report.debateSummary.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log();

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`Total time: ${elapsed}s`);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
