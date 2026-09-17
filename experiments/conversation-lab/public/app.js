"use strict";
// 画面側。APIキーは受け取らない。送信先・モデルはサーバー設定を表示するだけ。
var state = { data: null, selected: {}, overrides: {}, running: false };

function $(id) { return document.getElementById(id); }

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function api(path, body) {
  var options = body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  };
  var response = await fetch(path, options);
  if (!response.ok) {
    var detail = "";
    try { detail = (await response.json()).error || ""; } catch (error) { detail = ""; }
    throw new Error(detail || ("HTTP " + response.status));
  }
  return response.json();
}

function caseById(id) {
  return state.data.cases.filter(function (item) { return item.id === id; })[0];
}

function evidenceById(id) {
  return state.data.evidence.filter(function (item) { return item.id === id; })[0];
}

function overrideFor(id) {
  if (!state.overrides[id]) {
    var item = caseById(id);
    state.overrides[id] = { question: item.question, selection: item.selection.slice() };
  }
  return state.overrides[id];
}

function selectedCases() {
  return state.data.cases.filter(function (item) { return state.selected[item.id]; }).map(function (item) {
    var override = overrideFor(item.id);
    return { caseId: item.id, question: override.question, selection: override.selection };
  });
}

function renderConfig() {
  var data = state.data;
  var lines = [];
  lines.push("送信先: " + data.baseUrl + " / モデル: " + data.model);
  lines.push("プロンプト版: " + data.promptVersion + " / 記録: " + data.recordsPath);
  lines.push("キー: " + (data.keyConfigured ? "サーバーに設定済み" : "未設定（Aモードは動きません）"));
  lines.push("Jev: " + data.jev.status + "（" + data.jev.note + "）");
  lines.push("1回の実行上限: " + data.maxCasesPerRun + "件");
  $("config-line").textContent = lines.join(" / ");
  $("model").value = data.model;
  var select = $("mode");
  select.innerHTML = data.modes.map(function (mode) {
    return "<option value=\"" + esc(mode.id) + "\"" + (mode.ready ? "" : " disabled") + ">"
      + esc(mode.label) + (mode.ready ? "" : "（未実装）") + "</option>";
  }).join("");
  $("mode").value = "A";
}

function renderCases() {
  var html = state.data.cases.map(function (item) {
    var override = overrideFor(item.id);
    var evidence = state.data.evidence.map(function (unit) {
      var checked = override.selection.indexOf(unit.id) >= 0 ? " checked" : "";
      var flags = [];
      if (unit.approval !== "approved") flags.push(unit.approval);
      if (unit.visibility !== "public") flags.push(unit.visibility);
      if (unit.subjectId && unit.subjectId !== state.data.subjectId) flags.push("別の人物");
      return "<label><input type=\"checkbox\" data-case=\"" + esc(item.id) + "\" data-evidence=\"" + esc(unit.id) + "\""
        + checked + "> <span>" + esc(unit.id) + " " + esc(unit.text)
        + (flags.length ? " <span class=\"badge ng\">" + esc(flags.join("/")) + "</span>" : "") + "</span></label>";
    }).join("");
    var gold = "<div class=\"gold\">合格の要点: " + esc(item.gold.mustInclude.join(" / "))
      + "<br>禁止: " + esc(item.gold.mustNot.join(" / "))
      + (item.gold.allowedLimitation ? "<br>許される限定: " + esc(item.gold.allowedLimitation) : "") + "</div>";
    return "<div class=\"card" + (state.selected[item.id] ? " selected" : "") + "\" id=\"card-" + esc(item.id) + "\">"
      + "<div class=\"card-head\"><label><input type=\"checkbox\" data-case-select=\"" + esc(item.id) + "\""
      + (state.selected[item.id] ? " checked" : "") + "> <strong>" + esc(item.id) + "</strong></label>"
      + "<span class=\"badge\">履歴: " + esc(item.historyId || "なし") + "</span>"
      + (item.simulate ? "<span class=\"badge ng\">配線確認（タイムアウト）</span>" : "")
      + "<span class=\"badge\" id=\"plan-" + esc(item.id) + "\"></span></div>"
      + "<textarea data-case-question=\"" + esc(item.id) + "\" rows=\"2\">" + esc(override.question) + "</textarea>"
      + "<div class=\"evidence\">" + evidence + "</div>" + gold + "</div>";
  }).join("");
  $("case-list").innerHTML = html;
  $("case-count").textContent = Object.keys(state.selected).filter(function (id) { return state.selected[id]; }).length + "件を選択中";
}

