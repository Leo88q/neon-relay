#!/usr/bin/env python3
"""Offline guards for the server-probe wrapper, not server gameplay evidence."""
from pathlib import Path
import sqlite3
import tempfile
import unittest
from test_warmup_server import ROOT, races


class ServerProbeContract(unittest.TestCase):
    def test_sqlite_evidence_requires_correct_map_and_player(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'scores.sqlite'
            self.assertEqual(races(path),[])
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE record_race (Map TEXT, Name TEXT, Time REAL)')
                db.executemany('INSERT INTO record_race VALUES (?,?,?)',[
                    ('wrong map','WarmupProbe',10),('Neon Relay Warmup','wrong player',12),
                    ('Neon Relay Warmup','WarmupProbe',40),('Neon Relay Warmup','WarmupProbe',20)])
            self.assertEqual(races(path),[(20.0,),(40.0,)])

    def test_probe_is_opt_in_and_has_no_character_state_writes(self):
        cmake=(ROOT/'CMakeLists.txt').read_text()
        self.assertIn('option(NEONRELAY_WARMUP_PROBE "Build isolated Warmup server input probe (test only, never ship)" OFF)',cmake)
        driver=(ROOT/'tests/warmup/server_probe.cpp').read_text()
        self.assertIn('std::getenv("NEONRELAY_WARMUP_PROBE")',driver)
        self.assertIn('"127.0.0.1"',driver)
        self.assertIn('!g_Config.m_SvTestingCommands',driver)
        # Deliberately forbid setters/const_cast as well as direct writes here.
        for forbidden in ('SetPosition(', 'SetCore(', 'const_cast', 'm_DDRaceState = ', 'm_StartTime = ', 'Core.m_Pos =', 'Core.m_Vel ='):
            self.assertNotIn(forbidden,driver)


if __name__=='__main__':unittest.main()
