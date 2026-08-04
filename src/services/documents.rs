//! Dependency-free document storage for the `/data/**` API.
//!
//! Collections live under `data/collections/` and are loaded lazily. Each
//! change is appended to a JSONL write-ahead log before it reaches memory.
//! After a small batch the current collection is compacted into one atomic
//! snapshot and the log is cleared. Secondary indexes are rebuilt from the
//! snapshot/log when a collection is loaded; they are an optimization, never
//! a source of truth.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::RwLock;

use crate::error::{AppError, AppResult};

const COMPACTION_THRESHOLD: usize = 100;
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 1_000;

#[derive(Clone, Debug)]
pub struct CollectionPath {
    pub key: String,
    pub display: String,
    pub parent: Option<Parent>,
}

#[derive(Clone, Debug)]
pub struct Parent {
    pub collection_key: String,
    pub collection_display: String,
    pub id: String,
}

impl CollectionPath {
    /// Parse alternating collection/id segments ending at a collection.
    /// Examples: `users` and `users/u1/orders`.
    pub fn from_segments(segments: &[&str]) -> AppResult<Self> {
        if segments.is_empty() || segments.len().is_multiple_of(2) {
            return Err(AppError::BadRequest(
                "a collection path must end with a collection name".into(),
            ));
        }
        for (index, segment) in segments.iter().enumerate() {
            validate_segment(segment, index % 2 == 0)?;
        }
        let key = segments.join("/");
        let parent = if segments.len() >= 3 {
            let parent_segments = &segments[..segments.len() - 1];
            Some(Parent {
                collection_key: parent_segments[..parent_segments.len() - 1].join("/"),
                collection_display: parent_segments[..parent_segments.len() - 1].join("/"),
                id: parent_segments[parent_segments.len() - 1].to_string(),
            })
        } else {
            None
        };
        Ok(Self {
            display: key.clone(),
            key,
            parent,
        })
    }
}

