// Modal dialogs. Each mirrors the desktop dialog of the same name (master_reducer/dialogs.py).

import { cp949Bytes, get, post, truncateBytes, upload } from "./api.js";

const root = () => document.getElementById("modal-root");

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    // CSP blocks style="" attributes; setting through the CSSOM is allowed.
    else if (key === "style") node.style.cssText = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "checked" || key === "disabled" || key === "hidden") node[key] = Boolean(value);
    else if (key === "value") node.value = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * Open a modal. `build(close)` returns the content element; buttons are
 * [{label, value, primary, danger, onClick}] -- onClick may return false to keep it open.
 */
export function modal({ title, build, buttons = [], width, footerLeft }) {
  return new Promise((resolve) => {
    const backdrop = el("div", { class: "modal-backdrop" });
    const box = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title });
    if (width) box.style.width = width;
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape" && backdrop.isConnected && backdrop === root().lastElementChild) {
        event.stopPropagation();
        close(undefined);
      }
    };
    const content = el("div", { class: "content" }, build(close));
    const footer = el("footer");
    if (footerLeft) footer.append(el("div", { class: "left" }, footerLeft));
    for (const button of buttons) {
      const node = el("button", {
        type: "button",
        class: button.primary ? "primary" : button.danger ? "danger" : "",
        text: button.label,
        onclick: async () => {
          if (button.onClick) {
            node.disabled = true;
            try {
              const keepOpen = (await button.onClick(close)) === false;
              if (keepOpen) return;
            } finally {
              node.disabled = false;
            }
            if (done) return;
          }
          close(button.value);
        },
      });
      footer.append(node);
    }
    box.append(el("header", { text: title }), content, footer);
    backdrop.append(box);
    root().append(backdrop);
    document.addEventListener("keydown", onKey, true);
    const focusTarget = box.querySelector("input:not([type=checkbox]):not([type=file]), select") ||
      box.querySelector("footer button.primary");
    focusTarget?.focus();
  });
}

export function alertDialog(title, message) {
  return modal({
    title,
    build: () => el("pre", { text: message }),
    buttons: [{ label: "확인", primary: true, value: true }],
  });
}

export async function confirmDialog(title, message, okLabel = "확인") {
  const result = await modal({
    title,
    build: () => el("pre", { text: message }),
    buttons: [{ label: "취소", value: false }, { label: okLabel, primary: true, value: true }],
  });
  return Boolean(result);
}

function byteField(label, value, width, onEnter) {
  const input = el("input", { type: "text", value: value || "" });
  const counter = el("span", { class: "bytes" });
  const update = () => {
    if (width) {
      const trimmed = truncateBytes(input.value, width);
      if (trimmed !== input.value) input.value = trimmed;
      const count = cp949Bytes(input.value);
      counter.textContent = `${count} / ${width}byte · 패딩 ${Math.max(0, width - count)}byte`;
    } else {
      counter.textContent = `${cp949Bytes(input.value)}byte`;
    }
  };
  input.addEventListener("input", update);
  if (onEnter) input.addEventListener("keydown", (event) => event.key === "Enter" && onEnter());
  update();
  return { label: el("label", { text: label }), input, counter, update };
}

// ---------------------------------------------------------------- product row

