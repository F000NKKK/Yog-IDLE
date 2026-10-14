//! Yog Data text (the `yog-data` crate: JSON plus comments, trailing commas
//! and unquoted keys) as `serde_json` values, for the readers here that
//! only look things up.

use serde_json::{Map, Value};

/// `v` as a `serde_json` value; typed values become their string forms.
pub fn to_json(v: &yog_data::Value) -> Value {
    match v {
        yog_data::Value::Null => Value::Null,
        yog_data::Value::Bool(b) => Value::Bool(*b),
        yog_data::Value::Int(n) => Value::from(*n),
        yog_data::Value::Float(f) => serde_json::Number::from_f64(*f).map_or(Value::Null, Value::Number),
        yog_data::Value::Str(s) => Value::String(s.clone()),
        yog_data::Value::List(items) => Value::Array(items.iter().map(to_json).collect()),
        yog_data::Value::Map(m) => Value::Object(m.iter().map(|(k, v)| (k.to_string(), to_json(v))).collect()),
        typed => Value::String(yog_data::typed::typed_string(typed).unwrap_or_default()),
    }
}

/// A Yog Data file that's one object, `None` if it isn't.
pub fn read_object(text: &str) -> Option<Map<String, Value>> {
    match to_json(&yog_data::text::parse_value(text).ok()?) {
        Value::Object(m) => Some(m),
        _ => None,
    }
}
