#!/usr/bin/env python3
"""Native mouse-click test of the real lobby/local-server path (Linux/Xvfb).

Tests occupied port refusal, actual map verification/join, explicit stop and
relaunch. Does not pretend to exercise Android/Mac process launching.
"""
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time

ROOT=Path(__file__).resolve().parent.parent


def main():
    binary=str(Path(sys.argv[1]).resolve(strict=True))
    out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='warmup-lobby-') as tmp:
        home=Path(tmp)
        (home/'storage.cfg').write_text(f'add_path {home}\nadd_path {ROOT / "data"}\n')
        for filename in ('autoexec.cfg','autoexec_server.cfg'):
            (home/filename).write_text('# Isolated native lobby test\n')
        env={k:v for k,v in os.environ.items() if not k.startswith('NEONRELAY_')}
        env.update(HOME=tmp,XDG_CONFIG_HOME=tmp,XDG_DATA_HOME=tmp,LIBGL_ALWAYS_SOFTWARE='1')
        raw=home/'combined.log'
        blocker=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
        blocker.bind(('127.0.0.1',8305));blocker.setblocking(False)
        proc=None
        def text():return raw.read_text(errors='replace')
        def wait(predicate,seconds,label):
            deadline=time.monotonic()+seconds
            while not predicate():
                assert proc.poll() is None,'client exited: '+label
                assert time.monotonic()<deadline,'timeout: '+label
                time.sleep(.1)
        def tool(*args):return subprocess.run(list(args),capture_output=True,text=True,check=True,timeout=10)
        try:
            with raw.open('w') as log:
                proc=subprocess.Popen([binary,'gfx_fullscreen 0','gfx_vsync 0',
                    'gfx_screen_width 1280','gfx_screen_height 800','cl_menu_map ""',
                    'cl_show_welcome 0','player_name LobbyProbe','stdout_output_level 1'],
                    cwd=tmp,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                window=None
                def window_ready():
                    nonlocal window
                    result=subprocess.run(['xdotool','search','--onlyvisible','--pid',str(proc.pid)],capture_output=True,text=True)
                    if result.returncode==0 and result.stdout.strip():
                        window=result.stdout.splitlines()[-1]
                    return window is not None
                wait(window_ready,40,'client window')
                tool('xdotool','windowfocus','--sync',window)
                time.sleep(3)
                tool('xdotool','key','p');time.sleep(1)
                tool('import','-window',window,str(out/'warmup-lobby-card.png'))
                # Real UI units: screen.h=600, outer margin=10, tab bar=44,
                # desktop content margin=24, title=42, currency tabs=44,
                # gap=12, card=164, padding=12, button=40.
                button_y=round((10+44+24+42+44+12+164-12-20)*800/600)
                def click():
                    tool('xdotool','mousemove','--window',window,'640',str(button_y))
                    tool('xdotool','click','1')
                click();time.sleep(2)
                assert 'verified course=warmup' not in text()
                children=Path(f'/proc/{proc.pid}/task/{proc.pid}/children').read_text().strip()
                assert not children,'occupied port must not spawn a child server'
                try:
                    blocker.recvfrom(1500)
                    raise AssertionError('occupied port must not receive a connect attempt')
                except BlockingIOError:
                    pass
                tool('import','-window',window,str(out/'warmup-lobby-busy.png'))
                tool('xdotool','key','Return');time.sleep(.5)
                blocker.close()
                click()
                wait(lambda:'verified course=warmup map=Neon Relay Warmup' in text(),45,'verified Warmup connection')
                wait(lambda:'player has entered the game' in text(),30,'player enters the launched server')
                time.sleep(2)
                tool('import','-window',window,str(out/'warmup-lobby-connected.png'))
                def console(command):
                    tool('xdotool','key','F1');time.sleep(.3)
                    tool('xdotool','type','--clearmodifiers','--delay','1',command)
                    tool('xdotool','key','Return');time.sleep(.3)
                    tool('xdotool','key','F1');time.sleep(.5)
                console('disconnect')
                click();time.sleep(.5)
                def port_available():
                    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:
                        try:sock.bind(('127.0.0.1',8305))
                        except OSError:return False
                        return True
                wait(port_available,10,'explicit Stop practice server releases port')
                click()
                wait(lambda:text().count('verified course=warmup map=Neon Relay Warmup')==2,45,'relaunch from card')
                wait(lambda:text().count('player has entered the game')>=2,30,'rejoined launched server')
                # Native shutdown must clean up its owned child, not the test runner.
                tool('xdotool','key','F1');time.sleep(.3)
                tool('xdotool','type','--clearmodifiers','quit');tool('xdotool','key','Return')
                proc.wait(timeout=15)
                assert port_available(),'client exit left its practice server running'
                print('::notice title=Warmup lobby::PASS: native card click, busy-port refusal, verified map join, stop, relaunch, child cleanup')
        finally:
            blocker.close()
            if proc is not None:
                try:os.killpg(proc.pid,signal.SIGTERM)
                except ProcessLookupError:pass
                try:proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid,signal.SIGKILL);proc.wait()
            if raw.exists():
                safe='\n'.join(line for line in text().splitlines() if not any(word in line.lower() for word in ('password','auth_add','rcon_auth')))
                (out/'warmup-lobby.log').write_text(safe+'\n')
                print(safe[-3500:])


if __name__=='__main__':main()
