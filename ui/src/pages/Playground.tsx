import { useEffect, useMemo, useState } from "react";
import { useToast } from "../context/ToastContext";
import {
  IconCheck,
  IconCopy,
  IconPlay,
  IconPlus,
  IconSave,
  IconTrash,
} from "../icons";

const WORKSPACE_KEY = "restly-request-workspace";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const REQUEST_TABS = ["Params", "Headers", "Body", "Tests"] as const;
const RESPONSE_TABS = ["Pretty", "Raw", "Headers", "Tests"] as const;

type HttpMethod = (typeof METHODS)[number];
type RequestTab = (typeof REQUEST_TABS)[number];
type ResponseTab = (typeof RESPONSE_TABS)[number];

interface KeyValue {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

interface Assertion {
  id: string;
  kind: "status" | "json";
  path: string;
  expected: string;
  enabled: boolean;
}

interface RequestDraft {
  name: string;
  method: HttpMethod;
  path: string;
  params: KeyValue[];
  headers: KeyValue[];
  body: string;
  assertions: Assertion[];
}

interface SavedRequest extends RequestDraft {
  id: string;
  updatedAt: number;
}

interface HistoryItem {
  id: string;
  name: string;
  method: HttpMethod;
  path: string;
  status: number;
  durationMs: number;
  timestampMs: number;
}

interface Workspace {
  baseUrl: string;
  variables: KeyValue[];
  saved: SavedRequest[];
  history: HistoryItem[];
}

interface ResponseState {
  status: number;
  statusText: string;
  durationMs: number;
  size: number;
  url: string;
  text: string;
  pretty: string;
  headers: [string, string][];
  tests: TestResult[];
}

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const emptyRow = (): KeyValue => ({ id: makeId(), key: "", value: "", enabled: true });
const emptyAssertion = (): Assertion => ({
  id: makeId(),
  kind: "status",
  path: "",
  expected: "200",
  enabled: true,
});

const newDraft = (): RequestDraft => ({
  name: "Untitled request",
  method: "GET",
  path: "/data/users",
  params: [],
  headers: [],
  body: "{\n  \n}",
  assertions: [{ ...emptyAssertion(), expected: "200" }],
});

const TEMPLATES: { name: string; draft: RequestDraft }[] = [
  {
    name: "List documents",
    draft: {
      name: "List users",
      method: "GET",
      path: "/data/users",
      params: [
        { id: "limit", key: "limit", value: "50", enabled: true },
        { id: "sort", key: "sort", value: "-_updatedAt", enabled: true },
      ],
      headers: [],
      body: "",
      assertions: [{ ...emptyAssertion(), expected: "200" }],
    },
  },
  {
    name: "Create document",
    draft: {
      name: "Create user",
      method: "POST",
      path: "/data/users",
      params: [],
      headers: [{ id: "content-type", key: "Content-Type", value: "application/json", enabled: true }],
      body: '{\n  "name": "Ada Lovelace",\n  "active": true\n}',
      assertions: [{ ...emptyAssertion(), expected: "201" }],
    },
  },
  {
    name: "Find by filter",
    draft: {
      name: "Find active users",
      method: "GET",
      path: "/data/users",
      params: [
        { id: "active", key: "where.active", value: "true", enabled: true },
        { id: "sort", key: "sort", value: "-_updatedAt", enabled: true },
      ],
      headers: [],
      body: "",
      assertions: [{ ...emptyAssertion(), expected: "200" }],
    },
  },
  {
    name: "Server health",
    draft: {
      name: "Health",
      method: "GET",
      path: "/api/health",
      params: [],
      headers: [],
      body: "",
      assertions: [
        { ...emptyAssertion(), expected: "200" },
        { ...emptyAssertion(), kind: "json", path: "status", expected: '"ok"' },
      ],
    },
  },
];

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cloneDraft(draft: RequestDraft): RequestDraft {
  return {
    ...draft,
    params: draft.params.map((row) => ({ ...row, id: makeId() })),
    headers: draft.headers.map((row) => ({ ...row, id: makeId() })),
    assertions: draft.assertions.map((test) => ({ ...test, id: makeId() })),
  };
}

function loadWorkspace(): Workspace {
  const fallback: Workspace = { baseUrl: "", variables: [], saved: [], history: [] };
  try {
    const value = localStorage.getItem(WORKSPACE_KEY);
    if (!value) return fallback;
    const parsed = JSON.parse(value) as Partial<Workspace>;
    return {
      baseUrl: parsed.baseUrl ?? "",
      variables: parsed.variables ?? [],
      saved: parsed.saved ?? [],
      history: parsed.history ?? [],
    };
  } catch {
    return fallback;
  }
}

function resolveVariables(value: string, variables: Record<string, string>) {
  return value.replace(/{{\s*([^{}\s]+)\s*}}/g, (_whole, key: string) => {
    if (key === "$timestamp") return String(Date.now());
    if (key === "$uuid") return makeId();
    return variables[key] ?? `{{${key}}}`;
  });
}

function buildUrl(draft: RequestDraft, baseUrl: string, variables: Record<string, string>) {
  const path = resolveVariables(draft.path.trim(), variables);
  if (!path) throw new Error("A request path is required");
  const root = resolveVariables(baseUrl.trim(), variables).replace(/\/$/, "");
  const raw = /^https?:\/\//.test(path) ? path : `${root}${path.startsWith("/") ? path : `/${path}`}`;
  const url = new URL(raw, window.location.origin);
  for (const row of draft.params) {
    if (row.enabled && row.key.trim()) {
      url.searchParams.set(
        resolveVariables(row.key.trim(), variables),
        resolveVariables(row.value, variables),
      );
    }
  }
  return url.toString();
}

function jsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readJsonPath(value: unknown, path: string): unknown {
  if (!path.trim()) return value;
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, part) => {
      if (Array.isArray(current)) return current[Number(part)];
      if (current && typeof current === "object") return (current as Record<string, unknown>)[part];
      return undefined;
    }, value);
}