export async function productRowDialog({ sourceKey, sourceLabel, limits, row, onSaved }) {
  const editing = Boolean(row);
  let saved = 0;
  let submit;
  const fields = {
    barcode: byteField("바코드", row?.barcode, limits.barcode, () => submit()),
    long_name: byteField("상품명(긴)", row?.long_name, limits.long_name, () => submit()),
    short_name: byteField("상품명(단축)", row?.short_name, limits.short_name, () => submit()),
    tail: byteField("추가 원문", row?.tail, null, () => submit()),
  };
  const keepOpen = el("input", { type: "checkbox", checked: !editing });
  const error = el("p", { class: "error" });
  let closeFn;

  submit = async () => {
    error.textContent = "";
    const body = {
      barcode: fields.barcode.input.value.trim(),
      long_name: fields.long_name.input.value,
      short_name: fields.short_name.input.value,
      tail: fields.tail.input.value,
      original: row?.barcode || "",
    };
    if (!body.barcode) {
      error.textContent = "바코드는 비워둘 수 없습니다.";
      return false;
    }
    try {
      let result = await post(`/api/products/${sourceKey}/row`, body);
      if (result.duplicate) {
        if (!(await confirmDialog("바코드 중복", result.message, "덮어쓰기"))) return false;
        result = await post(`/api/products/${sourceKey}/row`, { ...body, overwrite: true });
      }
      saved += 1;
      onSaved?.(result.message);
      if (editing || !keepOpen.checked) {
        closeFn(saved);
        return true;
      }
      for (const field of Object.values(fields)) {
        field.input.value = "";
        field.update();
      }
      fields.barcode.input.focus();
      return false;
    } catch (exc) {
      error.textContent = exc.message;
      return false;
    }
  };

  return modal({
    title: `${sourceLabel} DB 행 ${editing ? "편집" : "추가"}`,
    width: "640px",
    build: (close) => {
      closeFn = close;
      const grid = el("div", { class: "form-grid" });
      for (const field of Object.values(fields)) grid.append(field.label, field.input, field.counter);
      return el(
        "div",
        {},
        el("p", {
          class: "note",
          text:
            `${sourceLabel} DB에 저장합니다. 바코드 ${limits.barcode}byte ASCII, 상품명(긴) ${limits.long_name}byte, ` +
            `상품명(단축) ${limits.short_name}byte, 추가 원문은 58byte 이후 tail입니다. 확인을 누르면 바로 DB에 저장됩니다.`,
        }),
        grid,
        sourceKey === "bundle"
          ? el("p", {
              class: "note",
              text: "번들 DB의 수량·단품 정보는 파일 가져오기에서만 채워집니다. 여기서 추가한 행은 출력에 필요한 원문만 저장합니다.",
            })
          : null,
        error,
      );
    },
    footerLeft: editing ? null : el("label", {}, keepOpen, " 연속 추가"),
    buttons: [
      { label: "닫기", value: saved },
      { label: "확인", primary: true, onClick: () => submit().then(() => false) },
    ],
  });
}

// ---------------------------------------------------------- import preview

export function importPreviewDialog(data) {
  const checked = new Set(data.rows.filter((r) => r.state === "신규").map((r) => r.offset));
  const tbody = el("tbody");
  const count = el("span", { class: "note" });
  const boxes = new Map();
  const refresh = () => {
    for (const [offset, box] of boxes) box.checked = checked.has(offset);
    count.textContent = `선택 ${checked.size.toLocaleString()} / ${data.rows.length.toLocaleString()}행`;
  };
  for (const row of data.rows) {
    const box = el("input", {
      type: "checkbox",
      onchange: () => (box.checked ? checked.add(row.offset) : checked.delete(row.offset), refresh()),
    });
    boxes.set(row.offset, box);
    tbody.append(
      el("tr", {}, el("td", {}, box), el("td", { text: row.state }), el("td", { text: row.barcode }),
        el("td", { text: row.long_name }), el("td", { text: row.short_name })),
    );
  }
  refresh();
  const setAll = (value) => {
    checked.clear();
    if (value) data.rows.forEach((r) => checked.add(r.offset));
    refresh();
  };
  return modal({
    title: `${data.source_label} DB에 추가할 상품 불러오기`,
    width: "980px",
    build: () =>
      el(
        "div",
        {},
        el("p", { text: `${data.file_name} · 읽은 행 ${data.rows.length.toLocaleString()}개 (기존 바코드 ${data.duplicates.toLocaleString()}개)` }),
        el(
          "div",
          { class: "row-inline" },
          el("button", { type: "button", text: "전체 선택", onclick: () => setAll(true) }),
          el("button", { type: "button", text: "전체 해제", onclick: () => setAll(false) }),
          el("button", {
            type: "button",
            text: "신규만 선택",
            onclick: () => {
              checked.clear();
              data.rows.filter((r) => r.state === "신규").forEach((r) => checked.add(r.offset));
              refresh();
            },
          }),
          count,
        ),
        el(
          "div",
          { class: "scroll-box", style: "margin-top:8px" },
          el("table", { class: "grid" },
            el("thead", {}, el("tr", {}, ...["추가", "상태", "바코드", "상품명(긴)", "상품명(단축)"].map((t) => el("th", { text: t })))),
            tbody),
        ),
      ),
    buttons: [
      { label: "취소", value: null },
      {
        label: "선택 행 저장",
        primary: true,
        onClick: async (close) => {
          if (!checked.size) {
            await alertDialog("선택 없음", "저장할 행을 하나 이상 선택하세요.");
            return false;
          }
          close([...checked].sort((a, b) => a - b));
          return true;
        },
      },
    ],
  });
}

