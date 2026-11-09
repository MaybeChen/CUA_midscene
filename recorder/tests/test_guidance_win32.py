"""设置 CUA_TEST_DESKTOP_OVERLAY=1，在 Windows 桌面验证边框及提示。"""

from __future__ import annotations

import ctypes
import os
import sys
import time
import unittest
from ctypes import wintypes as wt

from cua_recorder.overlay_win32 import RecorderOverlay
from cua_recorder.windows import list_displays
from test_overlay_win32 import average_difference, capture_patch


def contains(overlay: RecorderOverlay, x: int, y: int) -> bool:
    gdi, user = overlay._gdi, overlay._user
    user.GetWindowRgn.argtypes = [wt.HWND, wt.HANDLE]
    user.GetWindowRgn.restype = ctypes.c_int
    gdi.PtInRegion.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_int]
    gdi.PtInRegion.restype = wt.BOOL
    region = gdi.CreateRectRgn(0, 0, 0, 0)
    try:
        if not user.GetWindowRgn(overlay._guidance.hwnd, region):
            raise AssertionError("无法读取边框窗口区域")
        return bool(gdi.PtInRegion(region, x, y))
    finally:
        gdi.DeleteObject(region)


@unittest.skipUnless(
    sys.platform == "win32" and os.environ.get("CUA_TEST_DESKTOP_OVERLAY") == "1",
    "需要显式启用 Windows 桌面集成测试",
)
class RecordingGuidanceNativeTest(unittest.TestCase):
    def test_selected_screen_region_notice_lifecycle_and_click_through(self) -> None:
        display = list_displays()[0]
        overlay = RecorderOverlay(display, lambda _command: None)
        user = ctypes.windll.user32
        user.GetForegroundWindow.restype = wt.HWND
        foreground = user.GetForegroundWindow()
        try:
            overlay.start()
            overlay.update("armed")
            time.sleep(0.35)
            overlay.check()
            guidance = overlay._guidance
            rect = wt.RECT()
            self.assertTrue(user.GetWindowRect(guidance.hwnd, ctypes.byref(rect)))
            self.assertEqual((display.left, display.top, display.right, display.bottom),
                             (rect.left, rect.top, rect.right, rect.bottom))
            self.assertTrue(contains(overlay, 1, display.height // 2))
            self.assertFalse(contains(overlay, display.width // 2, display.height // 2))
            left, top, right, bottom = guidance.notice_rect()
            self.assertTrue(contains(overlay, (left + right) // 2, (top + bottom) // 2))
            for x, y in ((1, display.height // 2), ((left + right) // 2, (top + bottom) // 2)):
                hit = user.WindowFromPoint(wt.POINT(display.left + x, display.top + y))
                self.assertNotEqual(guidance.hwnd, user.GetAncestor(hit, 2))
            self.assertEqual(foreground, user.GetForegroundWindow())
            overlay.update("recording", time.perf_counter_ns())
            time.sleep(0.35)
            overlay.check()
            self.assertFalse(contains(overlay, (left + right) // 2, (top + bottom) // 2))
            self.assertTrue(contains(overlay, 1, display.height // 2))
        finally:
            overlay.stop()
        self.assertIsNone(overlay._guidance)

    def test_green_border_is_visible_but_excluded_from_video_capture(self) -> None:
        display = list_displays()[0]
        overlay = RecorderOverlay(display, lambda _command: None)
        left = display.left + max(1, round(2 * display.scale_factor))
        top = display.top + display.height // 2
        baseline = capture_patch(left, top, 3, 3)
        try:
            overlay.start()
            time.sleep(0.3)
            excluded = capture_patch(left, top, 3, 3)
            self.assertLess(average_difference(baseline, excluded), 1.0)
            hwnd = overlay._guidance.hwnd
            self.assertTrue(overlay._user.SetWindowDisplayAffinity(hwnd, 0))
            time.sleep(0.3)
            visible = capture_patch(left, top, 3, 3)
            self.assertLess(average_difference(bytes((101, 185, 94)) * 9, visible), 2.0)
            self.assertTrue(overlay._user.SetWindowDisplayAffinity(hwnd, 0x11))
        finally:
            overlay.stop()


if __name__ == "__main__":
    unittest.main()
