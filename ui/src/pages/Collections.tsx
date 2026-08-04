import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useToast } from "../context/ToastContext";
import { IconPlus, IconTrash } from "../icons";
import { api, type Document } from "../lib/api";

const EXAMPLE_DOCUMENT = '{\n  "name": "Ada Lovelace",\n  "active": true\n}';

function editableDocument(document: Document) {
  return Object.fromEntries(Object.entries(document).filter(([key]) => !key.startsWith("_")));
}

export default function CollectionsPage() {
  const queryClient = useQueryClient();
  const { notifyError, push } = useToast();
  const collectionsQuery = useQuery({ queryKey: ["collections"], queryFn: api.collections });
  const [collection, setCollection] = useState("");
  const [editor, setEditor] = useState(EXAMPLE_DOCUMENT);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const documentQuery = useQuery({
    queryKey: ["documents", collection],
    queryFn: () => api.listDocuments(collection, { limit: 100, sort: "-_updatedAt" }),
    enabled: collection.length > 0,
  });

  const knownCollections = collectionsQuery.data?.data ?? [];
  useEffect(() => {
    if (!collection && knownCollections[0]) setCollection(knownCollections[0].name);
  }, [collection, knownCollections]);

  const selectedDocument = useMemo(
    () => documentQuery.data?.data.find((document) => document._id === selectedId),
    [documentQuery.data, selectedId],
  );

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["collections"] });
    queryClient.invalidateQueries({ queryKey: ["documents", collection] });
    queryClient.invalidateQueries({ queryKey: ["store-stats"] });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      let document: Document;
      try {
        document = JSON.parse(editor) as Document;
      } catch {
        throw new Error("Document must be valid JSON");
      }
      if (!document || Array.isArray(document) || typeof document !== "object") {
        throw new Error("Document must be a JSON object");
      }
      return selectedId
        ? api.replaceDocument(collection, selectedId, document)
        : api.createDocument(collection, document);
    },
    onSuccess: (document) => {
      setSelectedId(String(document._id));
      setEditor(JSON.stringify(editableDocument(document), null, 2));
      refresh();
      push("success", "Document saved");
    },
    onError: notifyError,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteDocument(collection, id),
    onSuccess: () => {
      setSelectedId(null);
      setEditor(EXAMPLE_DOCUMENT);
      refresh();
      push("info", "Document deleted");
    },
    onError: notifyError,
  });

  const chooseDocument = (document: Document) => {
    setSelectedId(String(document._id));
    setEditor(JSON.stringify(editableDocument(document), null, 2));
  };

  const newDocument = () => {
    setSelectedId(null);
    setEditor(EXAMPLE_DOCUMENT);
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="card">
        <div className="card-head">
          <h2>Collection</h2>
          <span className="card-hint">/data/&lt;collection&gt;</span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="input font-mono"
            value={collection}
            placeholder="users or users/ada/orders"
            onChange={(event) => {
              setCollection(event.target.value);
              setSelectedId(null);
            }}
          />
          <button className="btn btn-secondary" onClick={() => documentQuery.refetch()} disabled={!collection}>
            Load
          </button>
        </div>
        {knownCollections.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {knownCollections.map((item) => (
              <button
                key={item.name}
                className={`rounded-md border px-2.5 py-1 font-mono text-[0.75rem] ${
                  item.name === collection ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-muted hover:bg-surface-2"
                }`}
                onClick={() => setCollection(item.name)}
              >
                {item.name} <span className="text-ink-faint">{item.count}</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
        <section className="card overflow-hidden p-0">
          <div className="flex items-center gap-3 border-b border-line p-5">
            <div>
              <h2 className="text-[0.95rem] font-semibold">Documents</h2>
              <span className="card-hint">{documentQuery.data?.total ?? 0} matching</span>
            </div>
            <button className="btn btn-secondary btn-sm ml-auto" onClick={newDocument} disabled={!collection}>
              <IconPlus size={15} /> New
            </button>
          </div>
          {!collection ? (
            <p className="p-5 text-sm text-ink-faint">Choose a collection to inspect its documents.</p>
          ) : documentQuery.isLoading ? (
            <div className="m-5 skeleton" />
          ) : documentQuery.isError ? (
            <p className="p-5 text-sm text-err">Could not load this collection.</p>
          ) : documentQuery.data?.data.length ? (
            <ul className="divide-y divide-line">
              {documentQuery.data.data.map((document) => {
                const id = String(document._id);
                return (
                  <li key={id} className={`flex items-center gap-3 p-3 hover:bg-surface-2 ${selectedId === id ? "bg-accent-soft" : ""}`}>
                    <button className="min-w-0 flex-1 text-left" onClick={() => chooseDocument(document)}>
                      <strong className="block truncate font-mono text-[0.8rem]">{id}</strong>
                      <span className="block truncate text-[0.8rem] text-ink-muted">{JSON.stringify(editableDocument(document))}</span>
                    </button>
                    <button className="icon-btn danger" onClick={() => deleteMutation.mutate(id)} aria-label={`Delete ${id}`}>
                      <IconTrash size={16} />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="p-5 text-sm text-ink-faint">No documents yet. Create the first one.</p>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>{selectedDocument ? "Edit document" : "New document"}</h2>
            <span className="card-hint">{selectedId ? `PUT /data/${collection}/${selectedId}` : `POST /data/${collection || "…"}`}</span>
          </div>
          <textarea
            className="input min-h-[360px] resize-y font-mono text-[0.8rem] leading-5"
            value={editor}
            onChange={(event) => setEditor(event.target.value)}
            spellCheck={false}
          />
          <button
            className="btn btn-primary mt-3 w-full"
            onClick={() => saveMutation.mutate()}
            disabled={!collection || saveMutation.isPending}
          >
            {selectedId ? "Save document" : "Create document"}
          </button>
        </section>
      </div>
    </div>
  );
}