// ---------------------------------------------------- workbook import

function shortNameDialog(row) {
  const field = byteField("상품명(단축)", row.short_name, 14, null);
  return modal({
    title: "상품명(단축) 수정",
    width: "460px",
    build: () => {
      const grid = el("div", { class: "form-grid" },
        el("span", { text: "원본 상품명(긴)" }), el("span", { class: "muted", text: row.long_name }), el("span"),
        el("span", { text: "바코드" }), el("span", { class: "muted", text: row.barcode }), el("span"),
        field.label, field.input, field.counter);
      field.input.addEventListener("keydown", (event) => event.key === "Enter" && event.target.closest(".modal").querySelector("footer .primary").click());
      setTimeout(() => field.input.select(), 0);
      return grid;
    },
    buttons: [
      { label: "취소", value: null },
      {
        label: "확인",
        primary: true,
        onClick: async (close) => {
          const value = field.input.value.trim();
          if (!value) {
            await alertDialog("입력 오류", "상품명(단축)은 비워둘 수 없습니다.");
            return false;
          }
          close(value);
          return true;
        },
      },
    ],
  });
}

export function workbookDialog(data) {
  const enabled = new Map(data.targets.map((t) => [t.key, true]));
  const tbody = el("tbody");
  const info = el("p", { class: "note" });
  const total = data.targets.reduce((sum, t) => sum + t.new, 0);

  const renderPreview = () => {
    tbody.replaceChildren();
    const selected = data.targets.filter((t) => enabled.get(t.key));
    let shown = 0;
    let rowsTotal = 0;
    let flagged = 0;
    for (const target of selected) {
      rowsTotal += target.new;
      flagged += target.note_count;
      for (const row of target.rows.slice(0, 60)) {
        const shortCell = el("td", { class: "editable", text: row.short_name, title: "더블클릭해서 수정" });
        const tr = el("tr", { class: row.note ? "note" : "" },
          el("td", { text: row.group }), el("td", { text: row.barcode }), el("td", { text: row.long_name }),
          shortCell, el("td", { text: row.extra }), el("td", { text: row.note }));
        shortCell.addEventListener("dblclick", async () => {
          const value = await shortNameDialog(row);
          if (!value) return;
          try {
            const updated = await post("/api/workbook/short-name", { target: row.target, index: row.index, short_name: value });
            Object.assign(row, updated);
            shortCell.textContent = updated.short_name;
          } catch (exc) {
            await alertDialog("수정 실패", exc.message);
          }
        });
        tbody.append(tr);
        shown += 1;
      }
    }
    const suffix = shown < rowsTotal ? ` (미리보기 ${shown.toLocaleString()}행 표시)` : "";
    const warning = flagged ? ` · 상품명 잘림 ${flagged.toLocaleString()}건` : "";
    info.textContent = `교체 대상 ${rowsTotal.toLocaleString()}행${warning}${suffix} · 상품명(단축)은 더블클릭으로 수정할 수 있습니다.`;
  };

  const targetTable = el("table", { class: "grid" },
    el("thead", {}, el("tr", {}, ...["교체", "대상 DB", "가져올 시트", "현재", "", "교체 후", "비고"].map((t) => el("th", { text: t })))),
    el("tbody", {}, ...data.targets.map((target) => {
      const notes = [];
      if (target.current && target.new < target.current) notes.push(`${(target.current - target.new).toLocaleString()}행 줄어듦`);
      if (target.note_count) notes.push(`상품명 잘림 ${target.note_count}건`);
      return el("tr", {},
        el("td", {}, el("input", { type: "checkbox", checked: true, onchange: (e) => (enabled.set(target.key, e.target.checked), renderPreview()) })),
        el("td", { text: target.label }),
        el("td", { class: "muted", text: target.source_label }),
        el("td", { class: "num", text: `${target.current.toLocaleString()}행` }),
        el("td", { text: "→" }),
        el("td", { class: "num", text: `${target.new.toLocaleString()}행` }),
        el("td", { class: notes.length ? "warn" : "muted", text: notes.join(" · ") }));
    })));
  renderPreview();

  return modal({
    title: "번들 마스터 통합 엑셀 가져오기",
    width: "1060px",
    build: () =>
      el("div", {},
        el("p", { text: `${data.file_name} · 대상 ${data.targets.length}개 DB, 총 ${total.toLocaleString()}행` }),
        el("p", { class: "warn", text: "체크한 DB는 기존 내용을 모두 지우고 엑셀 내용으로 교체합니다. 체크하지 않은 DB는 그대로 둡니다." }),
        targetTable,
        info,
        el("div", { class: "scroll-box" },
          el("table", { class: "grid" },
            el("thead", {}, el("tr", {}, ...["묶음", "바코드", "상품명(긴)", "상품명(단축)", "입수/단품", "비고"].map((t) => el("th", { text: t })))),
            tbody))),
    buttons: [
      { label: "취소", value: null },
      {
        label: "선택 DB 교체",
        primary: true,
        onClick: async (close) => {
          const selected = data.targets.filter((t) => enabled.get(t.key));
          if (!selected.length) {
            await alertDialog("선택 없음", "교체할 DB를 하나 이상 선택하세요.");
            return false;
          }
          const names = selected.map((t) => `· ${t.label} → ${t.new.toLocaleString()}행`).join("\n");
          if (!(await confirmDialog("DB 교체 확인", `다음 DB의 기존 내용을 모두 지우고 교체합니다.\n\n${names}\n\n계속할까요?`, "교체"))) return false;
          close(selected.map((t) => t.key));
          return true;
        },
      },
    ],
  });
}

