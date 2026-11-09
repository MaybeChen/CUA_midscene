from __future__ import annotations

import ctypes
import unittest
from ctypes import wintypes as wt
from unittest.mock import Mock, call

from cua_recorder.models import DisplayInfo
from cua_recorder.overlay_guidance import BORDER_COLOR, NOTICE_TEXT, RecordingGuidance, _rgb
from cua_recorder.overlay_win32 import PaintStruct
from cua_recorder.protocol import RecorderError


def fixture(scale: float = 1.0) -> tuple[RecordingGuidance, Mock, Mock]:
    display = DisplayInfo("display-1", "DISPLAY1", 1, -1920, 120, 1920, 1080, scale, False)
    user, gdi = Mock(), Mock()
    user.CreateWindowExW.return_value = 101
    gdi.CreateFontW.return_value = 201
    gdi.CreateRectRgn.side_effect = range(301, 401)
    gdi.CreateRoundRectRgn.return_value = 501
    return RecordingGuidance(display, user, gdi, PaintStruct), user, gdi


class RecordingGuidanceTest(unittest.TestCase):
    def test_selected_display_bounds_capture_exclusion_and_click_through(self) -> None:
        guidance, user, _gdi = fixture(1.5)
        guidance.create("overlay", 1)
        args = user.CreateWindowExW.call_args.args
        self.assertEqual((-1920, 120, 1920, 1080), args[4:8])
        self.assertTrue(args[0] & 0x08000000)  # WS_EX_NOACTIVATE
        self.assertTrue(args[0] & 0x00080000)  # WS_EX_LAYERED
        self.assertTrue(args[0] & 0x00000020)  # WS_EX_TRANSPARENT
        user.SetLayeredWindowAttributes.assert_called_once_with(101, 0, 255, 2)
        user.SetWindowDisplayAffinity.assert_called_once_with(101, 0x11)
        self.assertEqual(3, guidance.handle_message(0x0021))
        self.assertEqual(-1, guidance.handle_message(0x0084))
        self.assertEqual(0x53, user.SetWindowPos.call_args.args[-1])

    def test_border_scales_inside_screen_without_occupying_interior(self) -> None:
        for scale in (1.0, 1.25, 1.5, 2.0):
            with self.subTest(scale=scale):
                guidance, _user, gdi = fixture(scale)
                guidance.create("overlay", 1)
                border = round(10 * scale)
                self.assertEqual(call(border, border, 1920 - border, 1080 - border), gdi.CreateRectRgn.call_args_list[1])
                self.assertIn(call(301, 301, 302, 4), gdi.CombineRgn.call_args_list)
                left, top, right, bottom = guidance.notice_rect()
                self.assertEqual(1920, left + right)
                self.assertGreaterEqual(top, border)
                self.assertLess(bottom, 1080 - border)
                self.assertLessEqual(right, 1920 - border)

    def test_notice_disappears_when_starting_but_border_stays_until_finished(self) -> None:
        guidance, user, gdi = fixture()
        guidance.create("overlay", 1)
        guidance.update("armed")
        self.assertEqual(1, gdi.CreateRoundRectRgn.call_count)
        guidance.update("starting")
        guidance.update("recording")
        self.assertEqual(1, gdi.CreateRoundRectRgn.call_count)
        self.assertEqual(4, gdi.CreateRectRgn.call_count)
        self.assertEqual(0x53, user.SetWindowPos.call_args.args[-1])
        guidance.update("completed")
        self.assertEqual(0x93, user.SetWindowPos.call_args.args[-1])
        guidance.close()
        user.DestroyWindow.assert_called_once_with(101)
        self.assertEqual(0, guidance.hwnd)
        self.assertIn(call(201), gdi.DeleteObject.call_args_list)
        guidance.close()
        user.DestroyWindow.assert_called_once()

    def test_paint_uses_exact_border_color_and_notice_font(self) -> None:
        guidance, _user, gdi = fixture(1.25)
        guidance.create("overlay", 1)
        self.assertEqual(-round(14 * 1.25), gdi.CreateFontW.call_args.args[0])
        guidance._fill = Mock()
        guidance._paint_notice = Mock()
        guidance.handle_message(0x000F)
        self.assertEqual(4, guidance._fill.call_count)
        self.assertTrue(all(item.args[2] == BORDER_COLOR for item in guidance._fill.call_args_list))
        guidance._paint_notice.assert_called_once()
        guidance.update("recording")
        guidance.handle_message(0x000F)
        guidance._paint_notice.assert_called_once()

    def test_notice_text_color_and_complete_copy_are_preserved(self) -> None:
        guidance, user, gdi = fixture()
        guidance.create("overlay", 1)
        guidance._fill = Mock()
        guidance._paint_info_icon = Mock()

        def measure(_dc, _text, _length, rect, flags):
            if flags & 0x0400:
                box = ctypes.cast(rect, ctypes.POINTER(wt.RECT)).contents
                box.bottom = box.top + 20
            return 20

        user.DrawTextW.side_effect = measure
        guidance._paint_notice(1)
        gdi.SetTextColor.assert_called_with(1, _rgb(30, 30, 30))
        self.assertTrue(all(item.args[1] == NOTICE_TEXT for item in user.DrawTextW.call_args_list))

    def test_failed_capture_exclusion_and_failed_region_release_resources(self) -> None:
        guidance, user, gdi = fixture()
        user.SetWindowDisplayAffinity.return_value = False
        with self.assertRaisesRegex(RecorderError, "排除出画面"):
            guidance.create("overlay", 1)
        guidance.close()
        user.DestroyWindow.assert_called_once_with(101)
        gdi.CreateFontW.assert_not_called()
        guidance, user, gdi = fixture()
        user.SetWindowRgn.return_value = False
        with self.assertRaisesRegex(RecorderError, "边框区域"):
            guidance.create("overlay", 1)
        for handle in (301, 302, 501):
            self.assertIn(call(handle), gdi.DeleteObject.call_args_list)
        guidance.close()
        self.assertIn(call(201), gdi.DeleteObject.call_args_list)


if __name__ == "__main__":
    unittest.main()
