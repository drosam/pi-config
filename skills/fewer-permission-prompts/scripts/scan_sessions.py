#!/usr/bin/env python3
"""Inventory Pi tool calls across explicitly authorized session roots.

The report contains tool metadata, hashes, and source locators. It never emits
message text, tool results, or raw tool arguments.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import shlex
import stat
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterator

SCHEMA_VERSION = 1
SUPPORTED_SESSION_VERSIONS = {1, 2, 3}
DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024
MAX_LINE_BYTES = 64 * 1024 * 1024
SAFE_TOOL_NAME = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
SHELL_META = re.compile(r"(?:\n|\r|&&|\|\||[|;&<>`]|\$\()")
KNOWN_TOOL_NAMES = {
    "ast_search", "bash", "code_overview", "code_rewrite", "codemode", "edit",
    "find", "grep", "list", "ls", "lsp", "lsp_code_actions", "lsp_completions",
    "lsp_definition", "lsp_diagnostics", "lsp_hover", "lsp_references", "lsp_rename",
    "lsp_symbols", "question", "read", "task", "task_list", "todo", "webfetch",
    "websearch", "write",
}
ENV_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

# Labels classify command shape only. They are not safety judgments.
ONE_TOKEN_LABELS = {
    "awk", "basename", "cat", "comm", "cut", "date", "df", "diff", "du",
    "echo", "fd", "file", "find", "grep", "head", "jq", "ls", "pgrep",
    "printenv", "ps", "pwd", "readlink", "realpath", "rg", "sed", "sort",
    "stat", "tail", "tree", "type", "uname", "uniq", "wc", "which",
}
TWO_TOKEN_LABELS = {
    "git": {
        "blame", "branch", "cat-file", "config", "describe", "diff", "for-each-ref",
        "grep", "log", "ls-files", "ls-remote", "reflog", "remote", "rev-parse",
        "shortlog", "show", "stash", "status", "tag", "worktree",
    },
    "docker": {"images", "inspect", "logs", "ps"},
    "kubectl": {"describe", "get", "logs"},
}
THREE_TOKEN_LABELS = {
    "gh": {
        "auth": {"status"},
        "issue": {"list", "status", "view"},
        "pr": {"checks", "diff", "list", "status", "view"},
        "release": {"list", "view"},
        "repo": {"view"},
        "run": {"list", "view"},
        "workflow": {"list", "view"},
    }
}


class FatalArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError("invalid arguments")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = FatalArgumentParser(description="Inventory Pi session tool calls without exposing raw content.")
    parser.add_argument("--root", action="append", required=True, help="Authorized session root; repeatable")
    parser.add_argument("--exclude", action="append", default=[], help="Path subtree to skip; repeatable")
    parser.add_argument("--max-line-bytes", type=int, default=DEFAULT_MAX_LINE_BYTES)
    args = parser.parse_args(argv)
    if not 1024 <= args.max_line_bytes <= MAX_LINE_BYTES:
        parser.error("invalid line limit")
    for raw_path in [*args.root, *args.exclude]:
        if not raw_path or "\x00" in raw_path:
            parser.error("invalid path")
        try:
            Path(raw_path).expanduser()
        except (OSError, RuntimeError, ValueError):
            parser.error("invalid path")
    return args


def opaque_digest(key: bytes, value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return hmac.new(key, encoded, hashlib.sha256).hexdigest()


def path_is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def sanitized_gap(path: Path | None, reason: str, line: int | None = None) -> dict[str, Any]:
    gap: dict[str, Any] = {"reason": reason}
    if path is not None:
        gap["path"] = str(path)
    if line is not None:
        gap["line"] = line
    return gap


def discover_files(
    roots: list[str], excludes: list[str], coverage: dict[str, int], gaps: list[dict[str, Any]]
) -> tuple[list[tuple[Path, tuple[int, int]]], list[dict[str, Any]]]:
    raw_excluded = [Path(item).expanduser().absolute() for item in excludes]
    root_records: list[dict[str, Any]] = []
    physical_seen: set[tuple[int, int]] = set()
    files: list[tuple[Path, tuple[int, int]]] = []

    for raw_root in roots:
        supplied = Path(raw_root).expanduser().absolute()
        record: dict[str, Any] = {"supplied": str(supplied)}
        try:
            supplied_symlink = supplied.is_symlink()
            resolved = supplied.resolve(strict=True)
            record["supplied_symlink"] = supplied_symlink
            if supplied_symlink:
                record["resolved"] = str(resolved)
            if not resolved.is_dir():
                raise NotADirectoryError(str(resolved))
        except (OSError, RuntimeError) as error:
            record["status"] = "unavailable"
            root_records.append(record)
            gaps.append(sanitized_gap(supplied, f"root unavailable: {type(error).__name__}"))
            coverage["roots_unavailable"] += 1
            continue

        normalized_excluded: set[Path] = set(raw_excluded)
        for excluded in raw_excluded:
            try:
                normalized_excluded.add(excluded.resolve(strict=False))
            except (OSError, RuntimeError):
                pass
            if path_is_within(excluded, supplied):
                normalized_excluded.add(resolved / excluded.relative_to(supplied))

        def excluded_path(path: Path) -> bool:
            absolute = path.absolute()
            return any(path_is_within(absolute, item) for item in normalized_excluded)

        if excluded_path(resolved) or excluded_path(supplied):
            record["status"] = "excluded"
            root_records.append(record)
            coverage["excluded_roots"] += 1
            continue

        walk_failed = False

        def walk_error(error: OSError) -> None:
            nonlocal walk_failed
            walk_failed = True
            coverage["unreadable_directories"] += 1
            error_path = Path(error.filename) if error.filename else resolved
            gaps.append(sanitized_gap(error_path, f"directory unreadable: {type(error).__name__}"))

        traversed = False
        for current, dirnames, filenames in os.walk(
            resolved, topdown=True, followlinks=False, onerror=walk_error
        ):
            traversed = True
            current_path = Path(current)
            kept_dirs: list[str] = []
            for dirname in sorted(dirnames):
                candidate = current_path / dirname
                if excluded_path(candidate):
                    coverage["excluded_paths"] += 1
                elif candidate.is_symlink():
                    coverage["symlinks_skipped"] += 1
                else:
                    kept_dirs.append(dirname)
            dirnames[:] = kept_dirs

            for filename in sorted(filenames):
                candidate = current_path / filename
                if candidate.suffix != ".jsonl":
                    continue
                coverage["jsonl_discovered"] += 1
                if excluded_path(candidate):
                    coverage["excluded_paths"] += 1
                    continue
                try:
                    file_stat = candidate.lstat()
                except OSError as error:
                    gaps.append(sanitized_gap(candidate, f"file metadata unavailable: {type(error).__name__}"))
                    continue
                if stat.S_ISLNK(file_stat.st_mode):
                    coverage["symlinks_skipped"] += 1
                    continue
                if not stat.S_ISREG(file_stat.st_mode):
                    coverage["non_regular_skipped"] += 1
                    continue
                physical = (file_stat.st_dev, file_stat.st_ino)
                if physical in physical_seen:
                    coverage["overlap_duplicates_skipped"] += 1
                    continue
                physical_seen.add(physical)
                files.append((candidate, physical))

        if not traversed:
            record["status"] = "unavailable"
            coverage["roots_unavailable"] += 1
        else:
            record["status"] = "partial" if walk_failed else "scanned"
        root_records.append(record)

    return sorted(files, key=lambda item: str(item[0])), root_records


def bounded_lines(handle: Any, limit: int) -> Iterator[tuple[int, bytes | None, bool]]:
    line_number = 0
    while True:
        chunk = handle.readline(limit + 1)
        if not chunk:
            break
        line_number += 1
        oversized = len(chunk) > limit and not chunk.endswith(b"\n")
        if oversized:
            while chunk and not chunk.endswith(b"\n"):
                chunk = handle.readline(limit + 1)
            yield line_number, None, True
        else:
            yield line_number, chunk, False


def command_label(command: Any) -> str:
    if not isinstance(command, str) or not command.strip() or len(command) > 16_384 or SHELL_META.search(command):
        return "bash (inspect arguments)"
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        return "bash (inspect arguments)"
    if not tokens or any(ENV_ASSIGNMENT.match(token) for token in tokens[:2]):
        return "bash (inspect arguments)"
    if tokens[0] in {"command", "builtin", "env", "nice", "nohup", "sudo", "time", "timeout", "xargs"}:
        return "bash (inspect arguments)"
    executable = Path(tokens[0]).name
    if tokens[0] != executable:
        return "bash (inspect arguments)"
    if executable in ONE_TOKEN_LABELS:
        return executable
    if executable in TWO_TOKEN_LABELS and len(tokens) > 1 and tokens[1] in TWO_TOKEN_LABELS[executable]:
        return f"{executable} {tokens[1]}"
    if executable in THREE_TOKEN_LABELS and len(tokens) > 2:
        if tokens[1] in THREE_TOKEN_LABELS[executable] and tokens[2] in THREE_TOKEN_LABELS[executable][tokens[1]]:
            return f"{executable} {tokens[1]} {tokens[2]}"
    return "bash (inspect arguments)"


def safe_tool_name(value: Any, digest_key: bytes) -> str:
    if not isinstance(value, str) or not SAFE_TOOL_NAME.fullmatch(value):
        return "unknown-tool"
    if value in KNOWN_TOOL_NAMES:
        return value
    return f"tool-{opaque_digest(digest_key, value)[:12]}"


def project_id(header: dict[str, Any], digest_key: bytes) -> tuple[str, bool]:
    cwd = header.get("cwd")
    if not isinstance(cwd, str) or not cwd or len(cwd) > 4096:
        return "unknown-project", False
    if any(ord(character) < 32 for character in cwd):
        return "unknown-project", False
    return f"project-{opaque_digest(digest_key, cwd)[:12]}", True


def open_verified_file(path: Path, expected: tuple[int, int]) -> Any:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != expected:
            raise OSError("file changed after discovery")
        return os.fdopen(descriptor, "rb", closefd=True)
    except Exception:
        os.close(descriptor)
        raise


def scan_file(
    path: Path,
    expected_physical: tuple[int, int],
    max_line_bytes: int,
    digest_key: bytes,
    coverage: dict[str, int],
    gaps: list[dict[str, Any]],
    groups: dict[tuple[str, str], dict[str, Any]],
    dedup_seen: dict[tuple[str, str, str, str, str], tuple[tuple[str, str], str]],
) -> None:
    try:
        handle = open_verified_file(path, expected_physical)
    except OSError as error:
        gaps.append(sanitized_gap(path, f"file unreadable or changed: {type(error).__name__}"))
        return

    with handle:
        iterator = bounded_lines(handle, max_line_bytes)
        try:
            first_line_number, first_raw, first_oversized = next(iterator)
        except StopIteration:
            coverage["empty_files_skipped"] += 1
            return
        if first_oversized or first_raw is None:
            coverage["oversized_records"] += 1
            gaps.append(sanitized_gap(path, "oversized session header", first_line_number))
            return
        try:
            header = json.loads(first_raw)
        except (UnicodeDecodeError, ValueError, RecursionError):
            coverage["non_session_files_skipped"] += 1
            gaps.append(sanitized_gap(path, "invalid session header", first_line_number))
            return
        if not isinstance(header, dict) or header.get("type") != "session":
            coverage["non_session_files_skipped"] += 1
            return
        version = header.get("version", 1)
        if isinstance(version, bool) or not isinstance(version, int) or version not in SUPPORTED_SESSION_VERSIONS:
            coverage["unsupported_sessions"] += 1
            version_label = str(version) if isinstance(version, int) and not isinstance(version, bool) and 0 <= version <= 9999 else "invalid"
            gaps.append(sanitized_gap(path, f"unsupported session version: {version_label}", first_line_number))
            return

        project, valid_project = project_id(header, digest_key)
        if not valid_project:
            coverage["malformed_headers"] += 1
            gaps.append(sanitized_gap(path, "session header has invalid cwd", first_line_number))
        raw_session_id = header.get("id")
        if not isinstance(raw_session_id, str) or not raw_session_id:
            coverage["malformed_headers"] += 1
            gaps.append(sanitized_gap(path, "session header has invalid id", first_line_number))
        session_identity = raw_session_id if isinstance(raw_session_id, str) and raw_session_id else str(path)
        session_id = f"session-{opaque_digest(digest_key, session_identity)[:12]}"
        coverage["sessions_scanned"] += 1
        coverage["files_scanned"] += 1

        for line_number, raw, oversized in iterator:
            if oversized or raw is None:
                coverage["oversized_records"] += 1
                gaps.append(sanitized_gap(path, "oversized record skipped", line_number))
                continue
            try:
                entry = json.loads(raw)
            except (UnicodeDecodeError, ValueError, RecursionError):
                coverage["malformed_records"] += 1
                gaps.append(sanitized_gap(path, "malformed record skipped", line_number))
                continue
            if not isinstance(entry, dict):
                coverage["malformed_records"] += 1
                gaps.append(sanitized_gap(path, "record is not an object", line_number))
                continue
            if entry.get("type") != "message":
                continue
            message = entry.get("message")
            if not isinstance(message, dict):
                coverage["malformed_records"] += 1
                gaps.append(sanitized_gap(path, "message entry has invalid message object", line_number))
                continue
            if message.get("role") != "assistant":
                continue
            content = message.get("content")
            if not isinstance(content, list):
                coverage["malformed_records"] += 1
                gaps.append(sanitized_gap(path, "assistant message has invalid content", line_number))
                continue
            entry_id = entry.get("id") if isinstance(entry.get("id"), str) else ""
            raw_timestamp = message.get("timestamp", entry.get("timestamp", ""))
            message_timestamp = raw_timestamp if isinstance(raw_timestamp, (str, int, float)) else ""
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "toolCall":
                    continue
                raw_tool = block.get("name")
                if not isinstance(raw_tool, str) or not SAFE_TOOL_NAME.fullmatch(raw_tool):
                    coverage["malformed_tool_calls"] += 1
                    gaps.append(sanitized_gap(path, "tool call has invalid name", line_number))
                    continue
                tool = safe_tool_name(raw_tool, digest_key)
                arguments = block.get("arguments")
                if not isinstance(arguments, dict):
                    coverage["malformed_tool_calls"] += 1
                    gaps.append(sanitized_gap(path, "tool arguments are not an object", line_number))
                    continue
                try:
                    fingerprint = opaque_digest(digest_key, arguments)
                except (TypeError, ValueError, UnicodeError, RecursionError):
                    coverage["unfingerprintable_tool_calls"] += 1
                    gaps.append(sanitized_gap(path, "tool arguments could not be fingerprinted", line_number))
                    continue

                is_bash = raw_tool == "bash"
                label = command_label(arguments.get("command")) if is_bash else (
                    tool if isinstance(raw_tool, str) and raw_tool in KNOWN_TOOL_NAMES
                    else "extension-tool (inspect source)"
                )
                key = (tool, label)
                call_id = block.get("id") if isinstance(block.get("id"), str) else ""
                identity = (
                    tool,
                    opaque_digest(digest_key, entry_id),
                    opaque_digest(digest_key, call_id),
                    opaque_digest(digest_key, message_timestamp),
                    fingerprint,
                )
                if entry_id and call_id and identity in dedup_seen:
                    coverage["cloned_calls_deduplicated"] += 1
                    original_key, original_fingerprint = dedup_seen[identity]
                    group = groups[original_key]
                    project_stats = group["projects"].setdefault(project, {"unique_calls": 0, "cloned_occurrences": 0})
                    project_stats["cloned_occurrences"] += 1
                    group["sessions"].add(session_id)
                    variant = group["variants"][original_fingerprint]
                    variant["cloned_occurrences"] += 1
                    if len(variant["clone_locations"]) < 3:
                        variant["clone_locations"].append({"path": str(path), "line": line_number})
                    continue
                if entry_id and call_id:
                    dedup_seen[identity] = (key, fingerprint)

                group = groups.setdefault(key, {
                    "tool": tool,
                    "label": label,
                    "count": 0,
                    "projects": {},
                    "sessions": set(),
                    "variants": {},
                })
                group["count"] += 1
                project_stats = group["projects"].setdefault(project, {"unique_calls": 0, "cloned_occurrences": 0})
                project_stats["unique_calls"] += 1
                group["sessions"].add(session_id)
                variant = group["variants"].setdefault(fingerprint, {
                    "fingerprint": fingerprint,
                    "count": 0,
                    "cloned_occurrences": 0,
                    "locations": [],
                    "clone_locations": [],
                })
                variant["count"] += 1
                if len(variant["locations"]) < 3:
                    variant["locations"].append({"path": str(path), "line": line_number})
                coverage["unique_tool_calls"] += 1


def render_groups(groups: dict[tuple[str, str], dict[str, Any]]) -> list[dict[str, Any]]:
    rendered: list[dict[str, Any]] = []
    for group in groups.values():
        variants = sorted(group["variants"].values(), key=lambda item: (-item["count"], item["fingerprint"]))
        rendered.append({
            "tool": group["tool"],
            "label": group["label"],
            "count": group["count"],
            "session_count": len(group["sessions"]),
            "projects": [
                {"project_id": project, **stats}
                for project, stats in sorted(group["projects"].items())
            ],
            "variant_count": len(variants),
            "variants": variants,
        })
    return sorted(rendered, key=lambda item: (-item["count"], item["tool"], item["label"]))


def emit_report(report: dict[str, Any]) -> None:
    json.dump(report, sys.stdout, indent=2, sort_keys=False)
    sys.stdout.write("\n")


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv or sys.argv[1:])
    except ValueError:
        emit_report({
            "schema_version": SCHEMA_VERSION,
            "evidence_scope": "no scan performed",
            "roots": [],
            "coverage": {},
            "groups": [],
            "gaps": [{"reason": "invalid arguments"}],
        })
        return 1

    coverage: dict[str, int] = defaultdict(int)
    gaps: list[dict[str, Any]] = []
    files, roots = discover_files(args.root, args.exclude, coverage, gaps)
    groups: dict[tuple[str, str], dict[str, Any]] = {}
    dedup_seen: dict[tuple[str, str, str, str, str], tuple[tuple[str, str], str]] = {}
    digest_key = secrets.token_bytes(32)
    coverage["files_selected"] = len(files)
    for path, physical in files:
        scan_file(path, physical, args.max_line_bytes, digest_key, coverage, gaps, groups, dedup_seen)

    emit_report({
        "schema_version": SCHEMA_VERSION,
        "evidence_scope": "usage-only; frequency and labels are not safety or approval evidence",
        "identifiers": "per-run opaque HMACs; compare only within this report",
        "roots": roots,
        "coverage": dict(sorted(coverage.items())),
        "groups": render_groups(groups),
        "gaps": gaps,
    })

    if not any(root.get("status") in {"scanned", "partial"} for root in roots):
        return 1
    return 2 if gaps else 0


if __name__ == "__main__":
    raise SystemExit(main())
