#!/usr/bin/env python3
"""Source/generation regression checks. Not a native render or input test."""
import hashlib
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

    def test_warmup_card_and_verified_course_identity(self):
        header=self.text('src/game/client/practice_course.h')
        digest=hashlib.sha256((ROOT/'data/maps/Neon Relay Warmup.map').read_bytes()).hexdigest()
        self.assertIn('"'+digest+'"',header)
        self.assertIn('WARMUP_COURSE_ID = "warmup"',header)
        launch=self.text('src/game/client/components/local_server.cpp')
        for value in ['sv_register 0','bindaddr 127.0.0.1','sv_neonrelay_signing 0',
                      'sv_neonrelay_reward_per_match_micro 0','sv_use_sql 0',
                      'sv_sqlite_file warmup-practice.sqlite','sv_test_cmds 0']:
            self.assertIn(value,launch)
        self.assertLess(launch.index('net_udp_create(Address)'),launch.index('const bool Started = RunServer'))
        self.assertIn('GameClient()->Map()->Sha256()',launch)
        self.assertIn('GameClient()->Map()->BaseName()',launch)
        self.assertIn('Client()->State() != IClient::STATE_OFFLINE || IsServerRunning()',launch)
        self.assertNotIn('neonrelay_wallet_',launch)
        pages=self.text('src/game/client/components/menus_settings_wallet.cpp')
        self.assertIn('Localize("Warmup", "Original course")',pages)
        self.assertIn('m_LocalServer.StartWarmup()',pages)
        self.assertIn('m_LocalServer.StopWarmup()',pages)
        self.assertLess(pages.index('m_LocalServer.StartWarmup()'),pages.index('for(const auto &Race : RACE_CATALOG)'))
        translations=self.text('data/languages/russian.txt')
        self.assertIn('[Original course]\nWarmup\n== Разогрев',translations)
        self.assertIn('Warmup\n== Разминка',translations)

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
        self.assertNotIn('ApplySkin(NinjaTeeRenderInfo()', players)
        self.assertIn('TEE_EFFECT_FROZEN | TEE_NO_WEAPON', players)

    def test_fixed_faces_and_retired_wheel(self):
        self.assertFalse((ROOT/'src/game/client/components/emoticon.cpp').exists())
        self.assertNotIn('RenderTee7(', self.text('src/game/client/render.cpp'))
        self.assertNotIn('m_aEyes[TeeEye]', self.text('src/game/client/render.cpp'))
        skins = self.text('src/game/client/components/skins.cpp')
        self.assertIn('IsPotatoCatalogSkin(pName) ? pName : "potato_cool_guy_1"', skins)
        self.assertNotIn('LoadSkinDirect("default")', skins)
        touch = json.loads(self.text('data/touch_controls.json'))
        self.assertFalse(any(b['behavior'].get('id') == 'emoticon' for b in touch['touch-buttons']))
        start = self.text('src/game/client/components/menus_start.cpp')
        self.assertIn('RenderCharacterPortrait', start)
        self.assertIn('Compact', start)

    def test_wallet_is_read_only_and_scrollable(self):
        wallet = self.text('src/game/client/components/menus_settings_wallet.cpp')
        self.assertNotIn('neonrelay_wallet_request_economy(', wallet)
        self.assertIn('neonrelay_wallet_request_connect()', wallet)
        self.assertIn('neonrelay_wallet_request_disconnect()', wallet)
        self.assertIn('s_WalletScroll.Begin', wallet)
        self.assertIn('s_WalletScroll.End()', wallet)
        self.assertIn('Props.m_MaxWidth = MainView.w', wallet)
        self.assertIn('Payments, prize claims and NFT purchases are unavailable', wallet)
        settings = self.text('src/game/client/components/menus_settings.cpp')
        self.assertIn('const bool Compact', settings)
        self.assertIn('Button.h = 44.0f', settings)
        menus = self.text('src/game/client/components/menus.cpp')
        self.assertNotIn('Box.Margin(150.0f, &Box)', menus)

    def test_race_and_leader_scroll_regions(self):
        pages = self.text('src/game/client/components/menus_settings_wallet.cpp')
        race = pages[pages.index('void CMenus::RenderRaceLobby'):pages.index('void CMenus::RenderCharacterPortrait')]
        self.assertIn('s_RaceScroll.Begin', race)
        self.assertIn('s_RaceScroll.End()', race)
        self.assertIn('Props.m_MaxWidth = MainView.w', race)
        self.assertLess(race.index('s_Practice'), race.index('s_RaceScroll.Begin'))
        self.assertIn('Compact ? 108.0f : 84.0f', race)
        self.assertIn('for(const auto &Race : RACE_CATALOG)', race)
        leaders = pages[pages.index('void CMenus::RenderLeaders'):]
        self.assertIn('s_LeadersScroll.Begin', leaders)
        self.assertIn('s_LeadersScroll.End()', leaders)
        self.assertIn('SetMenuPage(PAGE_RACES)', leaders)
        self.assertNotIn('neonrelay_wallet_request_', leaders)

    def test_map_editor_removed_but_gameplay_maps_preserved(self):
        self.assertFalse((ROOT/'src/game/editor').exists())
        self.assertFalse((ROOT/'src/engine/editor.h').exists())
        self.assertFalse((ROOT/'data/editor').exists())
        cmake = self.text('CMakeLists.txt')
        self.assertNotIn('GAME_EDITOR', cmake)
        engine = self.text('src/engine/client/client.cpp')
        for retired in ['CreateEditor(', 'm_pEditor', 'HandleMapPath', 'CtrlShiftKey(KEY_E']:
            self.assertNotIn(retired, engine)
        self.assertNotIn('MACRO_CONFIG_INT(ClEditor,', self.text('src/engine/shared/config_variables.h'))
        self.assertIn('GameClient()->OnRender()', engine)
        self.assertTrue((ROOT/'src/engine/server/server.cpp').exists())
        images = self.text('src/game/client/components/mapimages.cpp')
        self.assertIn('game_entities/entities_clear', images)
        for name in ['ddnet', 'ddrace', 'f-ddrace', 'fng', 'race', 'vanilla', 'blockworlds']:
            path = 'game_entities/entities_clear/' + name + '.png'
            self.assertTrue((ROOT/'data'/path).is_file())
            self.assertIn(path, cmake)

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
