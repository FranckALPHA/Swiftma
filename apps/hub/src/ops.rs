//! Application générique des opérations sur un document JSON.
//!
//! Le hub ne connaît pas le design : il applique les opérations résolues envoyées par les clients et calcule leur
//! inverse, exactement comme `applyOp` du cœur TypeScript (packages/core/src/ops.ts). Les nœuds sont des objets JSON
//! dont seules les clés `id`, `parentId`, `children` et `text` sont interprétées ; tout le reste est conservé tel quel.

use std::collections::HashSet;
use std::fmt;

use serde_json::{Map, Value, json};

pub const DEFAULT_BACKGROUND: &str = "#F5F5F5";

/// Opération refusée : le message est destiné à l'utilisateur (identique au cœur TypeScript).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpError(pub String);

impl fmt::Display for OpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for OpError {}

fn err<T>(msg: impl Into<String>) -> Result<T, OpError> {
    Err(OpError(msg.into()))
}

/// Applique un lot de façon atomique et renvoie son inverse (inverse de la dernière opération d'abord, aplati).
/// Si une opération échoue, les opérations déjà appliquées sont défaites et le document revient à son état d'avant.
pub fn apply_ops(doc: &mut Value, ops: &[Value]) -> Result<Vec<Value>, OpError> {
    let mut inverses: Vec<Vec<Value>> = Vec::with_capacity(ops.len());
    for op in ops {
        match apply_op(doc, op) {
            Ok(inverse) => inverses.push(inverse),
            Err(e) => {
                // Chaque opération est elle-même atomique : défaire les précédentes suffit
                for inverse in inverses.iter().rev() {
                    for o in inverse {
                        let _ = apply_op(doc, o);
                    }
                }
                return Err(e);
            }
        }
    }
    Ok(inverses.into_iter().rev().flatten().collect())
}

/// Applique une opération en place et renvoie ses opérations inverses. En cas d'erreur, le document est intact.
pub fn apply_op(doc: &mut Value, op: &Value) -> Result<Vec<Value>, OpError> {
    let Some(kind) = op.get("kind").and_then(Value::as_str) else {
        return err("Opération invalide : « kind » manquant");
    };
    if !doc.get("nodes").is_some_and(Value::is_object) || !doc.get("roots").is_some_and(Value::is_array) {
        return err("Document invalide");
    }
    match kind {
        "create" => create(doc, op),
        "update" => update(doc, op),
        "delete" => delete(doc, op),
        "move" => move_node(doc, op),
        "set-doc" => set_doc(doc, op),
        other => err(format!("Opération inconnue : {other}")),
    }
}

fn create(doc: &mut Value, op: &Value) -> Result<Vec<Value>, OpError> {
    let Some(node) = op.get("node").and_then(Value::as_object) else {
        return err("Opération invalide : « node » manquant");
    };
    let Some(id) = node.get("id").and_then(Value::as_str) else {
        return err("Opération invalide : nœud sans « id »");
    };
    let parent = parent_of(node);
    if nodes(doc).contains_key(id) {
        return err(format!("Le nœud {id} existe déjà"));
    }
    if let Some(p) = parent
        && !nodes(doc).contains_key(p)
    {
        return err(format!("Parent introuvable : {p}"));
    }
    let id = id.to_string();
    let parent = parent.map(str::to_string);
    let mut stored = node.clone();
    // Les enfants fournis sont ignorés : ils arrivent par leurs propres créations
    stored.insert("children".into(), json!([]));
    nodes_mut(doc).insert(id.clone(), Value::Object(stored));
    insert_at(siblings_mut(doc, parent.as_deref()), &id, op.get("index"));
    Ok(vec![json!({ "kind": "delete", "id": id })])
}

fn update(doc: &mut Value, op: &Value) -> Result<Vec<Value>, OpError> {
    let id = op_id(op)?;
    let Some(props) = op.get("props").and_then(Value::as_object) else {
        return err("Opération invalide : « props » manquant");
    };
    let Some(node) = nodes_mut(doc).get_mut(id).and_then(Value::as_object_mut) else {
        return err(format!("Nœud introuvable : {id}"));
    };
    // Comme en TypeScript, un `text` nul est ignoré ; un objet est fusionné dans le texte existant
    let text = match props.get("text") {
        None | Some(Value::Null) => None,
        Some(Value::Object(t)) => Some(t),
        Some(_) => return err("Opération invalide : « text » doit être un objet"),
    };
    if text.is_some() && !node.get("text").is_some_and(Value::is_object) {
        return err(format!("Le nœud {id} n'est pas un texte"));
    }
    // Valeur absente = null, pour que l'inverse survive au JSON
    let before: Map<String, Value> = props
        .keys()
        .map(|k| {
            (
                k.clone(),
                node.get(k).filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null),
            )
        })
        .collect();
    for (k, v) in props {
        if k != "text" {
            node.insert(k.clone(), v.clone());
        }
    }
    if let Some(text) = text
        && let Some(Value::Object(current)) = node.get_mut("text")
    {
        for (k, v) in text {
            current.insert(k.clone(), v.clone());
        }
    }
    Ok(vec![json!({ "kind": "update", "id": id, "props": before })])
}

