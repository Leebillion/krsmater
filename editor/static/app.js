// Main screen: same layout and actions as the desktop app (master_reducer/app.py).

import { get, post, upload } from "./api.js";
import {
  alertDialog,
  bundleLayoutDialog,
  confirmDialog,
  el,
  importPreviewDialog,
  modal,
  outputSaveDialog,
  presetDialog,
  productRowDialog,
  workbookDialog,
} from "./dialogs.js";
import { VirtualTable } from "./table.js";

const GROUPS = ["compare", "reduce", "product", "output"];
const EDIT_TABS = ["all", "added"];
const RESTORE_TABS = ["excluded", "deleted_template", "ff_deleted"];

const COLUMNS = {
  edit: [
    { key: "checked", label: "체크", width: "56px", cls: "c", render: (r) => (r.checked ? "[x]" : "[ ]") },
    { key: "no", label: "행", width: "70px", cls: "r", sortable: true, sortKey: "index" },
    { key: "barcode", label: "바코드", width: "140px", cls: "mono", sortable: true },
    { key: "long_name", label: "상품명(긴)", width: "250px", sortable: true },
    { key: "short_name", label: "상품명(단축)", width: "160px", sortable: true },
    { key: "text", label: "원문", width: "minmax(400px, 1fr)", cls: "mono" },
  ],
  view: [
    { key: "no", label: "행", width: "70px", cls: "r", sortable: true, sortKey: "index" },
    { key: "barcode", label: "바코드", width: "140px", cls: "mono", sortable: true },
    { key: "long_name", label: "상품명(긴)", width: "250px", sortable: true },
    { key: "short_name", label: "상품명(단축)", width: "160px", sortable: true },
    { key: "text", label: "원문", width: "minmax(400px, 1fr)", cls: "mono" },
  ],
  db: [
    { key: "append", label: "추가예정", width: "80px", cls: "c" },
    { key: "barcode", label: "바코드", width: "140px", cls: "mono", sortable: true },
    { key: "long_name", label: "상품명(긴)", width: "250px", sortable: true },
    { key: "short_name", label: "상품명(단축)", width: "160px", sortable: true },
    { key: "text", label: "원문", width: "minmax(400px, 1fr)", cls: "mono" },
  ],
  catalog: [
    { key: "barcode", label: "바코드", width: "140px", cls: "mono", sortable: true },
    { key: "long_name", label: "상품명(긴)", width: "260px", sortable: true },
    { key: "short_name", label: "상품명(단축)", width: "170px", sortable: true },
    { key: "text", label: "원문", width: "minmax(400px, 1fr)", cls: "mono" },
  ],
};
const SORT_LABELS = { index: "행 번호", barcode: "바코드", long_name: "상품명(긴)", short_name: "상품명(단축)" };

const ui = {
  server: null,
  group: "compare",
  activeTab: { compare: "all", reduce: "excluded", product: "paid" },
  search: { field: "상품명", q: "" },
  sort: { column: "barcode", reverse: false },
  keyMode: "barcode",
  table: null,
};

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ status

function setStatus(message, warn = false) {
  const status = $("status");
  status.textContent = message || "";
  status.classList.toggle("warn", Boolean(warn));
}

function updateCounter() {
  const server = ui.server;
  if (!server) return;
  const parts = [];
  if (ui.group !== "output") {
    const tab = currentTabDef();
    if (tab) parts.push(`${tab.label} ${(server.counts[tab.key] || 0).toLocaleString()}행`);
    const selected = ui.table?.selectionCount() || 0;
    if (selected) parts.push(`선택 ${selected.toLocaleString()}행`);
  }
  parts.push(`저장 제외 ${server.excluded.toLocaleString()}행`);
  if (server.checked) parts.push(`체크 ${server.checked.toLocaleString()}행`);
  if (ui.search.q) parts.push(`검색: ${ui.search.field} '${ui.search.q}'`);
  $("counter").textContent = parts.join(" · ");
}