function renderPlan(plans, apiCalls, model, baseUrl) {
  $("plan-box").hidden = false;
  $("plan-summary").textContent = "送信先: " + baseUrl + " / モデル: " + model + " / API呼び出し: " + apiCalls
    + "件（1ケース1回。検索・校閲・修復は行わない）";
  $("plan-body").innerHTML = plans.map(function (plan) {
    var excluded = plan.excluded.map(function (entry) { return entry.id + "(" + entry.reason + ")"; }).join(", ");
    return "<tr><td>" + esc(plan.caseId) + "</td><td class=\"mono\">" + esc(plan.sentEvidenceIds.join(", ") || "なし")
      + "</td><td class=\"mono\">" + esc(excluded || "なし") + "</td><td>" + esc(plan.historyId || "なし")
      + "</td><td>" + esc(plan.question) + "</td><td>" + plan.apiCalls + "</td></tr>";
  }).join("");
  plans.forEach(function (plan) {
    var badge = $("plan-" + plan.caseId);
    if (!badge) return;
    var excluded = plan.excluded.length;
    badge.textContent = "送信根拠 " + plan.sentEvidenceIds.length + "件" + (excluded ? " / 除外 " + excluded + "件" : "");
    badge.className = "badge" + (excluded ? " ng" : "");
  });
}

function renderRecord(record) {
  $("results").hidden = false;
  var seconds = (record.timing.totalMs / 1000).toFixed(1);
  var usage = record.usage.inputTokens === null ? "usage未取得" : record.usage.inputTokens + "/" + record.usage.outputTokens;
  var labelOptions = function (name) {
    return ["?", "ok", "ng"].map(function (value) {
      return "<option value=\"" + value + "\">" + name + ": " + value + "</option>";
    }).join("");
  };
  var html = "<div class=\"card\" id=\"result-" + esc(record.runId) + "\">"
    + "<div class=\"card-head\"><strong>" + esc(record.caseId) + "</strong>"
    + "<span class=\"badge " + (record.status === "ok" ? "ok" : "ng") + "\">" + esc(record.errorKind || record.status) + "</span>"
    + "<span class=\"badge\">" + seconds + "秒</span>"
    + "<span class=\"badge\">初回トークン " + (record.timing.firstTokenMs === null ? "なし" : record.timing.firstTokenMs + "ms") + "</span>"
    + "<span class=\"badge\">tokens " + usage + "</span>"
    + "<span class=\"badge\">根拠 " + esc(record.sentEvidenceIds.join(", ") || "なし") + "</span>"
    + "<span class=\"badge mono\">" + esc(record.runId.slice(0, 8)) + "</span></div>"
    + "<p class=\"answer\">" + esc(record.answer || "（回答なし）") + "</p>"
    + (record.limitations ? "<p class=\"note\">不足: " + esc(record.limitations) + "</p>" : "")
    + (record.excluded.length ? "<p class=\"note\">除外: " + esc(record.excluded.map(function (entry) { return entry.id + "(" + entry.reason + ")"; }).join(", ")) + "</p>" : "")
    + "<div class=\"row\"><select id=\"target-" + esc(record.runId) + "\">" + labelOptions("対象一致") + "</select>"
    + "<select id=\"aspect-" + esc(record.runId) + "\">" + labelOptions("項目一致") + "</select>"
    + "<select id=\"supported-" + esc(record.runId) + "\">" + labelOptions("根拠支持") + "</select>"
    + "<input id=\"notes-" + esc(record.runId) + "\" placeholder=\"メモ\" size=\"30\">"
    + "<button data-label=\"" + esc(record.runId) + "\">ラベルを保存</button>"
    + "<span class=\"note\" id=\"label-status-" + esc(record.runId) + "\"></span></div></div>";
  $("result-list").insertAdjacentHTML("afterbegin", html);
}

function renderRecords(records, summary) {
  $("records-summary").textContent = "件数 " + summary.total + "（成功 " + summary.ok + " / 失敗 "
    + JSON.stringify(summary.errors) + "） / 所要 p50 " + summary.latency.p50 + "ms・p95 " + summary.latency.p95
    + "ms / 平均トークン 入力 " + summary.usage.meanInputTokens + "・出力 " + summary.usage.meanOutputTokens
    + "（usage取得 " + summary.usage.withUsage + "件） / ラベル " + summary.labeled + "件 / API呼び出し " + summary.apiCalls;
  $("records-list").innerHTML = "<table><thead><tr><th>runId</th><th>日時</th><th>ケース</th><th>状態</th><th>ms</th><th>tokens</th><th>ラベル</th></tr></thead><tbody>"
    + records.slice().reverse().map(function (record) {
      var label = record.label ? ("対象 " + record.label.targetMatch + " / 項目 " + record.label.aspectMatch + " / 支持 " + record.label.supported) : "なし";
      return "<tr><td class=\"mono\">" + esc(record.runId.slice(0, 8)) + "</td><td>" + esc(record.at) + "</td><td>"
        + esc(record.caseId) + "</td><td>" + esc(record.errorKind || record.status) + "</td><td>" + record.timing.totalMs
        + "</td><td>" + (record.usage.inputTokens === null ? "-" : record.usage.inputTokens + "/" + record.usage.outputTokens)
        + "</td><td>" + esc(label) + "</td></tr>";
    }).join("") + "</tbody></table>";
}