// ---------------------------------------------------------- bundle layout

export function bundleLayoutDialog() {
  const fields = [
    ["bundle_barcode_start", "번들바코드 시작 byte", 1], ["bundle_barcode_length", "번들바코드 길이", 13],
    ["bundle_name_start", "번들명 시작 byte", 14], ["bundle_name_length", "번들명 길이", 40],
    ["quantity_start", "수량 시작 byte", 54], ["quantity_length", "수량 길이", 4],
    ["unit_barcode_start", "단품바코드 시작 byte", 58], ["unit_barcode_length", "단품바코드 길이", 13],
    ["unit_name_start", "단품명 시작 byte", 71], ["unit_name_length", "단품명 길이", 40],
  ];
  const inputs = new Map(fields.map(([key, , value]) => [key, el("input", { type: "number", min: "1", value })]));
  return modal({
    title: "번들 컬럼 설정",
    width: "420px",
    build: () =>
      el("div", {},
        el("p", { class: "note", text: "번들 마스터는 파일마다 컬럼 위치가 달라 byte 기준 위치를 지정합니다. 시작 위치는 1부터입니다." }),
        el("div", { class: "form-grid" }, ...fields.flatMap(([key, label]) => [el("label", { text: label }), inputs.get(key), el("span")]))),
    buttons: [
      { label: "취소", value: null },
      {
        label: "확인",
        primary: true,
        onClick: async (close) => {
          const values = {};
          for (const [key, input] of inputs) {
            const value = Number(input.value);
            if (!Number.isInteger(value) || value <= 0) {
              await alertDialog("입력 오류", "모든 컬럼 위치와 길이는 1 이상의 숫자여야 합니다.");
              return false;
            }
            values[key] = value;
          }
          close(values);
          return true;
        },
      },
    ],
  });
}