async function run(action, { reload = true } = {}) {
  try {
    const result = await action();
    if (result && typeof result === "object" && "message" in result && result.message) {
      setStatus(result.message, result.ok === false);
    }
    if (reload) await refresh();
    return result;
  } catch (exc) {
    setStatus(exc.message, true);
    await alertDialog("오류", exc.message);
    return null;
  }
}

// --------------------------------------------------------------- file bar

function pickFile(accept = "") {
  return new Promise((resolve) => {
    const input = el("input", { type: "file", accept });
    input.addEventListener("change", () => resolve(input.files[0] || null));
    input.click();
  });
}

function renderFileBar() {
  const bar = $("file-bar");
  const server = ui.server;
  bar.replaceChildren(
    ...server.slot_rows.map((row) =>
      el("div", { class: "file-row" },
        ...row.map((slot) => {
          const info = server.slots[slot];
          const loaded = Boolean(info.name);
          return el("div", { class: "file-slot" },
            el("span", { class: "label", text: info.label }),
            el("span", { class: `name${loaded ? " loaded" : ""}`, text: info.name || "파일을 선택하세요", title: info.name }),
            loaded && slot !== "delete" ? el("span", { class: "rows", text: `${info.rows.toLocaleString()}행` }) : null,
            el("button", { type: "button", text: "…", title: `${info.label} 파일 선택`, onclick: () => chooseSlotFile(slot, info.label) }));
        }))),
  );
}

async function chooseSlotFile(slot, label) {
  const file = await pickFile(".txt,.TXT,.dat,*");
  if (!file) return;
  setStatus(`${label} 올리는 중…`);
  const result = await run(() => upload(`/api/files/${slot}`, file));
  if (!result) return;
  if (slot === "delete") {
    ui.activeTab.reduce = "deleted_template";
    await selectGroup("reduce");
    await alertDialog("삭제 마스터 불러오기", result.message);
  }
}

// ---------------------------------------------------------------- toolbars

function button(label, onclick, extra = {}) {
  return el("button", { type: "button", text: label, onclick, ...extra });
}

function separator() {
  return el("span", { class: "sep" });
}

function buildToolbars() {
  const host = $("toolbars");
  const radio = (value, label) =>
    el("label", { class: "radio" },
      el("input", { type: "radio", name: "key-mode", value, checked: ui.keyMode === value, onchange: () => (ui.keyMode = value) }),
      label);

  const toolbars = {
    compare: [
      el("span", { text: "비교 기준" }), radio("barcode", "앞 13byte 바코드"), radio("full_row", "전체 행"),
      button("비교 실행", () => run(() => post("/api/compare", { key_mode: ui.keyMode }))),
      separator(),
      button("선택 행 삭제", deleteSelectedRows),
      button("체크 행 삭제", () => run(() => post("/api/reduce/delete-checked"))),
      button("기존 삭제 실행", () => run(() => post("/api/reduce/apply-saved"))),
    ],
    reduce: [
      button("선택 행 복구", restoreSelectedRows),
      button("기존 삭제 실행", () => run(() => post("/api/reduce/apply-saved"))),
      separator(),
      el("span", { text: "카테고리 일괄 처리" }),
      button("담배 일괄 삭제", () => run(() => post("/api/reduce/delete-tobacco"))),
      button("담배 복구", () => restoreCategory("tobacco_deleted", "/api/reduce/restore-tobacco", "삭제된 담배행")),
      button("FF 일괄 삭제", () => run(() => post("/api/reduce/delete-ff"))),
      button("FF 복구", () => restoreCategory("ff_deleted", "/api/reduce/restore-ff", "삭제된 FF행")),
    ],
    product: [
      button("행 추가", addProductRow),
      button("선택 행 편집", editSelectedProductRow),
      button("선택 행 삭제", deleteSelectedProductRows),
      separator(),
      button("추가할 상품 불러오기", importProductRows),
      separator(),
      button("통합 엑셀 가져오기", importWorkbook),
      button("종량제 전체 교체", replacePaid),
      button("번들 텍스트 가져오기", importBundleText),
      button("담배 엑셀 가져오기", importTobaccoExcel),
      button("새로고침", async () => {
        await refresh();
        const counts = Object.entries(ui.server.sources)
          .map(([key, label]) => `${label} ${(ui.server.counts[key] || 0).toLocaleString()}`)
          .join(", ");
        setStatus(`상품 DB 새로고침: ${counts}`);
      }),
    ],
    output: [button("출력 저장…", openOutputDialog), button("구성 새로고침", refreshOutputPanel)],
  };
  host.replaceChildren(
    ...GROUPS.map((group) => el("div", { class: "toolbar", "data-group": group }, ...toolbars[group])),
  );
}