async function loadState() {
  state.data = await api("/api/state");
  state.data.cases.forEach(function (item) { state.selected[item.id] = true; });
  renderConfig();
  renderCases();
}

async function doPlan() {
  $("run-status").textContent = "計画を作成中…";
  try {
    var result = await api("/api/plan", { cases: selectedCases() });
    renderPlan(result.plans, result.apiCalls, result.model, result.baseUrl);
    $("run-status").textContent = "計画を表示しました（送信していません）。";
  } catch (error) {
    $("run-status").textContent = "エラー: " + error.message;
  }
}

async function doRun() {
  var cases = selectedCases();
  if (!cases.length) { $("run-status").textContent = "ケースを選択してください。"; return; }
  state.running = true;
  $("run-button").disabled = true;
  $("abort-button").disabled = false;
  $("run-status").textContent = "実行中… 送信先 " + state.data.baseUrl + " / API呼び出し " + cases.length + "件";
  var started = Date.now();
  var timer = setInterval(function () {
    $("run-status").textContent = "実行中… " + Math.round((Date.now() - started) / 1000) + "秒 / API呼び出し " + cases.length + "件";
  }, 1000);
  try {
    var response = await fetch("/api/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cases: cases,
        model: $("model").value,
        temperature: Number($("temperature").value),
        maxTokens: Number($("max-tokens").value),
        timeoutMs: Number($("timeout-ms").value)
      })
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        var line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        var event = JSON.parse(line);
        if (event.type === "plan") renderPlan(event.plans, event.apiCalls, event.model, event.baseUrl);
        if (event.type === "record") renderRecord(event.record);
        if (event.type === "done") $("run-status").textContent = "完了しました（" + Math.round((Date.now() - started) / 1000) + "秒"
          + (event.aborted ? "・中止" : "") + "）。記録を読み込みます。";
      }
    }
    await loadRecords();
  } catch (error) {
    $("run-status").textContent = "エラー: " + error.message;
  } finally {
    clearInterval(timer);
    state.running = false;
    $("run-button").disabled = false;
    $("abort-button").disabled = true;
  }
}

async function doAbort() {
  $("run-status").textContent = "中止を送信しました…";
  try { await api("/api/abort", {}); } catch (error) { $("run-status").textContent = "中止できませんでした: " + error.message; }
}

async function saveLabel(runId) {
  try {
    var result = await api("/api/label", {
      runId: runId,
      targetMatch: $("target-" + runId).value,
      aspectMatch: $("aspect-" + runId).value,
      supported: $("supported-" + runId).value,
      notes: $("notes-" + runId).value
    });
    $("label-status-" + runId).textContent = result.updated ? "保存しました" : "更新できませんでした";
    await loadRecords();
  } catch (error) {
    $("label-status-" + runId).textContent = "エラー: " + error.message;
  }
}

async function loadRecords() {
  var result = await api("/api/records?limit=20");
  renderRecords(result.records, result.summary);
}

document.addEventListener("click", function (event) {
  var target = event.target;
  if (target.dataset && target.dataset.label) saveLabel(target.dataset.label);
});

document.addEventListener("change", function (event) {
  var target = event.target;
  if (target.dataset && target.dataset.caseSelect) {
    state.selected[target.dataset.caseSelect] = target.checked;
    renderCases();
  }
  if (target.dataset && target.dataset.evidence) {
    var override = overrideFor(target.dataset.case);
    var index = override.selection.indexOf(target.dataset.evidence);
    if (target.checked && index < 0) override.selection.push(target.dataset.evidence);
    if (!target.checked && index >= 0) override.selection.splice(index, 1);
  }
});

document.addEventListener("input", function (event) {
  var target = event.target;
  if (target.dataset && target.dataset.caseQuestion) overrideFor(target.dataset.caseQuestion).question = target.value;
});

$("plan-button").addEventListener("click", doPlan);
$("run-button").addEventListener("click", doRun);
$("abort-button").addEventListener("click", doAbort);
$("select-all").addEventListener("click", function () {
  state.data.cases.forEach(function (item) { state.selected[item.id] = true; });
  renderCases();
});
$("select-none").addEventListener("click", function () {
  state.data.cases.forEach(function (item) { state.selected[item.id] = false; });
  renderCases();
});
$("reload-records").addEventListener("click", loadRecords);

loadState().then(loadRecords).catch(function (error) {
  $("config-line").textContent = "読み込みに失敗しました: " + error.message;
});
