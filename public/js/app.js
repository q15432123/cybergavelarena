// State
let currentView = 'home';
let analysisId = null;
let pollInterval = null;
let chatMessages = [];
let estimatedTokens = 0;

// --- View Management ---
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  currentView = name;
  window.scrollTo(0, 0);
}

// --- Home ---
function fillExample(el) {
  document.getElementById('proposal-input').value = el.textContent;
}

async function startAnalysis() {
  const input = document.getElementById('proposal-input').value.trim();
  if (!input) return;

  // If input is short (< 50 chars), go to chat for Phase 0
  if (input.length < 50) {
    chatMessages = [{ role: 'user', content: input }];
    showView('chat');
    await sendChatToServer();
    return;
  }

  // Otherwise go directly to analysis
  await submitProposal(input);
}

// --- Chat (Phase 0) ---
function renderChat() {
  const container = document.getElementById('chat-messages');
  container.innerHTML = chatMessages.map(m => `
    <div class="msg msg-${m.role === 'user' ? 'user' : 'ai'}">
      <div class="msg-bubble">${escapeHtml(m.content)}</div>
    </div>
  `).join('');
  container.scrollTop = container.scrollHeight;

  // Update token bar
  const fill = Math.min((estimatedTokens / 5000) * 100, 100);
  document.getElementById('token-bar-fill').style.width = fill + '%';
  document.getElementById('token-count').textContent = `${Math.round(estimatedTokens).toLocaleString()} / 5,000 tokens`;
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  chatMessages.push({ role: 'user', content: text });
  input.value = '';
  renderChat();
  await sendChatToServer();
}

function selectChatTag(text) {
  chatMessages.push({ role: 'user', content: text });
  renderChat();
  sendChatToServer();
}

async function sendChatToServer() {
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatMessages }),
    });
    const data = await res.json();

    chatMessages.push({ role: 'assistant', content: data.response });
    estimatedTokens = data.estimatedTokens || 0;

    // Render quick reply tags
    const tagsEl = document.getElementById('chat-tags');
    tagsEl.innerHTML = (data.tags || []).map(t =>
      `<span class="chat-tag" onclick="selectChatTag('${escapeAttr(t)}')">${escapeHtml(t)}</span>`
    ).join('');

    renderChat();

    // Auto-stop at 5000 tokens
    if (estimatedTokens >= 4500) {
      await summarizeChat();
    }
  } catch (err) {
    console.error('Chat error:', err);
  }
}

function skipChat() {
  summarizeChat();
}

async function summarizeChat() {
  try {
    const res = await fetch('/api/chat/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatMessages }),
    });
    const data = await res.json();

    document.getElementById('f-oneliner').value = data.oneLiner || '';
    document.getElementById('f-market').value = data.market || '';
    document.getElementById('f-product').value = data.product || '';
    document.getElementById('f-businessmodel').value = data.businessModel || '';
    document.getElementById('f-diff').value = data.differentiation || '';
    document.getElementById('f-resources').value = data.resources || '';

    document.querySelector('.chat-container').classList.add('hidden');
    document.getElementById('proposal-card').classList.remove('hidden');
  } catch (err) {
    console.error('Summarize error:', err);
  }
}

function restartChat() {
  chatMessages = [];
  estimatedTokens = 0;
  document.getElementById('proposal-card').classList.add('hidden');
  document.querySelector('.chat-container').classList.remove('hidden');
  renderChat();
}

async function confirmProposal() {
  const fields = ['f-oneliner', 'f-market', 'f-product', 'f-businessmodel', 'f-diff', 'f-resources'];
  const labels = ['一句話描述', '目標市場', '產品/服務', '商業模式', '差異化優勢', '資源與限制'];
  const parts = fields.map((id, i) => {
    const val = document.getElementById(id).value.trim();
    return val ? `${labels[i]}：${val}` : '';
  }).filter(Boolean);

  await submitProposal(parts.join('\n'));
}