// ------------------------------------------------------------------ groups

function currentTabDef() {
  if (!ui.server || ui.group === "output") return null;
  return ui.server.tabs.find((tab) => tab.key === ui.activeTab[ui.group]);
}

async function selectGroup(group) {
  ui.group = group;
  for (const node of document.querySelectorAll("#sidebar > button")) {
    node.classList.toggle("active", node.dataset.group === group);
  }
  for (const node of document.querySelectorAll("#toolbars > .toolbar")) {
    node.hidden = node.dataset.group !== group;
  }
  const isOutput = group === "output";
  $("search-area").hidden = isOutput;
  $("tabs").hidden = isOutput;
  $("table-host").hidden = isOutput;
  $("output-panel").hidden = !isOutput;
  if (isOutput) {
    await refreshOutputPanel();
  } else {
    renderTabs();
    mountTable();
  }
  updateCounter();
}

function renderTabs() {
  const tabs = ui.server.tabs.filter((tab) => tab.group === ui.group);
  $("tabs").replaceChildren(
    ...tabs.map((tab) =>
      el("button", {
        type: "button",
        role: "tab",
        class: tab.key === ui.activeTab[ui.group] ? "active" : "",
        text: `${tab.label} (${(ui.server.counts[tab.key] || 0).toLocaleString()})`,
        onclick: () => {
          ui.activeTab[ui.group] = tab.key;
          renderTabs();
          mountTable();
          updateCounter();
        },
      })),
  );
}

function mountTable() {
  const tab = currentTabDef();
  if (!tab) return;
  const columns = COLUMNS[tab.kind];
  ui.table = new VirtualTable($("table-host"), {
    columns,
    sort: { column: columns.find((c) => (c.sortKey || c.key) === ui.sort.column)?.key || "barcode", reverse: ui.sort.reverse },
    fetchPage: (offset, limit) =>
      get(`/api/rows/${tab.key}`, {
        offset, limit, sort: ui.sort.column, reverse: ui.sort.reverse, field: ui.search.field, q: ui.search.q,
      }),
    onSort: (key) => {
      const column = columns.find((c) => c.key === key);
      const sortKey = column.sortKey || key;
      ui.sort = { column: sortKey, reverse: ui.sort.column === sortKey ? !ui.sort.reverse : false };
      ui.table.setSort({ column: key, reverse: ui.sort.reverse });
      ui.table.reload({ keepScroll: false });
      setStatus(`${SORT_LABELS[sortKey] || sortKey} ${ui.sort.reverse ? "내림차순" : "오름차순"} 정렬`);
    },
    onActivate: (row) => activateRow(tab.key, row),
    onSpace: () => EDIT_TABS.includes(tab.key) && toggleChecked(),
    onDelete: () => deleteKey(tab.key),
    onSelectionChange: updateCounter,
  });
  ui.table.reload().catch((exc) => setStatus(exc.message, true));
}

function activateRow(tabKey, row) {
  if (EDIT_TABS.includes(tabKey)) return toggleChecked([row.key]);
  if (RESTORE_TABS.includes(tabKey)) return restoreSelectedRows();
  if (tabKey === "tobacco_deleted") return restoreCategory("tobacco_deleted", "/api/reduce/restore-tobacco", "삭제된 담배행");
  if (tabKey in ui.server.sources) return editSelectedProductRow();
  return null;
}

