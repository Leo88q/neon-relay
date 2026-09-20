#!/usr/bin/env python3
"""Compile actual CCharacterCore/CCollision and run against exported map records.

No replacement physics. The IMap adapter supplies raw Game/Tele records read
independently from the shipped file. This is NOT a linked server race test.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess
import tempfile
from datafile_v4 import read

ROOT=Path(__file__).resolve().parent.parent


def fixture(path, destination):
    raw=read(path)
    layers={p[6]:list(p) for _,p in raw.items[5] if p[1]==2 and p[6]}
    assert set(layers)=={1,2}, 'harness supports Game + Tele only'
    game,tele=layers[1],layers[2]
    data=bytearray(raw.raws[game[14]])
    blocks=[data,raw.raws[tele[18]]]
    game[14]=0;tele[18]=1
    def array(kind,name,values):return f'std::vector<{kind}> {name}={{'+','.join(map(str,values))+'};\n'
    destination.write_text(array('int','GameItem',game)+array('int','TeleItem',tele)+
        array('unsigned char','GameData',blocks[0])+array('unsigned char','TeleData',blocks[1]))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report',type=Path)
    parser.add_argument('--sanitize',action='store_true')
    args=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='warmup-core-') as tmp:
        tmp=Path(tmp);(tmp/'generated').mkdir()
        with (tmp/'generated/protocol.h').open('w') as output:
            subprocess.run(['python3','datasrc/compile.py','network_header'],cwd=ROOT,stdout=output,check=True)
        header=tmp/'warmup_fixture.h'
        fixture(ROOT/'data/maps/Neon Relay Warmup.map',header)
        executable=tmp/'warmup-core'
        command=[os.environ.get('CXX','g++'),'-std=c++20','-O0' if args.sanitize else '-O1','-g','-ffunction-sections','-fdata-sections',
            '-Isrc','-I'+str(tmp),'tests/warmup/physics.cpp',
            'src/game/gamecore.cpp','src/game/collision.cpp','src/game/layers.cpp',
            'src/game/teamscore.cpp','src/game/prng.cpp','src/base/mem.cpp',
            '-Wl,--gc-sections','-o',str(executable)]
        if args.sanitize:command[1:1]=['-fsanitize=address,undefined','-fno-omit-frame-pointer']
        subprocess.run(command,cwd=ROOT,check=True,timeout=180)
        run_env={**os.environ,'UBSAN_OPTIONS':'halt_on_error=1:print_stacktrace=1','ASAN_OPTIONS':'detect_leaks=1:halt_on_error=1'}
        positive=subprocess.run([str(executable)],env=run_env,capture_output=True,text=True,timeout=30)
        print(positive.stdout,end='')
        assert positive.returncode==0,positive.stderr
        assert not positive.stderr.strip(),positive.stderr
        result=json.loads(next(line[7:] for line in positive.stdout.splitlines() if line.startswith('RESULT ')))
        controls=[]
        for flag,message in [('--no-hook','hook attachment'),('--no-finish','start/finish')]:
            negative=subprocess.run([str(executable),flag],env=run_env,capture_output=True,text=True,timeout=30)
            assert negative.returncode!=0 and message in negative.stderr,negative.stdout+negative.stderr
            controls.append(flag)
            print(f'PASS: {flag} negative control rejected')
        report={
            'map':'data/maps/Neon Relay Warmup.map',
            'sha256':hashlib.sha256((ROOT/'data/maps/Neon Relay Warmup.map').read_bytes()).hexdigest(),
            'method':'Unmodified CCharacterCore, CCollision, CLayers and CTeamsCore; raw-record IMap adapter',
            'compiler':subprocess.check_output([command[0],'--version'],text=True).splitlines()[0],
            'sanitizers':args.sanitize,
            'native_core':result,'negative_controls_rejected':controls,
            'server_race_completion_verified':False,
            'server_checkpoint_relocation_verified':False,
            'manual_client_playthrough_verified':False,
        }
        if args.report:
            args.report.parent.mkdir(parents=True,exist_ok=True)
            args.report.write_text(json.dumps(report,indent=2)+'\n')


if __name__=='__main__':main()
