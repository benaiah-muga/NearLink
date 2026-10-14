//! A small, transport-independent validator for NearLink protocol v1 JSON.
//!
//! This crate performs structural validation only. It does not provide
//! authentication, encryption, canonical serialization, or transport logic.
//! The [`sync`] module adds bounded, in-memory reconciliation over validated
//! message packets. It does not add persistence or trust guarantees.

use serde_json::Value;

pub mod sync;

pub const PROTOCOL_VERSION: u8 = 1;
pub const MAX_MESSAGE_BODY_BYTES: usize = 16 * 1024;

const HUB_WHITESPACE: &[char] = &[
    '\u{0009}', '\u{000a}', '\u{000b}', '\u{000c}', '\u{000d}', '\u{001c}', '\u{001d}', '\u{001e}',
    '\u{001f}', '\u{0020}', '\u{0085}', '\u{00a0}', '\u{1680}', '\u{2000}', '\u{2001}', '\u{2002}',
    '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}', '\u{2007}', '\u{2008}', '\u{2009}', '\u{200a}',
    '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}',
];

fn record(value: &Value) -> bool {
    value.is_object()
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    value.as_object()?.get(name)
}

fn text_field<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    field(value, name)?.as_str()
}

fn has_v1(value: &Value) -> bool {
    field(value, "version").and_then(Value::as_f64) == Some(f64::from(PROTOCOL_VERSION))
}

fn has_type(value: &Value, expected: &str) -> bool {
    text_field(value, "type") == Some(expected)
}

pub fn is_protocol_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

pub fn is_protocol_room(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn strip_hub_whitespace(value: &str) -> &str {
    value.trim_matches(HUB_WHITESPACE)
}

fn is_display_name(value: &str) -> bool {
    let stripped = strip_hub_whitespace(value);
    let count = stripped.chars().count();
    count > 0 && count <= 64
}

fn digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn number(value: &str) -> Option<u32> {
    if digits(value) {
        value.parse().ok()
    } else {
        None
    }
}

pub fn is_protocol_timestamp(value: &str) -> bool {
    if value.len() > 64 || !value.is_ascii() || value.len() < 20 {
        return false;
    }

    let bytes = value.as_bytes();
    if bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return false;
    }

    let year = match number(&value[0..4]) {
        Some(number) if number >= 1 => number,
        _ => return false,
    };
    let month = match number(&value[5..7]) {
        Some(number) if (1..=12).contains(&number) => number,
        _ => return false,
    };
    let day = match number(&value[8..10]) {
        Some(number) => number,
        _ => return false,
    };
    let hour = match number(&value[11..13]) {
        Some(number) if number <= 23 => number,
        _ => return false,
    };
    let minute = match number(&value[14..16]) {
        Some(number) if number <= 59 => number,
        _ => return false,
    };
    let second = match number(&value[17..19]) {
        Some(number) if number <= 59 => number,
        _ => return false,
    };
    let _ = (hour, minute, second);

    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        2 if leap_year => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if day == 0 || day > days_in_month {
        return false;
    }

    let suffix = &value[19..];
    let zone = if let Some(fraction_and_zone) = suffix.strip_prefix('.') {
        let fraction_len = fraction_and_zone
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        if !(1..=3).contains(&fraction_len) {
            return false;
        }
        &fraction_and_zone[fraction_len..]
    } else {
        suffix
    };

    if zone == "Z" {
        return true;
    }
    if zone.len() != 6 || !(zone.starts_with('+') || zone.starts_with('-')) {
        return false;
    }
    if zone.as_bytes().get(3) != Some(&b':') {
        return false;
    }
    let offset_hour = match number(&zone[1..3]) {
        Some(number) if number <= 23 => number,
        _ => return false,
    };
    let offset_minute = match number(&zone[4..6]) {
        Some(number) if number <= 59 => number,
        _ => return false,
    };
    let _ = (offset_hour, offset_minute);
    true
}

