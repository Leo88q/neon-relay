#!/usr/bin/env python3
"""Actual local server + connected client captures. Not route-completion proof."""
import os,socket,subprocess,sys,tempfile,time
from pathlib import Path
root=Path(__file__).resolve().parent.parent
client,server=map(lambda p: str(Path(p).resolve()),sys.argv[1:3])
out=Path(sys.argv[3]);out.mkdir(parents=True,exist_ok=True)
names=['Neon Relay Basin','Chromatic Canyon','Vector Spire','Midnight Circuit','Aurora Ascent', 'LearnToPlay Sound']
for index,name in enumerate(names):
 with tempfile.TemporaryDirectory(prefix='neonrelay-world-') as tmp:
  home=Path(tmp)
  (home/'storage.cfg').write_text(f'add_path {home}\nadd_path {root / "data"}\n')
  (home/'autoexec_server.cfg').write_text('# isolated local visual test\n')
  env={k:v for k,v in os.environ.items() if not k.startswith('NEONRELAY_')}
  env.update(HOME=tmp,XDG_DATA_HOME=tmp,XDG_CONFIG_HOME=tmp,LIBGL_ALWAYS_SOFTWARE='1')
  with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:
   sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
  slog=home/'server.log';clog=out/f'world-{index}.log'
  processes=[]
  try:
   with slog.open('w') as sf,clog.open('w') as cf:
    sv=subprocess.Popen([server,'bindaddr 127.0.0.1',f'sv_port {port}','sv_register 0','sv_sixup 0','sv_dnsbl 0',f'sv_map "{name}"'],cwd=tmp,env=env,stdout=sf,stderr=subprocess.STDOUT);processes.append(sv)
    deadline=time.monotonic()+30
    while "server name is" not in slog.read_text(errors='replace'):
     assert sv.poll() is None, 'server exited before initialization'
     assert time.monotonic()<deadline,'server initialization timeout'
     time.sleep(.1)
    cl=subprocess.Popen([client,'gfx_fullscreen 0','gfx_vsync 0','gfx_screen_width 1280','gfx_screen_height 800','cl_show_welcome 0','stdout_output_level 1',f'connect 127.0.0.1:{port}'],cwd=tmp,env=env,stdout=cf,stderr=subprocess.STDOUT);processes.append(cl)
    deadline=time.monotonic()+45
    while 'player has entered the game' not in slog.read_text(errors='replace'):
     assert cl.poll() is None and sv.poll() is None,'process exited while joining'
     assert time.monotonic()<deadline,'client did not enter game'
     time.sleep(.1)
    result=subprocess.run(['xdotool','search','--onlyvisible','--pid',str(cl.pid)],capture_output=True,text=True,check=True)
    window=result.stdout.splitlines()[-1]
    time.sleep(2)
    subprocess.run(['import','-window',window,str(out/f'world-{index}.png')],check=True,timeout=10)
    if name == 'LearnToPlay Sound':
     # Two in-game phases plus the normal capture. Keep full native frames.
     for phase in range(2):
      time.sleep(.24)
      subprocess.run(['import','-window',window,str(out/f'learn-animation-{phase}.png')],check=True,timeout=10)
     # Inspect real render order in the previously unreadable hazard/stop sections.
     # Spectator captures are visual checks, never a claim of completing the route.
     def console(command):
      subprocess.run(['xdotool','windowfocus','--sync',window],check=True)
      subprocess.run(['xdotool','key','F1'],check=True);time.sleep(.25)
      subprocess.run(['xdotool','type','--clearmodifiers','--delay','1',command],check=True)
      subprocess.run(['xdotool','key','Return'],check=True);time.sleep(.25)
      subprocess.run(['xdotool','key','F1'],check=True);time.sleep(.4)
     console('team -1')
     for label,x,y in [('freeze-stop',188,29),('stop-floor',395,100),('rotated-stop',550,32),('teleport',310,40)]:
      console(f'set_view {x} {y}')
      time.sleep(.5)
      subprocess.run(['import','-window',window,str(out/f'learn-{label}.png')],check=True,timeout=10)

    assert cl.poll() is None,'client exited while rendering world'
    text=clog.read_text(errors='replace').lower()
    assert 'failed to load' not in text and 'invalid header' not in text,text[-1500:]
    print(f'PASS: native connected client rendered {name}')
  finally:
   for p in reversed(processes):
    if p.poll() is None:
     p.terminate()
     try:p.wait(timeout=5)
     except subprocess.TimeoutExpired:p.kill();p.wait()
