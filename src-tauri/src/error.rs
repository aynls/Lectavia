use std::fmt::Display;

use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Clone, Debug, Serialize)]
pub struct AppError {
    pub(crate) key: &'static str,
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub(crate) values: Map<String, Value>,
}

impl AppError {
    pub fn with(mut self, name: &str, value: impl Into<Value>) -> Self {
        self.values.insert(name.into(), value.into());
        self
    }

    pub fn detail(key: &'static str, detail: impl Display) -> Self {
        Self::from(key).with("detail", detail.to_string())
    }
}

impl From<&'static str> for AppError {
    fn from(key: &'static str) -> Self {
        Self {
            key,
            values: Map::new(),
        }
    }
}
