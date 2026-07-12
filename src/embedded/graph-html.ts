// Render an accessible knowledge graph to ONE self-contained, interactive HTML file - Chitta's
// shareable "here's what your agent remembers about you" artifact. No servers, no CDN, no build:
// open the file in any browser. Force-directed canvas, nodes colored by entity type and sized by
// degree, drag / zoom / hover-to-highlight / search. Everything (data + JS + CSS) is inlined, so
// the file works offline and is safe to commit, screenshot, or share.

export interface GraphHtmlInput {
  entities: Array<{ id: string; label: string; type: string }>
  relations: Array<{ from: string; to: string; type: string; weight?: number }>
}

/** Fixed colors for common entity types; anything else is hashed to a stable hue (see `hueOf`). */
const TYPE_COLORS: Record<string, string> = {
  PERSON: "#ff6b6b", ORG: "#4dabf7", ORGANIZATION: "#4dabf7", COMPANY: "#4dabf7",
  PROJECT: "#ffd43b", TECH: "#63e6be", TECHNOLOGY: "#63e6be", TOOL: "#63e6be",
  PLACE: "#da77f2", LOCATION: "#da77f2", CONCEPT: "#adb5bd", EVENT: "#ffa94d",
  PRODUCT: "#74c0fc", DATE: "#8ce99a", ROLE: "#e599f7", TOPIC: "#ffc078",
}

const hueOf = (t: string): number => {
  let h = 0
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 360
  return h
}
const colorOf = (t: string): string => TYPE_COLORS[t] ?? `hsl(${hueOf(t)} 60% 62%)`
const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string)

/** Build a standalone interactive HTML page for a knowledge graph. Pure function - no I/O. */
export function renderGraphHtml(graph: GraphHtmlInput, opts: { title?: string } = {}): string {
  const title = opts.title ?? "Chitta memory graph"

  // Degree from relations; keep entities that participate in ≥1 relation (a real graph). If there
  // are no relations at all, fall back to showing every entity so the page is never blank.
  const deg = new Map<string, number>()
  for (const r of graph.relations) {
    deg.set(r.from, (deg.get(r.from) ?? 0) + 1)
    deg.set(r.to, (deg.get(r.to) ?? 0) + 1)
  }
  const ents = graph.relations.length > 0 ? graph.entities.filter((e) => deg.has(e.id)) : graph.entities
  const index = new Map(ents.map((e, i) => [e.id, i]))
  const nodes = ents.map((e) => ({ l: e.label, t: (e.type || "CONCEPT").toUpperCase(), d: deg.get(e.id) ?? 0 }))
  const links = graph.relations
    .filter((r) => index.has(r.from) && index.has(r.to))
    .map((r) => ({ s: index.get(r.from) as number, t: index.get(r.to) as number, w: r.weight ?? 1 }))
  const types = [...new Set(nodes.map((n) => n.t))].sort()

  // JSON is injected into a <script>; escape "<" so a value can never break out of the tag.
  const json = JSON.stringify({ nodes, links, colors: TYPE_COLORS }).replace(/</g, "\\u003c")
  const legend = types
    .map((t) => `<span><i style="background:${colorOf(t)}"></i>${esc(t)}</span>`)
    .join("")
  const sub = `${nodes.length} concepts · ${links.length} relationships`

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)} · Chitta</title>
<style>
:root{color-scheme:dark}
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden;background:#0a0e14;color:#e7e9ea;
 font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
#hud{position:fixed;top:0;left:0;right:0;padding:14px 18px;display:flex;align-items:center;gap:12px;z-index:5;pointer-events:none}
#hud .t{font-weight:700;font-size:16px}
#hud .s{color:#71767b;font-size:12px}
#hud .brand{color:#71767b;font-size:12px}
#search{margin-left:auto;pointer-events:auto;background:#161b22;border:1px solid #2f3336;color:#e7e9ea;
 border-radius:8px;padding:7px 11px;width:210px;outline:none;font-size:13px}
#search:focus{border-color:#1d9bf0}
#legend{position:fixed;left:18px;bottom:16px;display:flex;flex-wrap:wrap;gap:6px 14px;max-width:62%;font-size:12px;color:#9aa4ae;z-index:5}
#legend span{display:inline-flex;align-items:center;gap:6px}
#legend i{width:10px;height:10px;border-radius:50%;display:inline-block}
#tip{position:fixed;padding:6px 9px;background:#161b22;border:1px solid #2f3336;border-radius:7px;
 font-size:12px;pointer-events:none;opacity:0;transition:opacity .12s;z-index:6;white-space:nowrap}
