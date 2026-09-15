(() => {
  const endpoint = "/livescore/api/scoreboard.php";
  const refreshIntervalMs = 30_000;
  const elements = {
    button: document.querySelector("#refresh-button"),
    retry: document.querySelector("#retry-button"),
    table: document.querySelector("#scoreboard-table"),
    body: document.querySelector("#scoreboard-body"),
    loading: document.querySelector("#loading-state"),
    empty: document.querySelector("#empty-state"),
    error: document.querySelector("#error-state"),
    errorMessage: document.querySelector("#error-message"),
    entryCount: document.querySelector("#entry-count"),
    refreshNote: document.querySelector("#refresh-note"),
  };

  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const dateTime = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short",
  });

  function numeric(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }
  function formatNumber(value) {
    return value === null || value === undefined
      ? "—"
      : number.format(numeric(value));
  }
  function formatUpdated(value) {
    return value ? dateTime.format(new Date(value)) : "—";
  }
  function showState(name) {
    ["loading", "empty", "error", "table"].forEach((key) => {
      elements[key].hidden = key !== name;
    });
  }
  function sourceTitle(entry) {
    if (
      entry.source_timestamp_quality === "UNZONED_SOURCE_TEXT" &&
      entry.source_timestamp_raw
    ) {
      return `Source timestamp (timezone not supplied): ${entry.source_timestamp_raw}`;
    }
    return entry.source_timestamp
      ? `Source timestamp: ${entry.source_timestamp}`
      : "Source timestamp unavailable";
  }
  function cell(row, value, className = "") {
    const item = document.createElement("td");
    item.className = className;
    item.textContent = value;
    row.append(item);
    return item;
  }
  function render(entries) {
    const sorted = [...entries].sort(
      (a, b) =>
        numeric(b.score) - numeric(a.score) ||
        String(a.callsign).localeCompare(String(b.callsign)),
    );
    elements.body.replaceChildren();
    sorted.forEach((entry, index) => {
      const row = document.createElement("tr");
      cell(row, String(index + 1), "rank-value");
      cell(row, entry.callsign || "—", "callsign");
      cell(row, formatNumber(entry.score), "number score");
      cell(row, formatNumber(entry.qso), "number");
      cell(row, formatNumber(entry.points), "number");
      cell(row, formatNumber(entry.multipliers), "number");
      const source = cell(row, "", "source-cell");
      source.title = sourceTitle(entry);
      const dot = document.createElement("span");
      dot.className = "source-dot";
      dot.setAttribute("aria-hidden", "true");
      source.append(dot, document.createTextNode(entry.source || "Unknown"));
      if (!entry.canonical) {
        const tag = document.createElement("span");
        tag.className = "observed-tag";
        tag.textContent = "Observed";
        source.append(tag);
      }
      const updated = cell(row, formatUpdated(entry.received_at), "updated");
      updated.title = entry.received_at || "";
      elements.body.append(row);
    });
    elements.entryCount.textContent = `${sorted.length} ${sorted.length === 1 ? "station" : "stations"} reporting`;
    elements.refreshNote.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    showState("table");
  }
  async function load({ initial = false } = {}) {
    if (initial) showState("loading");
    elements.button.disabled = true;
    try {
      const response = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(`The score service returned ${response.status}.`);
      const payload = await response.json();
      if (!Array.isArray(payload.entries))
        throw new Error("The score service returned an unexpected response.");
      if (payload.entries.length) {
        render(payload.entries);
      } else {
        elements.entryCount.textContent = "No stations reporting";
        showState("empty");
      }
    } catch (error) {
      elements.errorMessage.textContent =
        error instanceof Error
          ? error.message
          : "Please try refreshing in a moment.";
      elements.entryCount.textContent = "Unable to load stations";
      showState("error");
    } finally {
      elements.button.disabled = false;
    }
  }
  elements.button.addEventListener("click", () => load());
  elements.retry.addEventListener("click", () => load());
  load({ initial: true });
  window.setInterval(() => load(), refreshIntervalMs);
})();