function deleteKey(tabKey) {
  if (EDIT_TABS.includes(tabKey)) return deleteSelectedRows();
  if (RESTORE_TABS.includes(tabKey)) return restoreSelectedRows();
  if (tabKey === "tobacco_deleted") return restoreCategory("tobacco_deleted", "/api/reduce/restore-tobacco", "삭제된 담배행");
  if (tabKey in ui.server.sources) return deleteSelectedProductRows();
  return null;
}

function selectionBody(tabKey, keys) {
  const selection = keys ? { keys, all_visible: false } : ui.table.selection();
  return { tab: tabKey, ...selection, field: ui.search.field, q: ui.search.q };
}

// ------------------------------------------------------------- refreshing

async function refresh() {
  ui.server = await get("/api/state", { field: ui.search.field, q: ui.search.q });
  renderFileBar();
  renderPresets();
  if (ui.group === "output") {
    await refreshOutputPanel();
  } else {
    renderTabs();
    await ui.table?.reload({ keepScroll: true });
  }
  updateCounter();
}

async function refreshOutputPanel() {
  try {
    const panel = await get("/api/outputs/panel");
    $("output-rows").replaceChildren(
      ...panel.outputs.map((o) =>
        el("tr", {},
          el("td", { text: o.label }),
          el("td", { text: o.base }),
          el("td", { text: o.exclude }),
          el("td", { text: o.appends }),
          el("td", { class: "num", text: o.rows === null ? "-" : `${o.rows.toLocaleString()}행` }),
          el("td", { class: o.rows === null ? "warn" : "muted", text: o.state }))),
    );
  } catch (exc) {
    setStatus(exc.message, true);
  }
}

// ------------------------------------------------------------ search/preset

function applySearch() {
  ui.search = { field: $("search-field").value, q: $("search-text").value.trim() };
  setStatus(ui.search.q ? `${ui.search.field} 검색: '${ui.search.q}'` : "검색어가 비어 있어 전체 목록을 표시합니다.");
  return refresh();
}

function renderPresets() {
  const presets = ui.server.presets;
  const children = [];
  for (const field of ["상품명", "바코드"]) {
    const keywords = presets[field] || [];
    if (!keywords.length) continue;
    children.push(el("span", { class: "field", text: field }));
    for (const keyword of keywords) {
      const node = button(keyword, () => {
        $("search-field").value = field;
        $("search-text").value = keyword;
        applySearch();
      }, { title: "우클릭: 검색어 삭제" });
      node.addEventListener("contextmenu", async (event) => {
        event.preventDefault();
        if (!(await confirmDialog("검색어 삭제", `'${keyword}' 검색어를 삭제할까요?`, "삭제"))) return;
        await run(() => post("/api/presets/delete", { field, keywords: [keyword] }));
        setStatus(`빠른 검색어 삭제: ${field} '${keyword}'`);
      });
      children.push(node);
    }
  }
  $("presets").replaceChildren(...children);
}

function bindSearch() {
  $("search-apply").addEventListener("click", applySearch);
  $("search-text").addEventListener("keydown", (event) => event.key === "Enter" && applySearch());
  $("search-clear").addEventListener("click", () => {
    $("search-text").value = "";
    ui.search.q = "";
    setStatus("전체 목록을 표시합니다.");
    refresh();
  });
  $("preset-add").addEventListener("click", async () => {
    const keyword = $("search-text").value.trim();
    if (!keyword) {
      await alertDialog("검색어 저장", "저장할 검색어를 먼저 입력하세요.");
      return;
    }
    await run(() => post("/api/presets/add", { field: $("search-field").value, keyword }));
  });
  $("preset-manage").addEventListener("click", async () => {
    const changed = await presetDialog($("search-field").value, { ...ui.server.presets });
    if (changed) {
      await refresh();
      setStatus("빠른 검색어 목록을 갱신했습니다.");
    }
  });
}

// --------------------------------------------------------------- reduction