fn validate_segment(segment: &str, collection: bool) -> AppResult<()> {
    let valid = !segment.is_empty()
        && segment.len() <= 128
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
    if !valid {
        return Err(AppError::BadRequest(if collection {
            "collection names may contain only letters, numbers, underscores, and hyphens".into()
        } else {
            "document ids may contain only letters, numbers, underscores, and hyphens".into()
        }));
    }
    if collection && !segment.as_bytes()[0].is_ascii_alphabetic() {
        return Err(AppError::BadRequest(
            "collection names must begin with a letter".into(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListOptions {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(flatten)]
    pub query: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPage {
    pub data: Vec<Value>,
    pub page: PageInfo,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub limit: usize,
    pub returned: usize,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInfo {
    pub name: String,
    pub count: usize,
    pub indexes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreStats {
    pub collection_count: usize,
    pub document_count: usize,
    pub data_path: String,
}

#[derive(Default)]
struct StoreState {
    collections: HashMap<String, Collection>,
    known_collections: BTreeSet<String>,
}

#[derive(Default)]
struct Collection {
    documents: BTreeMap<String, Value>,
    indexes: HashMap<String, HashMap<String, BTreeSet<String>>>,
    pending_entries: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum JournalEntry {
    Put { id: String, document: Value },
    Delete { id: String },
}

pub struct DocumentStore {
    root: PathBuf,
    state: RwLock<StoreState>,
    next_id: AtomicU64,
}

impl DocumentStore {
    pub async fn open(root: impl AsRef<Path>) -> AppResult<Self> {
        let root = root.as_ref().to_path_buf();
        tokio::fs::create_dir_all(root.join("collections")).await?;
        let known_collections = discover_collections(&root.join("collections"))?;
        Ok(Self {
            root,
            state: RwLock::new(StoreState {
                collections: HashMap::new(),
                known_collections,
            }),
            next_id: AtomicU64::new(1),
        })
    }

    pub async fn list(
        &self,
        path: &CollectionPath,
        options: &ListOptions,
    ) -> AppResult<DocumentPage> {
        self.ensure_parent(path).await?;
        self.ensure_loaded(&path.key).await?;
        let limit = options.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
        if limit == 0 {
            return Err(AppError::BadRequest("limit must be at least 1".into()));
        }
        let filters = parse_filters(&options.query)?;
        let sorts = parse_sorts(options.sort.as_deref())?;
        let state = self.state.read().await;
        let collection = state
            .collections
            .get(&path.key)
            .expect("loaded collection missing");

        let candidates = candidate_ids(collection, &filters);
        let mut documents: Vec<Value> = collection
            .documents
            .iter()
            .filter(|(id, _)| candidates.as_ref().is_none_or(|ids| ids.contains(*id)))
            .map(|(_, document)| document.clone())
            .filter(|document| filters.iter().all(|filter| filter.matches(document)))
            .collect();

        documents.sort_by(|left, right| compare_documents(left, right, &sorts));
        if let Some(cursor) = &options.cursor {
            let position = documents
                .iter()
                .position(|document| document.get("_id").and_then(Value::as_str) == Some(cursor));
            match position {
                Some(position) => documents = documents.split_off(position + 1),
                None => {
                    return Err(AppError::BadRequest(
                        "cursor is not present in this result set".into(),
                    ))
                }
            }
        }
        let total = documents.len();
        let has_more = documents.len() > limit;
        documents.truncate(limit);
        let next_cursor = has_more.then(|| {
            documents
                .last()
                .and_then(|document| document.get("_id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        });
        Ok(DocumentPage {
            page: PageInfo {
                limit,
                returned: documents.len(),
                next_cursor,
            },
            data: documents,
            total,
        })
    }

    pub async fn get(&self, path: &CollectionPath, id: &str) -> AppResult<Value> {
        validate_segment(id, false)?;
        self.ensure_parent(path).await?;
        self.ensure_loaded(&path.key).await?;
        let state = self.state.read().await;
        state
            .collections
            .get(&path.key)
            .and_then(|collection| collection.documents.get(id))
            .cloned()
            .ok_or_else(|| {
                AppError::NotFound(format!("document {id} does not exist in {}", path.display))
            })
    }

    pub async fn insert(&self, path: &CollectionPath, body: Value) -> AppResult<Value> {
        self.ensure_parent(path).await?;
        validate_document(&body)?;
        let id = self.new_id();
        self.put(path, &id, body, false)
            .await
            .map(|(_, document)| document)
    }

    /// Replaces a document and creates it when it doesn't exist. The bool is
    /// true when the document was created, allowing the HTTP layer to choose
    /// 201 versus 200 without another lookup.
    pub async fn replace(
        &self,
        path: &CollectionPath,
        id: &str,
        body: Value,
    ) -> AppResult<(bool, Value)> {
        self.ensure_parent(path).await?;
        validate_segment(id, false)?;
        validate_document(&body)?;
        self.put(path, id, body, true).await
    }

    pub async fn patch(&self, path: &CollectionPath, id: &str, patch: Value) -> AppResult<Value> {
        self.ensure_parent(path).await?;
        validate_segment(id, false)?;
        let patch_object = patch
            .as_object()
            .ok_or_else(|| AppError::BadRequest("a document patch must be a JSON object".into()))?;
        reject_reserved_fields(patch_object)?;
        self.ensure_loaded(&path.key).await?;
        let mut state = self.state.write().await;
        let existing = state
            .collections
            .get(&path.key)
            .and_then(|collection| collection.documents.get(id))
            .cloned()
            .ok_or_else(|| {
                AppError::NotFound(format!("document {id} does not exist in {}", path.display))
            })?;
        let mut updated = existing;
        merge_patch(&mut updated, &patch);
        stamp_document(&mut updated, id, path);
        self.record_put_locked(&mut state, &path.key, id, updated.clone())
            .await?;
        Ok(updated)
    }

    pub async fn delete(&self, path: &CollectionPath, id: &str) -> AppResult<()> {
        self.ensure_parent(path).await?;
        validate_segment(id, false)?;
        self.ensure_loaded(&path.key).await?;
        let mut state = self.state.write().await;
        let descendants = format!("{}/{id}/", path.key);
        if state
            .known_collections
            .iter()
            .any(|name| name.starts_with(&descendants))
        {
            return Err(AppError::Conflict(format!(
                "document {id} has nested collections; delete those documents first"
            )));
        }
        if !state
            .collections
            .get(&path.key)
            .is_some_and(|collection| collection.documents.contains_key(id))
        {
            return Err(AppError::NotFound(format!(
                "document {id} does not exist in {}",
                path.display
            )));
        }
        self.record_delete_locked(&mut state, &path.key, id).await
    }

    pub async fn collections(&self) -> AppResult<Vec<CollectionInfo>> {
        let keys = self
            .state
            .read()
            .await
            .known_collections
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        for key in &keys {
            self.ensure_loaded(key).await?;
        }
        let state = self.state.read().await;
        Ok(keys
            .into_iter()
            .map(|name| {
                let collection = state
                    .collections
                    .get(&name)
                    .expect("loaded collection missing");
                let mut indexes = collection.indexes.keys().cloned().collect::<Vec<_>>();
                indexes.sort();
                CollectionInfo {
                    name,
                    count: collection.documents.len(),
                    indexes,
                }
            })
            .collect())
    }

    pub async fn stats(&self) -> AppResult<StoreStats> {
        let collections = self.collections().await?;
        Ok(StoreStats {
            collection_count: collections.len(),
            document_count: collections.iter().map(|collection| collection.count).sum(),
            data_path: self.root.display().to_string(),
        })
    }

    pub async fn compact_all(&self) -> AppResult<()> {
        let keys = self
            .state
            .read()
            .await
            .known_collections
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        for key in &keys {
            self.ensure_loaded(key).await?;
        }
        let mut state = self.state.write().await;
        for key in keys {
            self.compact_locked(&mut state, &key).await?;
        }
        Ok(())
    }

    async fn put(
        &self,
        path: &CollectionPath,
        id: &str,
        body: Value,
        upsert: bool,
    ) -> AppResult<(bool, Value)> {
        self.ensure_loaded(&path.key).await?;
        let mut state = self.state.write().await;
        let existing = state
            .collections
            .get(&path.key)
            .and_then(|collection| collection.documents.get(id))
            .cloned();
        let exists = existing.is_some();
        if exists && !upsert {
            return Err(AppError::Conflict(format!("document {id} already exists")));
        }
        let mut document = body;
        if let Some(created_at) = existing.and_then(|document| document.get("_createdAt").cloned())
        {
            document
                .as_object_mut()
                .expect("document validated as object")
                .insert("_createdAt".into(), created_at);
        }
        stamp_document(&mut document, id, path);
        self.record_put_locked(&mut state, &path.key, id, document.clone())
            .await?;
        Ok((!exists, document))
    }

    async fn ensure_parent(&self, path: &CollectionPath) -> AppResult<()> {
        let Some(parent) = &path.parent else {
            return Ok(());
        };
        self.ensure_loaded(&parent.collection_key).await?;
        let state = self.state.read().await;
        if state
            .collections
            .get(&parent.collection_key)
            .is_some_and(|collection| collection.documents.contains_key(&parent.id))
        {
            Ok(())
        } else {
            Err(AppError::NotFound(format!(
                "parent document {} does not exist in {}",
                parent.id, parent.collection_display
            )))
        }
    }

    async fn ensure_loaded(&self, key: &str) -> AppResult<()> {
        if self.state.read().await.collections.contains_key(key) {
            return Ok(());
        }
        let mut state = self.state.write().await;
        if state.collections.contains_key(key) {
            return Ok(());
        }
        let collection = load_collection(&self.collection_dir(key)).await?;
        state.collections.insert(key.to_string(), collection);
        Ok(())
    }

    async fn record_put_locked(
        &self,
        state: &mut StoreState,
        key: &str,
        id: &str,
        document: Value,
    ) -> AppResult<()> {
        append_journal(
            &self.collection_dir(key),
            &JournalEntry::Put {
                id: id.to_string(),
                document: document.clone(),
            },
        )
        .await?;
        let collection = state
            .collections
            .get_mut(key)
            .expect("loaded collection missing");
        collection.documents.insert(id.to_string(), document);
        rebuild_indexes(collection);
        collection.pending_entries += 1;
        state.known_collections.insert(key.to_string());
        if collection.pending_entries >= COMPACTION_THRESHOLD {
            self.compact_locked(state, key).await?;
        }
        Ok(())
    }

    async fn record_delete_locked(
        &self,
        state: &mut StoreState,
        key: &str,
        id: &str,
    ) -> AppResult<()> {
        append_journal(
            &self.collection_dir(key),
            &JournalEntry::Delete { id: id.to_string() },
        )
        .await?;
        let collection = state
            .collections
            .get_mut(key)
            .expect("loaded collection missing");
        collection.documents.remove(id);
        rebuild_indexes(collection);
        collection.pending_entries += 1;
        if collection.pending_entries >= COMPACTION_THRESHOLD {
            self.compact_locked(state, key).await?;
        }
        Ok(())
    }

    async fn compact_locked(&self, state: &mut StoreState, key: &str) -> AppResult<()> {
        let collection = state
            .collections
            .get_mut(key)
            .expect("loaded collection missing");
        write_snapshot(&self.collection_dir(key), &collection.documents).await?;
        clear_journal(&self.collection_dir(key)).await?;
        collection.pending_entries = 0;
        Ok(())
    }

    fn collection_dir(&self, key: &str) -> PathBuf {
        self.root.join("collections").join(key)
    }

    fn new_id(&self) -> String {
        let sequence = self.next_id.fetch_add(1, AtomicOrdering::Relaxed);
        let timestamp = Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or_else(|| Utc::now().timestamp_millis() * 1_000_000);
        format!("d_{timestamp:x}{sequence:x}")
    }
}

async fn load_collection(directory: &Path) -> AppResult<Collection> {
    let snapshot_path = directory.join("snapshot.json");
    let mut documents = match tokio::fs::read(&snapshot_path).await {
        Ok(raw) => serde_json::from_slice::<BTreeMap<String, Value>>(&raw)
            .map_err(|error| AppError::Internal(format!("invalid collection snapshot: {error}")))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(error) => return Err(error.into()),
    };
    let journal_path = directory.join("journal.jsonl");
    let pending_entries = match tokio::fs::read_to_string(&journal_path).await {
        Ok(journal) => {
            let mut count = 0;
            for line in journal.lines().filter(|line| !line.trim().is_empty()) {
                let entry: JournalEntry = serde_json::from_str(line).map_err(|error| {
                    AppError::Internal(format!("invalid collection journal: {error}"))
                })?;
                apply_entry(&mut documents, entry);
                count += 1;
            }
            count
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error.into()),
    };
    let mut collection = Collection {
        documents,
        indexes: HashMap::new(),
        pending_entries,
    };
    rebuild_indexes(&mut collection);
    Ok(collection)
}

fn apply_entry(documents: &mut BTreeMap<String, Value>, entry: JournalEntry) {
    match entry {
        JournalEntry::Put { id, document } => {
            documents.insert(id, document);
        }
        JournalEntry::Delete { id } => {
            documents.remove(&id);
        }
    }
}

async fn append_journal(directory: &Path, entry: &JournalEntry) -> AppResult<()> {
    tokio::fs::create_dir_all(directory).await?;
    let mut line = serde_json::to_string(entry).map_err(|error| {
        AppError::Internal(format!("failed to encode document journal: {error}"))
    })?;
    line.push('\n');
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("journal.jsonl"))
        .await?;
    file.write_all(line.as_bytes()).await?;
    file.sync_data().await?;
    Ok(())
}

async fn write_snapshot(directory: &Path, documents: &BTreeMap<String, Value>) -> AppResult<()> {
    tokio::fs::create_dir_all(directory).await?;
    let data = serde_json::to_vec(documents).map_err(|error| {
        AppError::Internal(format!("failed to encode collection snapshot: {error}"))
    })?;
    let temporary = directory.join("snapshot.json.tmp");
    tokio::fs::write(&temporary, data).await?;
    tokio::fs::rename(temporary, directory.join("snapshot.json")).await?;
    Ok(())
}

async fn clear_journal(directory: &Path) -> AppResult<()> {
    tokio::fs::write(directory.join("journal.jsonl"), "").await?;
    Ok(())
}

fn discover_collections(root: &Path) -> AppResult<BTreeSet<String>> {
    fn visit(root: &Path, directory: &Path, found: &mut BTreeSet<String>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                visit(root, &path, found)?;
            } else if entry.file_name() == "snapshot.json" || entry.file_name() == "journal.jsonl" {
                if let Some(parent) = path.parent() {
                    let relative = parent.strip_prefix(root).unwrap_or(parent);
                    let key = relative
                        .to_string_lossy()
                        .replace(std::path::MAIN_SEPARATOR, "/");
                    if !key.is_empty() {
                        found.insert(key);
                    }
                }
            }
        }
        Ok(())
    }
    let mut found = BTreeSet::new();
    visit(root, root, &mut found)?;
    Ok(found)
}

fn validate_document(document: &Value) -> AppResult<()> {
    let object = document
        .as_object()
        .ok_or_else(|| AppError::BadRequest("documents must be JSON objects".into()))?;
    reject_reserved_fields(object)
}

fn reject_reserved_fields(object: &Map<String, Value>) -> AppResult<()> {
    if object.keys().any(|key| key.starts_with('_')) {
        return Err(AppError::BadRequest(
            "fields beginning with '_' are reserved by Restly".into(),
        ));
    }
    Ok(())
}

fn stamp_document(document: &mut Value, id: &str, path: &CollectionPath) {
    let object = document
        .as_object_mut()
        .expect("document validated as object");
    let now = Utc::now().to_rfc3339();
    let created_at = object
        .get("_createdAt")
        .cloned()
        .unwrap_or_else(|| Value::String(now.clone()));
    object.insert("_id".into(), Value::String(id.to_string()));
    object.insert("_createdAt".into(), created_at);
    object.insert("_updatedAt".into(), Value::String(now));
    if let Some(parent) = &path.parent {
        object.insert(
            "_parent".into(),
            json!({ "collection": parent.collection_display, "id": parent.id }),
        );
    }
}

fn merge_patch(target: &mut Value, patch: &Value) {
    let (Some(target), Some(patch)) = (target.as_object_mut(), patch.as_object()) else {
        *target = patch.clone();
        return;
    };
    for (key, value) in patch {
        if value.is_null() {
            target.remove(key);
        } else if let Some(existing) = target.get_mut(key) {
            merge_patch(existing, value);
        } else {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn rebuild_indexes(collection: &mut Collection) {
    collection.indexes.clear();
    for (id, document) in &collection.documents {
        index_value(
            &mut collection.indexes,
            "_id",
            &Value::String(id.clone()),
            id,
        );
        index_document(&mut collection.indexes, document, id, "");
    }
}

fn index_document(
    indexes: &mut HashMap<String, HashMap<String, BTreeSet<String>>>,
    value: &Value,
    id: &str,
    prefix: &str,
) {
    let Some(object) = value.as_object() else {
        return;
    };
    for (field, value) in object {
        let path = if prefix.is_empty() {
            field.clone()
        } else {
            format!("{prefix}.{field}")
        };
        if scalar_key(value).is_some() {
            index_value(indexes, &path, value, id);
        } else if value.is_object() && !field.starts_with('_') {
            index_document(indexes, value, id, &path);
        }
    }
}

fn index_value(
    indexes: &mut HashMap<String, HashMap<String, BTreeSet<String>>>,
    field: &str,
    value: &Value,
    id: &str,
) {
    if let Some(key) = scalar_key(value) {
        indexes
            .entry(field.to_string())
            .or_default()
            .entry(key)
            .or_default()
            .insert(id.to_string());
    }
}

fn scalar_key(value: &Value) -> Option<String> {
    match value {
        Value::Null => Some("null".into()),
        Value::Bool(value) => Some(format!("bool:{value}")),
        Value::Number(value) => Some(format!("number:{value}")),
        Value::String(value) => Some(format!("string:{value}")),
        Value::Array(_) | Value::Object(_) => None,
    }
}

#[derive(Debug)]
struct Filter {
    field: String,
    operator: FilterOperator,
    value: String,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
enum FilterOperator {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    In,
    Contains,
    Prefix,
    Exists,
}

impl Filter {
    fn matches(&self, document: &Value) -> bool {
        let value = lookup(document, &self.field);
        match self.operator {
            FilterOperator::Exists => {
                value.is_some() == matches!(self.value.as_str(), "true" | "1")
            }
            FilterOperator::Ne => value.is_none_or(|actual| !values_equal(actual, &self.value)),
            FilterOperator::In => value
                .is_some_and(|actual| self.value.split(',').any(|item| values_equal(actual, item))),
            FilterOperator::Contains => value.is_some_and(|actual| match actual {
                Value::String(text) => text.contains(&self.value),
                Value::Array(items) => items.iter().any(|item| values_equal(item, &self.value)),
                _ => false,
            }),
            FilterOperator::Prefix => value
                .and_then(Value::as_str)
                .is_some_and(|text| text.starts_with(&self.value)),
            FilterOperator::Eq => value.is_some_and(|actual| values_equal(actual, &self.value)),
            FilterOperator::Gt => value.is_some_and(|actual| {
                compare_value_to_query(actual, &self.value) == Some(Ordering::Greater)
            }),
            FilterOperator::Gte => value.is_some_and(|actual| {
                matches!(
                    compare_value_to_query(actual, &self.value),
                    Some(Ordering::Greater | Ordering::Equal)
                )
            }),
            FilterOperator::Lt => value.is_some_and(|actual| {
                compare_value_to_query(actual, &self.value) == Some(Ordering::Less)
            }),
            FilterOperator::Lte => value.is_some_and(|actual| {
                matches!(
                    compare_value_to_query(actual, &self.value),
                    Some(Ordering::Less | Ordering::Equal)
                )
            }),
        }
    }
}

fn parse_filters(query: &HashMap<String, String>) -> AppResult<Vec<Filter>> {
    query
        .iter()
        .filter(|(key, _)| key.starts_with("where."))
        .map(|(key, value)| {
            let raw = key.trim_start_matches("where.");
            let (field, operator) = match raw.rsplit_once('.') {
                Some((field, suffix)) if parse_operator(suffix).is_some() => {
                    (field, parse_operator(suffix).expect("checked above"))
                }
                _ => (raw, FilterOperator::Eq),
            };
            if field.is_empty() {
                return Err(AppError::BadRequest(
                    "where fields must not be empty".into(),
                ));
            }
            if operator == FilterOperator::Exists
                && !matches!(value.as_str(), "true" | "false" | "1" | "0")
            {
                return Err(AppError::BadRequest("exists accepts true or false".into()));
            }
            Ok(Filter {
                field: field.into(),
                operator,
                value: value.clone(),
            })
        })
        .collect()
}

fn parse_operator(raw: &str) -> Option<FilterOperator> {
    Some(match raw {
        "eq" => FilterOperator::Eq,
        "ne" => FilterOperator::Ne,
        "gt" => FilterOperator::Gt,
        "gte" => FilterOperator::Gte,
        "lt" => FilterOperator::Lt,
        "lte" => FilterOperator::Lte,
        "in" => FilterOperator::In,
        "contains" => FilterOperator::Contains,
        "prefix" => FilterOperator::Prefix,
        "exists" => FilterOperator::Exists,
        _ => return None,
    })
}

fn candidate_ids(collection: &Collection, filters: &[Filter]) -> Option<BTreeSet<String>> {
    filters
        .iter()
        .filter(|filter| matches!(filter.operator, FilterOperator::Eq | FilterOperator::In))
        .filter_map(|filter| {
            let index = collection.indexes.get(&filter.field)?;
            let ids = match filter.operator {
                FilterOperator::Eq => index.get(&query_key(&filter.value)?)?.clone(),
                FilterOperator::In => filter
                    .value
                    .split(',')
                    .filter_map(|value| index.get(&query_key(value)?))
                    .flatten()
                    .cloned()
                    .collect(),
                _ => unreachable!(),
            };
            Some(ids)
        })
        .min_by_key(BTreeSet::len)
}

fn query_key(raw: &str) -> Option<String> {
    let value = serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()));
    scalar_key(&value)
}

fn lookup<'a>(document: &'a Value, field: &str) -> Option<&'a Value> {
    field
        .split('.')
        .try_fold(document, |value, segment| value.get(segment))
}

fn values_equal(value: &Value, raw: &str) -> bool {
    query_key(raw).is_some_and(|key| scalar_key(value).as_ref() == Some(&key))
}

fn compare_value_to_query(value: &Value, raw: &str) -> Option<Ordering> {
    let query = serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()));
    compare_values(value, &query)
}

#[derive(Debug)]
struct Sort {
    field: String,
    descending: bool,
}

fn parse_sorts(raw: Option<&str>) -> AppResult<Vec<Sort>> {
    let mut sorts = raw
        .unwrap_or("_id")
        .split(',')
        .filter(|part| !part.is_empty())
        .map(|part| Sort {
            field: part.trim_start_matches(['-', '+']).to_string(),
            descending: part.starts_with('-'),
        })
        .collect::<Vec<_>>();
    if sorts.iter().any(|sort| sort.field.is_empty()) {
        return Err(AppError::BadRequest("sort fields must not be empty".into()));
    }
    if !sorts.iter().any(|sort| sort.field == "_id") {
        sorts.push(Sort {
            field: "_id".into(),
            descending: false,
        });
    }
    Ok(sorts)
}

fn compare_documents(left: &Value, right: &Value, sorts: &[Sort]) -> Ordering {
    for sort in sorts {
        let order = match (lookup(left, &sort.field), lookup(right, &sort.field)) {
            (Some(left), Some(right)) => compare_values(left, right).unwrap_or(Ordering::Equal),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        };
        let order = if sort.descending {
            order.reverse()
        } else {
            order
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    Ordering::Equal
}

fn compare_values(left: &Value, right: &Value) -> Option<Ordering> {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64()?.partial_cmp(&right.as_f64()?),
        (Value::String(left), Value::String(right)) => Some(left.cmp(right)),
        (Value::Bool(left), Value::Bool(right)) => Some(left.cmp(right)),
        (Value::Null, Value::Null) => Some(Ordering::Equal),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_top_level_and_nested_collection_paths() {
        let top = CollectionPath::from_segments(&["users"]).unwrap();
        assert_eq!(top.key, "users");
        assert!(top.parent.is_none());

        let nested = CollectionPath::from_segments(&["users", "u_1", "orders"]).unwrap();
        assert_eq!(nested.key, "users/u_1/orders");
        assert_eq!(nested.parent.unwrap().id, "u_1");
    }

    #[test]
    fn rejects_unsafe_path_parts() {
        assert!(CollectionPath::from_segments(&["../users"]).is_err());
        assert!(CollectionPath::from_segments(&["users", "u1"]).is_err());
    }

    #[test]
    fn filters_support_dot_paths_and_typed_values() {
        let filters = parse_filters(&HashMap::from([
            ("where.profile.level.gte".into(), "3".into()),
            ("where.active".into(), "true".into()),
        ]))
        .unwrap();
        let document = json!({ "profile": { "level": 4 }, "active": true });
        assert!(filters.iter().all(|filter| filter.matches(&document)));
    }

    #[test]
    fn merge_patch_removes_null_fields_recursively() {
        let mut document = json!({ "name": "Ada", "profile": { "city": "London", "age": 37 } });
        merge_patch(&mut document, &json!({ "profile": { "city": null } }));
        assert_eq!(document, json!({ "name": "Ada", "profile": { "age": 37 } }));
    }

    #[tokio::test]
    async fn journal_recovers_documents_after_reopening_the_store() {
        let root = std::env::temp_dir().join(format!(
            "restly-document-store-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let path = CollectionPath::from_segments(&["users"]).unwrap();
        let store = DocumentStore::open(&root).await.unwrap();
        store
            .replace(&path, "ada", json!({ "name": "Ada", "active": true }))
            .await
            .unwrap();
        drop(store);

        let reopened = DocumentStore::open(&root).await.unwrap();
        let document = reopened.get(&path, "ada").await.unwrap();
        assert_eq!(document["name"], "Ada");

        let page = reopened
            .list(
                &path,
                &ListOptions {
                    limit: None,
                    cursor: None,
                    sort: None,
                    query: HashMap::from([("where.active".into(), "true".into())]),
                },
            )
            .await
            .unwrap();
        assert_eq!(page.total, 1);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
