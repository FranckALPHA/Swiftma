// Cas de référence générés par le cœur TypeScript (tests/fixtures/ops.json) : le hub doit obtenir les mêmes
// documents, les mêmes inverses et les mêmes erreurs.

use serde_json::Value;
use swiftma_hub::ops::apply_ops;

fn fixtures() -> Vec<Value> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/ops.json");
    let text = std::fs::read_to_string(path).expect("fixtures lisibles");
    serde_json::from_str(&text).expect("fixtures JSON")
}

/// Égalité JSON où une clé absente vaut null (et 1 == 1.0).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let null = Value::Null;
            x.keys()
                .chain(y.keys())
                .all(|k| same(x.get(k).unwrap_or(&null), y.get(k).unwrap_or(&null)))
        }
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b)),
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

#[test]
fn cas_de_reference_du_coeur() {
    let cases = fixtures();
    assert!(cases.len() >= 15, "fixtures incomplètes");
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let before = &case["before"];
        let ops = case["ops"].as_array().unwrap();
        let mut doc = before.clone();
        let result = apply_ops(&mut doc, ops);
        if case["error"].as_bool() == Some(true) {
            let e = result.expect_err(name);
            if let Some(msg) = case.get("message").and_then(Value::as_str) {
                assert_eq!(e.0, msg, "{name} : message");
            }
            assert!(
                same(&doc, before),
                "{name} : le document doit être intact après une erreur"
            );
        } else {
            let inverse = result.unwrap_or_else(|e| panic!("{name} : {e}"));
            assert!(same(&doc, &case["after"]), "{name} : document après\n{doc:#}");
            let inverse = Value::Array(inverse);
            assert!(same(&inverse, &case["inverse"]), "{name} : inverse\n{inverse:#}");
            apply_ops(&mut doc, inverse.as_array().unwrap()).unwrap_or_else(|e| panic!("{name} : inverse {e}"));
            assert!(
                same(&doc, before),
                "{name} : l'inverse doit ramener au document de départ"
            );
        }
    }
}

#[test]
fn comparaison_absent_egal_null() {
    assert!(same(
        &serde_json::json!({"a":1,"b":null}),
        &serde_json::json!({"a":1.0})
    ));
    assert!(!same(&serde_json::json!({"a":1}), &serde_json::json!({"a":2})));
}
