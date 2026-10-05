// Virtual-scroll table: renders only the rows on screen and fetches pages on demand,
// so a 100,000-row master scrolls as smoothly as a short list.

const ROW_HEIGHT = 24;
const PAGE_SIZE = 200;
const OVERSCAN = 8;

export class VirtualTable {
  /**
   * @param {HTMLElement} host
   * @param {object} options
   *   columns: [{key, label, width, cls, sortable}]
   *   fetchPage(offset, limit) -> Promise<{total, rows}>
   *   sort: {column, reverse}; onSort(column)
   *   onActivate(row), onSpace(), onDelete()  -- keyboard / double-click hooks
   *   onSelectionChange()
   */
  constructor(host, options) {
    this.host = host;
    this.options = options;
    this.total = 0;
    this.pages = new Map();
    this.loading = new Map();
    this.generation = 0;
    this.selected = new Set();
    this.allVisible = false;
    this.focusIndex = -1;
    this.anchorIndex = -1;
    this.build();
  }

  build() {
    const { columns } = this.options;
    this.template = columns.map((c) => c.width || "1fr").join(" ");
    this.root = document.createElement("div");
    this.root.className = "vt";
    this.root.tabIndex = 0;

    this.head = document.createElement("div");
    this.head.className = "vt-head";
    this.head.style.gridTemplateColumns = this.template;
    for (const column of columns) {
      const cell = document.createElement("div");
      cell.textContent = column.label;
      if (column.sortable) {
        cell.classList.add("sortable");
        cell.addEventListener("click", () => this.options.onSort?.(column.key));
      }
      cell.dataset.key = column.key;
      this.head.append(cell);
    }

    this.scroller = document.createElement("div");
    this.scroller.className = "vt-scroll";
    this.spacer = document.createElement("div");
    this.spacer.className = "vt-spacer";
    this.scroller.append(this.spacer);
    this.empty = document.createElement("div");
    this.empty.className = "vt-empty";
    this.empty.textContent = "표시할 행이 없습니다.";
    this.empty.hidden = true;

    this.root.append(this.head, this.scroller, this.empty);
    this.host.replaceChildren(this.root);

    this.scroller.addEventListener("scroll", () => this.render());
    this.spacer.addEventListener("mousedown", (event) => this.onMouseDown(event));
    this.spacer.addEventListener("dblclick", (event) => {
      const index = this.indexFromEvent(event);
      const row = this.rowAt(index);
      if (row) this.options.onActivate?.(row, index);
    });
    this.root.addEventListener("keydown", (event) => this.onKeyDown(event));
    new ResizeObserver(() => this.render()).observe(this.scroller);
    this.markSort();
  }

  markSort() {
    const { sort } = this.options;
    for (const cell of this.head.children) {
      const column = this.options.columns.find((c) => c.key === cell.dataset.key);
      cell.textContent = column.label + (sort && sort.column === column.key ? (sort.reverse ? " ▼" : " ▲") : "");
    }
  }

  async reload({ keepSelection = false, keepScroll = true } = {}) {
    this.generation += 1;
    this.pages.clear();
    this.loading.clear();
    if (!keepSelection) {
      this.selected.clear();
      this.allVisible = false;
    }
    if (!keepScroll) this.scroller.scrollTop = 0;
    const first = await this.loadPage(0);
    if (first === null) return;
    this.total = first.total;
    if (this.focusIndex >= this.total) this.focusIndex = this.total - 1;
    this.spacer.style.height = `${this.total * ROW_HEIGHT}px`;
    this.empty.hidden = this.total > 0;
    this.render();
    this.options.onSelectionChange?.();
  }

  async loadPage(page) {
    if (this.pages.has(page)) return { total: this.total, rows: this.pages.get(page) };
    if (this.loading.has(page)) return this.loading.get(page);
    const generation = this.generation;
    const promise = this.options
      .fetchPage(page * PAGE_SIZE, PAGE_SIZE)
      .then((result) => {
        if (generation !== this.generation) return null;
        this.pages.set(page, result.rows);
        this.loading.delete(page);
        if (result.total !== this.total) {
          this.total = result.total;
          this.spacer.style.height = `${this.total * ROW_HEIGHT}px`;
        }
        return result;
      })
      .catch((error) => {
        this.loading.delete(page);
        throw error;
      });
    this.loading.set(page, promise);
    return promise;
  }

  rowAt(index) {
    if (index < 0 || index >= this.total) return null;
    const page = this.pages.get(Math.floor(index / PAGE_SIZE));
    return page ? page[index % PAGE_SIZE] || null : null;
  }

  async rowsInRange(start, end) {
    for (let page = Math.floor(start / PAGE_SIZE); page <= Math.floor(end / PAGE_SIZE); page += 1) {
      await this.loadPage(page);
    }
    const rows = [];
    for (let index = start; index <= end; index += 1) {
      const row = this.rowAt(index);
      if (row) rows.push(row);
    }
    return rows;
  }

