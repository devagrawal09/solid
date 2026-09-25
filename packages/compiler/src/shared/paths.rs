//! Path helpers shared by the directive, refresh and resumable passes: the
//! root-relative id a build hashes so client and server output of the same
//! checkout agree without baking absolute paths into the output.

/// Node's `path.relative(root, id)` with separators normalized to `/` — the
/// hash input contract shared with the Babel implementation's `compile()`.
/// Also reused by the refresh pass for cwd-relative `location` strings.
pub(crate) fn relative_id(root: Option<&str>, filename: &str) -> String {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"));
    let root = normalize(&cwd, root.map(std::path::Path::new).unwrap_or(&cwd));
    let file = normalize(&cwd, std::path::Path::new(filename));

    let mut root_parts = root.iter().peekable();
    let mut file_parts = file.iter().peekable();
    while let (Some(a), Some(b)) = (root_parts.peek(), file_parts.peek()) {
        if a != b {
            break;
        }
        root_parts.next();
        file_parts.next();
    }
    let mut parts: Vec<String> = Vec::new();
    for _ in root_parts {
        parts.push("..".to_string());
    }
    for part in file_parts {
        parts.push(part.to_string_lossy().into_owned());
    }
    parts.join("/")
}

/// Resolve against `cwd` and fold `.`/`..` segments (Node `path.resolve`).
fn normalize(cwd: &std::path::Path, path: &std::path::Path) -> std::path::PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    let mut result = std::path::PathBuf::new();
    for component in joined.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}
