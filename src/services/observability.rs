use std::collections::VecDeque;

use serde::Serialize;
use tokio::sync::RwLock;

const MAX_REQUESTS: usize = 500;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestTrace {
    pub method: String,
    pub path: String,
    pub status: u16,
    pub duration_ms: f64,
    pub timestamp_ms: i64,
}

/// A bounded, in-memory request stream for the developer console. It is
/// intentionally separate from the durable access log and never records query
/// strings or request bodies, which can contain application data or secrets.
pub struct RequestTraces {
    entries: RwLock<VecDeque<RequestTrace>>,
}

impl RequestTraces {
    pub fn new() -> Self {
        Self {
            entries: RwLock::new(VecDeque::with_capacity(MAX_REQUESTS)),
        }
    }

    pub async fn record(&self, trace: RequestTrace) {
        let mut entries = self.entries.write().await;
        entries.push_front(trace);
        entries.truncate(MAX_REQUESTS);
    }

    pub async fn recent(&self, limit: usize) -> Vec<RequestTrace> {
        self.entries
            .read()
            .await
            .iter()
            .take(limit.clamp(1, MAX_REQUESTS))
            .cloned()
            .collect()
    }
}

impl Default for RequestTraces {
    fn default() -> Self {
        Self::new()
    }
}
