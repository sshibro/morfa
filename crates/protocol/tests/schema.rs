//! `schema.json` stays in step with the types: every tag has a definition, and every message the codec writes
//! has exactly the keys its definition lists (all required ones present, none unknown), with `t` first.

use morfa_model::{DocumentPatch, Map, Vec2};
use morfa_protocol::*;
use serde_json::Value;
use std::sync::Arc;

/// A blank page (fixtures/documents/template-blank.json).
const BLANK: &str = r#"{"schemaVersion":1,"pages":["t1"],"nodes":{"t1":{"id":"t1","type":"PAGE","name":"Page 1","parentId":null,"visible":true,"locked":false,"opacity":1,"blendMode":"NORMAL","isMask":false,"x":0,"y":0,"width":0,"height":0,"rotation":0,"fills":[],"strokes":[],"strokeWeight":1,"strokeAlign":"INSIDE","strokeCap":"NONE","strokeJoin":"MITER","strokeMiterLimit":4,"dashPattern":[],"effects":[],"constraints":{"horizontal":"MIN","vertical":"MIN"},"layoutPositioning":"AUTO","layoutSizingHorizontal":"FIXED","layoutSizingVertical":"FIXED","exportSettings":[],"reactions":[],"children":[],"guides":[],"flowStartingPoints":[],"prototypeDevice":{"type":"NONE"},"backgroundColor":{"r":0.9607843137254902,"g":0.9607843137254902,"b":0.9607843137254902}}},"styles":{},"images":{},"variableCollections":{},"variables":{}}"#;

fn schema() -> Value {
    serde_json::from_str(include_str!("../schema.json")).unwrap()
}

fn patch() -> DocumentPatch {
    DocumentPatch {
        pages: Some(vec!["page".into()]),
        ..Default::default()
    }
}

fn peer() -> Peer {
    Peer {
        connection: "c1".into(),
        user: "u1".into(),
        name: "Anna".into(),
        color: 3,
        role: Role::Editor,
        presence: Presence {
            cursor: Some(Vec2 { x: 1.5, y: 2.0 }),
            page: Some("page".into()),
            selection: vec!["n1".into()],
            selection_count: 1,
            viewport: None,
            editing: None,
            meeting: Some(MeetingPresence {
                chat: Some("привет".into()), // Non-ASCII text on the wire.
                ..Default::default()
            }),
        },
    }
}

fn change() -> Change {
    Change {
        version: 4,
        by: Some("c1".into()),
        client: Some(ClientId::new("tab-1")),
        seq: Some(2),
        user: "u1".into(),
        patch: Arc::new(patch()),
        fields: None,
    }
}

fn client_samples() -> Vec<ClientMsg> {
    vec![
        ClientMsg::Hello(Hello {
            ticket: "t.s".into(),
            client_id: ClientId::new("tab-1"),
            since: Some(3),
            last_seq: 2,
            protocol: PROTOCOL_VERSION,
        }),
        ClientMsg::Op(Box::new(Op {
            seq: 3,
            base_version: 4,
            patch: patch(),
            before: Some(Map::default().into()),
            before_tables: Some(patch()),
            fields: None,
        })),
        ClientMsg::Presence(PresenceUpdate {
            cursor: Some(None),
            page: Some(Some("page".into())),
            selection: Some(vec![]),
            selection_count: Some(0),
            viewport: Some(Some(Viewport {
                x: 0.0,
                y: 0.0,
                zoom: 1.0,
                width: 100.0,
                height: 50.0,
            })),
            editing: Some(None),
            meeting: Some(None),
        }),
        ClientMsg::Pull { since: 2 },
        ClientMsg::Ping,
    ]
}

fn server_samples() -> Vec<ServerMsg> {
    vec![
        ServerMsg::Welcome(Box::new(Welcome {
            connection: "c2".into(),
            version: 4,
            role: Role::Viewer,
            can_edit: false,
            user: "u2".into(),
            name: "Boris".into(),
            color: 1,
            peers: vec![peer()],
            resync: true,
            snapshot_url: Some("https://s3/ckpt".into()),
            acked_seq: 2,
        })),
        ServerMsg::Ack {
            seq: 3,
            version: 5,
            own: Some(Arc::new(patch())),
        },
        ServerMsg::Refused {
            seq: 3,
            code: ErrorCode::VersionConflict,
            current_version: Some(6),
            path: Some("nodes.n1.x".into()),
            node_id: Some("n1".into()),
            message: Some("…".into()),
        },
        ServerMsg::Change(change()),
        ServerMsg::Changes {
            changes: vec![change()],
        },
        ServerMsg::CatchUp { from: 5, to: 9 },
        ServerMsg::Presence {
            peers: vec![peer()],
        },
        ServerMsg::Leave {
            connection: "c1".into(),
        },
        ServerMsg::Pong,
        ServerMsg::Access {
            role: Role::Viewer,
            can_edit: false,
        },
        ServerMsg::File {
            name: "New".into(),
        },
        ServerMsg::Comments {},
        ServerMsg::Meeting {
            revision: 7,
            user: Some("u2".into()),
        },
        ServerMsg::Rollback { version: 4 },
        ServerMsg::Resync {
            version: 9,
            snapshot_url: Some("https://s3/x".into()),
        },
        ServerMsg::Document {
            version: 9,
            document: Arc::new(morfa_model::from_json(BLANK).unwrap_or_else(|e| panic!("{e}"))),
        },
        ServerMsg::Error {
            code: ErrorCode::BadMessage,
            message: Some("x".into()),
        },
        ServerMsg::Bye {
            reason: ByeReason::Slow,
        },
    ]
}

