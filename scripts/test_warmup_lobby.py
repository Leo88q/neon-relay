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
    data=Path(binary).parent/'data'
    assert (data/'maps/Neon Relay Warmup.map').is_file(),'Warmup missing from built data bundle'
    with tempfile.TemporaryDirectory(prefix='warmup-lobby-') as tmp:
        home=Path(tmp)
        (home/'storage.cfg').write_text(f'add_path {home}\nadd_path {data}\n')
        for filename in ('autoexec.cfg','autoexec_server.cfg'):
            (home/filename).write_text('# Isolated native lobby test\n')
        env={k:v for k,v in os.environ.items() if not k.startswith('NEONRELAY_')}
        env.update(HOME=tmp,XDG_CONFIG_HOME=tmp,XDG_DATA_HOME=tmp,LIBGL_ALWAYS_SOFTWARE='1',SDL_MOUSE_RELATIVE_MODE_WARP='1')
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
                    'cl_show_welcome 0','player_name LobbyProbe','stdout_output_level 1',
                    'ui_mousesens 100','cl_skip_start_menu 1','debug 1','snd_enable 0'],
                    cwd=tmp,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                window=None
                def window_ready():
                    nonlocal window
                    result=subprocess.run(['xdotool','search','--onlyvisible','--pid',str(proc.pid)],capture_output=True,text=True)
                    if result.returncode==0 and result.stdout.strip():
                        window=result.stdout.splitlines()[-1]
                    return window is not None
                wait(window_ready,40,'client window')
                tool('xdotool','windowsize',window,'1280','800')
                tool('xdotool','windowfocus','--sync',window)
                time.sleep(3)
                tool('import','-window',window,str(out/'warmup-lobby-card.png'))
                def move_then_click(px,py):
                    # The game uses a virtual relative mouse, not the OS cursor.
                    # Clamp that cursor to the top-left, then move in window pixels.
                    for _ in range(5):
                        tool('xdotool','mousemove_relative','--','-300','-300')
                        time.sleep(.1)
                    dx,dy=px,py
                    while dx or dy:
                        sx,sy=min(dx,80),min(dy,80)
                        tool('xdotool','mousemove_relative','--',str(sx),str(sy))
                        dx-=sx;dy-=sy
                        time.sleep(.1)
                    time.sleep(.2)
                    # CUi samples held mouse state once per frame. A synthetic
                    # press+release in one X11 batch can disappear between frames.
                    tool('xdotool','mousedown','1')
                    time.sleep(.2)
                    tool('xdotool','mouseup','1')
                # Measure the launch button instead of recomputing the whole vertical stack
                # (margin, tab bar, title, currency tabs, gap, card, padding) in numbers that rot
                # whenever the lobby gains a row: any click while the card is visible makes the
                # client log its real rect in UI units, which we then scale 600 -> 800 window px.
                def click():
                    move_then_click(button_px[0],button_px[1])
                button_px=(640,400)
                move_then_click(6,794)  # dead corner: no button there, only the log we want
                def measured():
                    import re as _re
                    matches=_re.findall(r'practice-ui: click=\([^)]*\) button=\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)',text())
                    if not matches:return False
                    x,y,w,h=(float(v) for v in matches[-1])
                    assert w>40 and h>10,f'launch button rect makes no sense: {(x,y,w,h)}'
                    nonlocal button_px
                    button_px=(round((x+w/2)*800/600),round((y+h/2)*800/600))
                    return True
                wait(measured,5,'client logs the launch button rect')
                def launched():return 'launch requested course=warmup' in text()
                probe_deadline=time.monotonic()+1  # the measuring click may itself have hit the button
                while not launched() and time.monotonic()<probe_deadline:
                    time.sleep(.1)
                if not launched():
                    click()
                    wait(launched,5,'card click reaches launch handler')
                time.sleep(1)
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


if __name__=='__main__':
    try:main()
    except Exception as error:
        message=str(error).replace('%','%25').replace('\r','%0D').replace('\n','%0A')
        print('::error title=Warmup lobby test::'+message,flush=True)
        raise
