from __future__ import annotations

import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

MODULE_PATH = Path(__file__).parents[1] / "scripts" / "scan_sessions.py"
SPEC = importlib.util.spec_from_file_location("scan_sessions", MODULE_PATH)
assert SPEC and SPEC.loader
scan_sessions = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scan_sessions)


def header(session_id: str, cwd: str, version: int = 3) -> dict:
    return {"type": "session", "version": version, "id": session_id, "timestamp": "2000-01-01T00:00:00Z", "cwd": cwd}


def assistant(entry_id: str, call_id: str, name: str, arguments: dict, timestamp: int = 1) -> dict:
    return {
        "type": "message",
        "id": entry_id,
        "parentId": None,
        "timestamp": "2000-01-01T00:00:01Z",
        "message": {
            "role": "assistant",
            "content": [{"type": "toolCall", "id": call_id, "name": name, "arguments": arguments}],
            "timestamp": timestamp,
        },
    }


def write_session(path: Path, rows: list[dict], trailing: bytes = b"") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        for row in rows:
            handle.write(json.dumps(row).encode("utf-8") + b"\n")
        handle.write(trailing)


def invoke(*args: str) -> tuple[int, dict]:
    output = io.StringIO()
    with redirect_stdout(output):
        code = scan_sessions.main(list(args))
    return code, json.loads(output.getvalue())