// ---------------------------------------------------------- preset manager

export function presetDialog(initialField, presets) {
  let field = initialField;
  let changed = false;
  let selected = new Set();
  const list = el("div", { class: "list-box" });
  const keywordInput = el("input", { type: "text", placeholder: "추가할 검색어" });
  const current = () => presets[field] || [];

  const render = () => {
    list.replaceChildren(...current().map((keyword) => {
      const item = el("div", { class: selected.has(keyword) ? "sel" : "", text: keyword });
      item.addEventListener("click", (event) => {
        if (!(event.ctrlKey || event.metaKey)) selected = new Set();
        if (selected.has(keyword)) selected.delete(keyword);
        else selected.add(keyword);
        render();
      });
      return item;
    }));
  };
  const reload = async () => {
    const state = await get("/api/state");
    Object.assign(presets, state.presets);
    render();
  };
  const add = async () => {
    const keyword = keywordInput.value.trim();
    if (!keyword) return;
    const result = await post("/api/presets/add", { field, keyword });
    if (!result.ok) {
      await alertDialog("중복", `'${keyword}'는 이미 등록되어 있습니다.`);
      return;
    }
    keywordInput.value = "";
    changed = true;
    await reload();
  };
  const move = async (direction) => {
    if (selected.size !== 1) return;
    const keywords = [...current()];
    const index = keywords.indexOf([...selected][0]);
    const target = index + direction;
    if (target < 0 || target >= keywords.length) return;
    [keywords[index], keywords[target]] = [keywords[target], keywords[index]];
    await post("/api/presets/reorder", { field, keywords });
    changed = true;
    await reload();
  };
  const remove = async () => {
    if (!selected.size) return;
    if (!(await confirmDialog("검색어 삭제", `${selected.size}개 검색어를 삭제할까요?`, "삭제"))) return;
    await post("/api/presets/delete", { field, keywords: [...selected] });
    selected = new Set();
    changed = true;
    await reload();
  };
  keywordInput.addEventListener("keydown", (event) => event.key === "Enter" && add());
  render();

  return modal({
    title: "빠른 검색어 관리",
    width: "480px",
    build: () =>
      el("div", {},
        el("div", { class: "row-inline" },
          el("span", { text: "검색 종류" }),
          ...["상품명", "바코드"].map((name) =>
            el("label", {},
              el("input", { type: "radio", name: "preset-field", checked: name === field, onchange: () => { field = name; selected = new Set(); render(); } }),
              ` ${name}`))),
        el("div", { class: "row-inline" }, keywordInput, el("button", { type: "button", text: "추가", onclick: add })),
        el("div", { style: "margin-top:8px" }, list),
        el("div", { class: "row-inline" },
          el("button", { type: "button", text: "위로", onclick: () => move(-1) }),
          el("button", { type: "button", text: "아래로", onclick: () => move(1) }),
          el("button", { type: "button", text: "선택 삭제", onclick: remove }))),
    buttons: [{ label: "닫기", primary: true, onClick: (close) => (close(changed), true) }],
  }).then((value) => value ?? changed);
}

// ---------------------------------------------------------- output save

