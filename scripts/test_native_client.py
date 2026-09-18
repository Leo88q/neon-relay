#!/usr/bin/env python3
"""Bounded fresh-profile desktop/portrait client boot and screenshot capture."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

binary = Path(sys.argv[1]).resolve(strict=True)
output = Path(sys.argv[2]); output.mkdir(parents=True, exist_ok=True)
root = Path(__file__).resolve().parent.parent
for name, width, height, page, key in [(f'{size}-{page}', width, height, page, key)
        for size, width, height in [('desktop', 1280, 800), ('portrait', 480, 900)]
        for page, key in [('store', 'c'), ('wallet', 'w'), ('settings', 's')]]:
    with tempfile.TemporaryDirectory(prefix='neonrelay-client-') as temp:
        home = Path(temp)
        (home/'storage.cfg').write_text(f'add_path {home}\nadd_path {root / "data"}\n')
        env = {k:v for k,v in os.environ.items() if not k.startswith('NEONRELAY_')}
        env.update(HOME=temp, XDG_DATA_HOME=temp, XDG_CONFIG_HOME=temp, LIBGL_ALWAYS_SOFTWARE='1')
        with (output/f'{name}.log').open('w') as log:
            process = subprocess.Popen([str(binary), 'gfx_fullscreen 0', 'gfx_vsync 0',
                f'gfx_screen_width {width}', f'gfx_screen_height {height}', 'cl_menu_map ""',
                'cl_show_welcome 0'], cwd=temp, env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic()+35
                window = None
                while time.monotonic()<deadline:
                    assert process.poll() is None, f'client exited; inspect {name}.log'
                    result = subprocess.run(['xdotool','search','--onlyvisible','--pid',str(process.pid)], capture_output=True, text=True)
                    if result.returncode == 0 and result.stdout.strip():
                        window = result.stdout.splitlines()[-1]; break
                    time.sleep(.1)
                assert window is not None, 'No visible client window'
                # Exercise responsive layout on the same real renderer.
                subprocess.run(['xdotool','windowsize',window,str(width),str(height)],check=True)
                time.sleep(3)
                assert process.poll() is None, 'client crashed while rendering'
                subprocess.run(['import','-window',window,str(output/f'{name}.png')],check=True,timeout=10)
                subprocess.run(['xdotool','windowfocus','--sync',window],check=True)
                subprocess.run(['xdotool','key',key],check=True)
                time.sleep(2)
                assert process.poll() is None, 'client crashed while opening product page'
                subprocess.run(['import','-window',window,str(output/f'{name}-page.png')],check=True,timeout=10)
                # Ask the application to close rather than leaving an orphan.
                subprocess.run(['xdotool','windowclose',window], check=False)
                try: process.wait(timeout=8)
                except subprocess.TimeoutExpired: process.terminate(); process.wait(timeout=5)
            finally:
                if process.poll() is None: process.kill(); process.wait()
        text = (output/f'{name}.log').read_text(errors='replace')
        assert 'ASSERTION' not in text and 'Segmentation fault' not in text, text[-2000:]
        assert not any("Failed to load PNG of skin" in line for line in text.splitlines()), text[-2000:]
print('PASS: full client linked and rendered desktop and portrait windows; screenshots captured')
