from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from cua_recorder.console_window import ConsoleWindowReturn, _window_api


class ConsoleWindowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.user, self.kernel = MagicMock(), MagicMock()
        self.hwnd = 0x123456789
        self.foreground = 456
        self.user.GetForegroundWindow.side_effect = lambda: self.foreground
        self.user.GetAncestor.return_value = self.hwnd
        self.user.GetDesktopWindow.return_value = 1
        self.user.GetShellWindow.return_value = 2
        self.user.IsWindow.return_value = True
        self.user.IsWindowVisible.return_value = True
        self.user.IsIconic.return_value = False
        self.user.GetWindowThreadProcessId.side_effect = self.window_thread
        self.kernel.GetCurrentThreadId.return_value = 10
        self.api = patch("cua_recorder.console_window._window_api", return_value=(self.user, self.kernel))
        self.api.start()
        self.addCleanup(self.api.stop)

    def window_thread(self, hwnd: int, process: object) -> int:
        if process is not None:
            process._obj.value = 100  # type: ignore[attr-defined]
        return 20 if hwnd == self.hwnd else 30

    def activate(self, hwnd: int) -> bool:
        self.foreground = hwnd
        return True

    def test_restores_captured_window_after_switching_to_another_application(self) -> None:
        console = ConsoleWindowReturn.capture()
        self.foreground = 999
        self.user.IsIconic.side_effect = lambda _hwnd: self.foreground != self.hwnd
        self.user.SetForegroundWindow.side_effect = self.activate
        result = console.restore()
        self.assertEqual({"console_foreground": True}, result)
        self.user.ShowWindowAsync.assert_called_once_with(self.hwnd, 9)
        self.user.SetForegroundWindow.assert_called_once_with(self.hwnd)
        self.assertEqual(
            [(10, 30, True), (10, 20, True), (10, 20, False), (10, 30, False)],
            [call.args for call in self.user.AttachThreadInput.call_args_list],
        )
        self.user.SetWindowPos.assert_called_once_with(self.hwnd, 0, 0, 0, 0, 0, 0x43)

    def test_checks_actual_foreground_instead_of_trusting_api_return(self) -> None:
        console = ConsoleWindowReturn.capture()
        self.user.SetForegroundWindow.return_value = True
        with patch("cua_recorder.console_window.time.sleep"):
            result = console.restore()
        self.assertFalse(result["console_foreground"])
        self.assertIn("Windows 未允许激活", result["focus_warning"])
        self.assertEqual(20, self.user.SetForegroundWindow.call_count)

    def test_does_not_activate_closed_or_reused_window(self) -> None:
        console = ConsoleWindowReturn.capture()
        for valid, process in [(False, 100), (True, 200)]:
            with self.subTest(valid=valid, process=process):
                self.user.IsWindow.return_value = valid
                def thread(_hwnd: int, owner: object) -> int:
                    owner._obj.value = process  # type: ignore[attr-defined]
                    return 20
                self.user.GetWindowThreadProcessId.side_effect = thread
                result = console.restore()
                self.assertFalse(result["console_foreground"])
                self.assertIn("原控制台窗口已关闭", result["focus_warning"])
                self.user.SetForegroundWindow.assert_not_called()

    def test_capture_failure_does_not_raise_or_activate_arbitrary_window(self) -> None:
        self.user.GetAncestor.return_value = 1
        console = ConsoleWindowReturn.capture()
        result = console.restore()
        self.assertFalse(result["console_foreground"])
        self.assertIn("未找到控制台窗口", result["focus_warning"])
        self.user.SetForegroundWindow.assert_not_called()

    def test_input_threads_are_detached_even_when_activation_raises(self) -> None:
        console = ConsoleWindowReturn.capture()
        self.user.SetForegroundWindow.side_effect = OSError("访问被拒绝")
        result = console.restore()
        self.assertFalse(result["console_foreground"])
        self.assertIn("访问被拒绝", result["focus_warning"])
        self.assertEqual(False, self.user.AttachThreadInput.call_args.args[-1])

    def test_retries_while_asynchronous_restore_is_pending(self) -> None:
        console = ConsoleWindowReturn.capture()
        self.user.IsIconic.side_effect = [True, True, False]
        self.user.SetForegroundWindow.side_effect = self.activate
        with patch("cua_recorder.console_window.time.sleep") as wait:
            self.assertTrue(console.restore()["console_foreground"])
        wait.assert_called_once_with(0.05)


class WindowApiTest(unittest.TestCase):
    def test_native_signatures_preserve_pointer_sized_window_handles(self) -> None:
        libraries = MagicMock()
        with (
            patch("cua_recorder.console_window.require_windows"),
            patch("cua_recorder.console_window.ctypes.windll", libraries, create=True),
        ):
            user, kernel = _window_api()
        from ctypes import wintypes as wt
        self.assertIs(user.GetForegroundWindow.restype, wt.HWND)
        self.assertIs(user.SetForegroundWindow.argtypes[0], wt.HWND)
        self.assertIs(user.GetAncestor.restype, wt.HWND)
        self.assertIs(kernel.GetCurrentThreadId.restype, wt.DWORD)