export async function outputSaveDialog(onStatus) {
  const options = await get("/api/outputs/options");
  const prefixInput = el("input", { type: "text", value: options.prefix, style: "width:100%" });
  const rows = new Map();
  const autoNames = new Map();
  const summary = el("pre");
  let timer = null;
  let latest = 0;

  const planBody = () => ({
    prefix: prefixInput.value,
    plans: options.outputs.map((o) => {
      const row = rows.get(o.key);
      return {
        key: o.key,
        enabled: o.available && row.enabled.checked,
        appends: options.sources.map(([key]) => key).filter((key) => row.appends.get(key).checked),
        filename: row.filename.value.trim(),
      };
    }),
  });

  const recount = async ({ forceNames = false } = {}) => {
    const ticket = ++latest;
    summary.textContent = "계산 중…";
    const body = planBody();
    const result = await post("/api/outputs/plan", body);
    if (ticket !== latest) return;
    const byKey = new Map(result.outputs.map((o) => [o.key, o]));
    const lines = [];
    for (const output of options.outputs) {
      const row = rows.get(output.key);
      const info = byKey.get(output.key);
      row.count.textContent = info ? `${info.total.toLocaleString()}행` : "";
      if (info) {
        // 사용자가 직접 고친 파일명은 그대로 두고, 자동 이름만 행수에 맞춰 바꾼다.
        if (forceNames || row.filename.value === autoNames.get(output.key)) {
          row.filename.value = info.filename;
          autoNames.set(output.key, info.filename);
        }
        lines.push(`${output.label.padEnd(10)}${info.total.toLocaleString().padStart(9)}행  =  ${info.summary}`);
      }
    }
    summary.textContent = lines.length ? lines.join("\n") : "선택된 출력이 없습니다.";
  };
  const schedule = (opts) => {
    clearTimeout(timer);
    timer = setTimeout(() => recount(opts).catch((exc) => (summary.textContent = exc.message)), 120);
  };

  const tbody = el("tbody");
  for (const output of options.outputs) {
    const enabled = el("input", { type: "checkbox", checked: output.available, disabled: !output.available, onchange: () => schedule() });
    const filename = el("input", { type: "text", value: output.fixed_filename || "", disabled: !output.available });
    autoNames.set(output.key, filename.value);
    const appends = new Map();
    const appendCells = options.sources.map(([key]) => {
      const box = el("input", { type: "checkbox", checked: output.default_appends.includes(key), disabled: !output.available, onchange: () => schedule() });
      appends.set(key, box);
      return el("td", { class: "c" }, box);
    });
    const count = el("td", { class: "num muted" });
    rows.set(output.key, { enabled, filename, appends, count });
    tbody.append(
      el("tr", {}, el("td", {}, enabled), el("td", { text: output.label }), el("td", {}, filename), ...appendCells, count),
      el("tr", { class: `desc${output.available ? "" : " unavailable"}` }, el("td"), el("td", { colspan: 7, text: `└ ${output.note}` })),
    );
  }

  // 통합 엑셀
  const workbookOn = el("input", { type: "checkbox", checked: Boolean(options.template) });
  const templateName = el("span", { class: options.template ? "" : "muted", text: options.template || "올린 템플릿 없음" });
  const templateFile = el("input", { type: "file", accept: ".xlsx", hidden: true });
  const workbookName = el("input", { type: "text", value: options.workbook_filename, style: "flex:1" });
  templateFile.addEventListener("change", async () => {
    const file = templateFile.files[0];
    templateFile.value = "";
    if (!file) return;
    try {
      const result = await upload("/api/outputs/template", file);
      templateName.textContent = result.template;
      templateName.className = "";
      workbookOn.checked = true;
    } catch (exc) {
      await alertDialog("템플릿 오류", exc.message);
    }
  });
  // 사이트 게시: 저장하는 출력 중 하나를 KRS Master 사이트의 현재 마스터로 바로 교체한다.
  const publishSelect = el("select", {},
    el("option", { value: "", text: "게시 안 함" }),
    ...options.outputs.filter((o) => o.available).map((o) => el("option", { value: o.key, text: o.label })));
  const publishSection = options.publish_enabled
    ? el("fieldset", {},
        el("legend", { text: "사이트 게시 (KRS Master)" }),
        el("div", { class: "row-inline" }, el("span", { text: "사이트 현재 마스터로 게시" }), publishSelect),
        el("p", { class: "note", text: "└ 고른 출력이 사이트의 현재 마스터(모든 사용자의 검색·스캐너 기준)를 바로 교체합니다. 그 출력도 저장 대상으로 체크되어 있어야 합니다." }))
    : null;

  prefixInput.addEventListener("input", () => {
    workbookName.value = (prefixInput.value.replace(/^_+|_+$/g, "") ? `${prefixInput.value.replace(/^_+|_+$/g, "")}_통합마스터.xlsx` : "통합마스터.xlsx");
    schedule({ forceNames: true });
  });

  const content = el("div", {},
    el("div", { class: "row-inline" }, el("label", { text: "파일명 접두어" }), prefixInput),
    el("table", { class: "grid save-table", style: "margin-top:10px" },
      el("thead", {}, el("tr", {}, el("th", { text: "저장" }), el("th", { text: "출력" }), el("th", { text: "파일명" }),
        ...options.sources.map(([, label]) => el("th", { class: "c", text: label })), el("th", { class: "num", text: "행수" }))),
      tbody),
    el("div", { class: "summary-box" }, el("div", { class: "note", text: "저장될 행수 (중복 바코드 제외 후)" }), summary),
    el("fieldset", {},
      el("legend", { text: "통합 엑셀 (krs_gs25 임포트용)" }),
      el("label", {}, workbookOn, " 이번 출력으로 시트를 교체한 통합 엑셀도 저장"),
      el("div", { class: "row-inline" }, el("span", { text: "템플릿 엑셀" }), templateName, templateFile,
        el("button", { type: "button", text: "템플릿 올리기", onclick: () => templateFile.click() })),
      el("div", { class: "row-inline" }, el("span", { text: "저장 파일명" }), workbookName),
      el("p", { class: "note", text: "└ 번들·종량제·서비스·점포코드·함수저장 시트와, 이번에 저장하지 않는 출력의 시트는 템플릿 그대로 복사됩니다(수식 포함). 템플릿은 모든 사용자가 같이 씁니다." }),
      el("p", { class: "note", text: `└ 교체 시트: ${options.sheet_pairs.map(([label, sheet]) => `${label}→${sheet}`).join(", ")}` })),
    publishSection,
    el("p", { class: "note", text: "저장하면 선택한 파일을 zip 하나로 내려받습니다. PDA Short는 master.txt로 들어 있습니다." }));

  await recount({ forceNames: true }).catch((exc) => (summary.textContent = exc.message));

  return modal({
    title: "출력 저장",
    width: "1000px",
    build: () => content,
    buttons: [
      { label: "취소", value: null },
      {
        label: "저장",
        primary: true,
        onClick: async (close) => {
          clearTimeout(timer);
          await recount();
          const body = planBody();
          const chosen = body.plans.filter((p) => p.enabled);
          if (!chosen.length) {
            await alertDialog("선택 없음", "저장할 출력을 하나 이상 선택하세요.");
            return false;
          }
          if (chosen.some((p) => !p.filename)) {
            await alertDialog("입력 오류", "파일명이 비어 있는 출력이 있습니다.");
            return false;
          }
          if (new Set(chosen.map((p) => p.filename)).size !== chosen.length) {
            await alertDialog("입력 오류", "출력 파일명이 서로 중복됩니다.");
            return false;
          }
          const publish = publishSelect.value;
          if (publish) {
            if (!chosen.some((p) => p.key === publish)) {
              await alertDialog("사이트 게시", "게시할 출력도 저장 대상으로 체크하세요.");
              return false;
            }
            const label = options.outputs.find((o) => o.key === publish).label;
            if (!(await confirmDialog("사이트 게시 확인", `${label} 출력으로 사이트의 현재 마스터를 교체합니다.\n모든 사용자의 검색·스캐너 기준이 바뀝니다. 계속할까요?`, "게시"))) return false;
          }
          onStatus?.("출력 파일을 만드는 중…");
          try {
            const result = await post("/api/outputs/save", {
              ...body,
              plans: chosen,
              workbook: workbookOn.checked,
              workbook_filename: workbookName.value.trim(),
              publish,
            });
            if (!result.ok) {
              await alertDialog("저장 불가", result.message);
              return false;
            }
            close(result);
            return true;
          } catch (exc) {
            await alertDialog("저장 오류", exc.message);
            return false;
          }
        },
      },
    ],
  });
}