  visibleRange() {
    const height = this.scroller.clientHeight || 400;
    const first = Math.max(0, Math.floor(this.scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(this.total - 1, Math.ceil((this.scroller.scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
    return [first, last];
  }

  render() {
    const [first, last] = this.visibleRange();
    const fragment = document.createDocumentFragment();
    const missing = new Set();
    for (let index = first; index <= last; index += 1) {
      const row = this.rowAt(index);
      if (!row) missing.add(Math.floor(index / PAGE_SIZE));
      fragment.append(this.renderRow(row, index));
    }
    this.spacer.replaceChildren(fragment);
    for (const page of missing) {
      this.loadPage(page).then((result) => result && this.render()).catch(() => {});
    }
  }

  renderRow(row, index) {
    const element = document.createElement("div");
    element.className = "vt-row";
    element.style.top = `${index * ROW_HEIGHT}px`;
    element.style.gridTemplateColumns = this.template;
    element.dataset.index = String(index);
    if (!row) {
      element.classList.add("loading");
      const cell = document.createElement("div");
      cell.textContent = "…";
      element.append(cell);
      return element;
    }
    if (row.checked) element.classList.add("checked");
    if (row.malformed) element.classList.add("malformed");
    if (this.isSelected(row)) element.classList.add("selected");
    if (index === this.focusIndex) element.classList.add("focused");
    for (const column of this.options.columns) {
      const cell = document.createElement("div");
      if (column.cls) cell.className = column.cls;
      const value = column.render ? column.render(row) : row[column.key];
      cell.textContent = value === undefined || value === null ? "" : String(value);
      cell.title = cell.textContent;
      element.append(cell);
    }
    return element;
  }

  isSelected(row) {
    return this.allVisible || this.selected.has(row.key);
  }

  indexFromEvent(event) {
    const rect = this.spacer.getBoundingClientRect();
    return Math.floor((event.clientY - rect.top) / ROW_HEIGHT);
  }

  async onMouseDown(event) {
    if (event.button !== 0) return;
    // The clicked row element is replaced by render() below; without this the
    // browser's default mousedown handling moves focus to <body> and the table
    // stops receiving Space/Delete/arrow keys. Also avoids text selection on shift-click.
    event.preventDefault();
    this.root.focus();
    const index = this.indexFromEvent(event);
    const row = this.rowAt(index);
    if (!row) return;
    if (event.shiftKey && this.anchorIndex >= 0) {
      await this.selectRange(this.anchorIndex, index, event.ctrlKey || event.metaKey);
    } else if (event.ctrlKey || event.metaKey) {
      this.materializeAll();
      if (this.selected.has(row.key)) this.selected.delete(row.key);
      else this.selected.add(row.key);
      this.anchorIndex = index;
    } else {
      this.allVisible = false;
      this.selected = new Set([row.key]);
      this.anchorIndex = index;
    }
    this.focusIndex = index;
    this.render();
    this.options.onSelectionChange?.();
  }

  // 'all visible' is kept as a flag (rows may not be loaded); ctrl-click needs real keys.
  materializeAll() {
    if (!this.allVisible) return;
    this.allVisible = false;
    this.selected = new Set();
    for (const rows of this.pages.values()) for (const row of rows) this.selected.add(row.key);
  }

  async selectRange(from, to, additive) {
    const [start, end] = from <= to ? [from, to] : [to, from];
    const rows = await this.rowsInRange(start, end);
    if (!additive) {
      this.allVisible = false;
      this.selected = new Set();
    }
    for (const row of rows) this.selected.add(row.key);
  }

  async moveFocus(delta, extend) {
    if (this.total === 0) return;
    const start = this.focusIndex < 0 ? 0 : this.focusIndex;
    const next = Math.max(0, Math.min(this.total - 1, start + delta));
    await this.rowsInRange(next, next);
    this.focusIndex = next;
    if (extend && this.anchorIndex >= 0) {
      await this.selectRange(this.anchorIndex, next, false);
    } else {
      const row = this.rowAt(next);
      this.allVisible = false;
      this.selected = new Set(row ? [row.key] : []);
      this.anchorIndex = next;
    }
    const top = next * ROW_HEIGHT;
    if (top < this.scroller.scrollTop) this.scroller.scrollTop = top;
    else if (top + ROW_HEIGHT > this.scroller.scrollTop + this.scroller.clientHeight) {
      this.scroller.scrollTop = top + ROW_HEIGHT - this.scroller.clientHeight;
    }
    this.render();
    this.options.onSelectionChange?.();
  }

  onKeyDown(event) {
    const pageRows = Math.max(1, Math.floor(this.scroller.clientHeight / ROW_HEIGHT) - 1);
    const handlers = {
      ArrowDown: () => this.moveFocus(1, event.shiftKey),
      ArrowUp: () => this.moveFocus(-1, event.shiftKey),
      PageDown: () => this.moveFocus(pageRows, event.shiftKey),
      PageUp: () => this.moveFocus(-pageRows, event.shiftKey),
      Home: () => this.moveFocus(-this.total, event.shiftKey),
      End: () => this.moveFocus(this.total, event.shiftKey),
      Delete: () => this.options.onDelete?.(),
      " ": () => this.options.onSpace?.(),
      Enter: () => {
        const row = this.rowAt(this.focusIndex);
        if (row) this.options.onActivate?.(row, this.focusIndex);
      },
    };
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this.allVisible = this.total > 0;
      this.selected.clear();
      this.render();
      this.options.onSelectionChange?.();
      return;
    }
    const handler = handlers[event.key];
    if (handler) {
      event.preventDefault();
      handler();
    }
  }

  selectionCount() {
    return this.allVisible ? this.total : this.selected.size;
  }

  // What an API action should apply to (see Selection in server/api.py).
  selection() {
    return { keys: [...this.selected], all_visible: this.allVisible };
  }

  firstSelectedRow() {
    for (const rows of this.pages.values()) {
      for (const row of rows) if (this.isSelected(row)) return row;
    }
    return null;
  }

  setSort(sort) {
    this.options.sort = sort;
    this.markSort();
  }
}