function evaluateTests(assertions: Assertion[], response: Pick<ResponseState, "status" | "text">): TestResult[] {
  let json: unknown;
  try {
    json = JSON.parse(response.text);
  } catch {
    json = undefined;
  }
  return assertions
    .filter((assertion) => assertion.enabled)
    .map((assertion) => {
      if (assertion.kind === "status") {
        const expected = Number(assertion.expected);
        const passed = response.status === expected;
        return {
          name: `Status is ${assertion.expected}`,
          passed,
          detail: `received ${response.status}`,
        };
      }
      const actual = readJsonPath(json, assertion.path);
      const expected = jsonValue(assertion.expected);
      const passed = JSON.stringify(actual) === JSON.stringify(expected);
      return {
        name: `JSON ${assertion.path || "$"} equals ${assertion.expected}`,
        passed,
        detail: `received ${actual === undefined ? "undefined" : JSON.stringify(actual)}`,
      };
    });
}

function statusTone(status: number) {
  if (status >= 500) return "text-err bg-err-soft";
  if (status >= 400) return "text-warn bg-warn-soft";
  if (status >= 300) return "text-info bg-info-soft";
  return "text-ok bg-ok-soft";
}

function methodTone(method: HttpMethod) {
  return {
    GET: "text-info",
    POST: "text-ok",
    PUT: "text-warn",
    PATCH: "text-warn",
    DELETE: "text-err",
  }[method];
}

