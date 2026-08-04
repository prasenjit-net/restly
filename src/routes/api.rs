use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::services::documents::{CollectionPath, ListOptions};
use crate::services::metrics::MetricsSnapshot;
use crate::state::SharedState;

pub async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

/// Bootstrap configuration for the SPA, sourced from config.toml.
pub async fn config(State(state): State<SharedState>) -> Json<Value> {
    Json(json!({
        "ui": state.config.ui,
        "version": env!("CARGO_PKG_VERSION"),
        "startedAtMs": state.started_at_ms,
    }))
}

pub async fn metrics(State(state): State<SharedState>) -> AppResult<Json<MetricsSnapshot>> {
    state
        .latest_metrics
        .read()
        .await
        .clone()
        .map(Json)
        .ok_or_else(|| AppError::Internal("metrics are not available yet".into()))
}

/// Lists the discovered data collections for the admin UI. Documents remain
/// exclusively under `/data/**`; `/api/**` is reserved for Restly itself.
pub async fn collections(State(state): State<SharedState>) -> AppResult<Json<Value>> {
    Ok(Json(
        json!({ "data": state.documents.collections().await? }),
    ))
}

pub async fn store_stats(State(state): State<SharedState>) -> AppResult<Json<Value>> {
    Ok(Json(
        serde_json::to_value(state.documents.stats().await?).map_err(|error| {
            AppError::Internal(format!("failed to encode store statistics: {error}"))
        })?,
    ))
}

pub async fn compact_store(State(state): State<SharedState>) -> AppResult<StatusCode> {
    state.documents.compact_all().await?;
    state.activity("storage", "Document store compacted");
    Ok(StatusCode::NO_CONTENT)
}

pub async fn read_data(
    State(state): State<SharedState>,
    Path(path): Path<String>,
    Query(options): Query<ListOptions>,
) -> AppResult<Json<Value>> {
    let (collection, id) = parse_data_path(&path)?;
    let result = match id {
        Some(id) => state.documents.get(&collection, &id).await?,
        None => serde_json::to_value(state.documents.list(&collection, &options).await?).map_err(
            |error| AppError::Internal(format!("failed to encode document page: {error}")),
        )?,
    };
    Ok(Json(result))
}

pub async fn insert_document(
    State(state): State<SharedState>,
    Path(path): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let (collection, id) = parse_data_path(&path)?;
    if id.is_some() {
        return Err(AppError::BadRequest(
            "POST targets a collection, not a document; use PUT to upsert a document id".into(),
        ));
    }
    let document = state.documents.insert(&collection, body).await?;
    state.activity(
        "document",
        format!("Document created in {}", collection.display),
    );
    Ok((StatusCode::CREATED, Json(document)))
}

pub async fn replace_document(
    State(state): State<SharedState>,
    Path(path): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let (collection, id) = parse_data_path(&path)?;
    let id = id.ok_or_else(|| AppError::BadRequest("PUT requires a document id".into()))?;
    let (created, document) = state.documents.replace(&collection, &id, body).await?;
    state.activity(
        "document",
        format!(
            "Document {} in {}",
            if created { "created" } else { "replaced" },
            collection.display
        ),
    );
    Ok((
        if created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(document),
    ))
}

pub async fn patch_document(
    State(state): State<SharedState>,
    Path(path): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let (collection, id) = parse_data_path(&path)?;
    let id = id.ok_or_else(|| AppError::BadRequest("PATCH requires a document id".into()))?;
    let document = state.documents.patch(&collection, &id, body).await?;
    state.activity(
        "document",
        format!("Document updated in {}", collection.display),
    );
    Ok(Json(document))
}

pub async fn delete_document(
    State(state): State<SharedState>,
    Path(path): Path<String>,
) -> AppResult<StatusCode> {
    let (collection, id) = parse_data_path(&path)?;
    let id = id.ok_or_else(|| AppError::BadRequest("DELETE requires a document id".into()))?;
    state.documents.delete(&collection, &id).await?;
    state.activity(
        "document",
        format!("Document deleted from {}", collection.display),
    );
    Ok(StatusCode::NO_CONTENT)
}

fn parse_data_path(path: &str) -> AppResult<(CollectionPath, Option<String>)> {
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.is_empty() {
        return Err(AppError::BadRequest("a collection name is required".into()));
    }
    let id = if segments.len().is_multiple_of(2) {
        segments.last().map(|segment| (*segment).to_string())
    } else {
        None
    };
    let collection_end = if id.is_some() {
        segments.len() - 1
    } else {
        segments.len()
    };
    let collection = CollectionPath::from_segments(&segments[..collection_end])?;
    Ok((collection, id))
}

#[cfg(test)]
mod data_path_tests {
    use super::parse_data_path;

    #[test]
    fn parses_document_and_nested_collection_paths() {
        let (collection, id) = parse_data_path("users/u1/orders").unwrap();
        assert_eq!(collection.key, "users/u1/orders");
        assert_eq!(id, None);

        let (collection, id) = parse_data_path("users/u1/orders/o1").unwrap();
        assert_eq!(collection.key, "users/u1/orders");
        assert_eq!(id.as_deref(), Some("o1"));
    }
}