async function deleteSelectedRows() {
  const tabKey = ui.activeTab[ui.group];
  if (ui.group !== "compare" || !EDIT_TABS.includes(tabKey)) {
    await alertDialog("삭제 불가", "전체 행 또는 추가 행 탭에서 삭제할 행을 선택하세요.");
    return;
  }
  if (!ui.table.selectionCount()) {
    setStatus("선택 행 삭제: 대상 행이 없습니다.", true);
    return;
  }
  await run(() => post("/api/reduce/delete", selectionBody(tabKey)));
}

async function toggleChecked(keys) {
  const tabKey = ui.activeTab[ui.group];
  if (!keys && !ui.table.selectionCount()) return;
  await run(() => post("/api/rows/check", selectionBody(tabKey, keys)), { reload: false });
  ui.server = await get("/api/state", { field: ui.search.field, q: ui.search.q });
  await ui.table.reload({ keepSelection: true, keepScroll: true });
  updateCounter();
}

async function restoreSelectedRows() {
  const tabKey = ui.activeTab[ui.group];
  if (ui.group !== "reduce" || ![...RESTORE_TABS, "tobacco_deleted"].includes(tabKey)) {
    await alertDialog("복구 불가", "현재 삭제 행 또는 삭제한 행 탭에서 복구할 행을 선택하세요.");
    return;
  }
  if (!ui.table.selectionCount()) {
    await alertDialog("복구 불가", "복구할 행을 선택하세요.");
    return;
  }
  await run(() => post("/api/reduce/restore", selectionBody(tabKey)));
}

async function restoreCategory(tabKey, path, label) {
  if (ui.activeTab.reduce !== tabKey || ui.group !== "reduce" || !ui.table.selectionCount()) {
    ui.activeTab.reduce = tabKey;
    await selectGroup("reduce");
    await alertDialog("복구 불가", `${label} 탭에서 복구할 행을 선택하세요.`);
    return;
  }
  await run(() => post(path, selectionBody(tabKey)));
}

// --------------------------------------------------------------- products

function currentSource() {
  const tabKey = ui.activeTab.product;
  return ui.group === "product" && tabKey in ui.server.sources ? tabKey : null;
}

async function requireSource(action) {
  const source = currentSource();
  if (!source) await alertDialog("상품 DB 선택 필요", `종량제 / 번들 / 단축상품 / 서비스 DB 탭에서 ${action}하세요.`);
  return source;
}

async function addProductRow() {
  const source = await requireSource("행을 추가");
  if (!source) return;
  await productRowDialog({
    sourceKey: source,
    sourceLabel: ui.server.sources[source],
    limits: ui.server.limits,
    onSaved: (message) => setStatus(message),
  });
  await refresh();
}

async function editSelectedProductRow() {
  const source = currentSource();
  const row = source ? ui.table.firstSelectedRow() : null;
  if (!row) {
    await alertDialog("편집 불가", "상품 DB 탭에서 편집할 행을 선택하세요.");
    return;
  }
  try {
    const detail = await get(`/api/products/${source}/row/${encodeURIComponent(row.barcode)}`);
    await productRowDialog({
      sourceKey: source,
      sourceLabel: ui.server.sources[source],
      limits: ui.server.limits,
      row: detail,
      onSaved: (message) => setStatus(message),
    });
    await refresh();
  } catch (exc) {
    await alertDialog("편집 불가", exc.message);
  }
}

async function deleteSelectedProductRows() {
  const source = currentSource();
  if (!source || !ui.table.selectionCount()) {
    await alertDialog("삭제 불가", "상품 DB 탭에서 삭제할 행을 선택하세요.");
    return;
  }
  const selection = ui.table.selection();
  let barcodes = selection.keys;
  if (selection.all_visible) {
    const all = await get(`/api/rows/${source}`, { offset: 0, limit: 2000, field: ui.search.field, q: ui.search.q });
    barcodes = all.rows.map((r) => r.barcode);
  }
  const label = ui.server.sources[source];
  if (!(await confirmDialog("DB 행 삭제", `${label} DB에서 ${barcodes.length.toLocaleString()}행을 삭제할까요?`, "삭제"))) return;
  await run(() => post(`/api/products/${source}/delete`, { barcodes }));
}

