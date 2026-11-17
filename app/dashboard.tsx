"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { runMessages } from "../src/domain";
import type { Run, Status, WorkerActivity } from "../src/domain";

type Filter = "all" | "approval" | "failed";
type Snapshot = { runs: Run[]; activity: WorkerActivity[]; demo: boolean; provider: string; actionTarget?: string };

const statusLabels: Record<Status, string> = {
  queued: "Queued", running: "Running", retrying: "Retry scheduled",
  awaiting_approval: "Awaiting approval", completed: "Completed", rejected: "Rejected", failed: "Failed", cancelled: "Cancelled"
};
const filterItems: { id: Filter; label: string; symbol: string }[] = [
  { id: "all", label: "All runs", symbol: "≋" },
  { id: "approval", label: "Approvals", symbol: "◇" },
  { id: "failed", label: "Failures", symbol: "△" }
];
const time = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hourCycle: "h23" });
const day = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function StatusPill({ status }: { status: Status }) {
  return <span className={"status " + status}><i aria-hidden="true" />{statusLabels[status]}</span>;
}

async function api<T>(path: string, token: string, body?: Record<string, string | undefined> | null, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    signal,
    headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (response.status === 401) throw new Error("Access denied. Check your operator token.");
  if (response.status === 409) throw new Error("The run or delivery destination changed. Refresh and check its current state.");
  if (!response.ok) throw new Error("The request failed. Try again.");
  return response.json();
}