class ScanSessionsTest(unittest.TestCase):
    def test_scans_all_sessions_projects_and_raw_branches_without_age_cap(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for index in range(55):
                project = "/project/a" if index % 2 == 0 else "/project/b"
                rows = [
                    header(f"session-{index}", project),
                    assistant(f"entry-{index}-a", f"call-{index}-a", "bash", {"command": "git status"}, index),
                    assistant(f"entry-{index}-b", f"call-{index}-b", "bash", {"command": "git status --short"}, index + 100),
                ]
                write_session(root / f"p{index % 2}" / f"session-{index}.jsonl", rows)

            code, report = invoke("--root", str(root))
            self.assertEqual(code, 0)
            self.assertEqual(report["coverage"]["sessions_scanned"], 55)
            group = next(group for group in report["groups"] if group["label"] == "git status")
            self.assertEqual(group["count"], 110)
            self.assertEqual(group["variant_count"], 2)
            self.assertEqual(len(group["projects"]), 2)
            self.assertTrue(all(item["project_id"].startswith("project-") for item in group["projects"]))

    def test_deduplicates_overlap_and_reliable_cloned_calls(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            rows = [header("one", "/project"), assistant("entry", "shared-call", "bash", {"command": "git log"}, 99)]
            write_session(root / "a.jsonl", rows)
            write_session(root / "b.jsonl", [header("two", "/other-project"), rows[1]])

            code, report = invoke("--root", str(root), "--root", str(root / "."))
            self.assertEqual(code, 0)
            self.assertEqual(report["coverage"]["overlap_duplicates_skipped"], 2)
            self.assertEqual(report["coverage"]["cloned_calls_deduplicated"], 1)
            self.assertEqual(report["coverage"]["unique_tool_calls"], 1)
            group = report["groups"][0]
            self.assertEqual(len(group["projects"]), 2)
            self.assertEqual(sum(item["cloned_occurrences"] for item in group["projects"]), 1)

    def test_reports_partial_coverage_without_emitting_sensitive_content(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            secret = "TOP_SECRET_TOKEN_123"
            write_session(
                root / "valid.jsonl",
                [
                    header("valid", "/project"),
                    assistant("safe", "safe-call", "bash", {"command": "git diff -- src/a.py"}, 1),
                    assistant("secret", "secret-call", "bash", {"command": f"python3 -c 'print({secret})'"}, 2),
                    assistant("custom", "custom-call", "mcp__docs__search", {"query": secret}, 3),
                    {"type": "message", "message": {"role": "user", "content": secret}},
                ],
                trailing=b'{"type":"message"',
            )
            write_session(root / "unsupported.jsonl", [header("future", "/future", 99)])
            (root / "not-session.jsonl").write_text(json.dumps({"anything": secret}) + "\n")

            code, report = invoke("--root", str(root))
            rendered = json.dumps(report)
            self.assertEqual(code, 2)
            self.assertNotIn(secret, rendered)
            self.assertEqual(report["coverage"]["unsupported_sessions"], 1)
            self.assertEqual(report["coverage"]["malformed_records"], 1)
            self.assertEqual(report["coverage"]["non_session_files_skipped"], 1)
            labels = {group["label"] for group in report["groups"]}
            self.assertIn("git diff", labels)
            self.assertIn("bash (inspect arguments)", labels)
            self.assertIn("extension-tool (inspect source)", labels)
            self.assertNotIn("mcp__docs__search", rendered)

    def test_exclusions_symlinks_oversized_records_and_missing_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write_session(root / "keep" / "ok.jsonl", [header("ok", "/ok"), assistant("e", "c", "bash", {"command": "pwd"})])
            write_session(root / "excluded" / "skip.jsonl", [header("skip", "/skip"), assistant("e2", "c2", "bash", {"command": "ls"})])
            oversized = root / "keep" / "oversized.jsonl"
            write_session(oversized, [header("large", "/ok")], trailing=b'{' + b'x' * 2000 + b'}\n')
            symlinks_created = False
            try:
                os.symlink(root / "excluded", root / "linked-dir")
                os.symlink(root / "keep" / "ok.jsonl", root / "linked-file.jsonl")
                symlinks_created = True
            except (OSError, NotImplementedError):
                pass

            code, report = invoke(
                "--root", str(root),
                "--root", str(root / "missing"),
                "--exclude", str(root / "excluded"),
                "--max-line-bytes", "1024",
            )
            self.assertEqual(code, 2)
            self.assertEqual(report["coverage"]["sessions_scanned"], 2)
            self.assertEqual(report["coverage"]["unique_tool_calls"], 1)
            self.assertGreaterEqual(report["coverage"].get("excluded_paths", 0), 1)
            self.assertEqual(report["coverage"]["oversized_records"], 1)
            self.assertEqual(report["coverage"]["roots_unavailable"], 1)
            if symlinks_created:
                self.assertEqual(report["coverage"].get("symlinks_skipped", 0), 2)

    def test_exact_root_and_symlink_alias_exclusions_are_honored(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            real_root = Path(temp) / "real"
            write_session(real_root / "private" / "secret.jsonl", [
                header("secret", "/private"),
                assistant("e", "c", "bash", {"command": "git status"}),
            ])
            alias = Path(temp) / "alias"
            try:
                os.symlink(real_root, alias)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks unavailable")

            code, report = invoke("--root", str(alias), "--exclude", str(alias / "private"))
            self.assertEqual(code, 0)
            self.assertEqual(report["coverage"].get("unique_tool_calls", 0), 0)
            self.assertEqual(report["coverage"]["excluded_paths"], 1)

            code, report = invoke("--root", str(alias), "--exclude", str(alias))
            self.assertEqual(code, 1)
            self.assertEqual(report["coverage"]["excluded_roots"], 1)

    def test_path_qualified_executable_and_malformed_arguments_require_review(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            malformed = assistant("m", "m-call", "bash", {"command": "pwd"})
            malformed["message"]["content"][0]["arguments"] = "not-an-object"
            write_session(root / "session.jsonl", [
                header("session", "/project"),
                assistant("p", "p-call", "bash", {"command": "/tmp/git status"}),
                malformed,
            ])
            code, report = invoke("--root", str(root))
            self.assertEqual(code, 2)
            self.assertEqual(report["groups"][0]["label"], "bash (inspect arguments)")
            self.assertEqual(report["coverage"]["malformed_tool_calls"], 1)

    def test_malformed_schema_is_partial_and_not_grouped_as_valid(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            invalid_tool = assistant("tool", "tool-call", "ignored", {})
            invalid_tool["message"]["content"][0]["name"] = {"secret": "hidden"}
            write_session(root / "session.jsonl", [
                {"type": "session", "version": 3, "id": "session", "cwd": ["not", "a", "path"]},
                {"type": "message", "message": "invalid"},
                {"type": "message", "message": {"role": "assistant", "content": "invalid"}},
                invalid_tool,
            ])
            code, report = invoke("--root", str(root))
            self.assertEqual(code, 2)
            self.assertEqual(report["coverage"]["malformed_headers"], 1)
            self.assertEqual(report["coverage"]["malformed_records"], 2)
            self.assertEqual(report["coverage"]["malformed_tool_calls"], 1)
            self.assertEqual(report["groups"], [])
            self.assertNotIn("hidden", json.dumps(report))

    def test_invalid_arguments_are_fatal_not_partial(self) -> None:
        invalid_cases = [
            ["--max-line-bytes", "1"],
            ["--root", ".", "--max-line-bytes", str(65 * 1024 * 1024)],
            ["--root", ""],
            ["--root", "bad\x00path"],
            ["--root", "~a-user-that-should-not-exist-anywhere"],
        ]
        for arguments in invalid_cases:
            with self.subTest(arguments=arguments):
                code, report = invoke(*arguments)
                self.assertEqual(code, 1)
                self.assertEqual(report["gaps"], [{"reason": "invalid arguments"}])

    def test_fatal_when_no_root_is_accessible(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            missing = Path(temp) / "missing"
            code, report = invoke("--root", str(missing))
            self.assertEqual(code, 1)
            self.assertEqual(report["coverage"]["roots_unavailable"], 1)
            self.assertEqual(report["groups"], [])


if __name__ == "__main__":
    unittest.main()