// --- Submit to backend ---
async function submitProposal(proposal) {
  const btn = document.getElementById('btn-start');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposal }),
    });

    if (res.status === 429) {
      alert('每小時最多 5 次分析，請稍後再試');
      if (btn) btn.disabled = false;
      return;
    }

    const data = await res.json();
    if (data.error) {
      alert(data.error);
      if (btn) btn.disabled = false;
      return;
    }

    analysisId = data.id;
    document.getElementById('progress-proposal').textContent = proposal.slice(0, 100) + (proposal.length > 100 ? '...' : '');
    showView('progress');
    startPolling();
  } catch (err) {
    alert('提交失敗：' + err.message);
    if (btn) btn.disabled = false;
  }
}

// --- Polling ---
function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(pollStatus, 2000);
  pollStatus();
}

async function pollStatus() {
  if (!analysisId) return;

  try {
    const res = await fetch(`/api/analyze/${analysisId}/status`);
    const data = await res.json();
    updateProgress(data);

    if (data.status === 'done' || data.status === 'error') {
      clearInterval(pollInterval);
    }
  } catch (err) {
    console.error('Poll error:', err);
  }
}

function updateProgress(data) {
  // Phase 1
  const p1 = data.phase1Progress;
  if (p1) {
    const pct = Math.round((p1.current / p1.total) * 100);
    document.getElementById('phase1-bar').style.width = pct + '%';
    document.getElementById('phase1-detail').textContent = p1.lastMessage || `${p1.current}/${p1.total} 回合`;

    if (p1.current >= p1.total) {
      document.getElementById('phase1-icon').textContent = '\u2705';
    }
  }

  // Phase 2
  const p2 = data.phase2Progress;
  if (p2 && p2.total > 0) {
    const pct = Math.round((p2.current / p2.total) * 100);
    document.getElementById('phase2-bar').style.width = pct + '%';
    document.getElementById('pass-count').textContent = p2.passes + ' PASS';
    document.getElementById('fail-count').textContent = p2.fails + ' FAIL';
    document.getElementById('phase2-detail').textContent = `${p2.current}/${p2.total} 測試完成`;

    if (p2.current >= p2.total) {
      document.getElementById('phase2-icon').textContent = '\u2705';
    }
  }

  // Phase 3
  if (data.phase3Progress) {
    if (data.phase3Progress.status === 'running') {
      document.getElementById('phase3-detail').textContent = '正在生成報告...';
    }
    if (data.phase3Progress.status === 'done') {
      document.getElementById('phase3-icon').textContent = '\u2705';
      document.getElementById('phase3-detail').textContent = '報告已生成';
      document.getElementById('btn-view-report').classList.remove('hidden');
    }
  }

  // Paused
  if (data.status === 'paused') {
    document.getElementById('pause-warning').classList.remove('hidden');
    document.getElementById('pause-reason').textContent = data.pauseReason || '分析暫停';
  } else {
    document.getElementById('pause-warning').classList.add('hidden');
  }

  // Status-based icons
  if (data.status === 'debating') {
    document.getElementById('phase1-icon').textContent = '\u23F3';
  } else if (data.status === 'stress-testing') {
    document.getElementById('phase2-icon').textContent = '\u23F3';
  } else if (data.status === 'generating') {
    document.getElementById('phase3-icon').textContent = '\u23F3';
  }
}

async function resumeAnalysis() {
  try {
    await fetch(`/api/analyze/${analysisId}/resume`, { method: 'POST' });
    startPolling();
  } catch (err) {
    alert('恢復失敗：' + err.message);
  }
}

// --- Report ---
async function viewReport() {
  try {
    const res = await fetch(`/api/analyze/${analysisId}/report`);
    const data = await res.json();
    renderReport(data);
    showView('report');
  } catch (err) {
    alert('載入報告失敗：' + err.message);
  }
}

