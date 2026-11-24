import os, subprocess, tempfile, pathlib, socket, signal, json, time
node=subprocess.check_output(['node','-p','process.execPath'], text=True).strip()
cli=str(pathlib.Path(__file__).resolve().parents[1] / 'dist' / 'index.js')
with tempfile.TemporaryDirectory(prefix='issue165-life-') as d:
 root=pathlib.Path(d); (root/'bin').mkdir(); home=root/'home';home.mkdir()
 fake=root/'fake.cjs';fake.write_text('const http=require("http");require("fs").writeFileSync(process.env.HOME+"/launcher-pid",String(process.pid));const port=Number(process.argv.find(x=>x.startsWith("--port=")).split("=")[1]); const s=http.createServer((q,r)=>{r.setHeader("content-type","application/json");r.end(JSON.stringify(q.url==="/ready"?{ready:true}:{status:"ok",model:"fixture",vectorDimension:256,ready:true}));});s.listen(port,"127.0.0.1");process.on("SIGTERM",()=>s.close(()=>process.exit(0)));')
 uv=root/'bin'/'uv'; uv.write_text(f'#!/bin/sh\nexec "{node}" "{fake}" "$@"\n');uv.chmod(0o755)
 env=dict(os.environ,HOME=str(home),PATH=str(root/'bin')+os.pathsep+os.environ['PATH'])
 with socket.socket() as s:s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
 def run(*args):
  p=subprocess.run([node,cli,'embedding',*args],env=env,text=True,capture_output=True,timeout=30)
  print(args,'exit',p.returncode, (p.stdout+p.stderr).strip().replace('\n',' | '),flush=True)
  return p
 pid=None
 try:
  for iteration in range(2):
   p=run('start','--port',str(port),'--ready-timeout','10000'); assert p.returncode==0
   state=json.loads((home/'.search-docs'/'embedding.pid').read_text());pid=state['pid']; os.kill(pid,0); print('running pid',pid,flush=True)
   p=run('stop'); assert p.returncode==0; pid=None
 finally:
  marker=home/'launcher-pid'
  if not pid and marker.exists() and marker.read_text().strip(): pid=int(marker.read_text())
  if pid:
   try:
    if os.getpgid(pid)==pid: os.killpg(pid,signal.SIGTERM)
   except ProcessLookupError:pass