/// The definition's own properties (following one `allOf` with a `$ref`).
fn properties(schema: &Value, name: &str) -> (Vec<String>, Vec<String>) {
    let def = &schema["$defs"][name];
    assert!(def.is_object(), "schema.json has no $defs.{name}");
    let mut props = Vec::new();
    let mut required = Vec::new();
    let mut parts = vec![def.clone()];
    if let Some(all) = def["allOf"].as_array() {
        parts = all
            .iter()
            .map(|part| match part["$ref"].as_str() {
                Some(r) => schema["$defs"][r.trim_start_matches("#/$defs/")].clone(),
                None => part.clone(),
            })
            .collect();
    }
    for part in parts {
        if let Some(map) = part["properties"].as_object() {
            props.extend(map.keys().cloned());
        }
        if let Some(list) = part["required"].as_array() {
            required.extend(list.iter().map(|v| v.as_str().unwrap().to_owned()));
        }
    }
    (props, required)
}

fn check(schema: &Value, side: &str, tag: &str, text: &[u8]) {
    let text = std::str::from_utf8(text).unwrap();
    assert!(
        text.starts_with(&format!("{{\"t\":\"{tag}\"")),
        "`t` is not the first key: {text}"
    );
    let value: Value = serde_json::from_str(text).unwrap();
    let (props, required) = properties(schema, &format!("{side}.{tag}"));
    for key in value.as_object().unwrap().keys() {
        assert!(
            props.contains(key),
            "{side}.{tag}: key `{key}` missing from schema.json"
        );
    }
    for key in &required {
        assert!(
            value.get(key).is_some(),
            "{side}.{tag}: required `{key}` not written"
        );
    }
}

#[test]
fn every_tag_has_a_definition() {
    let schema = schema();
    for tag in CLIENT_TAGS {
        properties(&schema, &format!("c.{tag}"));
    }
    for tag in SERVER_TAGS {
        properties(&schema, &format!("s.{tag}"));
    }
    assert_eq!(client_samples().len(), CLIENT_TAGS.len());
    assert_eq!(server_samples().len(), SERVER_TAGS.len());
}

#[test]
fn written_messages_match_the_schema_and_read_back() {
    let schema = schema();
    let codec = JsonCodec;
    for msg in client_samples() {
        let frame = codec.encode_client(&msg);
        check(&schema, "c", msg.tag(), &frame.bytes);
        assert_eq!(codec.decode_client(&frame.bytes).unwrap(), msg);
    }
    for msg in server_samples() {
        let frame = codec.encode_server(&msg);
        check(&schema, "s", msg.tag(), &frame.bytes);
        assert_eq!(codec.decode_server(&frame.bytes).unwrap(), msg);
    }
    // Peers inside presence frames have the Peer definition's keys.
    let (props, required) = properties(&schema, "Peer");
    let peer: Value = serde_json::from_slice(&codec.encode_peer(&peer())).unwrap();
    for key in peer.as_object().unwrap().keys() {
        assert!(
            props.contains(key),
            "Peer: `{key}` missing from schema.json"
        );
    }
    for key in required {
        assert!(peer.get(&key).is_some(), "Peer: `{key}` not written");
    }
}

