const fs=require("node:fs"),path=require("node:path");
const port=Number(fs.readFileSync(path.join(process.env.APPDATA,"Antigravity","DevToolsActivePort"),"utf8").split(/\r?\n/)[0]);
(async()=>{
  const list=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t=list.find(x=>x.type==="page"&&x.url.startsWith("https://127.0.0.1"));
  const ws=new WebSocket(t.webSocketDebuggerUrl);
  let id=1; const w=new Map();
  ws.addEventListener("message",e=>{const m=JSON.parse(e.data); if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}});
  await new Promise(r=>ws.addEventListener("open",r));
  const send=(method,params={})=>new Promise(res=>{const i=id++;w.set(i,res);ws.send(JSON.stringify({id:i,method,params}))});
  const r=await send("Runtime.evaluate",{expression:`JSON.stringify({btn:!!document.getElementById('agy-usage-btn'),panel:!!document.getElementById('agy-usage-panel'),display:document.getElementById('agy-usage-panel')?.style.display,cfg:!!window.__APP_CONFIG__,text:document.getElementById('agy-usage-panel')?.innerText?.slice(0,400)})`,returnByValue:true});
  console.log(r.result?.result?.value||JSON.stringify(r));
  ws.close();
})();
