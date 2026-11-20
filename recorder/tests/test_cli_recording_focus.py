from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from cua_recorder.cli import _record, build_parser
from cua_recorder.protocol import RecorderError


class RecordingFocusLifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.order: list[str] = []
        self.events: list[dict[str, object]] = []
        self.result: dict[str, object] = {"recording_id": "Recording_test", "video": "saved.mp4"}
        self.console = MagicMock()
        self.console.restore.side_effect = self.restore
        self.session = MagicMock()
        self.session.run.side_effect = self.run_session
        patches = [
            patch("cua_recorder.cli.ConsoleWindowReturn.capture", side_effect=self.capture),
            patch("cua_recorder.cli.inspect_media", side_effect=lambda: self.order.append("inspect")),
            patch("cua_recorder.cli.require_recording_capabilities"),
            patch("cua_recorder.cli._select_display"),
            patch("cua_recorder.cli.require_output_root", return_value=Path("recordings")),
            patch("cua_recorder.cli.RecordingSession", return_value=self.session),
            patch("cua_recorder.cli.write_event", side_effect=self.write_event),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        self.args = build_parser().parse_args(["record", "--display-id", "0", "--output-root", "recordings"])

    def capture(self) -> MagicMock:
        self.order.append("capture")
        return self.console

    def run_session(self, _stream: object, status: object) -> dict[str, object]:
        status("armed")  # type: ignore[operator]
        status("completed", **self.result)  # type: ignore[operator]
        self.assertNotIn("completed", [event["event"] for event in self.events])
        self.order.append("cleanup")
        return self.result

    def restore(self) -> dict[str, object]:
        self.order.append("restore")
        return {"console_foreground": True}

    def write_event(self, event: str, **payload: object) -> None:
        self.events.append({"event": event, **payload})
        self.order.append(event)

    def test_completion_is_published_after_cleanup_and_console_activation(self) -> None:
        self.assertEqual(0, _record(self.args))
        self.assertEqual(["capture", "inspect", "armed", "cleanup", "restore", "completed"], self.order)
        self.assertTrue(self.events[-1]["console_foreground"])
        self.assertEqual("Recording_test", self.events[-1]["recording_id"])

    def test_focus_failure_preserves_successful_recording_with_warning(self) -> None:
        self.console.restore.side_effect = None
        self.console.restore.return_value = {"console_foreground": False, "focus_warning": "激活失败"}
        self.assertEqual(0, _record(self.args))
        self.assertEqual("completed", self.events[-1]["event"])
        self.assertEqual("激活失败", self.events[-1]["focus_warning"])
        self.assertEqual("saved.mp4", self.events[-1]["video"])

    def test_cancelled_session_does_not_restore_window_or_emit_completion(self) -> None:
        def cancel(_stream: object, status: object) -> dict[str, object]:
            status("cancelled")
            return {"cancelled": True}
        self.session.run.side_effect = cancel
        self.assertEqual(0, _record(self.args))
        self.console.restore.assert_not_called()
        self.assertEqual([{"event": "cancelled"}], self.events)

    def test_recording_failure_does_not_restore_window_or_emit_completion(self) -> None:
        self.session.run.side_effect = RecorderError("编码失败")
        with self.assertRaisesRegex(RecorderError, "编码失败"):
            _record(self.args)
        self.console.restore.assert_not_called()
        self.assertEqual([], self.events)