function KeyValueEditor({
  rows,
  onChange,
  keyLabel,
  valueLabel,
}: {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  keyLabel: string;
  valueLabel: string;
}) {
  const update = (id: string, patch: Partial<KeyValue>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-[28px_minmax(0,1fr)_minmax(0,1fr)_32px] gap-1.5 px-1 font-mono text-[0.67rem] text-ink-faint">
        <span />
        <span>{keyLabel}</span>
        <span>{valueLabel}</span>
        <span />
      </div>
      {rows.map((row) => (
        <div key={row.id} className="grid grid-cols-[28px_minmax(0,1fr)_minmax(0,1fr)_32px] gap-1.5">
          <input
            type="checkbox"
            className="m-auto size-3.5 accent-[var(--accent)]"
            checked={row.enabled}
            onChange={(event) => update(row.id, { enabled: event.target.checked })}
            aria-label={`Enable ${row.key || keyLabel}`}
          />
          <input className="input py-1.5 font-mono text-[0.75rem]" value={row.key} onChange={(event) => update(row.id, { key: event.target.value })} />
          <input className="input py-1.5 font-mono text-[0.75rem]" value={row.value} onChange={(event) => update(row.id, { value: event.target.value })} />
          <button className="icon-btn danger size-8" onClick={() => onChange(rows.filter((entry) => entry.id !== row.id))} title="Remove row" aria-label="Remove row">
            <IconTrash size={14} />
          </button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm self-start" onClick={() => onChange([...rows, emptyRow()])}>
        <IconPlus size={14} /> Add row
      </button>
    </div>
  );
}

export default function PlaygroundPage() {
  const { push } = useToast();
  const [workspace, setWorkspace] = useState<Workspace>(loadWorkspace);
  const [draft, setDraft] = useState<RequestDraft>(newDraft);
  const [requestTab, setRequestTab] = useState<RequestTab>("Params");
  const [responseTab, setResponseTab] = useState<ResponseTab>("Pretty");
  const [response, setResponse] = useState<ResponseState | null>(null);
  const [pending, setPending] = useState(false);
  const [selectedSaved, setSelectedSaved] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));
  }, [workspace]);

  const variables = useMemo(
    () => ({
      baseUrl: workspace.baseUrl,
      ...Object.fromEntries(workspace.variables.filter((entry) => entry.enabled && entry.key).map((entry) => [entry.key, entry.value])),
    }),
    [workspace],
  );

  const updateDraft = (patch: Partial<RequestDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const saveRequest = () => {
    const name = draft.name.trim() || "Untitled request";
    const saved: SavedRequest = { ...draft, name, id: selectedSaved ?? makeId(), updatedAt: Date.now() };
    setWorkspace((current) => ({
      ...current,
      saved: [saved, ...current.saved.filter((entry) => entry.id !== saved.id)].slice(0, 50),
    }));
    setDraft((current) => ({ ...current, name }));
    setSelectedSaved(saved.id);
    push("success", "Request saved locally");
  };

  const selectSaved = (saved: SavedRequest) => {
    const { id: _id, updatedAt: _updatedAt, ...nextDraft } = saved;
    setDraft(cloneDraft(nextDraft));
    setSelectedSaved(saved.id);
    setResponse(null);
  };

  const send = async () => {
    let url: string;
    let body: string | undefined;
    try {
      url = buildUrl(draft, workspace.baseUrl, variables);
      const contentType = draft.headers.find((header) => header.enabled && header.key.toLowerCase() === "content-type")?.value;
      if (!["GET", "DELETE"].includes(draft.method) && draft.body.trim()) {
        const resolvedBody = resolveVariables(draft.body, variables);
        body = contentType?.includes("application/json") || !contentType ? JSON.stringify(JSON.parse(resolvedBody)) : resolvedBody;
      }
    } catch (error) {
      push("error", error instanceof Error ? error.message : "Request setup failed");
      return;
    }

    const headers = Object.fromEntries(
      draft.headers
        .filter((header) => header.enabled && header.key.trim())
        .map((header) => [resolveVariables(header.key, variables), resolveVariables(header.value, variables)]),
    );
    if (body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }

    setPending(true);
    const started = performance.now();
    try {
      const result = await fetch(url, { method: draft.method, headers, body });
      const text = await result.text();
      const durationMs = performance.now() - started;
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Preserve a non-JSON response verbatim.
      }
      const nextResponse: ResponseState = {
        status: result.status,
        statusText: result.statusText,
        durationMs,
        size: new TextEncoder().encode(text).length,
        url,
        text,
        pretty,
        headers: [...result.headers.entries()].sort(([left], [right]) => left.localeCompare(right)),
        tests: evaluateTests(draft.assertions, { status: result.status, text }),
      };
      setResponse(nextResponse);
      setResponseTab("Pretty");
      setWorkspace((current) => ({
        ...current,
        history: [
          {
            id: makeId(),
            name: draft.name || draft.path,
            method: draft.method,
            path: draft.path,
            status: result.status,
            durationMs,
            timestampMs: Date.now(),
          },
          ...current.history,
        ].slice(0, 50),
      }));
      if (!result.ok) push("warning", `${result.status} ${result.statusText || "Request failed"}`);
    } catch {
      push("error", "Network error: cannot reach the server");
      setResponse(null);
    } finally {
      setPending(false);
    }
  };

  const copyResponse = async () => {
    if (!response) return;
    await navigator.clipboard?.writeText(response.pretty);
    push("info", "Response copied");
  };

  const responseContent = () => {
    if (!response) return <p className="p-4 text-sm text-ink-faint">No response yet</p>;
    if (responseTab === "Headers") {
      return (
        <dl className="divide-y divide-line p-3 font-mono text-[0.75rem]">
          {response.headers.map(([key, value]) => (
            <div key={key} className="grid grid-cols-[minmax(120px,0.45fr)_minmax(0,1fr)] gap-3 py-2">
              <dt className="text-ink-faint">{key}</dt>
              <dd className="m-0 break-all text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      );
    }
    if (responseTab === "Tests") {
      return response.tests.length ? (
        <ul className="flex flex-col gap-1.5 p-3">
          {response.tests.map((test) => (
            <li key={test.name} className={`rounded-md px-3 py-2 text-sm ${test.passed ? "bg-ok-soft text-ok" : "bg-err-soft text-err"}`}>
              <div className="flex items-center gap-2 font-medium"><IconCheck size={15} /> {test.name}</div>
              <p className="mt-0.5 font-mono text-[0.72rem] opacity-80">{test.detail}</p>
            </li>
          ))}
        </ul>
      ) : <p className="p-4 text-sm text-ink-faint">No assertions configured</p>;
    }
    return <pre className="min-h-[420px] overflow-auto p-4 font-mono text-[0.78rem] leading-5 whitespace-pre-wrap break-words">{responseTab === "Pretty" ? response.pretty : response.text}</pre>;
  };

  return (
    <div className="flex min-h-[calc(100vh-108px)] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-[190px] py-1.5 text-[0.8rem]" onChange={(event) => {
          const template = TEMPLATES.find((entry) => entry.name === event.target.value);
          if (template) {
            setDraft(cloneDraft(template.draft));
            setSelectedSaved(null);
            setResponse(null);
          }
        }} defaultValue="">
          <option value="" disabled>Request templates</option>
          {TEMPLATES.map((template) => <option key={template.name}>{template.name}</option>)}
        </select>
        <input className="input min-w-[180px] flex-1 py-1.5 text-[0.8rem]" value={workspace.baseUrl} placeholder="Base URL (current server)" onChange={(event) => setWorkspace((current) => ({ ...current, baseUrl: event.target.value }))} />
        <button className="btn btn-secondary btn-sm" onClick={() => { setDraft(newDraft()); setSelectedSaved(null); setResponse(null); }}>
          <IconPlus size={14} /> New
        </button>
        <button className="btn btn-secondary btn-sm" onClick={saveRequest}>
          <IconSave size={14} /> Save
        </button>
      </div>

      <section className="grid min-h-[650px] flex-1 grid-cols-1 overflow-hidden rounded-lg border border-line bg-surface shadow-sm xl:grid-cols-[240px_minmax(0,1fr)_minmax(0,1fr)]">
        <aside className="flex min-h-[260px] flex-col border-b border-line xl:min-h-0 xl:border-r xl:border-b-0">
          <div className="flex h-11 items-center border-b border-line bg-surface-2 px-3"><h2 className="text-[0.8rem] font-semibold">Workspace</h2></div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <h3 className="px-1 pb-1 font-mono text-[0.67rem] text-ink-faint">SAVED REQUESTS</h3>
            <div className="mb-4 flex flex-col gap-0.5">
              {workspace.saved.map((saved) => (
                <button key={saved.id} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left ${selectedSaved === saved.id ? "bg-accent text-on-accent" : "hover:bg-surface-2"}`} onClick={() => selectSaved(saved)}>
                  <span className={`font-mono text-[0.67rem] font-semibold ${selectedSaved === saved.id ? "text-on-accent" : methodTone(saved.method)}`}>{saved.method}</span>
                  <span className="min-w-0 flex-1 truncate text-[0.78rem]">{saved.name}</span>
                </button>
              ))}
              {!workspace.saved.length ? <p className="px-2 py-1 text-[0.76rem] text-ink-faint">No saved requests</p> : null}
            </div>
            <h3 className="px-1 pb-1 font-mono text-[0.67rem] text-ink-faint">RECENT RUNS</h3>
            <div className="flex flex-col gap-0.5">
              {workspace.history.map((entry) => (
                <button key={entry.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2" onClick={() => setDraft((current) => ({ ...current, method: entry.method, path: entry.path }))}>
                  <span className={`font-mono text-[0.67rem] font-semibold ${methodTone(entry.method)}`}>{entry.method}</span>
                  <span className="min-w-0 flex-1 truncate text-[0.75rem]">{entry.path}</span>
                  <span className={`rounded px-1.5 py-0.5 font-mono text-[0.65rem] ${statusTone(entry.status)}`}>{entry.status}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="border-t border-line p-2">
            <h3 className="mb-1.5 px-1 font-mono text-[0.67rem] text-ink-faint">VARIABLES</h3>
            <KeyValueEditor rows={workspace.variables} onChange={(variables) => setWorkspace((current) => ({ ...current, variables }))} keyLabel="Name" valueLabel="Value" />
          </div>
        </aside>

        <section className="flex min-h-[470px] flex-col border-b border-line xl:min-h-0 xl:border-r xl:border-b-0">
          <div className="flex h-11 items-center gap-2 border-b border-line bg-surface-2 px-3">
            <input className="min-w-0 flex-1 bg-transparent text-[0.8rem] font-semibold outline-none placeholder:text-ink-faint" value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} placeholder="Request name" />
          </div>
          <div className="flex gap-2 border-b border-line p-3">
            <select className={`input w-[96px] py-1.5 font-mono text-[0.78rem] ${methodTone(draft.method)}`} value={draft.method} onChange={(event) => updateDraft({ method: event.target.value as HttpMethod })}>
              {METHODS.map((method) => <option key={method}>{method}</option>)}
            </select>
            <input className="input min-w-0 flex-1 py-1.5 font-mono text-[0.78rem]" value={draft.path} onChange={(event) => updateDraft({ path: event.target.value })} placeholder="/data/users" />
            <button className="btn btn-primary btn-sm" onClick={send} disabled={pending} title="Send request">
              <IconPlay size={14} /> {pending ? "Sending" : "Send"}
            </button>
          </div>
          <div className="flex border-b border-line px-3">
            {REQUEST_TABS.map((tab) => <button key={tab} className={`border-b-2 px-3 py-2 text-[0.76rem] font-medium ${requestTab === tab ? "border-accent text-accent" : "border-transparent text-ink-muted hover:text-ink"}`} onClick={() => setRequestTab(tab)}>{tab}</button>)}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {requestTab === "Params" ? <KeyValueEditor rows={draft.params} onChange={(params) => updateDraft({ params })} keyLabel="Parameter" valueLabel="Value" /> : null}
            {requestTab === "Headers" ? <KeyValueEditor rows={draft.headers} onChange={(headers) => updateDraft({ headers })} keyLabel="Header" valueLabel="Value" /> : null}
            {requestTab === "Body" ? <textarea className="input min-h-[320px] resize-y font-mono text-[0.78rem] leading-5" value={draft.body} onChange={(event) => updateDraft({ body: event.target.value })} disabled={["GET", "DELETE"].includes(draft.method)} spellCheck={false} /> : null}
            {requestTab === "Tests" ? <div className="flex flex-col gap-2">{draft.assertions.map((assertion) => <div key={assertion.id} className="grid grid-cols-[28px_92px_minmax(0,1fr)_minmax(0,1fr)_32px] gap-1.5"><input type="checkbox" className="m-auto size-3.5 accent-[var(--accent)]" checked={assertion.enabled} onChange={(event) => updateDraft({ assertions: draft.assertions.map((entry) => entry.id === assertion.id ? { ...entry, enabled: event.target.checked } : entry) })} /><select className="input py-1.5 text-[0.75rem]" value={assertion.kind} onChange={(event) => updateDraft({ assertions: draft.assertions.map((entry) => entry.id === assertion.id ? { ...entry, kind: event.target.value as Assertion["kind"] } : entry) })}><option value="status">Status</option><option value="json">JSON path</option></select><input className="input py-1.5 font-mono text-[0.75rem]" value={assertion.path} disabled={assertion.kind === "status"} placeholder={assertion.kind === "status" ? "Status" : "data[0].name"} onChange={(event) => updateDraft({ assertions: draft.assertions.map((entry) => entry.id === assertion.id ? { ...entry, path: event.target.value } : entry) })} /><input className="input py-1.5 font-mono text-[0.75rem]" value={assertion.expected} onChange={(event) => updateDraft({ assertions: draft.assertions.map((entry) => entry.id === assertion.id ? { ...entry, expected: event.target.value } : entry) })} /><button className="icon-btn danger size-8" onClick={() => updateDraft({ assertions: draft.assertions.filter((entry) => entry.id !== assertion.id) })} title="Remove assertion" aria-label="Remove assertion"><IconTrash size={14} /></button></div>)}<button className="btn btn-ghost btn-sm self-start" onClick={() => updateDraft({ assertions: [...draft.assertions, emptyAssertion()] })}><IconPlus size={14} /> Add assertion</button></div> : null}
          </div>
        </section>

        <section className="flex min-h-[440px] flex-col xl:min-h-0">
          <div className="flex h-11 items-center gap-2 border-b border-line bg-surface-2 px-3">
            <h2 className="mr-auto text-[0.8rem] font-semibold">Response</h2>
            {response ? <><span className={`rounded px-2 py-1 font-mono text-[0.68rem] font-semibold ${statusTone(response.status)}`}>{response.status}</span><span className="font-mono text-[0.68rem] text-ink-faint">{response.durationMs.toFixed(0)} ms</span><span className="font-mono text-[0.68rem] text-ink-faint">{response.size} B</span><button className="icon-btn size-7" onClick={copyResponse} title="Copy response" aria-label="Copy response"><IconCopy size={14} /></button></> : null}
          </div>
          <div className="flex border-b border-line px-3">
            {RESPONSE_TABS.map((tab) => <button key={tab} className={`border-b-2 px-3 py-2 text-[0.76rem] font-medium ${responseTab === tab ? "border-accent text-accent" : "border-transparent text-ink-muted hover:text-ink"}`} onClick={() => setResponseTab(tab)}>{tab}</button>)}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">{responseContent()}</div>
          {response ? <div className="border-t border-line px-3 py-2 font-mono text-[0.68rem] text-ink-faint truncate">{response.url}</div> : null}
        </section>
      </section>
    </div>
  );
}
