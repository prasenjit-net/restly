pub mod api;
#[cfg(test)]
mod tests;
pub mod ws;

use axum::middleware::from_fn_with_state;
use axum::routing::{get, post};
use axum::Router;

use crate::access_log;
use crate::state::SharedState;
use crate::static_assets;

pub fn router(state: SharedState) -> Router {
    Router::new()
        .route("/api/health", get(api::health))
        .route("/api/config", get(api::config))
        .route("/api/metrics", get(api::metrics))
        .route("/api/stats", get(api::store_stats))
        .route("/api/collections", get(api::collections))
        .route("/api/maintenance/compact", post(api::compact_store))
        .route("/data", get(api::collections))
        .route(
            "/data/{*path}",
            get(api::read_data)
                .post(api::insert_document)
                .put(api::replace_document)
                .patch(api::patch_document)
                .delete(api::delete_document),
        )
        .route("/ws", get(ws::handler))
        .fallback(static_assets::handler)
        .layer(from_fn_with_state(state.clone(), access_log::record))
        .with_state(state)
}
