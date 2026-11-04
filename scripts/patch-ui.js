#!/usr/bin/env node
'use strict';
// Patches the extracted CPN IDE UI bundle (ui/main.*.js, version 1.24.1031). Idempotent.
//
// Token animation: the original draws the red token with SVG SMIL <animateMotion> in a group
// outside the diagram viewport, resets the document clock for every arc and waits 300 ms
// after each phase. The token therefore often jumps or appears off the arc. The replacement
// moves the token along the arc path itself (inside the viewport, so pan/zoom stay aligned)
// with requestAnimationFrame and an ease-in-out curve, and resolves right when it arrives.
// A timer always finishes it as well: hidden/occluded windows get no animation frames, and the
// simulation waits for this promise.

const fs = require('fs');
const path = require('path');

const MARKER = '/*cpn-mac:smooth-tokens*/';
const uiDir = path.join(__dirname, '..', 'ui');
const bundle = fs.readdirSync(uiDir).find((f) => /^main\.[0-9a-f]+\.js$/.test(f));
if (!bundle) { console.error('patch-ui: ui/main.*.js not found (run npm run fetch-ui first)'); process.exit(1); }
const file = path.join(uiDir, bundle);
let src = fs.readFileSync(file, 'utf8');

if (src.includes(MARKER)) { console.log('patch-ui: already patched'); process.exit(0); }

const drawRe = /(\w+)\.prototype\.drawArcAnimation=function\(e,t=500,n=!1\)\{[\s\S]*?\}\)\)\},(?=\1\.prototype\.createPathFromConnection=)/;
const m = src.match(drawRe);
if (!m) { console.error('patch-ui: drawArcAnimation not found (different UI version?)'); process.exit(1); }
const R = m[1];

const drawArcAnimation = `${R}.prototype.drawArcAnimation=function(e,t=500,n=!1){${MARKER}
const self=this;
return new Promise(function(done){
  try{
    const NS="http://www.w3.org/2000/svg";
    const layer=self._canvas._viewport||self._canvas.getDefaultLayer();
    if(!layer||!e.waypoints||e.waypoints.length<2||!(t>0)){done(e);return}
    const id="tokenG_"+e.id;const old=document.getElementById(id);old&&(old.__cpnFinish?old.__cpnFinish():old.remove());
    const g=document.createElementNS(NS,"g");g.setAttribute("id",id);g.setAttribute("pointer-events","none");
    const route=document.createElementNS(NS,"path");
    route.setAttribute("d",self.createPathFromConnection(e,{x:0,y:0},n).replace(/^\\s*m/,"M"));
    route.setAttribute("fill","none");route.setAttribute("stroke","none");
    const tok=document.createElementNS(NS,"g");
    const shadow=document.createElementNS(NS,"circle");
    shadow.setAttribute("r","9");shadow.setAttribute("cx","1.5");shadow.setAttribute("cy","1.5");shadow.setAttribute("fill","rgba(0,0,0,0.25)");
    const dot=document.createElementNS(NS,"circle");
    dot.setAttribute("r","9");dot.setAttribute("fill","#ff3333");dot.setAttribute("stroke","#c41d1d");dot.setAttribute("stroke-width","1");
    tok.appendChild(shadow);tok.appendChild(dot);g.appendChild(route);g.appendChild(tok);layer.appendChild(g);
    const len=route.getTotalLength();
    const ease=function(x){return .5-.5*Math.cos(Math.PI*x)};
    const raf=window.__zone_symbol__requestAnimationFrame||window.requestAnimationFrame;
    const place=function(k){const p=route.getPointAtLength(len*ease(k));tok.setAttribute("transform","translate("+p.x+","+p.y+")")};
    place(0);
    let finished=false;
    const finish=function(){if(finished)return;finished=true;g.remove();done(e)};
    g.__cpnFinish=finish;
    const t0=performance.now();
    const frame=function(){
      if(finished)return;
      if(!g.isConnected){finish();return}
      const k=Math.min(1,(performance.now()-t0)/t);place(k);
      if(k<1)raf(frame);else finish();
    };
    raf(frame);
    setTimeout(finish,t+60);
  }catch(a){console.error("CpnRenderer.prototype.drawArcAnimation(), ex = ",a);done(e)}
})},`;

src = src.replace(drawRe, drawArcAnimation);

// Single-step mode: 500 ms per firing (250 ms per arc phase) plus the removed pauses felt jumpy.
// 900 ms gives 450 ms per phase. Multi-step keeps its configured delay.
const delayOld = 'default:return 500}},e.prototype.runMultiStep=';
if (!src.includes(delayOld)) { console.error('patch-ui: getAnimationDelay not found'); process.exit(1); }
src = src.replace(delayOld, 'default:return 900}},e.prototype.runMultiStep=');

// Page switch from the project tree: the editor panel opened the page only after a fixed 1 s timeout.
const tabOld = 'this.eventService.on(yG.PAGE_TAB_OPEN,(function(t){return setTimeout((function(){return e.openModelEditor(t.pageObject).then()}),1e3)}))';
if (!src.includes(tabOld)) { console.error('patch-ui: PAGE_TAB_OPEN handler not found'); process.exit(1); }
src = src.replace(tabOld, tabOld.replace('}),1e3)', '}),0)'));

fs.writeFileSync(file, src);
console.log(`patch-ui: ${bundle} patched (token animation, page switching)`);
