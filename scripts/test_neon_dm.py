#!/usr/bin/env python3
"""Compiled live rule tests + source wiring contracts, NOT a full-server test."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


def source(path):
    return (ROOT / path).read_text()


class NeonDmTests(unittest.TestCase):
    def test_compiled_live_rules(self):
        with tempfile.TemporaryDirectory(prefix='neon-dm-') as tmp:
            exe=Path(tmp)/'rules'
            subprocess.run([os.environ.get('CXX','g++'),'-std=c++20','-O1','-g',
                            '-fsanitize=undefined','-fno-sanitize-recover=all',
                            '-Wall','-Wextra','-Werror','-Isrc','tests/neon_dm/rules.cpp',
                            '-o',str(exe)],cwd=ROOT,check=True,timeout=60)
            run=subprocess.run([str(exe)],capture_output=True,text=True,check=True,timeout=15)
            self.assertEqual(run.stderr,'')
            self.assertEqual(run.stdout.count('PASS:'),4)
            print(run.stdout,end='')

    def test_attribution_is_not_a_branding_bypass(self):
        from branding_scan import classify
        path='scripts/build_chrome_dm.py'
        self.assertEqual(classify(path,"m.info.author='Teeworlds / Neon Relay'")[0],'legal-attribution')
        self.assertEqual(classify(path,"print('Welcome to Teeworlds')")[0],'user-facing')
        self.assertEqual(classify('src/game/server/gamemodes/neon_dm.cpp', '"Welcome to Teeworlds"')[0],'user-facing')

    def test_probe_disabled_by_default_and_input_only(self):
        cmake=source('CMakeLists.txt')
        self.assertIn('option(NEONRELAY_DM_PROBE "Build isolated DM server input probe (test only, never ship)" OFF)',cmake)
        probe=source('tests/neon_dm/server_probe.cpp')
        for forbidden in ('->SetPosition(', '->SetVelocity(', '->TakeDamage(', '->IncreaseHealth(', '->GiveWeapon(', '->SetArmor(', '->m_Pos =', '->Die('):
            self.assertNotIn(forbidden,probe)
        self.assertIn('OnClientPredictedEarlyInput',probe)
        self.assertIn('std::getenv("NEONRELAY_DM_PROBE")',probe)

    def test_isolated_local_launcher(self):
        from run_neon_dm_local import server_args, MAP_NAME
        args=server_args(Path('/tmp/neonrelay-server'),8306)
        for setting in ('bindaddr 127.0.0.1','sv_register 0','sv_sixup 0',
                        'sv_gametype neon-dm','sv_test_cmds 0','sv_practice 0',
                        'sv_solo_server 0','sv_neonrelay_signing 0',
                        'sv_neonrelay_reward_per_match_micro 0'):
            self.assertIn(setting,args)
        report=json.loads(source('docs/dm/CHROME_STUDY.json'))
        self.assertEqual(hashlib.sha256((ROOT/'docs/dm'/(MAP_NAME+'.map')).read_bytes()).hexdigest(),report['output_sha256'])
        self.assertIn('CC-BY-SA 3.0',source('docs/dm/UPSTREAM_MAP_LICENSE.txt'))

    def test_opt_in_default_unchanged(self):
        config=source('src/engine/shared/config_variables.h')
        self.assertIn('SvGametype, sv_gametype, 32, "ddnet"',config)
        self.assertIn('virtual bool IsDeathmatch() const { return false; }',source('src/game/server/gamecontroller.h'))
        context=source('src/game/server/gamecontext.cpp')
        self.assertIn('if(!str_comp(Config()->m_SvGametype, "neon-dm"))\n\t\tm_pController = new CGameControllerNeonDm(this);',context)
        self.assertIn('else\n\t\tm_pController = new CGameControllerDDNet(this);',context)
        for path in ('neon_dm.cpp','neon_dm.h','neon_dm_rules.h'):
            self.assertIn('gamemodes/'+path,source('CMakeLists.txt'))

    def test_character_live_wiring(self):
        text=source('src/game/server/entities/character.cpp')
        damage=text.split('bool CCharacter::TakeDamage(',1)[1].split('void CCharacter::SendDeathMessage',1)[0]
        self.assertIn('if(GameServer()->m_pController->IsDeathmatch())',damage)
        self.assertIn('NeonDm::Damage(m_Health, m_Armor, Dmg, From == m_pPlayer->GetCid())',damage)
        self.assertIn('Die(From, Weapon);',damage)
        self.assertIn('m_Health = Result.m_Health;',damage)
        self.assertIn('m_Armor = Result.m_Armor;',damage)
        race_fallback=damage.split('if(Dmg)',1)[1]
        self.assertNotIn('m_Health =',race_fallback)
        self.assertNotIn('Die(',race_fallback)
        self.assertIn('Killer >= 0 && Killer < MAX_CLIENTS',text)
        self.assertIn('IsDeathmatch() && !m_Alive',text)
        self.assertIn('--Weapon.m_Ammo;',text)
        self.assertIn('s_aSpread[]',text)
        self.assertIn('Gun.m_AmmoRegenStart',text)
        self.assertIn('IsDeathmatch() ? (int)TuningList()[m_TuneZone].m_LaserDamage : 0',source('src/game/server/entities/laser.cpp'))
        self.assertIn('Dm ? 1 : 0',source('src/game/server/entities/projectile.cpp'))

    def test_pickup_is_shared_and_hidden_until_respawn(self):
        text=source('src/game/server/entities/pickup.cpp')
        self.assertIn('pChr->IncreaseHealth(1)',text)
        self.assertIn('if(m_Type == POWERUP_HEALTH)',text)
        self.assertIn('Type = IsDeathmatch() ? POWERUP_HEALTH : POWERUP_FREEZE;',source('src/game/server/gamecontroller.cpp'))
        self.assertIn('pChr->IncreaseArmor(1)',text)
        self.assertIn('pChr->SetWeaponAmmo(m_Subtype, NeonDm::MAX_AMMO)',text)
        self.assertIn('break; // one shared pickup',text)
        self.assertIn('++m_RespawnTick;',text)
        snap=text.split('void CPickup::Snap(',1)[1]
        self.assertIn('IsDeathmatch() && m_RespawnTick > Server()->Tick()',snap)
        self.assertIn('pChr->Freeze()',text) # original race behavior remains

    def test_scores_and_hud_are_not_race_times(self):
        text=source('src/game/server/gamemodes/neon_dm.cpp')
        self.assertIn('NeonDm::ScoreDelta(',text)
        self.assertIn('NeonDm::RoundResult(',text)
        self.assertIn('m_aScores.fill(0)',text)
        self.assertIn('m_aScores[pPlayer->GetCid()] = 0;',text)
        self.assertIn('EndRound();',text)
        self.assertIn('RemoveEntitiesFromPlayer(pPlayer->GetCid())',text)
        self.assertNotIn('GiveNinja',text)
        snap=source('src/game/server/gamecontroller.cpp')
        self.assertIn('GAMEINFOFLAG2_HUD_HEALTH_ARMOR | GAMEINFOFLAG2_HUD_AMMO',snap)
        self.assertIn('GAMEINFOFLAG_PREDICT_VANILLA',snap)

    def test_respawn_and_no_race_escape(self):
        text=source('src/game/server/player.cpp')
        spawn=text.split('void CPlayer::TryRespawn()',1)[1].split('m_pCharacter = new',1)[0]
        self.assertIn('IsDeathmatch() && Server()->Tick() < m_DieTick + Server()->TickSpeed() / 2',spawn)
        self.assertIn('IsDeathmatch() && State != PAUSE_NONE',text)
        self.assertIn('saved race state must never restore combat health/ammo',source('src/game/server/entities/character.cpp'))
        self.assertIn('Race teams are unavailable in Neon DM',source('src/game/server/teams.cpp'))


if __name__=='__main__':
    unittest.main()