export function Dashboard({ localDemo }: { localDemo: boolean }) {
  const [token, setToken] = useState(localDemo ? "flowpulse-local-demo" : "");
  const [credential, setCredential] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [action, setAction] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await api<Snapshot>("runs", token, undefined, signal);
    if (!signal?.aborted) setSnapshot(result);
    return result;
  }, [token]);

  useEffect(() => {
    if (!token || action) return;
    const controller = new AbortController();
    let running = false;
    async function sync() {
      if (running) return;
      running = true;
      try {
        await refresh(controller.signal);
      } catch (problem) {
        if (!controller.signal.aborted) setError((problem as Error).message);
      } finally {
        running = false;
      }
    }
    void sync();
    const interval = setInterval(sync, 4000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [action, refresh, token]);

  const runs = snapshot?.runs ?? [];
  const query = search.trim().toLowerCase();
  const visible = runs.filter(run =>
    (filter === "all" || run.status === (filter === "approval" ? "awaiting_approval" : "failed")) &&
    `${run.subject} ${run.event_id}`.toLowerCase().includes(query));
  const pricedRuns = runs.flatMap(run => run.classifier_telemetry?.estimatedUsd ?? []);
  const recentCost = pricedRuns.reduce((total, cost) => total + cost, 0);
  const selected = visible.find(run => run.id === selectedId) ?? visible[0];
  const pending = runs.filter(run => run.status === "awaiting_approval").length;
  const failures = runs.filter(run => run.status === "failed").length;
  const active = runs.filter(run => ["queued", "running", "retrying"].includes(run.status)).length;

  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setToken(credential.trim());
    setCredential("");
  }

  function signOut() {
    setToken("");
    setSnapshot(null);
    setSelectedId("");
    setSearch("");
    setError("");
  }

  async function invoke(label: string, work: () => Promise<void>) {
    setAction(label);
    setError("");
    try {
      await work();
      await refresh();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setAction("");
    }
  }

  async function sample() {
    const { id } = await api<{ id: string }>("demo/sample", token, null);
    setFilter("all");
    setSearch("");
    setSelectedId(id);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await api("demo/tick", token, null);
      const result = await refresh();
      const run = result.runs.find(item => item.id === id);
      if (run?.status === "awaiting_approval" || run?.status === "failed") return;
      await wait(500);
    }
    throw new Error("The sample is still queued. Use Process next or start the local worker.");
  }

  return <div className="shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="FlowPulse home"><span className="brand-mark" aria-hidden="true">ϟ</span>FlowPulse</a>
      {snapshot && <nav aria-label="Run views">
        <p className="nav-title">WORKSPACE</p>
        {filterItems.map(item => <button key={item.id} onClick={() => setFilter(item.id)} aria-current={filter === item.id ? "page" : undefined}>
          <span className="nav-symbol" aria-hidden="true">{item.symbol}</span>{item.label}
          {item.id === "approval" && pending > 0 && <span className="nav-count">{pending}</span>}
        </button>)}
      </nav>}
      <div className="sidebar-bottom">
        <span className="workspace-dot" />
        <div>{snapshot?.demo ? "Local demo" : "Operator workspace"}
          <small>{snapshot?.provider === "openai" ? "Model classifier" : "Support workflows"}</small>
        </div>
      </div>
    </aside>

    <main>
      <header className="topbar">
        <span>Workspace <span aria-hidden="true" className="breadcrumb">/</span> <strong>Support operations</strong></span>
        {token && <button className="quiet" disabled={!!action} onClick={signOut}>Sign out</button>}
      </header>

      <div className="content">
        <section className="hero">
          <div><h1>Workflow runs</h1><p>Follow support events from intake through draft approval.</p></div>
          {snapshot?.demo && <div className="hero-actions">
            <button className="outline" disabled={!!action} onClick={() => void invoke("Processing", async () => { await api("demo/tick", token, null); })}>Process next</button>
            <button className="primary" disabled={!!action} onClick={() => void invoke("Running sample", sample)}>{action === "Running sample" ? "Running…" : "Run sample"}</button>
          </div>}
        </section>

        {error && <p className="alert" role="alert">{error}</p>}
        {!snapshot && <section className="panel login">
          {token && !error ? <output>Connecting to the workspace…</output> : <form onSubmit={login}>
            <h2>Operator access</h2>
            <label htmlFor="operator-token">Operator token</label>
            <input id="operator-token" type="password" value={credential} onChange={event => setCredential(event.target.value)} autoComplete="off" required />
            <button className="primary" type="submit">Connect</button>
          </form>}
        </section>}

        {snapshot && <>
          <div className="metrics" aria-label="Recent run counts">
            {[["Recent runs", runs.length, "all"], ["In progress", active, ""], ["Awaiting approval", pending, "approval"], ["Failures", failures, "failed"]].map(([label, count, target]) =>
              <div className="metric" key={label}>
                <span>{label}</span><strong>{count}</strong>
                {target && <button className="metric-link" onClick={() => setFilter(target as Filter)} aria-label={"View " + String(label).toLowerCase()}>↗</button>}
              </div>)}
          </div>
          {pricedRuns.length > 0 && <p>Estimated model cost for {pricedRuns.length} recent runs: ${recentCost.toFixed(6)}</p>}
          <section className="panel worker-activity">
            <h2>Worker activity</h2>
            {snapshot.activity.length ? snapshot.activity.map(item => <div key={item.source}>
              <strong>{item.source === "worker" ? "Worker API" : "Manual demo"}</strong>
              <span>Last poll <time dateTime={item.last_tick_at}>{day.format(new Date(item.last_tick_at))} · {time.format(new Date(item.last_tick_at))} UTC</time></span>
              <span>{item.ticks} polls · {item.idle_ticks} idle · {item.finished_steps} finished · {item.retrying_steps} retried · {item.failed_steps} failed</span>
            </div>) : <p>No worker polls have been recorded.</p>}
          </section>
          <div className="work-area">
            <section className="panel" aria-label="Runs">
              <header className="panel-header"><div><h2>{filter === "all" ? "Recent runs" : filter === "approval" ? "Approval queue" : "Failed runs"}</h2><p>Newest events first · UTC</p></div><span className="panel-count">{visible.length}</span></header>
              <div className="run-search"><label htmlFor="run-search">Search runs</label><input id="run-search" type="search" placeholder="Subject or event ID" value={search} onChange={event => setSearch(event.target.value)} /></div>
              {query && visible.length === 0 ? <output className="empty">No runs match your search.</output> : visible.length === 0 ? <div className="empty"><span aria-hidden="true">≋</span><h3>{filter === "all" ? "No events yet" : filter === "approval" ? "No drafts to review" : "No failed runs"}</h3>
                <p>{filter === "all" && snapshot.demo ? "Run a sample to see intake, retry and approval in one workflow." : "Incoming runs appear here automatically."}</p></div> :
                <div className="table-scroll"><table>
                  <thead><tr><th scope="col">Event</th><th scope="col">Status</th><th scope="col" className="attempts">Attempts</th><th scope="col">Received</th></tr></thead>
                  <tbody>{visible.map(run => <tr key={run.id} data-selected={run.id === selected?.id}>
                    <td><button className="run-link" aria-pressed={run.id === selected?.id} onClick={() => setSelectedId(run.id)}>{run.subject}</button>
                      <small>{run.event_id.length > 28 ? run.event_id.slice(0, 25) + "…" : run.event_id}</small></td>
                    <td><StatusPill status={run.status} /></td>
                    <td className="attempts">{run.attempts}</td>
                    <td className="received"><time dateTime={run.created_at}>{day.format(new Date(run.created_at))} · {time.format(new Date(run.created_at))}</time></td>
                  </tr>)}</tbody>
                </table></div>}
            </section>

            <section className="panel inspector" aria-label="Run details">
              <header className="panel-header"><div><h2>Run details</h2><p>Classification and execution trace</p></div></header>
              {!selected ? <div className="empty detail-empty"><span aria-hidden="true">◇</span><p>Select a run to inspect its details.</p></div> :
                <div className="details">
                  <div className="run-heading"><StatusPill status={selected.status} /><h3>{selected.subject}</h3></div>
                  {selected.action_target && <p className="delivery-target">Delivery destination <strong>{selected.action_target}</strong></p>}
                  {selected.error_code && <div className="error-detail"><strong>{selected.status === "retrying" ? "Retry scheduled" : "Execution error"}</strong><code>{selected.error_code}</code>{selected.status === "retrying" && <small>Eligible at {time.format(new Date(selected.available_at))} UTC</small>}</div>}
                  {selected.classification && <dl className="classification">
                    <div><dt>Category</dt><dd>{selected.classification.category}</dd></div>
                    <div><dt>Priority</dt><dd>{selected.classification.priority}</dd></div>
                    {selected.classification.team && <div><dt>Suggested team</dt><dd>{selected.classification.team}</dd></div>}
                  </dl>}
                  {selected.classifier_telemetry && <dl className="classification" aria-label="Model usage">
                    <div><dt>Model</dt><dd>{selected.classifier_telemetry.model}</dd></div>
                    <div><dt>Response time</dt><dd>{selected.classifier_telemetry.latencyMs} ms</dd></div>
                    {selected.classifier_telemetry.inputTokens !== undefined && <div><dt>Tokens in / out</dt><dd>{selected.classifier_telemetry.inputTokens} / {selected.classifier_telemetry.outputTokens}</dd></div>}
                    {selected.classifier_telemetry.estimatedUsd !== undefined && <div><dt>Estimated cost</dt><dd>${selected.classifier_telemetry.estimatedUsd.toFixed(6)}</dd></div>}
                  </dl>}
                  {selected.draft && <div className="draft"><h4>Notification draft</h4><pre>{selected.draft}</pre></div>}
                  {selected.status === "awaiting_approval" && <>
                    {snapshot.actionTarget && <p className="delivery-target">Delivery destination <strong>{snapshot.actionTarget}</strong></p>}
                    <div className="review-actions">
                      <button className="secondary" disabled={!!action} onClick={() => void invoke("Rejecting", async () => { await api("runs/" + selected.id + "/decision", token, { decision: "reject" }); })}>Reject</button>
                      <button className="primary" disabled={!!action} onClick={() => void invoke("Approving", async () => { await api("runs/" + selected.id + "/decision", token, { decision: "approve", target: snapshot.actionTarget }); })}>{snapshot.actionTarget ? "Approve delivery" : "Approve draft"}</button>
                    </div>
                  </>}
                  {selected.status === "failed" && selected.manual_retries < 3 && <div className="review-actions">
                    <button className="secondary" disabled={!!action} onClick={() => void invoke("Retrying", async () => { await api("runs/" + selected.id + "/operation", token, { operation: "retry" }); })}>Retry failed step</button>
                  </div>}
                  {["queued", "retrying", "awaiting_approval"].includes(selected.status) && <div className="review-actions">
                    <button className="secondary" disabled={!!action} onClick={() => void invoke("Cancelling", async () => { await api("runs/" + selected.id + "/operation", token, { operation: "cancel" }); })}>Cancel pending work</button>
                  </div>}
                  <div className="trace"><h4>Execution trace</h4><ol>
                    {selected.trace.map((entry, index) => <li key={index}><span>{runMessages[entry.step]}</span>
                      <small><time dateTime={entry.at}>{time.format(new Date(entry.at))} UTC</time>{entry.attempt > 0 && " · Attempt " + entry.attempt}</small></li>)}
                  </ol></div>
                </div>}
            </section>
          </div>
        </>}
      </div>
    </main>
  </div>;
}
