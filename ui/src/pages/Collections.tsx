import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useToast } from "../context/ToastContext";
import { IconChevronRight, IconDatabase, IconPlus, IconTrash } from "../icons";
import { api, type CollectionInfo, type Document } from "../lib/api";

const EXAMPLE_DOCUMENT = '{\n  "name": "Ada Lovelace",\n  "active": true\n}';
const VALID_COLLECTION_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

function editableDocument(document: Document) {
  return Object.fromEntries(Object.entries(document).filter(([key]) => !key.startsWith("_")));
}

function topLevelCollections(collections: CollectionInfo[]) {
  return collections.filter((collection) => !collection.name.includes("/"));
}

function childCollections(collections: CollectionInfo[], collection: string, id: string | null) {
  if (!id) return [];
  const prefix = `${collection}/${id}/`;
  return collections
    .filter((entry) => entry.name.startsWith(prefix))
    .map((entry) => ({ ...entry, child: entry.name.slice(prefix.length) }))
    .filter((entry) => !entry.child.includes("/"));
}

function collectionLabel(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export default function CollectionsPage() {
  const queryClient = useQueryClient();
  const { notifyError, push } = useToast();
  const collectionsQuery = useQuery({ queryKey: ["collections"], queryFn: api.collections });
  const [collection, setCollection] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState(EXAMPLE_DOCUMENT);
  const [newCollection, setNewCollection] = useState("");
  const [newSubcollection, setNewSubcollection] = useState("");

  const documentQuery = useQuery({
    queryKey: ["documents", collection],
    queryFn: () => api.listDocuments(collection, { limit: 100, sort: "-_updatedAt" }),
    enabled: collection.length > 0,
  });

  const knownCollections = collectionsQuery.data?.data ?? [];
  const rootCollections = useMemo(() => topLevelCollections(knownCollections), [knownCollections]);
  const selectedDocument = useMemo(
    () => documentQuery.data?.data.find((document) => document._id === selectedId),
    [documentQuery.data, selectedId],
  );
  const children = useMemo(
    () => childCollections(knownCollections, collection, selectedId),
    [knownCollections, collection, selectedId],
  );

  useEffect(() => {
    if (!collection && rootCollections[0]) setCollection(rootCollections[0].name);
  }, [collection, rootCollections]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["collections"] });
    queryClient.invalidateQueries({ queryKey: ["documents", collection] });
    queryClient.invalidateQueries({ queryKey: ["store-stats"] });
  };

  const chooseCollection = (name: string) => {
    setCollection(name);
    setSelectedId(null);
    setEditor(EXAMPLE_DOCUMENT);
    setNewSubcollection("");
  };

  const chooseDocument = (document: Document) => {
    setSelectedId(String(document._id));
    setEditor(JSON.stringify(editableDocument(document), null, 2));
    setNewSubcollection("");
  };

  const newDocument = () => {
    setSelectedId(null);
    setEditor(EXAMPLE_DOCUMENT);
    setNewSubcollection("");
  };

  const createCollection = () => {
    const name = newCollection.trim();
    if (!VALID_COLLECTION_NAME.test(name)) {
      push("warning", "Collection names begin with a letter and use letters, numbers, _ or -");
      return;
    }
    setNewCollection("");
    chooseCollection(name);
  };

  const openSubcollection = (name: string) => {
    if (!selectedId) return;
    chooseCollection(`${collection}/${selectedId}/${name}`);
  };

  const createSubcollection = () => {
    const name = newSubcollection.trim();
    if (!VALID_COLLECTION_NAME.test(name)) {
      push("warning", "Subcollection names begin with a letter and use letters, numbers, _ or -");
      return;
    }
    setNewSubcollection("");
    openSubcollection(name);
    push("info", `Add a document to create ${name}`);
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
      newDocument();
      refresh();
      push("info", "Document deleted");
    },
    onError: notifyError,
  });

  const pathParts = collection.split("/").filter(Boolean);

  return (
    <div className="flex min-h-[calc(100vh-108px)] flex-col gap-3">
      <div className="flex min-h-9 items-center gap-1 overflow-x-auto px-1 font-mono text-[0.74rem] text-ink-faint">
        <span className="shrink-0">data</span>
        {pathParts.map((part, index) => (
          <span key={`${part}-${index}`} className="flex shrink-0 items-center gap-1">
            <IconChevronRight size={13} />
            <span className={index === pathParts.length - 1 ? "text-ink" : ""}>{part}</span>
          </span>
        ))}
      </div>

      <section className="grid min-h-[600px] flex-1 grid-cols-1 overflow-hidden rounded-lg border border-line bg-surface shadow-sm lg:grid-cols-[minmax(190px,0.7fr)_minmax(270px,1fr)_minmax(360px,1.25fr)]">
        <aside className="flex min-h-[240px] flex-col border-b border-line lg:min-h-0 lg:border-r lg:border-b-0">
          <div className="flex h-11 shrink-0 items-center border-b border-line bg-surface-2 px-3">
            <h2 className="text-[0.8rem] font-semibold">Collections</h2>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {rootCollections.map((entry) => (
              <button
                key={entry.name}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.86rem] transition-colors ${
                  entry.name === collection
                    ? "bg-accent text-on-accent"
                    : "text-ink hover:bg-surface-2"
                }`}
                onClick={() => chooseCollection(entry.name)}
              >
                <IconDatabase size={15} />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <span className="font-mono text-[0.68rem] opacity-70">{entry.count}</span>
              </button>
            ))}
          </nav>
          <form
            className="flex gap-1.5 border-t border-line p-2"
            onSubmit={(event) => {
              event.preventDefault();
              createCollection();
            }}
          >
            <input
              className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1.5 font-mono text-[0.75rem] placeholder:text-ink-faint focus:border-accent focus:outline-none"
              value={newCollection}
              placeholder="new collection"
              onChange={(event) => setNewCollection(event.target.value)}
              aria-label="New collection name"
            />
            <button className="icon-btn" type="submit" title="Open new collection" aria-label="Open new collection">
              <IconPlus size={16} />
            </button>
          </form>
        </aside>

        <section className="flex min-h-[300px] flex-col border-b border-line lg:min-h-0 lg:border-r lg:border-b-0">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3">
            <h2 className="min-w-0 flex-1 truncate text-[0.8rem] font-semibold">
              {collection ? collectionLabel(collection) : "Documents"}
            </h2>
            <span className="font-mono text-[0.67rem] text-ink-faint">{documentQuery.data?.total ?? 0}</span>
            <button className="icon-btn size-7" onClick={newDocument} disabled={!collection} title="New document" aria-label="New document">
              <IconPlus size={16} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {!collection ? (
              <p className="px-2 py-3 text-sm text-ink-faint">No collection selected</p>
            ) : documentQuery.isLoading ? (
              <div className="m-2 skeleton" />
            ) : documentQuery.isError ? (
              <p className="px-2 py-3 text-sm text-err">Could not load documents</p>
            ) : documentQuery.data?.data.length ? (
              <ul className="flex flex-col gap-0.5">
                {documentQuery.data.data.map((document) => {
                  const id = String(document._id);
                  return (
                    <li key={id}>
                      <button
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                          selectedId === id ? "bg-accent text-on-accent" : "text-ink hover:bg-surface-2"
                        }`}
                        onClick={() => chooseDocument(document)}
                      >
                        <span className="min-w-0 flex-1">
                          <strong className="block truncate font-mono text-[0.76rem] font-medium">{id}</strong>
                          <span className="block truncate text-[0.72rem] opacity-70">{JSON.stringify(editableDocument(document))}</span>
                        </span>
                        <IconChevronRight size={15} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-2 py-3 text-sm text-ink-faint">No documents</p>
            )}
          </div>
        </section>

        <section className="flex min-h-[420px] flex-col lg:min-h-0">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3">
            <h2 className="min-w-0 flex-1 truncate text-[0.8rem] font-semibold">
              {selectedId ?? "New document"}
            </h2>
            {selectedId ? (
              <button
                className="icon-btn danger size-7"
                onClick={() => deleteMutation.mutate(selectedId)}
                disabled={deleteMutation.isPending}
                title="Delete document"
                aria-label="Delete document"
              >
                <IconTrash size={16} />
              </button>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {selectedDocument ? (
              <div className="mb-4 border-b border-line pb-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h3 className="text-[0.8rem] font-semibold text-ink-muted">Subcollections</h3>
                  <span className="font-mono text-[0.68rem] text-ink-faint">{children.length}</span>
                </div>
                <div className="flex flex-col gap-1">
                  {children.map((entry) => (
                    <button
                      key={entry.name}
                      className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5 text-left text-[0.8rem] hover:bg-surface-2"
                      onClick={() => chooseCollection(entry.name)}
                    >
                      <IconDatabase size={14} className="text-accent" />
                      <span className="min-w-0 flex-1 truncate">{entry.child}</span>
                      <span className="font-mono text-[0.67rem] text-ink-faint">{entry.count}</span>
                      <IconChevronRight size={14} className="text-ink-faint" />
                    </button>
                  ))}
                </div>
                <form
                  className="mt-2 flex gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    createSubcollection();
                  }}
                >
                  <input
                    className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1.5 font-mono text-[0.75rem] placeholder:text-ink-faint focus:border-accent focus:outline-none"
                    value={newSubcollection}
                    placeholder="new subcollection"
                    onChange={(event) => setNewSubcollection(event.target.value)}
                    aria-label="New subcollection name"
                  />
                  <button className="icon-btn" type="submit" title="Open new subcollection" aria-label="Open new subcollection">
                    <IconPlus size={16} />
                  </button>
                </form>
              </div>
            ) : null}

            <label className="mb-1.5 block font-mono text-[0.68rem] text-ink-faint">JSON document</label>
            <textarea
              className="input min-h-[270px] resize-y font-mono text-[0.78rem] leading-5"
              value={editor}
              onChange={(event) => setEditor(event.target.value)}
              spellCheck={false}
            />
          </div>
          <div className="border-t border-line p-3">
            <button
              className="btn btn-primary w-full"
              onClick={() => saveMutation.mutate()}
              disabled={!collection || saveMutation.isPending}
            >
              {selectedId ? "Save document" : "Create document"}
            </button>
          </div>
        </section>
      </section>
    </div>
  );
}
