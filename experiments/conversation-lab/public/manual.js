const $ = id => document.getElementById(id);
let state, plan, running = false, revision = 0;
const seconds = value => value == null ? '未取得' : (value / 1000).toFixed(2) + '秒';
const errors = {
  confirm_plan_and_fictional_profile: '送信内容をもう一度確認してください（計画の有効期限は10分です）。',
  run_in_progress: '別の実行が進行中です。完了後に試してください。',
  endpoint_mismatch: 'サーバーの送信先が対応するOpenCodeの接続先と一致していません。',
  configuration_changed: '送信設定が変わりました。送信内容をもう一度確認してください。',
  invalid_question: '質問を1〜2,000文字で入力してください。'
};
async function api(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await response.json();
  if (!response.ok) throw new Error(errors[data.error] || data.error || '処理に失敗しました');
  return data;
}
function el(tag, text, className) { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; }
function invalidate() { revision++; plan = null; $('plan-box').hidden = true; $('fictional').checked = false; $('run-button').disabled = true; }
function updateMode() { $('mode-note').textContent = state.modes.find(mode => mode.id === $('mode').value).description; invalidate(); }
function renderRecord(record) {
  const card = el('article', '', 'card');
  card.append(el('h3', record.condition + ' · ' + record.question));
  card.append(el('p', record.answer || '回答本文なし', 'answer'));
  card.append(el('p', '処理：' + record.execution.status + (record.execution.errorKind ? ' / ' + record.execution.errorKind : '')
    + ' · 待ち時間 ' + seconds(record.stage.totalMs) + ' · API ' + record.execution.apiCalls + '回', 'note'));
  card.append(el('p', '検索 ' + seconds(record.stage.retrievalMs) + ' / 生成 ' + record.stage.generationMs.map(seconds).join(', ')
    + ' / 校閲 ' + (record.stage.verificationMs.map(seconds).join(', ') || 'なし') + ' / モデルの回答区分 ' + (record.modelAnswerability || '未取得'), 'note'));
  const detail = el('details', ''); detail.append(el('summary', '使用した根拠・処理の記録'));
  detail.append(el('pre', JSON.stringify({ runId: record.runId, at: record.at, evidence: record.evidenceRefs, diagnostics: record.pipelineLog.diagnostics }, null, 2)));
  card.append(detail); return card;
}
async function loadRecords() {
  const data = await api('/api/manual/records');
  $('records').replaceChildren(...data.records.slice().reverse().map(renderRecord));
  if (!data.records.length) $('records').textContent = '手動テストはまだ実行していません。';
  $('jev-count').textContent = '保存済みの比較結果 ' + data.jev.length + '件を読む（API呼び出しなし）';
  $('jev-results').replaceChildren(...data.jev.map(record => {
    const card = el('article', '', 'card');
    card.append(el('h3', record.caseId + ' · ' + record.candidateKind + ' · ' + record.question));
    let candidate = record.structuredCandidate;
    try { candidate = JSON.parse(candidate).segments.map(segment => segment.text).join('\n'); } catch {}
    card.append(el('p', candidate, 'answer'));
    card.append(el('p', '保存時の版 ' + record.baseSha + ' / 判定定義 ' + record.judgeDefinitionHash + ' / ' + record.at, 'note'));
    card.append(el('p', '現行校閲：' + record.current.executionStatus + ' / ' + (record.current.verdict || '判定なし')
      + ' / ' + seconds(record.current.latencyMs) + ' / ' + (record.current.reason || record.current.errorKind || ''), 'note'));
    card.append(el('p', 'JEV：' + record.jev.executionStatus + ' / ' + seconds(record.jev.latencyMs), 'note'));
    card.append(el('pre', Object.entries(record.jev.answers || {}).map(([name, value]) => name + '：確率 ' + (value.probability ?? '未取得') + ' / confidence ' + (value.confidence ?? '未取得')).join('\n')));
    card.append(el('p', [...(record.implementationNote || []), ...(record.notes || [])].join('\n'), 'note'));
    return card;
  }));
}
$('preset').onchange = () => {
  const preset = state.cases.find(item => item.id === $('preset').value);
  if (preset) $('question').value = preset.question;
  $('history-box').hidden = !preset?.history.length;
  $('history').textContent = preset?.history.map(turn => (turn.role === 'user' ? '質問：' : '回答：') + turn.content).join('\n') || '';
  invalidate();
};
$('question').oninput = invalidate;
$('mode').onchange = updateMode;
$('fictional').onchange = () => { $('run-button').disabled = !plan || running || !$('fictional').checked; };
$('plan-button').onclick = async () => {
  invalidate(); $('status').textContent = '送信内容を確認しています…';
  const requestedRevision = revision;
  try {
    const data = await api('/api/manual/plan', { question: $('question').value, mode: $('mode').value, caseId: $('preset').value });
    if (requestedRevision !== revision || running) return;
    plan = data.plan;
    $('plan-summary').textContent = '対象：架空のミナトさん / ' + plan.mode + ' / 送信先 ' + plan.endpoint + '/chat/completions / モデル ' + plan.model
      + ' / API最大' + plan.maxCalls + '回（エラーを含む） / 上限60秒 / JEV 0回';
    $('plan-input').textContent = plan.item.history.map(turn => turn.role + ': ' + turn.content).concat('今回の質問：' + plan.item.question).join('\n');
    $('plan-box').hidden = false; $('status').textContent = 'まだ送信していません。確認後に実行できます。';
  } catch (error) { if (requestedRevision === revision) $('status').textContent = error.message; }
};
$('run-button').onclick = async () => {
  if (!plan || running || !$('fictional').checked) return;
  const id = plan.id; plan = null; running = true; revision++;
  for (const name of ['preset', 'question', 'mode', 'plan-button', 'run-button', 'fictional']) $(name).disabled = true;
  $('abort-button').disabled = false;
  const started = Date.now();
  const timer = setInterval(() => { $('status').textContent = '回答を待っています… ' + seconds(Date.now() - started); }, 200);
  try {
    const data = await api('/api/manual/run', { planId: id, fictionalOnly: true });
    clearInterval(timer);
    $('result').replaceChildren(renderRecord(data.record)); $('result-box').hidden = false;
    $('status').textContent = data.record.execution.status === 'ok' ? '完了しました。続ける場合は送信内容を確認してください。' : '処理は完了しましたが、エラーがあります。結果を確認してください。';
    await loadRecords();
  } catch (error) { clearInterval(timer); $('status').textContent = error.message; }
  finally {
    clearInterval(timer); running = false;
    for (const name of ['preset', 'question', 'mode', 'plan-button', 'fictional']) $(name).disabled = false;
    $('abort-button').disabled = true; $('run-button').disabled = true;
  }
};
$('abort-button').onclick = async () => { await api('/api/abort', {}); $('status').textContent = '中止しています…'; };
$('reload').onclick = () => loadRecords().catch(error => { $('status').textContent = error.message; });
(async () => {
  try {
    state = await api('/api/manual/state');
    $('connection').textContent = 'ローカル限定 · ' + state.profile + ' · ' + state.model + ' · APIキー ' + (state.keyConfigured ? '設定済み' : '未設定');
    state.modes.forEach(mode => { const option = el('option', mode.label); option.value = mode.id; $('mode').append(option); });
    state.cases.forEach(item => { const option = el('option', item.id + '：' + item.question); option.value = item.id; $('preset').append(option); });
    $('documents').replaceChildren(...state.documents.map(doc => { const details = el('details', ''); details.append(el('summary', doc.title), el('pre', doc.content)); return details; }));
    updateMode(); await loadRecords();
    if (!state.keyConfigured) { $('plan-button').disabled = true; $('status').textContent = 'サーバーのAPIキーが未設定です。'; }
  } catch (error) { $('status').textContent = '読み込み失敗：' + error.message; }
})();