fn delete(doc: &mut Value, op: &Value) -> Result<Vec<Value>, OpError> {
    let id = op_id(op)?;
    let Some(node) = nodes(doc).get(id).and_then(Value::as_object) else {
        return err(format!("Nœud introuvable : {id}"));
    };
    let parent = parent_of(node).map(str::to_string);
    let ids = subtree(doc, id);
    let siblings = siblings_mut(doc, parent.as_deref());
    let index = siblings.iter().position(|v| v.as_str() == Some(id));
    if let Some(i) = index {
        siblings.remove(i);
    }
    // Inverse : recréer le nœud puis ses descendants, parents d'abord ; seul le premier porte sa position
    let nodes = nodes_mut(doc);
    let mut inverse = Vec::with_capacity(ids.len());
    for (i, nid) in ids.iter().enumerate() {
        let Some(n) = nodes.shift_remove(nid) else { continue };
        let mut create = json!({ "kind": "create", "node": n });
        if i == 0
            && let Some(index) = index
        {
            create["index"] = json!(index);
        }
        inverse.push(create);
    }
    Ok(inverse)
}

fn move_node(doc: &mut Value, op: &Value) -> Result<Vec<Value>, OpError> {
    let id = op_id(op)?;
    let new_parent_value = op.get("parentId").cloned().unwrap_or(Value::Null);
    let new_parent = match &new_parent_value {
        Value::Null => None,
        Value::String(s) if s.is_empty() => None,
        Value::String(s) => Some(s.clone()),
        _ => return err("Opération invalide : « parentId » doit être un id ou null"),
    };
    let Some(node) = nodes(doc).get(id).and_then(Value::as_object) else {
        return err(format!("Nœud introuvable : {id}"));
    };
    let old_parent_value = node.get("parentId").cloned().unwrap_or(Value::Null);
    let old_parent = parent_of(node).map(str::to_string);
    if let Some(p) = &new_parent {
        if subtree(doc, id).iter().any(|n| n == p) {
            return err("Impossible de déplacer un nœud dans lui-même");
        }
        if !nodes(doc).contains_key(p) {
            return err(format!("Nœud introuvable : {p}"));
        }
    }
    let old_siblings = siblings_mut(doc, old_parent.as_deref());
    let old_index = old_siblings.iter().position(|v| v.as_str() == Some(id));
    if let Some(i) = old_index {
        old_siblings.remove(i);
    }
    if let Some(Value::Object(node)) = nodes_mut(doc).get_mut(id) {
        node.insert("parentId".into(), new_parent_value);
    }
    insert_at(siblings_mut(doc, new_parent.as_deref()), id, op.get("index"));
    let mut inverse = json!({ "kind": "move", "id": id, "parentId": old_parent_value });
    if let Some(i) = old_index {
        inverse["index"] = json!(i);
    }
    Ok(vec![inverse])
}

fn set_doc(doc: &mut Value, op: &Value) -> Result<Vec<Value>, OpError> {
    let Some(props) = op.get("props").and_then(Value::as_object) else {
        return err("Opération invalide : « props » manquant");
    };
    // Vérifier toutes les clés avant de modifier quoi que ce soit
    if let Some(key) = props.keys().find(|k| matches!(k.as_str(), "nodes" | "roots" | "id")) {
        return err(format!("Propriété de document non modifiable : {key}"));
    }
    let Some(d) = doc.as_object_mut() else {
        return err("Document invalide");
    };
    let mut before = Map::new();
    for (key, value) in props {
        let previous = match d.get(key) {
            Some(v) if !v.is_null() => v.clone(),
            _ if key == "background" => json!(DEFAULT_BACKGROUND),
            _ => Value::Null,
        };
        before.insert(key.clone(), previous);
        d.insert(key.clone(), value.clone());
    }
    Ok(vec![json!({ "kind": "set-doc", "props": before })])
}