function renderReport(data) {
  const report = data.report;

  // Score
  const scoreEl = document.getElementById('score-number');
  scoreEl.textContent = report.survivalScore;
  if (report.survivalScore >= 70) {
    scoreEl.style.color = '#16A34A';
  } else if (report.survivalScore >= 40) {
    scoreEl.style.color = '#EA580C';
  } else {
    scoreEl.style.color = '#DC2626';
  }

  // Radar chart
  drawRadar(report.radar);

  // Radar labels
  const dimLabels = {
    market: '市場需求', tech: '技術可行性', finance: '財務模型',
    legal: '法規風險', competition: '競爭壁壘', team: '團隊執行力'
  };
  document.getElementById('radar-labels').innerHTML = Object.entries(report.radar).map(([k, v]) =>
    `<div class="radar-label">${dimLabels[k] || k} <span>${v}</span></div>`
  ).join('');

  // Top risks
  document.getElementById('risk-cards').innerHTML = (report.topRisks || []).map(r => `
    <div class="risk-card">
      <h4>${escapeHtml(r.assumption)}</h4>
      <div class="risk-rate">存活率 ${Math.round(r.passRate * 100)}%</div>
      <p>${escapeHtml(r.topFailReason)}</p>
    </div>
  `).join('');

  // Moat
  if (report.moat) {
    document.getElementById('moat-card').innerHTML = `
      <div class="moat-card">
        <h4>${escapeHtml(report.moat.assumption)}</h4>
        <div class="moat-rate">存活率 ${Math.round(report.moat.passRate * 100)}%</div>
        <p>${escapeHtml(report.moat.analysis)}</p>
      </div>
    `;
  }

  // Assumptions table
  document.getElementById('assumptions-table').innerHTML = (report.assumptions || []).map(a => {
    const pct = Math.round(a.passRate * 100);
    const color = pct >= 70 ? '#16A34A' : pct >= 40 ? '#EA580C' : '#DC2626';
    return `
      <div class="assumption-row">
        <div class="assumption-text">${escapeHtml(a.text)}</div>
        <div class="assumption-dim">${dimLabels[a.dimension] || a.dimension}</div>
        <div class="assumption-bar-wrap">
          <div class="assumption-bar" style="width:${pct}%;background:${color}"></div>
        </div>
        <div class="assumption-rate" style="color:${color}">${pct}%</div>
      </div>
    `;
  }).join('');

  // Debate summary
  document.getElementById('debate-summary').innerHTML = (report.debateSummary || []).map(s =>
    `<div class="summary-card">${escapeHtml(s)}</div>`
  ).join('');
}

// --- Radar Chart (Canvas, no lib) ---
function drawRadar(radar) {
  const canvas = document.getElementById('radar-canvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(cx, cy) - 60;

  const dims = ['market', 'tech', 'finance', 'legal', 'competition', 'team'];
  const labels = ['市場需求', '技術可行性', '財務模型', '法規風險', '競爭壁壘', '團隊執行力'];
  const n = dims.length;

  ctx.clearRect(0, 0, w, h);

  // Draw grid (5 levels)
  for (let level = 1; level <= 5; level++) {
    const lr = (r * level) / 5;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      const x = cx + lr * Math.cos(angle);
      const y = cy + lr * Math.sin(angle);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#E5E7EB';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Draw axes
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
    ctx.strokeStyle = '#E5E7EB';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Draw data polygon
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const idx = i % n;
    const val = (radar[dims[idx]] || 0) / 100;
    const angle = (Math.PI * 2 * idx) / n - Math.PI / 2;
    const x = cx + r * val * Math.cos(angle);
    const y = cy + r * val * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.fillStyle = 'rgba(37, 99, 235, 0.15)';
  ctx.fill();
  ctx.strokeStyle = '#2563EB';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Draw data points
  for (let i = 0; i < n; i++) {
    const val = (radar[dims[i]] || 0) / 100;
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const x = cx + r * val * Math.cos(angle);
    const y = cy + r * val * Math.sin(angle);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#2563EB';
    ctx.fill();
  }

  // Draw labels
  ctx.fillStyle = '#1A1A1A';
  ctx.font = '13px Inter, sans-serif';
  ctx.textAlign = 'center';
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    let lx = cx + (r + 30) * Math.cos(angle);
    let ly = cy + (r + 30) * Math.sin(angle);
    ctx.fillText(labels[i], lx, ly + 4);
  }
}

// --- Paywall ---
function payToUnlock() {
  // For testing: directly unlock
  document.getElementById('blurred-content').classList.add('unlocked');
  document.getElementById('paywall-overlay').classList.add('hidden');
}

function downloadPDF() {
  if (!analysisId) return;
  window.open(`/api/report/${analysisId}/pdf`, '_blank');
}

// --- Utils ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// Init
showView('home');
