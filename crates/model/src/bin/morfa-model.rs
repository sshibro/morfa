//! `morfa-model`: the command line the Node harness (`scripts/model/check.ts`) drives to compare the Rust model with
//! the TypeScript one. Results go to stdout, one line per input where the input is
//! a list; usage and IO errors go to stderr with a non-zero exit.
//!
//! ```text
//! morfa-model roundtrip <in.json> <out.json>        from_json → to_json; {"ok":false,...} and exit 1 when the shape is refused
//! morfa-model check [--no-value] [--store] <in.jsonl>
//!                                                    one document per line → {"ok":true,"value":…} | {"ok":false,"error":…,"path":…};
//!                                                    --store: an accepted document also goes through the store and its binary codec,
//!                                                    "store":true when it comes back with the same JSON (else storeValue / storeError)
//! morfa-model check-patch [--no-value] <in.jsonl>    the same for DocumentPatch (validatePatch)
//! morfa-model store-roundtrip <in.json> <out.json>   from_json → store → binary → store → model → to_json; sizes and times on stdout
//! morfa-model js-number <in.txt>                     one f64 bit pattern (16 hex digits) per line → JavaScript's String(n)
//! morfa-model bench <file.json> [iterations=10]      min / median ms of parse, parse+validate, validate, serialize
//! ```
//!
//! An input path of `-` reads stdin.

use morfa_model::codec::{self, CodecError};
use morfa_model::store::Document;
use morfa_model::{
    DesignDocument, Invalid, from_json, from_json_validated, js_number, patch_from_json_validated,
    to_json, validate_document,
};
use std::io::{self, BufWriter, Read, Write};
use std::process::ExitCode;
use std::time::Instant;

const USAGE: &str = "usage:
  morfa-model roundtrip <in.json> <out.json>
  morfa-model check [--no-value] [--store] <in.jsonl>
  morfa-model check-patch [--no-value] <in.jsonl>
  morfa-model store-roundtrip <in.json> <out.json>
  morfa-model js-number <in.txt>
  morfa-model bench <file.json> [iterations=10]
(an input of - reads stdin)";

