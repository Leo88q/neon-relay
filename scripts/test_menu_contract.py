#!/usr/bin/env python3
"""Source/generation regression checks. Not a native render or input test."""
import json
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parent.parent

class MenuContract(unittest.TestCase):
    def text(self, file):
        return (ROOT / file).read_text()

    def test_five_home_destinations(self):
        start = self.text('src/game/client/components/menus_start.cpp')
        pages = re.search(r'const int aPages\[\] = \{([^}]+)\}', start).group(1)
        self.assertEqual(re.findall(r'CMenus::(PAGE_\w+)', pages),
                         ['PAGE_RACES', 'PAGE_CHARACTERS', 'PAGE_WALLET', 'PAGE_LEADERS', 'PAGE_SETTINGS'])
        for old in ['s_MapEditorButton', 's_DemoButton', 's_LocalServerButton', 'RunServer(', 'm_ClEditor = 1']:
            self.assertNotIn(old, start)
        menus = self.text('src/game/client/components/menus.cpp')
        for page in ['PAGE_RACES', 'PAGE_CHARACTERS', 'PAGE_WALLET', 'PAGE_LEADERS']:
            self.assertIn('m_MenuPage == ' + page, menus)
        self.assertIn('m_MenuPage = PAGE_RACES;', menus)

    def test_settings_whitelist_and_legal_access(self):
        settings = self.text('src/game/client/components/menus_settings.cpp')
        pages = re.search(r'const int aPages\[\] = \{([^}]+)\}', settings).group(1)
        self.assertEqual(re.findall(r'SETTINGS_\w+', pages),
                         ['SETTINGS_LANGUAGE', 'SETTINGS_GRAPHICS', 'SETTINGS_SOUND', 'SETTINGS_CONTROLS'])
        self.assertIn('g_Config.m_UiSettingsPage != SETTINGS_CREDITS', settings)
        self.assertIn('Localize("Credits")', settings)

    def test_generated_catalogs_are_current(self):
        for header, command in [
            ('src/game/client/potato_catalog.h', ['python3', 'scripts/gen_potato_catalog.py']),
            ('src/game/client/race_catalog.h', ['node', '--experimental-strip-types', 'scripts/gen_race_catalog.ts']),
        ]:
            before = (ROOT / header).read_bytes()
            subprocess.run(command, cwd=ROOT, check=True)
            self.assertEqual(before, (ROOT / header).read_bytes(), header + ' was stale')
        catalog = json.loads(self.text('data/skins/potato_catalog.json'))['skins']
        self.assertEqual(len(catalog), 10)
        header = self.text('src/game/client/potato_catalog.h')
        for item in catalog:
            self.assertIn('"' + item['id'] + '"', header)
            self.assertIn(str(item['price_skr']), header)

    def test_character_lore_and_freeze_identity(self):
        catalog = json.loads(self.text('data/skins/potato_catalog.json'))
        self.assertFalse(catalog['purchase_enabled'])
        self.assertTrue(catalog['skills_are_lore_only'])
        self.assertEqual(sorted(s['price_skr'] for s in catalog['skins']), [500]*5+[1000]*3+[2000]*2)
        for row in catalog['skins']:
            self.assertFalse(row['gameplay_bonuses'])
            for field in ('name', 'title', 'skill_lore', 'legend'):
                self.assertTrue(row[field]['ru'])
                self.assertTrue(row[field]['en'])
        players = self.text('src/game/client/components/players.cpp')
        self.assertIn('!IsPotatoCatalogSkin(GameClient()->m_aClients[i].m_aSkinName)', players)
        self.assertIn('TEE_EFFECT_FROZEN | TEE_NO_WEAPON', players)

    def test_no_fake_purchase_or_rankings(self):
        pages = self.text('src/game/client/components/menus_settings_wallet.cpp')
        pages = pages[pages.index('void CMenus::RenderRaceLobby'):]
        self.assertIn('Paid entry is not available yet.', pages)
        self.assertIn('NFT purchases unavailable.', pages)
        self.assertIn('Skills are lore only. No gameplay bonuses.', pages)
        self.assertIn('Try on free (preview)', pages)
        self.assertIn('Rankings are unavailable', pages)
        self.assertNotIn('neonrelay_wallet_request_', pages)
        self.assertIn('Practice - server browser', pages)

if __name__ == '__main__':
    unittest.main()