/// Ids du sous-arbre d'un nœud, parents d'abord, dans l'ordre des `children` (protégé contre les cycles).
pub fn subtree(doc: &Value, id: &str) -> Vec<String> {
    let nodes = nodes(doc);
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut stack = vec![id.to_string()];
    while let Some(nid) = stack.pop() {
        if !seen.insert(nid.clone()) {
            continue;
        }
        if let Some(children) = nodes
            .get(&nid)
            .and_then(|n| n.get("children"))
            .and_then(Value::as_array)
        {
            stack.extend(children.iter().rev().filter_map(Value::as_str).map(str::to_string));
        }
        out.push(nid);
    }
    out
}

/// Nombre de nœuds d'un document.
pub fn node_count(doc: &Value) -> usize {
    doc.get("nodes").and_then(Value::as_object).map_or(0, Map::len)
}

/// Document vide.
pub fn empty_document(id: &str, name: &str) -> Value {
    json!({ "id": id, "name": name, "background": DEFAULT_BACKGROUND, "nodes": {}, "roots": [] })
}

/// Complète un document reçu de l'extérieur (import, création avec `doc`) pour qu'il soit applicable.
pub fn normalize_document(doc: &mut Value, id: &str, name: &str) -> Result<(), OpError> {
    let Some(d) = doc.as_object_mut() else {
        return err("Document invalide : un objet est attendu");
    };
    if !d.get("id").is_some_and(Value::is_string) {
        d.insert("id".into(), json!(id));
    }
    d.insert("name".into(), json!(name));
    if !d.contains_key("background") {
        d.insert("background".into(), json!(DEFAULT_BACKGROUND));
    }
    match d.get("nodes") {
        None => {
            d.insert("nodes".into(), json!({}));
        }
        Some(Value::Object(_)) => {}
        Some(_) => return err("Document invalide : « nodes » doit être un objet"),
    }
    match d.get("roots") {
        None => {
            d.insert("roots".into(), json!([]));
        }
        Some(Value::Array(_)) => {}
        Some(_) => return err("Document invalide : « roots » doit être une liste"),
    }
    Ok(())
}

// --- Accès internes (le document a été vérifié par `apply_op`) ---

fn op_id(op: &Value) -> Result<&str, OpError> {
    match op.get("id").and_then(Value::as_str) {
        Some(id) => Ok(id),
        None => err("Opération invalide : « id » manquant"),
    }
}

/// Parent d'un nœud : `parentId` non vide, sinon racine (comme le test de vérité du TypeScript).
fn parent_of(node: &Map<String, Value>) -> Option<&str> {
    node.get("parentId").and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn nodes(doc: &Value) -> &Map<String, Value> {
    doc.get("nodes").and_then(Value::as_object).expect("document vérifié")
}

fn nodes_mut(doc: &mut Value) -> &mut Map<String, Value> {
    doc.get_mut("nodes")
        .and_then(Value::as_object_mut)
        .expect("document vérifié")
}

/// Liste qui contient un nœud : `children` de son parent, ou `roots`.
fn siblings_mut<'a>(doc: &'a mut Value, parent: Option<&str>) -> &'a mut Vec<Value> {
    // Parent incohérent (document abîmé) : on se rabat sur la racine plutôt que d'échouer
    let parent = parent.filter(|p| nodes(doc).get(*p).is_some_and(Value::is_object));
    let list = match parent {
        Some(p) => {
            let node = nodes_mut(doc)
                .get_mut(p)
                .and_then(Value::as_object_mut)
                .expect("parent vérifié");
            let children = node.entry("children").or_insert_with(|| json!([]));
            if !children.is_array() {
                *children = json!([]);
            }
            children
        }
        None => doc.get_mut("roots").expect("document vérifié"),
    };
    list.as_array_mut().expect("liste vérifiée")
}

