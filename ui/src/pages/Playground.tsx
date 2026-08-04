import { useState } from "react";
import { useToast } from "../context/ToastContext";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export default function PlaygroundPage() {
  const { push } = useToast();
  const [method, setMethod] = useState<(typeof METHODS)[number]>("GET");
  const [path, setPath] = useState("/data/users?limit=20&sort=-_updatedAt");
  const [body, setBody] = useState('{\n  "name": "Ada"\n}');
  const [result, setResult] = useState("Run a request to inspect the response.");
  const [pending, setPending] = useState(false);

  const run = async () => {
    if (!path.startsWith("/data/")) {
      setResult("Only /data/** endpoints are available in this playground.");
      return;
    }
    let payload: string | undefined;
    if (!["GET", "DELETE"].includes(method)) {
      try {
        payload = JSON.stringify(JSON.parse(body));
      } catch {
        setResult("Request body must be valid JSON.");
        return;
      }
    }
    setPending(true);
    try {
      const response = await fetch(path, {
        method,
        headers: payload ? { "Content-Type": "application/json" } : undefined,
        body: payload,
      });
      const text = await response.text();
      let rendered = text;
      try {
        rendered = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Keep non-JSON bodies readable too.
      }
      setResult(`${response.status} ${response.statusText}\n\n${rendered}`);
      if (!response.ok) push("warning", `Request returned ${response.status}`);
    } catch {
      setResult("Network error: cannot reach the server.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="card">
        <div className="card-head">
          <h2>Request</h2>
          <span className="card-hint">live server</span>
        </div>
        <div className="flex gap-2">
          <select className="input w-[112px] font-mono" value={method} onChange={(event) => setMethod(event.target.value as typeof method)}>
            {METHODS.map((entry) => <option key={entry}>{entry}</option>)}
          </select>
          <input className="input min-w-0 flex-1 font-mono" value={path} onChange={(event) => setPath(event.target.value)} />
        </div>
        <textarea
          className="input mt-3 min-h-[300px] resize-y font-mono text-[0.8rem] leading-5"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          disabled={method === "GET" || method === "DELETE"}
          spellCheck={false}
        />
        <button className="btn btn-primary mt-3 w-full" onClick={run} disabled={pending}>
          {pending ? "Running…" : "Send request"}
        </button>
      </section>
      <section className="card">
        <div className="card-head">
          <h2>Response</h2>
          <span className="card-hint">status + JSON</span>
        </div>
        <pre className="min-h-[392px] max-w-full overflow-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-[0.78rem] leading-5 whitespace-pre-wrap break-words">
          {result}
        </pre>
      </section>
    </div>
  );
}