#[test]
fn presence_frames_join_pre_encoded_peers() {
    let codec = JsonCodec;
    let one = codec.encode_peer(&peer());
    let frame = codec.presence_frame(&mut [one.clone(), one].iter());
    match codec.decode_server(&frame.bytes).unwrap() {
        ServerMsg::Presence { peers } => assert_eq!(peers, vec![peer(), peer()]),
        other => panic!("{other:?}"),
    }
    let change = codec.encode_server(&ServerMsg::Change(change())).bytes;
    let batch = codec.changes_frame(&mut [change.clone(), change].iter());
    assert_eq!(
        codec.decode_server(&batch.bytes).unwrap(),
        ServerMsg::Changes {
            changes: vec![self::change(), self::change()]
        }
    );
    let empty = codec.presence_frame(&mut std::iter::empty());
    assert_eq!(&empty.bytes[..], br#"{"t":"presence","peers":[]}"#);
}

#[test]
fn an_invalid_patch_is_refused_with_its_seq_and_path() {
    let codec = JsonCodec;
    let err = codec
        .decode_client(br#"{"t":"op","seq":7,"baseVersion":1,"patch":{"nodes":{"n1":{"id":"n1","type":"NOPE"}}}}"#)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::DesignDocumentInvalid);
    assert_eq!(err.seq, Some(7));
    assert!(err.path.unwrap().starts_with("patch"));
    let err = codec.decode_client(br#"{"t":"op","seq":"x"}"#).unwrap_err();
    assert_eq!(err.code, ErrorCode::BadMessage);
    // `t` not first still reads.
    let msg = codec
        .decode_client(br#"{"seq":1,"baseVersion":0,"patch":{},"t":"op"}"#)
        .unwrap();
    assert!(matches!(msg, ClientMsg::Op(op) if op.seq == 1));
}

/// The binary wire carries the same messages: every sample reads back equal, its JSON text equals the JSON
/// wire's, and the browser's JSON text turns into a frame that reads back equal too.
#[test]
fn the_binary_wire_carries_every_message() {
    let bin = Wire::Binary.codec();
    let json = Wire::Json.codec();
    let as_value = |bytes: &[u8]| serde_json::from_slice::<Value>(bytes).unwrap();
    for msg in server_samples() {
        let frame = bin.encode_server(&msg);
        assert_eq!(frame.kind, codec::FrameKind::Binary);
        assert_eq!(bin.decode_server(&frame.bytes).unwrap(), msg);
        let text = binary::frame_to_json(&frame.bytes).unwrap();
        assert_eq!(
            as_value(text.as_bytes()),
            as_value(&json.encode_server(&msg).bytes),
            "{msg:?}"
        );
    }
    for msg in client_samples() {
        let frame = bin.encode_client(&msg);
        assert_eq!(bin.decode_client(&frame.bytes).unwrap(), msg);
        let text = String::from_utf8(json.encode_client(&msg).bytes.to_vec()).unwrap();
        let from_text = binary::json_to_frame(&text).unwrap();
        assert_eq!(bin.decode_client(&from_text).unwrap(), msg);
        assert_eq!(
            as_value(binary::frame_to_json(&frame.bytes).unwrap().as_bytes()),
            as_value(text.as_bytes())
        );
    }
    // Batches spliced from frames made once.
    let peers = [bin.encode_peer(&peer()), bin.encode_peer(&peer())];
    let presence = bin.presence_frame(&mut peers.iter());
    assert_eq!(
        bin.decode_server(&presence.bytes).unwrap(),
        ServerMsg::Presence {
            peers: vec![peer(), peer()]
        }
    );
    let changes = [
        bin.encode_server(&ServerMsg::Change(change())).bytes,
        bin.encode_server(&ServerMsg::Change(change())).bytes,
    ];
    let batch = bin.changes_frame(&mut changes.iter());
    assert_eq!(
        bin.decode_server(&batch.bytes).unwrap(),
        ServerMsg::Changes {
            changes: vec![change(), change()]
        }
    );
    let text = binary::frame_to_json(&batch.bytes).unwrap();
    assert_eq!(
        json.decode_server(text.as_bytes()).unwrap(),
        ServerMsg::Changes {
            changes: vec![change(), change()]
        }
    );
}

/// Numbers keep their JSON meaning: whole ones are varints, the rest floats, `-0` a float.
#[test]
fn binary_numbers_round_trip() {
    for x in [
        0.0f64,
        -0.0,
        1.0,
        -1.0,
        0.5,
        1e300,
        -2.5e-8,
        9007199254740991.0,
        9007199254740993.0,
        123456.789,
    ] {
        let frame = binary::encode(&x);
        let back: f64 = binary::Tree::read(&frame).unwrap().value().unwrap();
        assert_eq!(back.to_bits(), x.to_bits(), "{x}");
        assert_eq!(
            binary::frame_to_json(&frame).unwrap(),
            morfa_model::js_number(x)
        );
    }
}

/// The binary reader is at least as strict as the JSON one: a struct only from an object, a unit variant only from
/// a string; and damaged frames are refused, never read past their end.
#[test]
fn the_binary_reader_refuses_what_json_refuses() {
    let bin = Wire::Binary.codec();
    // A node whose fills are an object (the model's reader refuses it from JSON too).
    let text = r#"{"t":"op","seq":1,"baseVersion":0,"patch":{"pages":{"0":"p"}}}"#;
    assert!(json_refuses(text));
    assert!(
        bin.decode_client(&binary::json_to_frame(text).unwrap())
            .is_err()
    );
    // A struct written as an array (serde_json's derive would read it; the binary reader does not).
    let text = r#"{"t":"presence","viewport":[0,0,1,10,10]}"#;
    assert!(
        bin.decode_client(&binary::json_to_frame(text).unwrap())
            .is_err()
    );
    // Truncated and padded frames.
    let frame = bin.encode_server(&ServerMsg::Change(change())).bytes;
    for cut in [1, frame.len() / 2, frame.len() - 1] {
        assert!(bin.decode_server(&frame[..cut]).is_err());
    }
    let mut padded = frame.to_vec();
    padded.push(0);
    assert!(bin.decode_server(&padded).is_err());
}

fn json_refuses(text: &str) -> bool {
    Wire::Json.codec().decode_client(text.as_bytes()).is_err()
}