/// Insère à `index` ; absent, négatif ou au-delà de la fin → à la fin.
fn insert_at(list: &mut Vec<Value>, id: &str, index: Option<&Value>) {
    let index = index
        .and_then(Value::as_f64)
        .filter(|i| *i >= 0.0 && *i <= list.len() as f64);
    match index {
        Some(i) => list.insert(i.trunc() as usize, json!(id)),
        None => list.push(json!(id)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> Value {
        let mut d = empty_document("d", "Test");
        let ops = vec![
            json!({"kind":"create","node":{"id":"a","parentId":null,"children":["x"]}}),
            json!({"kind":"create","node":{"id":"b","parentId":"a","text":null}}),
            json!({"kind":"create","node":{"id":"c","parentId":"b","text":{"content":"Salut","size":12}}}),
            json!({"kind":"create","node":{"id":"d","parentId":"a"}}),
        ];
        apply_ops(&mut d, &ops).unwrap();
        d
    }

    #[test]
    fn create_ignore_les_enfants_et_respecte_l_index() {
        let mut d = doc();
        assert_eq!(d["nodes"]["a"]["children"], json!(["b", "d"]));
        apply_op(
            &mut d,
            &json!({"kind":"create","node":{"id":"e","parentId":"a"},"index":1}),
        )
        .unwrap();
        apply_op(
            &mut d,
            &json!({"kind":"create","node":{"id":"f","parentId":"a"},"index":-1}),
        )
        .unwrap();
        apply_op(
            &mut d,
            &json!({"kind":"create","node":{"id":"g","parentId":"a"},"index":99}),
        )
        .unwrap();
        assert_eq!(d["nodes"]["a"]["children"], json!(["b", "e", "d", "f", "g"]));
    }

    #[test]
    fn delete_puis_inverse_restaure_le_sous_arbre() {
        let mut d = doc();
        let before = d.clone();
        let inv = apply_ops(&mut d, &[json!({"kind":"delete","id":"b"})]).unwrap();
        assert!(d["nodes"].get("c").is_none());
        assert_eq!(inv.len(), 2);
        assert_eq!(inv[0]["index"], json!(0));
        assert!(inv[1].get("index").is_none());
        apply_ops(&mut d, &inv).unwrap();
        assert_eq!(d["nodes"]["a"]["children"], before["nodes"]["a"]["children"]);
        assert_eq!(d["nodes"]["c"], before["nodes"]["c"]);
    }

    #[test]
    fn update_fusionne_le_texte() {
        let mut d = doc();
        let inv = apply_op(
            &mut d,
            &json!({"kind":"update","id":"c","props":{"text":{"size":20},"x":3}}),
        )
        .unwrap();
        assert_eq!(d["nodes"]["c"]["text"], json!({"content":"Salut","size":20}));
        assert_eq!(inv[0]["props"], json!({"text":{"content":"Salut","size":12},"x":null}));
    }

    #[test]
    fn update_texte_sur_non_texte_ne_modifie_rien() {
        let mut d = doc();
        let before = d.clone();
        let e = apply_op(
            &mut d,
            &json!({"kind":"update","id":"b","props":{"x":1,"text":{"content":"x"}}}),
        )
        .unwrap_err();
        assert_eq!(e.0, "Le nœud b n'est pas un texte");
        assert_eq!(d, before);
    }

    #[test]
    fn move_refuse_les_cycles() {
        let mut d = doc();
        let e = apply_op(&mut d, &json!({"kind":"move","id":"a","parentId":"c"})).unwrap_err();
        assert_eq!(e.0, "Impossible de déplacer un nœud dans lui-même");
        let e = apply_op(&mut d, &json!({"kind":"move","id":"a","parentId":"a"})).unwrap_err();
        assert_eq!(e.0, "Impossible de déplacer un nœud dans lui-même");
        let e = apply_op(&mut d, &json!({"kind":"move","id":"zz","parentId":null})).unwrap_err();
        assert_eq!(e.0, "Nœud introuvable : zz");
    }

    #[test]
    fn set_doc_verifie_avant_de_modifier() {
        let mut d = doc();
        let before = d.clone();
        let e = apply_op(&mut d, &json!({"kind":"set-doc","props":{"name":"X","roots":[]}})).unwrap_err();
        assert_eq!(e.0, "Propriété de document non modifiable : roots");
        assert_eq!(d, before);
        d.as_object_mut().unwrap().remove("background");
        let inv = apply_op(&mut d, &json!({"kind":"set-doc","props":{"background":"#000"}})).unwrap();
        assert_eq!(inv[0]["props"], json!({"background": DEFAULT_BACKGROUND}));
    }

    #[test]
    fn operation_inconnue() {
        let mut d = doc();
        assert_eq!(
            apply_op(&mut d, &json!({"kind":"boom"})).unwrap_err().0,
            "Opération inconnue : boom"
        );
        assert!(apply_op(&mut d, &json!({"id":"a"})).is_err());
    }
}