async function importProductRows() {
  const source = await requireSource("불러오기를 실행");
  if (!source) return;
  const file = await pickFile(".txt,.xlsx");
  if (!file) return;
  try {
    const preview = await upload(`/api/products/${source}/import-preview`, file);
    const offsets = await importPreviewDialog(preview);
    if (!offsets) return;
    await run(() => post(`/api/products/${source}/import-save`, { offsets }));
  } catch (exc) {
    await alertDialog("불러오기", exc.message);
  }
}

async function importWorkbook() {
  const file = await pickFile(".xlsx,.xlsm");
  if (!file) return;
  setStatus("통합 엑셀 읽는 중…");
  try {
    const preview = await upload("/api/workbook/preview", file);
    const targets = await workbookDialog(preview);
    if (!targets) {
      setStatus("통합 엑셀 가져오기를 취소했습니다.");
      return;
    }
    const result = await run(() => post("/api/workbook/apply", { targets }));
    if (result?.ok) await alertDialog("통합 엑셀 가져오기", `교체 완료\n\n${result.lines.join("\n")}`);
  } catch (exc) {
    await alertDialog("통합 엑셀 오류", exc.message);
  }
}

async function replacePaid() {
  const file = await pickFile(".txt,.TXT");
  if (!file) return;
  if (!(await confirmDialog("종량제 전체 교체", "기존 종량제 DB를 모두 지우고 선택한 파일 내용으로 다시 씁니다.\n계속할까요?", "교체"))) return;
  await run(() => upload("/api/products/paid/replace", file));
}

async function importBundleText() {
  const file = await pickFile(".txt,.TXT");
  if (!file) return;
  const layout = await bundleLayoutDialog();
  if (!layout) return;
  await run(() => upload("/api/products/bundle/import-text", file, layout));
}

async function importTobaccoExcel() {
  const file = await pickFile(".xlsx");
  if (!file) return;
  await run(() => upload("/api/products/tobacco/import-excel", file));
}

// ----------------------------------------------------------------- outputs

async function openOutputDialog() {
  const available = (await get("/api/outputs/options")).outputs.some((o) => o.available);
  if (!available) {
    await alertDialog("저장 불가", "신규·단축·전체·폐점 마스터 중 하나 이상을 먼저 선택하세요.");
    return;
  }
  const result = await outputSaveDialog(setStatus);
  if (!result) return;
  const href = `${result.download}?name=${encodeURIComponent(result.zip_name)}`;
  const link = el("a", { href, download: result.zip_name, class: "primary-link", text: `${result.zip_name} 내려받기` });
  link.click();
  setStatus(`출력 저장 완료: ${result.summary.length}개 항목 · ${result.zip_name}`);
  await modal({
    title: "저장 완료",
    width: "900px",
    build: () =>
      el("div", {},
        el("pre", { text: result.summary.join("\n") }),
        el("p", { class: "note", text: "다운로드가 시작되지 않았다면 아래 링크를 누르세요." }),
        el("p", {}, el("a", { href, download: result.zip_name, text: `${result.zip_name} 내려받기` }))),
    buttons: [{ label: "확인", primary: true, value: true }],
  });
  await refreshOutputPanel();
}

// ------------------------------------------------------------------- start

async function start() {
  bindSearch();
  for (const node of document.querySelectorAll("#sidebar > button[data-group]")) {
    node.addEventListener("click", () => selectGroup(node.dataset.group));
  }
  $("logout").addEventListener("click", async () => {
    await post("/api/logout").catch(() => {});
    window.location.href = "login";
  });
  ui.server = await get("/api/state");
  ui.keyMode = ui.server.key_mode;
  buildToolbars();
  renderFileBar();
  renderPresets();
  await selectGroup("compare");
  setStatus("상단에서 파일을 선택해 작업을 시작하세요. 상품 DB는 모든 사용자가 같이 씁니다.");
}

start().catch((exc) => setStatus(exc.message, true));