/// Why the command stopped: a usage mistake (exit 2) or a failure (exit 1).
enum Failure {
    Usage(String),
    Failed(String),
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(code) => code,
        Err(Failure::Usage(message)) => {
            eprintln!("morfa-model: {message}\n{USAGE}");
            ExitCode::from(2)
        }
        Err(Failure::Failed(message)) => {
            eprintln!("morfa-model: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[String]) -> Result<ExitCode, Failure> {
    let Some((command, rest)) = args.split_first() else {
        return Err(Failure::Usage("no command".into()));
    };
    match command.as_str() {
        "roundtrip" => match rest {
            [input, output] => roundtrip(input, output),
            _ => Err(Failure::Usage(
                "roundtrip takes <in.json> <out.json>".into(),
            )),
        },
        "check" | "check-patch" => {
            let patch = command == "check-patch";
            let (flags, files): (Vec<&String>, Vec<&String>) =
                rest.iter().partition(|arg| arg.starts_with("--"));
            let known: &[&str] = if patch {
                &["--no-value"]
            } else {
                &["--no-value", "--store"]
            };
            if let Some(flag) = flags.iter().find(|flag| !known.contains(&flag.as_str())) {
                return Err(Failure::Usage(format!("{command}: unknown flag {flag}")));
            }
            let with_value = !flags.iter().any(|flag| flag.as_str() == "--no-value");
            let store = flags.iter().any(|flag| flag.as_str() == "--store");
            match files.as_slice() {
                [input] => check(input, patch, with_value, store),
                _ => Err(Failure::Usage(format!(
                    "{command} takes {} <in.jsonl>",
                    known
                        .iter()
                        .map(|flag| format!("[{flag}]"))
                        .collect::<Vec<_>>()
                        .join(" ")
                ))),
            }
        }
        "store-roundtrip" => match rest {
            [input, output] => store_roundtrip(input, output),
            _ => Err(Failure::Usage(
                "store-roundtrip takes <in.json> <out.json>".into(),
            )),
        },
        "js-number" => match rest {
            [input] => numbers(input),
            _ => Err(Failure::Usage("js-number takes <in.txt>".into())),
        },
        "bench" => match rest {
            [file] => bench(file, 10),
            [file, iterations] => match iterations.parse::<usize>() {
                Ok(count) if count > 0 => bench(file, count),
                _ => Err(Failure::Usage(format!(
                    "bench: iterations must be a positive integer, not {iterations}"
                ))),
            },
            _ => Err(Failure::Usage(
                "bench takes <file.json> [iterations]".into(),
            )),
        },
        "-h" | "--help" | "help" => {
            println!("{USAGE}");
            Ok(ExitCode::SUCCESS)
        }
        other => Err(Failure::Usage(format!("unknown command {other}"))),
    }
}

fn read(path: &str) -> Result<String, Failure> {
    let mut text = String::new();
    let result = if path == "-" {
        io::stdin().read_to_string(&mut text).map(|_| ())
    } else {
        std::fs::read_to_string(path).map(|read| text = read)
    };
    result.map_err(|error| Failure::Failed(format!("cannot read {path}: {error}")))?;
    Ok(text)
}

fn written(result: io::Result<()>) -> Result<(), Failure> {
    result.map_err(|error| Failure::Failed(format!("cannot write: {error}")))
}

/// `{"ok":false,"error":…,"path":…}`.
fn refusal(invalid: &Invalid) -> String {
    format!(
        r#"{{"ok":false,"error":{},"path":{}}}"#,
        to_json(invalid.message.as_str()),
        to_json(invalid.path.as_str())
    )
}

fn roundtrip(input: &str, output: &str) -> Result<ExitCode, Failure> {
    let text = read(input)?;
    match from_json(&text) {
        Ok(doc) => {
            let json = to_json(&doc);
            std::fs::write(output, json)
                .map_err(|error| Failure::Failed(format!("cannot write {output}: {error}")))?;
            Ok(ExitCode::SUCCESS)
        }
        Err(invalid) => {
            println!("{}", refusal(&invalid));
            Ok(ExitCode::FAILURE)
        }
    }
}

/// The document through the store and its binary codec and back: the model again, and the frame's size.
fn through_store(doc: &DesignDocument) -> Result<(DesignDocument, usize), CodecError> {
    let bytes = codec::encode(&Document::from_model(doc));
    let stored = codec::decode(&bytes)?;
    Ok((stored.to_model(), bytes.len()))
}

/// `,"store":true` when the document survives the store with the same JSON, else what came back.
fn store_verdict(doc: &DesignDocument, json: &str) -> String {
    match through_store(doc) {
        Ok((back, _)) => {
            let again = to_json(&back);
            if again == json {
                r#","store":true"#.to_string()
            } else {
                format!(r#","store":false,"storeValue":{again}"#)
            }
        }
        Err(error) => format!(
            r#","store":false,"storeError":{}"#,
            to_json(error.to_string().as_str())
        ),
    }
}

fn check(input: &str, patch: bool, with_value: bool, store: bool) -> Result<ExitCode, Failure> {
    let text = read(input)?;
    let stdout = io::stdout();
    let mut out = BufWriter::with_capacity(1 << 20, stdout.lock());
    for line in text.lines() {
        let verdict = if patch {
            patch_from_json_validated(line).map(|value| (to_json(&value), String::new()))
        } else {
            from_json_validated(line).map(|doc| {
                let json = to_json(&doc);
                let stored = if store {
                    store_verdict(&doc, &json)
                } else {
                    String::new()
                };
                (json, stored)
            })
        };
        let result = match verdict {
            Ok((value, stored)) if with_value => {
                writeln!(out, r#"{{"ok":true,"value":{value}{stored}}}"#)
            }
            Ok((_, stored)) => writeln!(out, r#"{{"ok":true{stored}}}"#),
            Err(invalid) => writeln!(out, "{}", refusal(&invalid)),
        };
        written(result)?;
    }
    written(out.flush())?;
    Ok(ExitCode::SUCCESS)
}

fn store_roundtrip(input: &str, output: &str) -> Result<ExitCode, Failure> {
    let text = read(input)?;
    let doc = match from_json(&text) {
        Ok(doc) => doc,
        Err(invalid) => {
            println!("{}", refusal(&invalid));
            return Ok(ExitCode::FAILURE);
        }
    };
    let ms = |started: Instant| started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    let stored = Document::from_model(&doc);
    let from_model = ms(started);
    let started = Instant::now();
    let bytes = codec::encode(&stored);
    let encode = ms(started);
    let started = Instant::now();
    let decoded = match codec::decode(&bytes) {
        Ok(decoded) => decoded,
        Err(error) => {
            println!(
                r#"{{"ok":false,"error":{},"path":""}}"#,
                to_json(format!("codec: {error}").as_str())
            );
            return Ok(ExitCode::FAILURE);
        }
    };
    let decode = ms(started);
    let started = Instant::now();
    let back = decoded.to_model();
    let to_model = ms(started);
    let json = to_json(&back);
    std::fs::write(output, &json)
        .map_err(|error| Failure::Failed(format!("cannot write {output}: {error}")))?;
    println!(
        r#"{{"ok":true,"nodes":{},"jsonBytes":{},"binaryBytes":{},"sameJson":{},"ms":{{"fromModel":{from_model:.3},"encode":{encode:.3},"decode":{decode:.3},"toModel":{to_model:.3}}}}}"#,
        doc.nodes.len(),
        text.len(),
        bytes.len(),
        json == to_json(&doc)
    );
    Ok(ExitCode::SUCCESS)
}

fn numbers(input: &str) -> Result<ExitCode, Failure> {
    let text = read(input)?;
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    for (index, line) in text.lines().enumerate() {
        let hex = line.trim();
        let bits = (hex.len() == 16)
            .then(|| u64::from_str_radix(hex, 16).ok())
            .flatten();
        let Some(bits) = bits else {
            return Err(Failure::Failed(format!(
                "{input}:{}: expected 16 hex digits, got {hex:?}",
                index + 1
            )));
        };
        written(writeln!(out, "{}", js_number(f64::from_bits(bits))))?;
    }
    written(out.flush())?;
    Ok(ExitCode::SUCCESS)
}

/// Milliseconds of each run of `step`, sorted.
fn timed(
    iterations: usize,
    mut step: impl FnMut() -> Result<(), Failure>,
) -> Result<Vec<f64>, Failure> {
    let mut times = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        step()?;
        times.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    Ok(times)
}

fn stats(times: &[f64]) -> String {
    let median = if times.len() % 2 == 1 {
        times[times.len() / 2]
    } else {
        (times[times.len() / 2 - 1] + times[times.len() / 2]) / 2.0
    };
    format!(
        r#"{{"min":{:.3},"median":{:.3},"max":{:.3}}}"#,
        times[0],
        median,
        times[times.len() - 1]
    )
}

fn bench(file: &str, iterations: usize) -> Result<ExitCode, Failure> {
    let text = read(file)?;
    let refused = |invalid: Invalid| Failure::Failed(format!("{file}: {invalid}"));
    let doc = from_json(&text).map_err(refused)?;
    let nodes = doc.nodes.len();
    let validated = validate_document(&doc).is_ok();
    let parse = timed(iterations, || from_json(&text).map(drop).map_err(refused))?;
    let parse_validate = timed(iterations, || {
        // A document the validation refuses still costs its full parse and the checks up to the refusal.
        let _ = std::hint::black_box(from_json_validated(&text));
        Ok(())
    })?;
    let validate = timed(iterations, || {
        let _ = std::hint::black_box(validate_document(&doc));
        Ok(())
    })?;
    let mut serialized = 0;
    let serialize = timed(iterations, || {
        serialized = std::hint::black_box(to_json(&doc)).len();
        Ok(())
    })?;
    println!(
        r#"{{"file":{},"bytes":{},"nodes":{},"valid":{},"iterations":{},"parse":{},"parseValidate":{},"validate":{},"serialize":{},"serializedBytes":{}}}"#,
        to_json(file),
        text.len(),
        nodes,
        validated,
        iterations,
        stats(&parse),
        stats(&parse_validate),
        stats(&validate),
        stats(&serialize),
        serialized
    );
    Ok(ExitCode::SUCCESS)
}
