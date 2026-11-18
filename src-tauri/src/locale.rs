use std::{collections::HashMap, sync::OnceLock};

use clap::ValueEnum;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error::AppError;

#[cfg_attr(feature = "mcp", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "desktop", derive(serde::Serialize))]
#[cfg_attr(feature = "mcp", schemars(inline))]
#[derive(Clone, Copy, Deserialize, ValueEnum, PartialEq)]
pub enum Locale {
    #[serde(rename = "zh-CN")]
    #[value(name = "zh-CN")]
    ZhCn,
    #[serde(rename = "ja")]
    Ja,
    #[serde(rename = "en")]
    En,
}

type Catalog = HashMap<String, String>;

impl Locale {
    pub fn text(self, key: &str) -> &str {
        static ZH_CN: OnceLock<Catalog> = OnceLock::new();
        static JA: OnceLock<Catalog> = OnceLock::new();
        static EN: OnceLock<Catalog> = OnceLock::new();
        let (catalog, json) = match self {
            Self::ZhCn => (&ZH_CN, include_str!("../../src/locales/zh-CN.json")),
            Self::Ja => (&JA, include_str!("../../src/locales/ja.json")),
            Self::En => (&EN, include_str!("../../src/locales/en.json")),
        };
        catalog
            .get_or_init(|| serde_json::from_str(json).expect("invalid translation catalog"))
            .get(key)
            .map_or(key, String::as_str)
    }

    pub fn error(self, error: &AppError) -> String {
        self.render(error.key, Some(&error.values))
    }

    fn render(self, key: &str, values: Option<&Map<String, Value>>) -> String {
        let mut remaining = self.text(key);
        let mut output = String::new();
        while let Some((prefix, after_open)) = remaining.split_once("{{") {
            let Some((name, after_close)) = after_open.split_once("}}") else {
                break;
            };
            output.push_str(prefix);
            if let Some(value) = values.and_then(|values| values.get(name.trim())) {
                if let Some(key) = value.get("key").and_then(Value::as_str) {
                    let nested = value.get("values").and_then(Value::as_object);
                    output.push_str(&self.render(key, nested));
                } else if let Some(text) = value.as_str() {
                    output.push_str(text);
                } else {
                    output.push_str(&value.to_string());
                }
            }
            remaining = after_close;
        }
        output.push_str(remaining);
        output
    }
}
