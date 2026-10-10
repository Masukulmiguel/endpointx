"""Unit tests for agent self-update channels and tamper anchoring.

Regression gate for the production discovery fix:
- every self-update channel must ship ``discovery.py`` before ``agent.py``
  (``agent.py`` imports it at module level, so a partial update crashes the
  restart with ModuleNotFoundError);
- a legitimate update must re-anchor the tamper backup/hash, otherwise the
  periodic integrity check restores the pre-update backup and silently
  reverts every update;
- hash/backup must live next to agent.py so the (unelevated) account the
  agent runs as can actually write them - ProgramData copies created during
  an elevated install are read-only for it and made re-anchoring fail with
  Permission denied.

Stdlib unittest only. No network: downloads are mocked into a temp dir.
"""

import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import agent


class TestUpdateFileLists(unittest.TestCase):
    def test_core_update_files_ship_discovery_before_agent(self):
        core = agent.CORE_UPDATE_FILES
        self.assertIn("discovery.py", core)
        self.assertIn("agent.py", core)
        self.assertLess(core.index("discovery.py"), core.index("agent.py"))

    def test_both_update_channels_include_discovery(self):
        for label, files in (
            ("auto", agent.auto_update_files()),
            ("command", agent.command_update_files()),
        ):
            with self.subTest(channel=label):
                self.assertIn("discovery.py", files)
                self.assertIn("agent.py", files)
                self.assertLess(files.index("discovery.py"), files.index("agent.py"))


class TestDownloadUpdateFiles(unittest.TestCase):
    @staticmethod
    def _fake_urlopen(req, timeout=None):
        name = req.full_url.rsplit("/", 1)[-1]
        resp = mock.MagicMock()
        resp.read.return_value = f"# content of {name}\n".encode()
        resp.__enter__.return_value = resp
        return resp

    def test_download_ships_discovery_and_refreshes_anchor(self):
        with tempfile.TemporaryDirectory() as tmp:
            tamper = mock.Mock()
            with mock.patch(
                "urllib.request.urlopen", side_effect=self._fake_urlopen
            ):
                updated = agent.download_update_files(
                    "https://example.invalid/agent",
                    agent.auto_update_files(),
                    tmp,
                    tamper,
                )
            self.assertIn("discovery.py", updated)
            self.assertIn("agent.py", updated)
            self.assertTrue((Path(tmp) / "discovery.py").exists())
            self.assertTrue((Path(tmp) / "agent.py").exists())
            tamper.refresh_after_update.assert_called_once()

    def test_no_refresh_when_nothing_downloaded(self):
        with tempfile.TemporaryDirectory() as tmp:
            tamper = mock.Mock()
            with mock.patch(
                "urllib.request.urlopen", side_effect=OSError("offline")
            ):
                updated = agent.download_update_files(
                    "https://example.invalid/agent",
                    ["agent.py"],
                    tmp,
                    tamper,
                )
            self.assertEqual(updated, [])
            tamper.refresh_after_update.assert_not_called()


class TestTamperAnchorLocation(unittest.TestCase):
    def test_hash_backup_and_lock_live_in_agent_dir(self):
        paths = agent._get_platform_paths()
        agent_dir = Path(agent.os.path.abspath(agent.__file__)).parent
        self.assertEqual(paths["hash"].parent, agent_dir)
        self.assertEqual(paths["backup"].parent, agent_dir)
        self.assertEqual(paths["lock"].parent, agent_dir)
        self.assertNotEqual(paths["hash"].parent, paths["base"])


class TestMissingDiscoveryRecovery(unittest.TestCase):
    @staticmethod
    def _fake_urlopen(req, timeout=None):
        resp = mock.MagicMock()
        resp.read.return_value = b"# recovered discovery\n"
        resp.__enter__.return_value = resp
        return resp

    def test_fetch_missing_discovery_writes_module(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = str(Path(tmp) / "discovery.py")
            with mock.patch(
                "urllib.request.urlopen", side_effect=self._fake_urlopen
            ):
                agent._fetch_missing_discovery(target)
            self.assertEqual(
                Path(target).read_bytes(), b"# recovered discovery\n"
            )

    def test_fetch_missing_discovery_never_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = str(Path(tmp) / "discovery.py")
            with mock.patch(
                "urllib.request.urlopen", side_effect=OSError("offline")
            ):
                agent._fetch_missing_discovery(target)
            self.assertFalse(Path(target).exists())


class TestTamperRefreshAfterUpdate(unittest.TestCase):
    @staticmethod
    def _tamper(agent_path, tmp):
        tamper = agent.TamperProtection.__new__(agent.TamperProtection)
        tamper.server_url = "https://example.invalid"
        tamper.agent_id = "agt"
        tamper.agent_secret = "sec"
        tamper._paths = {
            "base": Path(tmp),
            "lock": Path(tmp) / "agent.lock",
            "backup": Path(tmp) / "agent.py.bak",
            "hash": Path(tmp) / "agent.sha256",
        }
        tamper._agent_path = agent_path
        tamper._initial_hash = None
        return tamper

    def test_refresh_rewires_backup_and_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_path = Path(tmp) / "agent.py"
            agent_path.write_text("# updated agent\n", encoding="utf-8")
            tamper = self._tamper(agent_path, tmp)
            # Stale anchor left behind by the previous version.
            (Path(tmp) / "agent.sha256").write_text("0" * 64, encoding="utf-8")

            tamper.refresh_after_update()

            expected = hashlib.sha256(agent_path.read_bytes()).hexdigest()
            stored = (Path(tmp) / "agent.sha256").read_text(encoding="utf-8").strip()
            self.assertEqual(stored, expected)
            self.assertEqual(
                (Path(tmp) / "agent.py.bak").read_text(encoding="utf-8"),
                "# updated agent\n",
            )
            self.assertTrue(tamper.verify_integrity())

    def test_verify_flags_file_tampering_after_anchor(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_path = Path(tmp) / "agent.py"
            agent_path.write_text("# anchored agent\n", encoding="utf-8")
            tamper = self._tamper(agent_path, tmp)
            tamper.refresh_after_update()

            agent_path.write_text("# tampered agent\n", encoding="utf-8")
            with mock.patch.object(tamper, "report_tamper") as report:
                self.assertFalse(tamper.verify_integrity())
            report.assert_called_once()


if __name__ == "__main__":
    unittest.main()