#foot{position:fixed;right:16px;bottom:14px;color:#5b6169;font-size:11px;z-index:5}
#empty{position:fixed;inset:0;display:none;place-items:center;text-align:center;color:#71767b;z-index:4}
canvas{display:block;cursor:grab}
canvas:active{cursor:grabbing}
</style></head><body>
<div id="hud"><span class="t">${esc(title)}</span><span class="s">${sub}</span>
 <input id="search" placeholder="search concepts…" autocomplete="off" spellcheck="false"/></div>
<div id="legend">${legend}</div>
<div id="foot">drag · scroll to zoom · hover to focus · made by Chitta</div>
<div id="empty">No connected concepts yet - remember a few things, then regenerate.</div>
<canvas id="c"></canvas>
<div id="tip"></div>
<script>var DATA=${json};</script>
<script>
(function(){
var d=DATA, cv=document.getElementById('c'), ctx=cv.getContext('2d');
var dpr=Math.max(1,window.devicePixelRatio||1), W=0,H=0;
function resize(){W=innerWidth;H=innerHeight;cv.width=W*dpr;cv.height=H*dpr;cv.style.width=W+'px';cv.style.height=H+'px';ctx.setTransform(dpr,0,0,dpr,0,0);}
addEventListener('resize',resize);resize();
if(!d.nodes.length){document.getElementById('empty').style.display='grid';return;}
var R=Math.min(W,H)*0.42;
var N=d.nodes.map(function(n,i){return {l:n.l,t:n.t,deg:n.d,i:i,x:(Math.random()-0.5)*R,y:(Math.random()-0.5)*R,vx:0,vy:0,fixed:false};});
var L=d.links;
var adj=N.map(function(){return new Set();});
for(var li=0;li<L.length;li++){adj[L[li].s].add(L[li].t);adj[L[li].t].add(L[li].s);}
var maxDeg=1;for(var i=0;i<N.length;i++)maxDeg=Math.max(maxDeg,N[i].deg);
var degSorted=N.map(function(n){return n.deg;}).sort(function(a,b){return b-a;});
var hubCut=degSorted[Math.min(degSorted.length-1,11)]||1e9;
function rad(n){return 4+9*Math.sqrt(n.deg/maxDeg);}
function colorOf(t){return d.colors[t]||('hsl('+hue(t)+' 60% 62%)');}
function hue(t){var h=0;for(var k=0;k<t.length;k++)h=(h*31+t.charCodeAt(k))%360;return h;}
var scale=0.85,ox=W/2,oy=H/2,fit=true;
function sx(x){return x*scale+ox;} function sy(y){return y*scale+oy;}
function fitView(){var mnx=1e9,mny=1e9,mxx=-1e9,mxy=-1e9;for(var i=0;i<N.length;i++){var n=N[i];if(n.x<mnx)mnx=n.x;if(n.x>mxx)mxx=n.x;if(n.y<mny)mny=n.y;if(n.y>mxy)mxy=n.y;}var bw=(mxx-mnx)||1,bh=(mxy-mny)||1,pad=200,topM=76,botM=66,avH=Math.max(140,H-topM-botM);var ts=Math.min((W-pad)/bw,avH/bh);ts=Math.max(0.12,Math.min(2.4,ts));var cx=(mnx+mxx)/2,cy=(mny+mxy)/2;scale+=(ts-scale)*0.14;ox+=((W/2-cx*ts)-ox)*0.14;oy+=((topM+avH/2-cy*ts)-oy)*0.14;}
var alpha=1;
function step(){
 var rep=2400;
 for(var a=0;a<N.length;a++){var na=N[a],fx=0,fy=0;
  for(var b=0;b<N.length;b++){if(a===b)continue;var nb=N[b];var dx=na.x-nb.x,dy=na.y-nb.y;var d2=dx*dx+dy*dy+0.01;var dd=Math.sqrt(d2);var f=rep/d2;fx+=dx/dd*f;fy+=dy/dd*f;}
  fx+=-na.x*0.011;fy+=-na.y*0.011;
  na.vx=(na.vx+fx*alpha)*0.82;na.vy=(na.vy+fy*alpha)*0.82;}
 for(var l=0;l<L.length;l++){var A=N[L[l].s],B=N[L[l].t];var dx2=B.x-A.x,dy2=B.y-A.y;var dl=Math.sqrt(dx2*dx2+dy2*dy2)||1;var f2=(dl-95)*0.02*alpha;var ux=dx2/dl,uy=dy2/dl;A.vx+=ux*f2;A.vy+=uy*f2;B.vx-=ux*f2;B.vy-=uy*f2;}
 for(var n=0;n<N.length;n++){if(N[n].fixed)continue;N[n].x+=N[n].vx;N[n].y+=N[n].vy;}
 if(alpha>0.03)alpha*=0.994;
}
var hover=-1,q='';
function draw(){
 ctx.clearRect(0,0,W,H);
 ctx.lineWidth=1;
 for(var l=0;l<L.length;l++){var A=N[L[l].s],B=N[L[l].t];var hl=hover>=0&&(L[l].s===hover||L[l].t===hover);
  ctx.strokeStyle=hl?'rgba(29,155,240,0.55)':'rgba(120,132,145,0.12)';
  ctx.beginPath();ctx.moveTo(sx(A.x),sy(A.y));ctx.lineTo(sx(B.x),sy(B.y));ctx.stroke();}
 for(var i=0;i<N.length;i++){var n=N[i];var X=sx(n.x),Y=sy(n.y);var r=rad(n)*Math.max(0.6,Math.min(scale,1.7));
  var match=q&&n.l.toLowerCase().indexOf(q)>=0;
  var near=hover<0||n.i===hover||adj[hover].has(n.i);
  ctx.globalAlpha=(hover<0&&!q)?1:((near||match)?1:0.13);
  ctx.beginPath();ctx.arc(X,Y,r,0,6.2832);ctx.fillStyle=colorOf(n.t);ctx.fill();
  if(match){ctx.lineWidth=2;ctx.strokeStyle='#fff';ctx.stroke();ctx.lineWidth=1;}
  if(N.length<=45||n.deg>=hubCut||n.i===hover||match){ctx.globalAlpha=(near||match)?0.98:0.16;ctx.fillStyle='#e7e9ea';ctx.font='12px -apple-system,system-ui,sans-serif';ctx.shadowColor='#0a0e14';ctx.shadowBlur=4;ctx.fillText(n.l,X+r+4,Y+4);ctx.shadowBlur=0;}
 }
 ctx.globalAlpha=1;
}
function loop(){step();if(fit)fitView();draw();requestAnimationFrame(loop);}loop();
function pick(px,py){var best=-1,bd=1e9;for(var i=0;i<N.length;i++){var X=sx(N[i].x),Y=sy(N[i].y);var r=rad(N[i])+5;var dx=X-px,dy=Y-py;var dd=dx*dx+dy*dy;if(dd<r*r&&dd<bd){bd=dd;best=i;}}return best;}
var drag=-1,pan=false,lx=0,ly=0,tip=document.getElementById('tip');
cv.addEventListener('mousedown',function(e){fit=false;var i=pick(e.offsetX,e.offsetY);if(i>=0){drag=i;N[i].fixed=true;}else{pan=true;}lx=e.offsetX;ly=e.offsetY;});
addEventListener('mousemove',function(e){var px=e.offsetX,py=e.offsetY;
 if(drag>=0){N[drag].x=(px-ox)/scale;N[drag].y=(py-oy)/scale;alpha=Math.max(alpha,0.35);}
 else if(pan){ox+=px-lx;oy+=py-ly;lx=px;ly=py;}
 else{var i=pick(px,py);hover=i;if(i>=0){tip.style.opacity=1;tip.style.left=(e.clientX+13)+'px';tip.style.top=(e.clientY+13)+'px';tip.textContent=N[i].l+'  ·  '+N[i].t+'  ·  '+N[i].deg+(N[i].deg===1?' link':' links');}else{tip.style.opacity=0;}}});
addEventListener('mouseup',function(){if(drag>=0)N[drag].fixed=false;drag=-1;pan=false;});
cv.addEventListener('wheel',function(e){e.preventDefault();fit=false;var wx=(e.offsetX-ox)/scale,wy=(e.offsetY-oy)/scale;scale*=Math.exp(-e.deltaY*0.0011);scale=Math.max(0.15,Math.min(4,scale));ox=e.offsetX-wx*scale;oy=e.offsetY-wy*scale;},{passive:false});
document.getElementById('search').addEventListener('input',function(e){q=e.target.value.trim().toLowerCase();});
})();
</script>
</body></html>`
}