pub fn is_join_packet(value: &Value) -> bool {
    record(value)
        && has_v1(value)
        && has_type(value, "join")
        && text_field(value, "room").is_some_and(is_protocol_room)
        && text_field(value, "sender").is_some_and(is_protocol_identifier)
        && text_field(value, "senderName").is_some_and(is_display_name)
}

pub fn is_message_packet(value: &Value) -> bool {
    record(value)
        && has_v1(value)
        && has_type(value, "message")
        && text_field(value, "id").is_some_and(is_protocol_identifier)
        && text_field(value, "room").is_some_and(is_protocol_room)
        && text_field(value, "sender").is_some_and(is_protocol_identifier)
        && text_field(value, "senderName").is_some_and(is_display_name)
        && text_field(value, "createdAt").is_some_and(is_protocol_timestamp)
        && text_field(value, "body").is_some_and(|body| {
            !strip_hub_whitespace(body).is_empty() && body.len() <= MAX_MESSAGE_BODY_BYTES
        })
}

fn nonnegative_integer(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|number| number.is_finite() && number >= 0.0 && number.fract() == 0.0)
}

pub fn is_server_packet(value: &Value) -> bool {
    if !record(value) || !has_v1(value) {
        return false;
    }

    match text_field(value, "type") {
        Some("joined") => {
            text_field(value, "room").is_some_and(is_protocol_room)
                && nonnegative_integer(field(value, "peers"))
                && field(value, "historyTruncated")
                    .is_none_or(|history_truncated| history_truncated.is_boolean())
        }
        Some("message") => is_message_packet(value),
        Some("ack") => text_field(value, "id").is_some_and(is_protocol_identifier),
        Some("presence") => nonnegative_integer(field(value, "peers")),
        Some("error") => {
            matches!(
                text_field(value, "code"),
                Some(
                    "invalid_packet"
                        | "room_required"
                        | "message_too_large"
                        | "capacity_reached"
                        | "rate_limited"
                        | "message_conflict"
                        | "storage_unavailable"
                )
            ) && text_field(value, "message").is_some()
                && field(value, "id")
                    .is_none_or(|id| id.as_str().is_some_and(is_protocol_identifier))
        }
        _ => false,
    }
}

pub fn is_client_packet(value: &Value) -> bool {
    is_join_packet(value) || is_message_packet(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_protocol_v1_vectors_match() {
        let vectors: Vec<Value> =
            serde_json::from_str(include_str!("../../../packages/protocol/vectors/v1.json"))
                .expect("shared protocol vectors are valid JSON");

        for vector in vectors {
            let validator = vector["validator"].as_str().expect("validator name");
            let value = &vector["value"];
            let expected = vector["valid"].as_bool().expect("expected result");
            let actual = match validator {
                "client" => is_client_packet(value),
                "join" => is_join_packet(value),
                "message" => is_message_packet(value),
                "server" => is_server_packet(value),
                "timestamp" => value.as_str().is_some_and(is_protocol_timestamp),
                "identifier" => value.as_str().is_some_and(is_protocol_identifier),
                "room" => value.as_str().is_some_and(is_protocol_room),
                unknown => panic!("unknown vector validator: {unknown}"),
            };
            assert_eq!(actual, expected, "vector: {vector}");
        }
    }

    #[test]
    fn body_limit_is_utf8_bytes() {
        let base: Value = serde_json::json!({
            "version": 1,
            "type": "message",
            "id": "m1",
            "room": "room1",
            "sender": "device1",
            "senderName": "Amina",
            "createdAt": "2026-10-14T12:00:00Z",
            "body": "x"
        });

        for (body, expected) in [
            ("x".repeat(MAX_MESSAGE_BODY_BYTES), true),
            ("x".repeat(MAX_MESSAGE_BODY_BYTES + 1), false),
            ("🔒".repeat(MAX_MESSAGE_BODY_BYTES / 4), true),
            ("🔒".repeat(MAX_MESSAGE_BODY_BYTES / 4 + 1), false),
        ] {
            let mut packet = base.clone();
            packet["body"] = Value::String(body);
            assert_eq!(is_message_packet(&packet), expected);
        }
    }
}
