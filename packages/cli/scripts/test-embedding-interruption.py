import os, subprocess, tempfile, time, signal, pathlib, socket

# Run after `pnpm run build:fast`; uses only isolated processes and temporary state.
node = subprocess.check_output(['node','-p','process.execPath'], text=True).strip()
cli = str(pathlib.Path(__file__).resolve().parents[1] / 'dist' / 'index.js')
with tempfile.TemporaryDirectory(prefix='issue165-') as tmp:
    root = pathlib.Path(tmp)
    (root/'bin').mkdir()
    uv = root/'bin'/'uv'
    uv.write_text('#!/bin/sh\necho $$ > "$HOME/launcher-pid"\nexec /bin/sleep 60\n')
    uv.chmod(0o755)
    other = subprocess.Popen([node, '-e', "require('http').createServer((q,r)=>r.end('ok')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], start_new_session=True, stdout=subprocess.PIPE, text=True)
    other_port = int(other.stdout.readline())
    print('unrelated HTTP server', other.pid, 'port', other_port, flush=True)
    try:
      for sig in (signal.SIGINT, signal.SIGTERM):
          for attempt in range(2):
              home = root/f'{sig.name}-{attempt}'; home.mkdir()
              env = dict(os.environ, HOME=str(home), PATH=str(root/'bin')+os.pathsep+os.environ['PATH'])
              with socket.socket() as s:
                  s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
              p = subprocess.Popen([node,cli,'embedding','start','--port',str(port),'--ready-timeout','30000'],env=env,preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
              marker=home/'launcher-pid'
              try:
                  deadline=time.monotonic()+10
                  while (not marker.exists() or not marker.read_text().strip()) and p.poll() is None and time.monotonic()<deadline: time.sleep(.02)
                  if not marker.exists() or not marker.read_text().strip():
                      raise RuntimeError('launcher PID was not observed')
                  child=int(marker.read_text()); pgid=os.getpgid(child)
                  assert child == pgid and child != os.getpgrp()
                  time.sleep(.02 if attempt == 0 else 1); os.kill(p.pid,sig); p.wait(timeout=5); time.sleep(.3)
                  try: os.kill(child,0); alive=True
                  except ProcessLookupError: alive=False
                  print(sig.name, attempt, 'cli',p.pid,'launcher',child,'pgid',pgid,'exit',p.returncode,'alive',alive,'unrelated alive',other.poll() is None,flush=True)
                  assert p.returncode == (130 if sig == signal.SIGINT else 143) and not alive
                  assert other.poll() is None
              finally:
                  if p.poll() is None: p.kill(); p.wait()
                  if marker.exists() and marker.read_text().strip():
                      child=int(marker.read_text())
                      try:
                          if os.getpgid(child)==child and child != os.getpgrp(): os.killpg(child, signal.SIGTERM)
                      except ProcessLookupError: pass
    finally:
      other.terminate(); other.wait()
