//! Router-level integration tests: build the real `Router` used by
//! `main.rs` (including the access-log middleware) and drive it with
//! `tower::ServiceExt::oneshot`, the same way `axum::serve` would.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::connect_info::ConnectInfo;
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use crate::config::AppConfig;
use crate::state::AppState;

async fn test_app() -> Router {
    // Keep document persistence isolated per test app while still exercising
    // the real on-disk store and its recovery path.
    let data_dir = std::env::temp_dir().join(format!(
        "restly-test-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let state = Arc::new(
        AppState::with_data_dir(AppConfig::default(), data_dir)
            .await
            .unwrap(),
    );
    crate::routes::router(state)
}

/// The access-log middleware extracts `ConnectInfo<SocketAddr>`, which
/// `axum::serve(...).into_make_service_with_connect_info()` normally
/// inserts per-connection. Driving the router directly with `oneshot`
/// bypasses that, so tests insert it manually — otherwise every request
/// would fail extraction before reaching a handler.
fn request(method: Method, uri: &str) -> Request<Body> {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .unwrap();
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 0))));
    req
}

fn json_request(method: Method, uri: &str, body: Value) -> Request<Body> {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 0))));
    req
}

async fn body_json(response: axum::response::Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn health_reports_ok() {
    let app = test_app().await;
    let res = app
        .oneshot(request(Method::GET, "/api/health"))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res).await;
    assert_eq!(body["status"], "ok");
}

#[tokio::test]
async fn config_exposes_ui_section_camel_cased() {
    let app = test_app().await;
    let res = app
        .oneshot(request(Method::GET, "/api/config"))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res).await;
    assert_eq!(body["ui"]["appName"], "Restly");
    assert_eq!(body["ui"]["defaultTheme"], "auto");
    assert!(body["version"].is_string());
}

#[tokio::test]
async fn data_api_creates_queries_updates_and_deletes_documents() {
    let app = test_app().await;

    let created = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/data/products",
            serde_json::json!({ "name": "Keyboard", "price": 120, "active": true }),
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    let created = body_json(created).await;
    let id = created["_id"].as_str().unwrap().to_string();
    assert_eq!(created["name"], "Keyboard");
    assert!(created["_createdAt"].is_string());

    let listed = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/data/products?where.active=true&sort=-price",
        ))
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
    let listed = body_json(listed).await;
    assert_eq!(listed["total"], 1);
    assert_eq!(listed["data"][0]["_id"], id);

    let updated = app
        .clone()
        .oneshot(json_request(
            Method::PATCH,
            &format!("/data/products/{id}"),
            serde_json::json!({ "price": 99, "spec": { "wireless": true } }),
        ))
        .await
        .unwrap();
    assert_eq!(updated.status(), StatusCode::OK);
    let updated = body_json(updated).await;
    assert_eq!(updated["price"], 99);
    assert_eq!(updated["spec"]["wireless"], true);
    assert_eq!(updated["_createdAt"], created["_createdAt"]);

    let deleted = app
        .clone()
        .oneshot(request(Method::DELETE, &format!("/data/products/{id}")))
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);

    let missing = app
        .oneshot(request(Method::GET, &format!("/data/products/{id}")))
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn data_api_supports_nested_collections_and_put_upserts() {
    let app = test_app().await;
    let parent = app
        .clone()
        .oneshot(json_request(
            Method::PUT,
            "/data/users/ada",
            serde_json::json!({ "name": "Ada" }),
        ))
        .await
        .unwrap();
    assert_eq!(parent.status(), StatusCode::CREATED);

    let child = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/data/users/ada/orders",
            serde_json::json!({ "total": 32 }),
        ))
        .await
        .unwrap();
    assert_eq!(child.status(), StatusCode::CREATED);
    let child = body_json(child).await;
    assert_eq!(child["_parent"]["collection"], "users");
    assert_eq!(child["_parent"]["id"], "ada");

    let protected_parent = app
        .clone()
        .oneshot(request(Method::DELETE, "/data/users/ada"))
        .await
        .unwrap();
    assert_eq!(protected_parent.status(), StatusCode::CONFLICT);

    let upsert = app
        .oneshot(json_request(
            Method::PUT,
            "/data/users/grace",
            serde_json::json!({ "name": "Grace" }),
        ))
        .await
        .unwrap();
    assert_eq!(upsert.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn data_root_and_admin_collection_routes_list_auto_created_collections() {
    let app = test_app().await;
    let created = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/data/logs",
            serde_json::json!({ "message": "started" }),
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);

    for endpoint in ["/data", "/api/collections"] {
        let response = app
            .clone()
            .oneshot(request(Method::GET, endpoint))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["data"][0]["name"], "logs");
        assert_eq!(body["data"][0]["count"], 1);
    }
}

#[tokio::test]
async fn unknown_api_route_returns_json_404_not_the_spa_shell() {
    let app = test_app().await;
    let res = app
        .oneshot(request(Method::GET, "/api/this-does-not-exist"))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let body = body_json(res).await;
    assert_eq!(body["error"]["code"], "NOT_FOUND");
}

/// Non-API routes fall back to the embedded SPA. Whether `ui/dist` has
/// been built varies by environment (a fresh clone hasn't run `npm run
/// build` yet), so this only pins down the two contractually valid
/// outcomes rather than depending on the frontend build being present.
#[tokio::test]
async fn unknown_non_api_route_serves_spa_shell_or_the_not_built_notice() {
    let app = test_app().await;
    let res = app
        .oneshot(request(Method::GET, "/some/deep/link"))
        .await
        .unwrap();
    assert!(
        res.status() == StatusCode::OK || res.status() == StatusCode::SERVICE_UNAVAILABLE,
        "unexpected status: {}",
        res.status()
    );
}
