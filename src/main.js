import { initializeApp } from "firebase/app";
import { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache, doc, collection, setDoc, deleteDoc, onSnapshot } from "firebase/firestore";
import { FIREBASE_CONFIG } from "./firebase-config.js";



/* ---------- datas ---------- */
const pad = n => String(n).padStart(2,"0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parse = s => { const [y,m,d] = s.split("-").map(Number); return new Date(y, m-1, d); };
const addDays = (s,n) => { const d = parse(s); d.setDate(d.getDate()+n); return ymd(d); };
const todayS = () => ymd(new Date());
const dow = s => parse(s).getDay();
const mondayOf = s => addDays(s, -((dow(s)+6)%7));
const diff = (a,b) => Math.round((parse(b)-parse(a))/86400000);
const DIAS = ["Domingo","Segunda","Terça","Quarta","Quinta","Sexta","Sábado"];
const D3 = ["DOM","SEG","TER","QUA","QUI","SEX","SÁB"];
const D1 = ["D","S","T","Q","Q","S","S"];
const MES = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
const fmt = s => { const d = parse(s); return `${d.getDate()} ${MES[d.getMonth()]}`; };
const fmtDay = (s, today) => {
  const k = diff(today, s);
  if (k === 0) return "Hoje"; if (k === 1) return "Amanhã"; if (k === -1) return "Ontem";
  if (k > 1 && k < 7) return DIAS[dow(s)];
  return `${D3[dow(s)].charAt(0)+D3[dow(s)].slice(1).toLowerCase()} ${fmt(s)}`;
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2,8);
const clone = o => JSON.parse(JSON.stringify(o));

/* ---------- estado ---------- */
const DEFAULT_CATS = [
  {id:"tecnico", name:"Técnico", slot:1},
  {id:"carta", name:"Carta", slot:2},
  {id:"projetos", name:"Projetos", slot:3},
  {id:"gym", name:"Gym", slot:4},
  {id:"namorada", name:"Namorada", slot:5},
  {id:"familia", name:"Família", slot:6},
  {id:"descanso", name:"Descanso", slot:7},
];
const S = {
  items: new Map(), cats: clone(DEFAULT_CATS), loaded:false,
  view:"hoje", listTab:"task", listCat:"all", period:30, showMore:{}, lastCat:"tecnico"
};
const FB = {app:null, auth:null, db:null, uid:null, email:"", unsub:[]};
let writable = true;

const catOf = id => S.cats.find(c => c.id === id) || {id:"", name:"Sem categoria", slot:0};
const ccStyle = id => { const c = catOf(id); return c.slot ? `--cc:var(--c${c.slot})` : ""; };
const all = kind => [...S.items.values()].filter(i => i.kind === kind);

/* ---------- regras de estado ---------- */
function taskStatus(t, today){
  if (t.status === "done") return "done";
  if (t.status === "missed") return "missed";
  if (t.date && t.date < today) return "auto";
  return "pending";
}
function habitActive(h, d){ return d >= h.start && (!h.end || d <= h.end); }
function scheduled(h, d){ return h.mode === "days" && habitActive(h,d) && (h.days||[]).includes(dow(d)); }
function habitStatusOn(h, d, today){
  if (!scheduled(h,d)) return null;
  const v = h.log && h.log[d];
  if (v) return v;
  return d < today ? "auto" : "pending";
}
function weekDone(h, monday, today){
  let c = 0;
  for (let i=0;i<7;i++){ const d = addDays(monday,i); if (d > today) break; if (habitActive(h,d) && h.log && h.log[d] === "done") c++; }
  return c;
}
function weekTarget(h, monday){
  let avail = 0; for (let i=0;i<7;i++){ if (habitActive(h, addDays(monday,i))) avail++; }
  return Math.min(h.perWeek||1, avail);
}
function goalStatus(g, today){
  if (g.status === "missed") return "missed";
  if (g.status === "done") return "done";
  if (g.deadline && g.deadline < today) return "auto";
  return "active";
}
const goalProgress = g => g.steps && g.steps.length ? g.steps.filter(s=>s.done).length / g.steps.length : (goalStatus(g, todayS())==="done"?1:0);

/* eventos: cada ocorrência que conta para as estatísticas */
function events(from, to){
  const today = todayS(); if (to > today) to = today;
  const out = [];
  if (from > to) return out;
  for (const t of all("task")){
    const st = taskStatus(t, today);
    let d = t.date;
    if (st === "done" && t.doneOn && (!d || t.doneOn < d)) d = t.doneOn;
    if (!d) continue;
    if (d < from || d > to) continue;
    out.push({d, st: st === "auto" ? "missed" : st, cat:t.cat, id:t.id, kind:"task"});
  }
  for (const h of all("habit")){
    if (h.mode === "days"){
      let d = from < h.start ? h.start : from;
      const end = h.end && h.end < to ? h.end : to;
      for (; d <= end; d = addDays(d,1)){
        const st = habitStatusOn(h,d,today); if (!st) continue;
        out.push({d, st: st === "auto" ? "missed" : st, cat:h.cat, id:h.id, kind:"habit"});
      }
    } else {
      let m = mondayOf(from < h.start ? h.start : from);
      const end = h.end && h.end < to ? h.end : to;
      for (; m <= end; m = addDays(m,7)){
        const target = weekTarget(h, m); if (!target) continue;
        const doneDays = [];
        for (let i=0;i<7;i++){ const d = addDays(m,i); if (d > today) break; if (habitActive(h,d) && h.log && h.log[d]==="done") doneDays.push(d); }
        doneDays.slice(0,target).forEach(d => { if (d>=from && d<=to) out.push({d, st:"done", cat:h.cat, id:h.id, kind:"habit"}); });
        const sun = addDays(m,6);
        const closeDay = h.end && h.end < sun ? h.end : sun;
        if (closeDay < today && closeDay >= from && closeDay <= to){
          const miss = target - Math.min(doneDays.length, target);
          for (let k=0;k<miss;k++) out.push({d:closeDay, st:"missed", cat:h.cat, id:h.id, kind:"habit"});
        }
      }
    }
  }
  return out;
}
function earliest(){
  let e = todayS();
  for (const i of S.items.values()){
    const d = i.kind==="habit" ? i.start : i.kind==="task" ? (i.date || i.doneOn) : null;
    if (d && d < e) e = d;
  }
  return e;
}
function byDay(evs){
  const m = new Map();
  for (const e of evs){ let r = m.get(e.d); if (!r){ r={done:0,missed:0,pending:0}; m.set(e.d,r); } r[e.st]++; }
  return m;
}
function streaks(){
  const today = todayS(), from = earliest();
  const m = byDay(events(from, today));
  let cur = 0;
  for (let d = today, n=0; d >= from && n < 800; d = addDays(d,-1), n++){
    const r = m.get(d); if (!r) continue;
    if (r.missed) break;
    if (r.pending) continue;
    if (r.done) cur++;
  }
  let best = 0, run = 0;
  for (let d = from; d <= today; d = addDays(d,1)){
    const r = m.get(d); if (!r) continue;
    if (r.missed){ run = 0; continue; }
    if (r.pending) continue;
    if (r.done){ run++; if (run>best) best=run; }
  }
  return {cur, best};
}

/* ---------- escrita (Firestore) ---------- */
function body(item){ const b = clone(item); delete b.id; return b; }
function saveItem(item){
  S.items.set(item.id, item); render();
  if (!FB.uid) return;
  setDoc(doc(FB.db, "users", FB.uid, "items", item.id), body(item)).catch(writeError);
}
function deleteItem(id){
  S.items.delete(id); render();
  if (!FB.uid) return;
  deleteDoc(doc(FB.db, "users", FB.uid, "items", id)).catch(writeError);
}
function saveCats(){
  render();
  if (!FB.uid) return;
  setDoc(doc(FB.db, "users", FB.uid), {cats: clone(S.cats)}, {merge:true}).catch(writeError);
}
function writeError(e){
  const c = e && e.code;
  if (c === "permission-denied") toast("Sem permissão para guardar. Confirma as regras do Firestore.");
  else if (c === "resource-exhausted") toast("Limite gratuito do Firebase atingido por hoje. Tenta amanhã.");
  else toast("Não foi possível guardar" + (c ? ` (${c})` : "") + ".");
}

/* ---------- ui helpers ---------- */
const $ = s => document.querySelector(s);
const view = $("#view");
let toastT;
function toast(msg){ const t=$("#toast"); t.textContent = msg; t.hidden=false; clearTimeout(toastT); toastT=setTimeout(()=>t.hidden=true, 3200); }
function banner(msg){ const b=$("#banner"); if (!msg){ b.hidden=true; return; } b.textContent=msg; b.hidden=false; }
const I = {
  check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  x:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  minus:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 12h12"/></svg>'
};
const ST_LABEL = {done:"Feito", missed:"Não feito", auto:"Falhou · automático", pending:"Por fazer"};

function rowTask(t, today, opts={}){
  const st = taskStatus(t, today);
  const meta = [`<span class="cat" style="${ccStyle(t.cat)}">${esc(catOf(t.cat).name)}</span>`];
  if (opts.showDate && t.date) meta.push(`<span class="mono">${esc(fmtDay(t.date, today))}</span>`);
  if (t.time) meta.push(`<span class="mono">${esc(t.time)}</span>`);
  if (st === "auto") meta.push(`<span class="pill bad">Falhou · auto</span>`);
  if (st === "missed") meta.push(`<span class="pill bad">Não feito</span>`);
  if (t.postponed) meta.push(`<span class="pill">adiada ${t.postponed}×</span>`);
  const right = opts.recover
    ? `<div class="row-actions"><button class="txt-btn good" data-act="t-done">Fiz</button><button class="txt-btn" data-act="t-today">Para hoje</button></div>`
    : `<button class="xbtn" data-act="t-miss" aria-label="Marcar como não feito">${I.x}</button>`;
  return `<div class="row st-${st}" style="${ccStyle(t.cat)}" data-id="${t.id}">
    ${opts.recover ? "" : `<button class="chk" data-act="t-done" aria-label="Marcar como feito">${I.check}</button>`}
    <button class="row-main" data-act="open"><div class="row-title">${esc(t.title)}</div><div class="row-meta">${meta.join("")}</div></button>
    ${right}</div>`;
}
function freqText(h){
  if (h.mode === "weekly") return `${h.perWeek}× por semana`;
  const d = [...(h.days||[])].sort((a,b)=>((a+6)%7)-((b+6)%7));
  if (d.length === 7) return "Todos os dias";
  if (d.join() === "1,2,3,4,5") return "Dias úteis";
  return d.map(x => D3[x].slice(0,3).toLowerCase()).join(" · ");
}
function rowHabit(h, d, today){
  const st = habitStatusOn(h, d, today) || "pending";
  return `<div class="row st-${st}" style="${ccStyle(h.cat)}" data-id="${h.id}" data-day="${d}">
    <button class="chk" data-act="h-done" aria-label="Marcar como feito">${I.check}</button>
    <button class="row-main" data-act="open"><div class="row-title">${esc(h.title)}</div><div class="row-meta"><span class="cat" style="${ccStyle(h.cat)}">${esc(catOf(h.cat).name)}</span><span class="pill">hábito · ${esc(freqText(h))}</span></div></button>
    <button class="xbtn" data-act="h-miss" aria-label="Marcar como não feito">${I.x}</button></div>`;
}
function rowWeekly(h, today){
  const m = mondayOf(today), target = weekTarget(h,m), c = weekDone(h,m,today);
  const doneToday = h.log && h.log[today] === "done";
  const dots = Array.from({length:target},(_,i)=>`<i class="${i<c?"on":""}"></i>`).join("");
  return `<div class="row st-${doneToday?"done":"pending"}" style="${ccStyle(h.cat)}" data-id="${h.id}" data-day="${today}">
    <button class="chk" data-act="w-done" aria-label="Fiz hoje">${I.check}</button>
    <button class="row-main" data-act="open"><div class="row-title">${esc(h.title)}</div><div class="row-meta"><span class="cat" style="${ccStyle(h.cat)}">${esc(catOf(h.cat).name)}</span><span class="weekly" aria-label="${c} de ${target} esta semana">${dots}</span><span class="mono">${c}/${target} esta semana</span></div></button></div>`;
}
function goalCard(g, today){
  const st = goalStatus(g, today), p = goalProgress(g);
  let tag = "";
  if (st === "done") tag = `<span class="pill good">Cumprida</span>`;
  else if (st === "missed") tag = `<span class="pill bad">Não cumprida</span>`;
  else if (st === "auto") tag = `<span class="pill bad">Prazo passou</span>`;
  else if (g.deadline){ const n = diff(today, g.deadline); tag = `<span class="tminus">${n===0?"T−0 · hoje":`T−${n} dias`}</span>`; }
  const steps = (g.steps||[]).map((s,i)=>`<li><button class="${s.done?"on":""}" data-act="g-step" data-i="${i}" aria-pressed="${!!s.done}"><span class="box">${I.check}</span><span>${esc(s.t)}</span></button></li>`).join("");
  return `<div class="goal" style="${ccStyle(g.cat)}" data-id="${g.id}">
    <div class="goal-head"><button class="row-main" data-act="open"><div class="row-title">${esc(g.title)}</div><div class="row-meta"><span class="cat" style="${ccStyle(g.cat)}">${esc(catOf(g.cat).name)}</span>${g.deadline?`<span class="mono">até ${esc(fmt(g.deadline))}</span>`:""}<span class="mono">${Math.round(p*100)}%</span></div></button>${tag}</div>
    <div class="bar"><i style="width:${Math.round(p*100)}%"></i></div>
    ${steps?`<ul class="steps">${steps}</ul>`:(st==="active"?`<div class="row-actions" style="margin-top:10px"><button class="txt-btn good" data-act="g-finish">Marcar como cumprida</button></div>`:"")}
  </div>`;
}

/* ---------- vistas ---------- */
function renderHoje(){
  const today = todayS();
  const tasks = all("task"), habits = all("habit"), goals = all("goal");
  const todays = tasks.filter(t => t.date === today).sort((a,b)=>(a.time||"99").localeCompare(b.time||"99") || a.created-b.created);
  const habToday = habits.filter(h => scheduled(h,today));
  const weekly = habits.filter(h => h.mode==="weekly" && habitActive(h,today));
  const overdue = tasks.filter(t => taskStatus(t,today)==="auto" && t.date >= addDays(today,-7)).sort((a,b)=>b.date.localeCompare(a.date));
  const upcoming = tasks.filter(t => t.date && t.date > today && t.date <= addDays(today,7) && taskStatus(t,today)==="pending").sort((a,b)=>a.date.localeCompare(b.date)||(a.time||"99").localeCompare(b.time||"99"));
  const undated = tasks.filter(t => !t.date && taskStatus(t,today)==="pending").sort((a,b)=>a.created-b.created);
  const activeGoals = goals.filter(g => goalStatus(g,today)==="active").sort((a,b)=>(a.deadline||"9").localeCompare(b.deadline||"9"));

  const total = todays.length + habToday.length;
  const done = todays.filter(t=>taskStatus(t,today)==="done").length + habToday.filter(h=>habitStatusOn(h,today,today)==="done").length;
  const missedToday = todays.filter(t=>taskStatus(t,today)==="missed").length + habToday.filter(h=>habitStatusOn(h,today,today)==="missed").length;
  const frac = total ? done/total : 0;
  const C = 2*Math.PI*40;

  const wk = events(mondayOf(today), today);
  const wkDone = wk.filter(e=>e.st==="done").length, wkMiss = wk.filter(e=>e.st==="missed").length;
  const wkRate = wkDone+wkMiss ? Math.round(wkDone/(wkDone+wkMiss)*100) : null;
  const sk = streaks();

  const d = parse(today);
  let h = `<section class="hero">
    <div>
      <h1 class="h1">${DIAS[d.getDay()]}<br>${d.getDate()} ${MES[d.getMonth()]}</h1>
      <div class="hero-meta">
        <span>Semana <b>${wkRate===null?"—":wkRate+"%"}</b></span>
        <span>Sequência <b>${sk.cur}</b> ${sk.cur===1?"dia":"dias"}</span>
        ${missedToday?`<span>Não feitas <b>${missedToday}</b></span>`:""}
      </div>
    </div>
    <div class="ring" role="img" aria-label="${done} de ${total} feitas hoje">
      <svg viewBox="0 0 92 92"><circle cx="46" cy="46" r="40" fill="none" stroke="var(--line)" stroke-width="8"/>
      <circle cx="46" cy="46" r="40" fill="none" stroke="${frac>=1&&total?"var(--good)":"var(--accent)"}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(C*frac).toFixed(1)} ${C.toFixed(1)}"/></svg>
      <div class="lbl"><div>${done}/${total}<small>HOJE</small></div></div>
    </div>
  </section>
  <form class="quick" id="quick"><input id="quick-in" aria-label="Adicionar tarefa para hoje" placeholder="Adicionar para hoje…" autocomplete="off" enterkeyhint="done"><button type="submit">Adicionar</button></form>`;

  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  let hidden = false; try { hidden = localStorage.getItem("ontrack-install-hidden") === "1"; } catch(_){}
  if (isIOS && !standalone && !hidden){
    h = `<div class="install"><div><b>Instala no ecrã principal</b><br>No Safari, toca em <span class="kbd">Partilhar</span> e depois em <span class="kbd">Adicionar ao ecrã principal</span>.</div><button class="icon-btn" data-act="hide-install" aria-label="Esconder">${I.x}</button></div>` + h;
  }
  const nothing = !S.items.size;
  if (nothing){
    h += `<div class="sec">Começar</div><div class="empty"><h3>Ainda não tens nada marcado</h3><p>Escreve uma tarefa acima ou toca numa sugestão para a abrir já preenchida.</p>
      <div class="chips">
        <button class="chip cat-chip" style="${ccStyle("tecnico")}" data-act="suggest" data-s="0">Estudar Álgebra Linear 1h</button>
        <button class="chip cat-chip" style="${ccStyle("gym")}" data-act="suggest" data-s="1">Ginásio 3× por semana</button>
        <button class="chip cat-chip" style="${ccStyle("carta")}" data-act="suggest" data-s="2">Aula de condução</button>
        <button class="chip cat-chip" style="${ccStyle("descanso")}" data-act="suggest" data-s="3">Dormir antes da meia-noite</button>
      </div></div>`;
    return h;
  }

  if (overdue.length){
    h += `<div class="sec">Ficaram por fazer <span class="n">${overdue.length}</span></div><div class="list">${overdue.map(t=>rowTask(t,today,{recover:true,showDate:true})).join("")}</div>`;
  }
  h += `<div class="sec">Hoje <span class="n">${done}/${total}</span></div>`;
  if (total){
    h += `<div class="list">${todays.map(t=>rowTask(t,today)).join("")}${habToday.map(x=>rowHabit(x,today,today)).join("")}</div>`;
  } else h += `<div class="muted-note">Nada marcado para hoje. Usa o campo acima ou o botão +.</div>`;
  if (weekly.length){
    h += `<div class="sec">Metas da semana</div><div class="list">${weekly.map(x=>rowWeekly(x,today)).join("")}</div>`;
  }
  if (upcoming.length){
    h += `<div class="sec">Próximos 7 dias <span class="n">${upcoming.length}</span></div><div class="list">${upcoming.map(t=>rowTask(t,today,{showDate:true})).join("")}</div>`;
  }
  if (undated.length){
    h += `<div class="sec">Sem data <span class="n">${undated.length}</span></div><div class="list">${undated.map(t=>rowTask(t,today)).join("")}</div>`;
  }
  if (activeGoals.length){
    h += `<div class="sec">Metas em curso</div><div class="stack">${activeGoals.map(g=>goalCard(g,today)).join("")}</div>`;
  }
  return h;
}

function moreBtn(key, n){ return n>0?`<button class="txt-btn" style="margin-top:8px" data-act="more" data-k="${key}">Mostrar mais ${n}</button>`:""; }
function renderLista(){
  const today = todayS();
  const tab = S.listTab, cat = S.listCat;
  const fc = i => cat==="all" || i.cat===cat;
  let h = `<h1 class="h1">Lista</h1>
  <div class="seg" style="margin-top:14px" role="group" aria-label="Tipo">
    ${[["task","Tarefas"],["habit","Hábitos"],["goal","Metas"]].map(([k,l])=>`<button data-act="ltab" data-v="${k}" aria-pressed="${tab===k}">${l}</button>`).join("")}
  </div>
  <div class="chip-row" style="margin-top:12px">
    <button class="chip" data-act="lcat" data-v="all" aria-pressed="${cat==="all"}">Todas</button>
    ${S.cats.map(c=>`<button class="chip cat-chip" style="--cc:var(--c${c.slot})" data-act="lcat" data-v="${c.id}" aria-pressed="${cat===c.id}">${esc(c.name)}</button>`).join("")}
  </div>`;
  if (tab === "task"){
    const ts = all("task").filter(fc);
    const pend = ts.filter(t=>taskStatus(t,today)==="pending").sort((a,b)=>(a.date||"9999").localeCompare(b.date||"9999")||(a.time||"99").localeCompare(b.time||"99"));
    const miss = ts.filter(t=>["missed","auto"].includes(taskStatus(t,today))).sort((a,b)=>(b.date||"").localeCompare(a.date||""));
    const dn = ts.filter(t=>taskStatus(t,today)==="done").sort((a,b)=>(b.doneOn||b.date||"").localeCompare(a.doneOn||a.date||""));
    const lim = k => S.showMore[k] ? 1e9 : 15;
    const block = (title, arr, key) => arr.length ? `<div class="sec">${title} <span class="n">${arr.length}</span></div><div class="list">${arr.slice(0,lim(key)).map(t=>rowTask(t,today,{showDate:true})).join("")}</div>${moreBtn(key, arr.length-lim(key))}` : "";
    h += block("Por fazer", pend, "p") + block("Não feitas", miss, "m") + block("Feitas", dn, "d");
    if (!ts.length) h += `<div class="muted-note" style="margin-top:16px">Sem tarefas${cat!=="all"?" nesta categoria":""}. Toca em + para criar.</div>`;
  } else if (tab === "habit"){
    const hs = all("habit").filter(fc);
    const act = hs.filter(x=>!x.end || x.end >= today), ended = hs.filter(x=>x.end && x.end < today);
    const card = x => habitLine(x, today, 30, true);
    if (act.length) h += `<div class="sec">Ativos <span class="n">${act.length}</span></div><div class="card">${act.map(card).join("")}</div>`;
    if (ended.length) h += `<div class="sec">Terminados</div><div class="card">${ended.map(card).join("")}</div>`;
    if (!hs.length) h += `<div class="muted-note" style="margin-top:16px">Sem hábitos${cat!=="all"?" nesta categoria":""}. Um hábito repete-se (ex.: estudar todos os dias, ginásio 3× por semana).</div>`;
  } else {
    const gs = all("goal").filter(fc);
    const act = gs.filter(g=>goalStatus(g,today)==="active").sort((a,b)=>(a.deadline||"9").localeCompare(b.deadline||"9"));
    const fin = gs.filter(g=>goalStatus(g,today)!=="active");
    if (act.length) h += `<div class="sec">Em curso <span class="n">${act.length}</span></div><div class="stack">${act.map(g=>goalCard(g,today)).join("")}</div>`;
    if (fin.length) h += `<div class="sec">Fechadas</div><div class="stack">${fin.map(g=>goalCard(g,today)).join("")}</div>`;
    if (!gs.length) h += `<div class="muted-note" style="margin-top:16px">Sem metas${cat!=="all"?" nesta categoria":""}. Uma meta tem prazo e passos (ex.: passar no código até janeiro).</div>`;
  }
  return h;
}

function habitLine(x, today, period, clickable){
  const from = addDays(today, -(period-1));
  const ev = events(from, today).filter(e=>e.id===x.id);
  const dn = ev.filter(e=>e.st==="done").length, ms = ev.filter(e=>e.st==="missed").length;
  const rate = dn+ms ? Math.round(dn/(dn+ms)*100)+"%" : "—";
  const cells = [];
  for (let i=13;i>=0;i--){
    const d = addDays(today,-i);
    let cls = "off", tip = `${fmtDay(d,today)}: não calha`;
    if (x.mode==="days"){
      const st = habitStatusOn(x,d,today);
      if (st==="done"){cls="done";tip=`${fmtDay(d,today)}: feito`;}
      else if (st==="missed"||st==="auto"){cls="missed";tip=`${fmtDay(d,today)}: não feito${st==="auto"?" (auto)":""}`;}
      else if (st==="pending"){cls="pend";tip=`${fmtDay(d,today)}: por fazer`;}
    } else if (habitActive(x,d)){
      if (x.log && x.log[d]==="done"){cls="done";tip=`${fmtDay(d,today)}: feito`;} else {cls="";tip=`${fmtDay(d,today)}: —`;}
    }
    cells.push(`<i class="${cls}" data-tip="${esc(tip)}"></i>`);
  }
  return `<div class="hab" data-id="${x.id}">
    <${clickable?`button class="row-main" data-act="open"`:"div"}><div class="row-title" style="font-size:15px">${esc(x.title)}</div><div class="row-meta"><span class="cat" style="${ccStyle(x.cat)}">${esc(catOf(x.cat).name)}</span><span>${esc(freqText(x))}</span></div></${clickable?"button":"div"}>
    <div class="rate" data-tip="${dn} feitas · ${ms} não feitas (${period} dias)">${rate}</div>
    <div class="strip" aria-label="Últimos 14 dias">${cells.join("")}</div></div>`;
}

function niceMax(v){ if (v<=4) return 4; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1,2,2.5,5,10]) if (m*p >= v) return m*p; return 10*p; }
function roundTop(x,y,w,h,r){ r=Math.min(r,h,w/2); return `M${x},${y+h}V${y+r}Q${x},${y} ${x+r},${y}H${x+w-r}Q${x+w},${y} ${x+w},${y+r}V${y+h}Z`; }

function renderStats(){
  const today = todayS();
  const P = S.period;
  const from = P==="all" ? earliest() : addDays(today, -(P-1));
  const ev = events(from, today);
  const dn = ev.filter(e=>e.st==="done").length, ms = ev.filter(e=>e.st==="missed").length;
  const rate = dn+ms ? Math.round(dn/(dn+ms)*100) : null;
  const sk = streaks();
  // período anterior para comparação
  let delta = "";
  if (P !== "all"){
    const pe = events(addDays(from,-P), addDays(from,-1));
    const pd = pe.filter(e=>e.st==="done").length, pm = pe.filter(e=>e.st==="missed").length;
    if (pd+pm && rate!==null){ const pr = Math.round(pd/(pd+pm)*100), k = rate-pr; delta = `${k>0?"▲ +":k<0?"▼ ":"= "}${k} pts vs ${P} dias antes`; }
  }

  let h = `<h1 class="h1">Estatísticas</h1>
  <div class="seg" style="margin-top:14px" role="group" aria-label="Período">
    ${[[7,"7 dias"],[30,"30 dias"],[90,"90 dias"],["all","Tudo"]].map(([k,l])=>`<button data-act="period" data-v="${k}" aria-pressed="${P===k}">${l}</button>`).join("")}
  </div>
  <div class="tiles">
    <div class="tile big"><div><div class="k">Cumprimento</div><div class="v">${rate===null?"—":rate+"%"}</div><div class="d">${delta||"Feitas a dividir por feitas + não feitas"}</div></div>
      <div class="d" style="text-align:right">Por fazer não conta<br>até passar o prazo</div></div>
    <div class="tile"><div class="k">Feitas</div><div class="v" style="color:var(--good-ink)">${dn}</div></div>
    <div class="tile"><div class="k">Não feitas</div><div class="v" style="color:var(--bad-ink)">${ms}</div></div>
    <div class="tile"><div class="k">Sequência</div><div class="v">${sk.cur}<small>${sk.cur===1?"dia":"dias"}</small></div><div class="d">dias seguidos sem falhar</div></div>
    <div class="tile"><div class="k">Melhor</div><div class="v">${sk.best}<small>${sk.best===1?"dia":"dias"}</small></div><div class="d">recorde de sequência</div></div>
  </div>`;

  /* semanas */
  const m0 = addDays(mondayOf(today), -77);
  const wks = [];
  for (let i=0;i<12;i++){
    const a = addDays(m0, i*7), b = addDays(a,6);
    const e = events(a, b);
    wks.push({a, done:e.filter(x=>x.st==="done").length, missed:e.filter(x=>x.st==="missed").length});
  }
  const W=340, H=190, L=26, R=6, T=18, B=26, pw=W-L-R, ph=H-T-B;
  const mx = niceMax(Math.max(1, ...wks.map(w=>w.done+w.missed)));
  const slot = pw/12, bw = Math.min(18, slot-8);
  const y = v => T + ph - v/mx*ph;
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Feitas e não feitas por semana nas últimas 12 semanas">`;
  for (const g of [0, mx/2, mx]){ svg += `<line x1="${L}" x2="${W-R}" y1="${y(g)}" y2="${y(g)}" stroke="${g?"var(--grid)":"var(--axis)"}" stroke-width="1"/><text x="${L-6}" y="${y(g)+3}" text-anchor="end">${Math.round(g)}</text>`; }
  wks.forEach((w,i)=>{
    const x = L + i*slot + (slot-bw)/2;
    const tot = w.done+w.missed, r = tot? Math.round(w.done/tot*100) : null;
    const tip = `Semana de ${fmt(w.a)}: ${w.done} feitas, ${w.missed} não feitas${r!==null?` · ${r}%`:""}`;
    const hd = w.done/mx*ph, hm = w.missed/mx*ph, gap = (w.done && w.missed) ? 2 : 0;
    if (w.done) svg += w.missed ? `<rect x="${x}" y="${y(w.done)}" width="${bw}" height="${hd}" fill="var(--good)"/>` : `<path d="${roundTop(x, y(w.done), bw, hd, 4)}" fill="var(--good)"/>`;
    if (w.missed) svg += `<path d="${roundTop(x, y(tot), bw, Math.max(0,hm-gap), 4)}" fill="var(--bad)"/>`;
    svg += `<rect x="${L+i*slot}" y="${T}" width="${slot}" height="${ph+B}" fill="transparent" data-tip="${esc(tip)}"/>`;
    if (i%3===2 || i===11) svg += `<text x="${x+bw/2}" y="${H-8}" text-anchor="middle" ${i===11?'class="lbl-strong"':""}>${i===11?"esta":fmt(w.a)}</text>`;
    if (i===11 && r!==null) svg += `<text x="${x+bw/2}" y="${y(tot)-6}" text-anchor="middle" class="lbl-strong">${r}%</text>`;
  });
  svg += `</svg>`;
  const tbl = `<details class="tbl"><summary>Ver tabela</summary><table><tr><th>Semana</th><th>Feitas</th><th>Não feitas</th><th>%</th></tr>${wks.map(w=>{const t=w.done+w.missed;return `<tr><td>${fmt(w.a)}</td><td>${w.done}</td><td>${w.missed}</td><td>${t?Math.round(w.done/t*100)+"%":"—"}</td></tr>`}).join("")}</table></details>`;
  h += `<div class="sec">Por semana · 12 semanas</div><div class="card"><div class="card-h"><h3>Feitas e não feitas</h3><div class="legend"><span><i style="background:var(--good)"></i>Feitas</span><span><i style="background:var(--bad)"></i>Não feitas</span></div></div>${svg}${tbl}</div>`;

  /* mapa diário */
  const dm = byDay(events(m0, today));
  let hm = `<div class="hm"><div></div>`;
  for (let c=0;c<12;c++){ const a = addDays(m0,c*7); const first = c===0 || parse(a).getMonth() !== parse(addDays(a,-7)).getMonth(); hm += `<div class="ml">${first?MES[parse(a).getMonth()]:""}</div>`; }
  for (let r=0;r<7;r++){
    hm += `<div class="dl">${r%2===0?D3[(r+1)%7].slice(0,1):""}</div>`;
    for (let c=0;c<12;c++){
      const d = addDays(m0, c*7+r);
      if (d > today){ hm += `<div class="c f" aria-hidden="true"></div>`; continue; }
      const x = dm.get(d); let cls = "", tip = `${fmtDay(d,today)}: nada marcado`;
      if (x && (x.done+x.missed)){
        const q = x.done/(x.done+x.missed); cls = q===0?"l1":q<.5?"l2":q<.8?"l3":q<1?"l4":"l5";
        tip = `${fmtDay(d,today)}: ${x.done}/${x.done+x.missed} feitas (${Math.round(q*100)}%)`;
      } else if (x && x.pending) tip = `${fmtDay(d,today)}: ${x.pending} por fazer`;
      hm += `<div class="c ${cls} ${d===today?"t":""}" data-tip="${esc(tip)}"></div>`;
    }
  }
  hm += `</div>`;
  h += `<div class="sec">Dia a dia</div><div class="card"><div class="card-h"><h3>% cumprido por dia</h3><div class="scale">0%<i style="background:var(--h1)"></i><i style="background:var(--h2)"></i><i style="background:var(--h3)"></i><i style="background:var(--h4)"></i><i style="background:var(--h5)"></i>100%</div></div>${hm}</div>`;

  /* categorias */
  const rows = S.cats.map(c=>{ const e = ev.filter(x=>x.cat===c.id); const d1=e.filter(x=>x.st==="done").length, m1=e.filter(x=>x.st==="missed").length; return {c, d:d1, m:m1, t:d1+m1}; }).filter(r=>r.t).sort((a,b)=>b.t-a.t);
  h += `<div class="sec">Por categoria</div><div class="card">`;
  h += rows.length ? `<div class="catbars">${rows.map(r=>{const p=Math.round(r.d/r.t*100);return `<div data-tip="${esc(r.c.name)}: ${r.d} feitas, ${r.m} não feitas"><div class="cb-top"><span class="cat" style="--cc:var(--c${r.c.slot})">${esc(r.c.name)}</span><span class="mono">${p}% · ${r.d}/${r.t}</span></div><div class="cb-track"><i style="--cc:var(--c${r.c.slot});width:${p}%"></i></div></div>`}).join("")}</div>`
    : `<div class="muted-note">Ainda sem tarefas fechadas neste período.</div>`;
  h += `</div>`;

  /* hábitos */
  const hs = all("habit").filter(x=>!x.end || x.end >= from);
  if (hs.length){
    const per = P==="all" ? Math.max(1, diff(earliest(), today)+1) : P;
    h += `<div class="sec">Hábitos</div><div class="card">${hs.map(x=>habitLine(x,today,per,false)).join("")}<div class="legend" style="margin-top:10px"><span><i style="background:var(--good)"></i>Feito</span><span><i style="background:var(--bad)"></i>Não feito</span><span><i style="border:1px dashed var(--axis)"></i>Por fazer</span></div></div>`;
  }

  /* metas */
  const gs = all("goal");
  if (gs.length){
    const st = gs.map(g=>goalStatus(g,today));
    const ok = st.filter(s=>s==="done").length, ko = st.filter(s=>s==="missed"||s==="auto").length, on = st.filter(s=>s==="active").length;
    h += `<div class="sec">Metas</div><div class="tiles" style="grid-template-columns:1fr 1fr 1fr;margin-top:0">
      <div class="tile"><div class="k">Em curso</div><div class="v">${on}</div></div>
      <div class="tile"><div class="k">Cumpridas</div><div class="v" style="color:var(--good-ink)">${ok}</div></div>
      <div class="tile"><div class="k">Falhadas</div><div class="v" style="color:var(--bad-ink)">${ko}</div></div></div>`;
  }
  return h;
}

function render(){
  const ae = document.activeElement;
  const keep = ae && ae.id === "quick-in" ? {v:ae.value, s:ae.selectionStart} : null;
  const d = parse(todayS());
  $("#stamp").textContent = `${D3[d.getDay()]} ${pad(d.getDate())} ${MES[d.getMonth()].toUpperCase()} ${d.getFullYear()}`;
  document.querySelectorAll(".tabs button").forEach(b => b.getAttribute("data-tab")===S.view ? b.setAttribute("aria-current","page") : b.removeAttribute("aria-current"));
  if (!S.loaded){ view.innerHTML = `<div class="loading">A carregar as tuas tarefas…</div>`; return; }
  view.innerHTML = S.view==="lista" ? renderLista() : S.view==="estatisticas" ? renderStats() : renderHoje();
  if (keep){ const q = $("#quick-in"); if (q){ q.value = keep.v; q.focus(); try{q.setSelectionRange(keep.s,keep.s);}catch(_){} } }
}

/* ---------- ações ---------- */
view.addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act;
  const host = b.closest("[data-id]");
  const item = host ? S.items.get(host.dataset.id) : null;
  const today = todayS();
  if (!writable && ["t-done","t-miss","t-today","h-done","h-miss","w-done","g-step","g-finish"].includes(act)){ toast("Sem permissão para guardar."); return; }
  switch (act){
    case "t-done": { const t = clone(item); if (t.status==="done"){ t.status="pending"; t.doneOn=null; } else { t.status="done"; t.doneOn=today; } saveItem(t); break; }
    case "t-miss": { const t = clone(item); t.status = t.status==="missed" ? "pending" : "missed"; t.doneOn=null; saveItem(t); break; }
    case "t-today": { const t = clone(item); t.date = today; t.status="pending"; t.postponed=(t.postponed||0)+1; saveItem(t); toast("Passou para hoje."); break; }
    case "h-done": case "h-miss": { const x = clone(item), d = host.dataset.day, v = act==="h-done"?"done":"missed"; x.log = x.log||{}; if (x.log[d]===v) delete x.log[d]; else x.log[d]=v; saveItem(x); break; }
    case "w-done": { const x = clone(item); x.log = x.log||{}; if (x.log[today]==="done") delete x.log[today]; else x.log[today]="done"; saveItem(x); break; }
    case "g-step": { const g = clone(item), i = +b.dataset.i; g.steps[i].done = !g.steps[i].done; if (g.status!=="missed"){ const allDone = g.steps.every(s=>s.done); g.status = allDone ? "done" : "active"; g.doneOn = allDone ? today : null; if (allDone) toast("Meta cumprida."); } saveItem(g); break; }
    case "g-finish": { const g = clone(item); g.status="done"; g.doneOn=today; saveItem(g); break; }
    case "open": openForm(item.kind, item); break;
    case "suggest": {
      const s = +b.dataset.s;
      const presets = [
        {kind:"task", title:"Estudar Álgebra Linear 1h", cat:"tecnico"},
        {kind:"habit", title:"Ginásio", cat:"gym", mode:"weekly", perWeek:3},
        {kind:"task", title:"Aula de condução", cat:"carta"},
        {kind:"habit", title:"Dormir antes da meia-noite", cat:"descanso", mode:"days", days:[0,1,2,3,4,5,6]},
      ];
      openForm(presets[s].kind, null, presets[s]); break;
    }
    case "ltab": S.listTab = b.dataset.v; render(); break;
    case "lcat": S.listCat = b.dataset.v; render(); break;
    case "more": S.showMore[b.dataset.k] = true; render(); break;
    case "period": S.period = b.dataset.v==="all" ? "all" : +b.dataset.v; render(); break;
  }
});
view.addEventListener("submit", e => {
  if (e.target.id !== "quick") return;
  e.preventDefault();
  const inp = $("#quick-in"), title = inp.value.trim(); if (!title) return;
  if (!writable){ toast("Sem permissão para guardar."); return; }
  const cat = S.cats.some(c=>c.id===S.lastCat) ? S.lastCat : (S.cats[0]||{}).id || "";
  saveItem({id:newId(), kind:"task", title, cat, date:todayS(), time:null, notes:"", status:"pending", doneOn:null, postponed:0, created:Date.now()});
  inp.value = ""; inp.focus();
  toast(`Adicionada em ${catOf(cat).name}. Toca na tarefa para mudar.`);
});

document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => go(b.dataset.tab)));
function go(v){ S.view = v; if (location.hash !== "#"+v) history.replaceState(null, "", "#"+v); render(); window.scrollTo(0,0); }
window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (["hoje","lista","estatisticas"].includes(v)){ S.view=v; render(); } });
$("#fab").addEventListener("click", () => openForm(S.view==="lista" ? S.listTab : "task", null));
$("#btn-cats").addEventListener("click", openCats);
view.addEventListener("click", e => { if (e.target.closest("[data-act='hide-install']")){ try{ localStorage.setItem("ontrack-install-hidden","1"); }catch(_){} render(); } });

/* ---------- folha (formulário) ---------- */
const sheet = $("#sheet"), sb = $("#sheet-body");
let F = null; // rascunho
function closeSheet(){ sheet.hidden = true; F = null; sb.innerHTML=""; }
sheet.addEventListener("click", e => { if (e.target === sheet) closeSheet(); });
document.addEventListener("keydown", e => { if (e.key==="Escape" && !sheet.hidden) closeSheet(); });

function openForm(kind, item, preset){
  const today = todayS();
  if (item) F = clone(item);
  else {
    const cat = (preset && preset.cat) || (S.cats.some(c=>c.id===S.lastCat) ? S.lastCat : (S.cats[0]||{}).id || "");
    F = {id:newId(), kind, title:"", cat, created:Date.now()};
    Object.assign(F, defaultsFor(kind, today), preset||{});
  }
  F._new = !item; F._arm = false;
  drawForm();
  sheet.hidden = false;
  setTimeout(()=>{ const t = $("#f-title"); if (t && !item && !preset) t.focus(); }, 60);
}
function defaultsFor(kind, today){
  if (kind==="task") return {date:today, time:null, notes:"", status:"pending", doneOn:null, postponed:0};
  if (kind==="habit") return {mode:"days", days:[0,1,2,3,4,5,6], perWeek:3, start:today, end:null, log:{}};
  return {deadline:null, steps:[], status:"active", doneOn:null};
}
function switchKind(k){
  const keep = {id:F.id, title:F.title, cat:F.cat, created:F.created};
  F = Object.assign({kind:k}, keep, defaultsFor(k, todayS()), {_new:true, _arm:false});
  drawForm();
}
function drawForm(){
  const today = todayS();
  const k = F.kind;
  const names = {task:"tarefa", habit:"hábito", goal:"meta"};
  let h = `<div class="grab"></div><h2 id="sheet-title">${F._new?(k==="task"?"Nova tarefa":k==="habit"?"Novo hábito":"Nova meta"):"Editar "+names[k]}</h2>`;
  if (F._new) h += `<div class="seg" style="margin-bottom:16px" role="group" aria-label="Tipo">${[["task","Tarefa"],["habit","Hábito"],["goal","Meta"]].map(([v,l])=>`<button type="button" data-f="kind" data-v="${v}" aria-pressed="${k===v}">${l}</button>`).join("")}</div>`;
  h += `<div class="field"><label for="f-title">${k==="goal"?"Meta":"O que tens de fazer"}</label><input class="inp" id="f-title" value="${esc(F.title)}" placeholder="${k==="task"?"Ex.: entregar relatório de Química":k==="habit"?"Ex.: estudar 1h, ginásio":"Ex.: passar no exame de código"}" autocomplete="off"></div>`;
  h += `<div class="field"><div class="lab">Categoria</div><div class="chips">${S.cats.map(c=>`<button type="button" class="chip cat-chip" style="--cc:var(--c${c.slot})" data-f="cat" data-v="${c.id}" aria-pressed="${F.cat===c.id}">${esc(c.name)}</button>`).join("")}</div></div>`;
  if (k==="task"){
    h += `<div class="two"><div class="field"><label for="f-date">Dia</label><input class="inp" type="date" id="f-date" value="${F.date||""}" ${F.date?"":"disabled"}></div>
      <div class="field"><label for="f-time">Hora (opcional)</label><input class="inp" type="time" id="f-time" value="${F.time||""}"></div></div>
      <label class="check-line" style="margin:-6px 0 14px"><input type="checkbox" id="f-nodate" ${F.date?"":"checked"}> Sem data (não falha automaticamente)</label>
      <div class="field"><label for="f-notes">Notas</label><textarea class="inp" id="f-notes" rows="2">${esc(F.notes||"")}</textarea></div>`;
    if (!F._new){
      const st = F.status==="done"?"done":F.status==="missed"?"missed":"pending";
      h += `<div class="field"><div class="lab">Estado</div><div class="seg">${[["pending","Por fazer"],["done","Feito"],["missed","Não feito"]].map(([v,l])=>`<button type="button" data-f="status" data-v="${v}" aria-pressed="${st===v}">${l}</button>`).join("")}</div>
        ${taskStatus(F,today)==="auto"?`<div class="muted-note">O dia passou sem estar feita, por isso conta como não feita. Marca "Feito" se a fizeste, ou muda o dia para adiar.</div>`:""}</div>`;
    }
  } else if (k==="habit"){
    h += `<div class="field"><div class="lab">Frequência</div><div class="seg">${[["days","Dias certos"],["weekly","X vezes por semana"]].map(([v,l])=>`<button type="button" data-f="mode" data-v="${v}" aria-pressed="${F.mode===v}">${l}</button>`).join("")}</div></div>`;
    if (F.mode==="days"){
      h += `<div class="field"><div class="lab">Em que dias</div><div class="days">${[1,2,3,4,5,6,0].map(d=>`<button type="button" data-f="day" data-v="${d}" aria-pressed="${F.days.includes(d)}" aria-label="${DIAS[d]}">${D1[d]}</button>`).join("")}</div></div>`;
    } else {
      h += `<div class="field"><div class="lab">Quantas vezes por semana</div><div class="stepper"><button type="button" data-f="pw" data-v="-1" aria-label="Menos">−</button><output>${F.perWeek}</output><button type="button" data-f="pw" data-v="1" aria-label="Mais">+</button><span class="muted-note">semana de segunda a domingo</span></div></div>`;
    }
    h += `<div class="field"><label for="f-start">Começa em</label><input class="inp" type="date" id="f-start" value="${F.start}"></div>`;
    if (!F._new){
      const cells = [];
      for (let i=20;i>=0;i--){
        const d = addDays(today,-i);
        let cls="", dis=false;
        if (F.mode==="days"){ const st = habitStatusOn(F,d,today); if (!st) dis=true; else cls = st; }
        else { if (!habitActive(F,d)) dis=true; else cls = F.log[d]==="done"?"done":""; }
        const dd = parse(d);
        cells.push(`<button type="button" class="${cls}" data-f="corr" data-v="${d}" ${dis?"disabled":""} aria-label="${fmtDay(d,today)}: ${ST_LABEL[cls]||"sem registo"}">${D1[dd.getDay()]}<b>${dd.getDate()}</b></button>`);
      }
      h += `<div class="field"><div class="lab">Corrigir últimos 21 dias · toca para mudar</div><div class="corr">${cells.join("")}</div></div>`;
      if (!F.end || F.end >= today) h += `<button type="button" class="txt-btn" data-f="end" style="margin-bottom:6px">Terminar este hábito</button>`;
      else h += `<div class="muted-note">Terminado a ${fmt(F.end)}. <button type="button" class="txt-btn" data-f="reopen">Retomar</button></div>`;
    }
  } else {
    h += `<div class="field"><label for="f-deadline">Prazo</label><input class="inp" type="date" id="f-deadline" value="${F.deadline||""}"></div>
      <div class="field"><div class="lab">Passos</div>${(F.steps||[]).map((s,i)=>`<div class="step-edit"><input class="inp" data-step="${i}" value="${esc(s.t)}" aria-label="Passo ${i+1}"><button type="button" data-f="rmstep" data-v="${i}" aria-label="Remover passo">${I.minus}</button></div>`).join("")}
      <div class="step-edit"><input class="inp" id="f-newstep" placeholder="Adicionar passo e carregar Enter" enterkeyhint="done"><button type="button" data-f="addstep" aria-label="Adicionar passo">+</button></div></div>`;
    if (!F._new){
      const st = F.status;
      h += `<div class="field"><div class="lab">Estado</div><div class="seg">${[["active","Em curso"],["done","Cumprida"],["missed","Não cumprida"]].map(([v,l])=>`<button type="button" data-f="gstatus" data-v="${v}" aria-pressed="${st===v}">${l}</button>`).join("")}</div></div>`;
    }
  }
  h += `<div class="err" id="f-err"></div><div class="sheet-actions">
    ${F._new?`<button type="button" class="btn" data-f="cancel">Cancelar</button>`:`<button type="button" class="btn danger ${F._arm?"arm":""}" data-f="del">${F._arm?"Toca outra vez":"Apagar"}</button>`}
    <button type="button" class="btn primary" data-f="save">${F._new?"Guardar":"Guardar alterações"}</button></div>`;
  sb.innerHTML = h;
}
function readInputs(){
  if (!F) return;
  const v = id => { const el = $("#"+id); return el ? el.value : undefined; };
  F.title = (v("f-title") ?? F.title).trim();
  if (F.kind==="task"){
    const nod = $("#f-nodate"); if (nod && nod.checked) F.date = null; else if (v("f-date")) F.date = v("f-date");
    F.time = v("f-time") || null; F.notes = v("f-notes") ?? F.notes;
  } else if (F.kind==="habit"){ if (v("f-start")) F.start = v("f-start"); }
  else {
    F.deadline = v("f-deadline") || null;
    sb.querySelectorAll("[data-step]").forEach(el => { const i=+el.dataset.step; if (F.steps[i]) F.steps[i].t = el.value; });
    const ns = $("#f-newstep"); if (ns && ns.value.trim()){ F.steps.push({id:newId(), t:ns.value.trim(), done:false}); ns.value=""; }
  }
}
sb.addEventListener("change", e => {
  if (e.target.id === "f-nodate"){ readInputs(); const d = $("#f-date"); if (e.target.checked){ F.date=null; } else { F.date = todayS(); } drawForm(); }
});
sb.addEventListener("keydown", e => {
  if (e.key==="Enter" && e.target.id==="f-newstep"){ e.preventDefault(); readInputs(); drawForm(); const n=$("#f-newstep"); if(n) n.focus(); }
  else if (e.key==="Enter" && e.target.id==="f-title"){ e.preventDefault(); sb.querySelector('[data-f="save"]').click(); }
});
sb.addEventListener("click", e => {
  const b = e.target.closest("[data-f]"); if (!b || !F) return;
  const f = b.dataset.f, v = b.dataset.v;
  const today = todayS();
  if (f!=="del") F._arm = false;
  readInputs();
  switch (f){
    case "kind": switchKind(v); return;
    case "cat": F.cat = v; break;
    case "status": F.status = v; F.doneOn = v==="done" ? (F.doneOn || today) : null; break;
    case "mode": F.mode = v; break;
    case "day": { const d=+v; F.days = F.days.includes(d) ? F.days.filter(x=>x!==d) : [...F.days, d]; break; }
    case "pw": F.perWeek = Math.max(1, Math.min(7, F.perWeek + (+v))); break;
    case "corr": {
      F.log = F.log || {};
      if (F.mode==="weekly"){ if (F.log[v]==="done") delete F.log[v]; else F.log[v]="done"; }
      else { const cur = F.log[v]; if (!cur) F.log[v]="done"; else if (cur==="done") F.log[v]="missed"; else delete F.log[v]; }
      break;
    }
    case "end": F.end = (F.log && F.log[today]) ? today : addDays(today,-1); if (F.end < F.start) F.end = F.start; break;
    case "reopen": F.end = null; break;
    case "addstep": break;
    case "rmstep": F.steps.splice(+v,1); break;
    case "gstatus": F.status = v; F.doneOn = v==="done" ? today : null; break;
    case "cancel": closeSheet(); return;
    case "del":
      if (!F._arm){ F._arm = true; break; }
      deleteItem(F.id); closeSheet(); toast("Apagado."); return;
    case "save": {
      const err = $("#f-err");
      if (!F.title){ err.textContent = "Escreve o que tens de fazer."; $("#f-title").focus(); return; }
      if (F.kind==="habit" && F.mode==="days" && !F.days.length){ err.textContent = "Escolhe pelo menos um dia."; return; }
      if (!writable){ err.textContent = "Sem permissão para guardar nesta app."; return; }
      const out = clone(F); delete out._new; delete out._arm;
      if (out.kind==="goal") out.steps = out.steps.filter(s=>s.t.trim());
      if (out.kind==="goal" && out.status!=="missed" && out.steps.length){ const a = out.steps.every(s=>s.done); if (a && out.status==="active"){ out.status="done"; out.doneOn=today; } }
      S.lastCat = out.cat;
      saveItem(out); closeSheet();
      toast("Guardado.");
      return;
    }
  }
  drawForm();
});

/* categorias */
function openCats(){
  F = {kind:"cats", cats: clone(S.cats)};
  drawCats(); sheet.hidden = false;
}
function drawCats(){
  const used = new Set([...S.items.values()].map(i=>i.cat));
  sb.innerHTML = `<div class="grab"></div><h2 id="sheet-title">Definições</h2>
    <div class="field"><div class="lab">Conta</div>
      <div class="acct"><span>${FB.email ? esc(FB.email) : "Modo de teste (sem conta)"}</span>${FB.uid?`<button type="button" class="txt-btn" data-c="logout">Sair</button>`:""}</div></div>
    <div class="field"><div class="lab">Cópia de segurança</div>
      <div class="chips"><button type="button" class="txt-btn" data-c="export">Exportar (.json)</button><label class="txt-btn file-btn">Importar<input type="file" id="f-import" accept="application/json,.json" hidden></label></div>
      <div class="muted-note">Os dados já ficam guardados na tua conta. A cópia é só para teres um ficheiro teu.</div></div>
    <div class="field"><div class="lab">Categorias</div></div>
    ${F.cats.map((c,i)=>`<div class="cat-edit" style="--cc:var(--c${c.slot})"><span class="sw"></span><input class="inp" data-ci="${i}" value="${esc(c.name)}" aria-label="Nome da categoria"><button type="button" data-c="rm" data-v="${i}" aria-label="Remover ${esc(c.name)}" ${used.has(c.id)?'title="Tem tarefas: ficam sem categoria"':""}>${I.minus}</button></div>`).join("")}
    ${F.cats.length<8?`<button type="button" class="txt-btn" data-c="add">+ Nova categoria</button>`:`<div class="muted-note">Máximo de 8 categorias, para as cores se distinguirem bem.</div>`}
    <div class="err" id="c-err"></div>
    <div class="sheet-actions"><button type="button" class="btn" data-c="cancel">Cancelar</button><button type="button" class="btn primary" data-c="save">Guardar</button></div>`;
}
sb.addEventListener("click", e => {
  const b = e.target.closest("[data-c]"); if (!b || !F || F.kind!=="cats") return;
  sb.querySelectorAll("[data-ci]").forEach(el => { F.cats[+el.dataset.ci].name = el.value; });
  const a = b.dataset.c;
  if (a==="cancel"){ closeSheet(); return; }
  if (a==="logout"){ closeSheet(); signOut(FB.auth); return; }
  if (a==="export"){ exportBackup(); return; }
  if (a==="rm"){ F.cats.splice(+b.dataset.v,1); }
  if (a==="add"){ const usedSlots = new Set(F.cats.map(c=>c.slot)); let s=1; while (usedSlots.has(s)) s++; F.cats.push({id:"c"+newId(), name:"", slot:s}); }
  if (a==="save"){
    const cats = F.cats.map(c=>({...c, name:c.name.trim()})).filter(c=>c.name);
    if (!cats.length){ $("#c-err").textContent = "Precisas de pelo menos uma categoria."; return; }
    if (!writable){ $("#c-err").textContent = "Sem permissão para guardar."; return; }
    S.cats = cats; saveCats(); closeSheet(); return;
  }
  drawCats();
  if (a==="add"){ const ins = sb.querySelectorAll("[data-ci]"); ins[ins.length-1].focus(); }
});

sb.addEventListener("change", async e => {
  if (e.target.id !== "f-import") return;
  const file = e.target.files && e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.items)) throw new Error("formato");
    let n = 0;
    for (const it of data.items){ if (it && it.id && ["task","habit","goal"].includes(it.kind)){ saveItem(it); n++; } }
    if (Array.isArray(data.cats) && data.cats.length){ S.cats = data.cats; saveCats(); }
    closeSheet(); toast(`Importados ${n} registos.`);
  } catch(_) { toast("Esse ficheiro não é uma cópia do On track."); }
});
function exportBackup(){
  const data = {app:"on-track", version:1, exportedAt:new Date().toISOString(), cats:S.cats, items:[...S.items.values()]};
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `on-track-${todayS()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------- dicas (tooltip) ---------- */
const tip = $("#tip");
function showTip(el, x, y){
  tip.textContent = el.getAttribute("data-tip"); tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x - r.width/2, top = y - r.height - 12;
  left = Math.max(8, Math.min(window.innerWidth - r.width - 8, left));
  if (top < 8) top = y + 16;
  tip.style.left = left+"px"; tip.style.top = top+"px";
}
document.addEventListener("pointermove", e => {
  if (e.pointerType === "touch") return;
  const el = e.target.closest && e.target.closest("[data-tip]");
  if (el) showTip(el, e.clientX, e.clientY); else tip.hidden = true;
});
document.addEventListener("pointerdown", e => {
  const el = e.target.closest && e.target.closest("[data-tip]");
  if (el && e.pointerType === "touch") showTip(el, e.clientX, e.clientY); else if (!el) tip.hidden = true;
});
window.addEventListener("scroll", () => { tip.hidden = true; }, {passive:true});

/* ---------- mudança de dia ---------- */
let lastDay = todayS();
setInterval(() => { if (todayS() !== lastDay){ lastDay = todayS(); render(); } }, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && todayS() !== lastDay){ lastDay = todayS(); render(); } });

/* ---------- ecrã de entrada ---------- */
const authEl = $("#auth");
let authMode = "login";
function drawAuth(msg = "", ok = ""){
  const signup = authMode === "signup", reset = authMode === "reset";
  authEl.innerHTML = `<div class="auth-in">
    <div class="brand">On track<b>.</b></div>
    <h1 class="h1">${signup ? "Criar conta" : reset ? "Recuperar" : "Entrar"}</h1>
    <p class="lead">${signup ? "Uma conta para veres as mesmas tarefas no telemóvel e no PC." : reset ? "Enviamos-te um email para escolheres uma palavra-passe nova." : "Entra para veres as tuas tarefas e estatísticas."}</p>
    <form id="auth-form" novalidate>
      <div class="field"><label for="a-email">Email</label><input class="inp" id="a-email" type="email" autocomplete="email" inputmode="email" required></div>
      ${reset ? "" : `<div class="field"><label for="a-pass">Palavra-passe</label><input class="inp" id="a-pass" type="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="6" required></div>`}
      <div class="err" id="a-err">${esc(msg)}</div><div class="ok">${esc(ok)}</div>
      <button class="btn primary" type="submit" id="a-go">${signup ? "Criar conta" : reset ? "Enviar email" : "Entrar"}</button>
    </form>
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:6px">
      ${authMode !== "login" ? `<button class="link" data-mode="login">Já tenho conta</button>` : `<button class="link" data-mode="signup">Criar conta nova</button>`}
      ${authMode === "login" ? `<button class="link" data-mode="reset">Esqueci-me da palavra-passe</button>` : ""}
    </div>
  </div>`;
}
const AUTH_ERR = {
  "auth/invalid-credential":"Email ou palavra-passe errados.",
  "auth/wrong-password":"Email ou palavra-passe errados.",
  "auth/user-not-found":"Não há conta com esse email.",
  "auth/email-already-in-use":"Já existe uma conta com esse email. Entra em vez de criar.",
  "auth/weak-password":"A palavra-passe tem de ter pelo menos 6 caracteres.",
  "auth/invalid-email":"Esse email não parece válido.",
  "auth/missing-password":"Escreve a palavra-passe.",
  "auth/too-many-requests":"Demasiadas tentativas. Espera um bocado e tenta outra vez.",
  "auth/network-request-failed":"Sem ligação à internet. Liga-te para entrar.",
  "auth/operation-not-allowed":"O login por email não está ativo no Firebase (Authentication → Email/palavra-passe)."
};
authEl.addEventListener("click", e => { const b = e.target.closest("[data-mode]"); if (b){ authMode = b.dataset.mode; drawAuth(); } });
authEl.addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("#a-email").value.trim(), passEl = $("#a-pass"), pass = passEl ? passEl.value : "";
  if (!email){ drawAuthErr("Escreve o teu email."); return; }
  const go = $("#a-go"); go.disabled = true; go.textContent = "Um momento…";
  try {
    if (authMode === "signup") await createUserWithEmailAndPassword(FB.auth, email, pass);
    else if (authMode === "reset"){ await sendPasswordResetEmail(FB.auth, email); authMode = "login"; drawAuth("", "Email enviado. Vê também o spam."); $("#a-email").value = email; return; }
    else await signInWithEmailAndPassword(FB.auth, email, pass);
  } catch(err){
    const m = AUTH_ERR[err && err.code] || "Não deu para entrar" + (err && err.code ? ` (${err.code})` : "") + ".";
    drawAuth(m); $("#a-email").value = email;
  }
});
function drawAuthErr(m){ const el = $("#a-err"); if (el) el.textContent = m; }

/* ---------- ligação ---------- */
function netBanner(){
  if (!navigator.onLine) banner("Sem internet. O que marcares fica guardado no telemóvel e sincroniza quando a ligação voltar.");
  else if (writable) banner("");
}
window.addEventListener("online", netBanner);
window.addEventListener("offline", netBanner);

/* ---------- arranque ---------- */
const hv = location.hash.slice(1);
if (["hoje","lista","estatisticas"].includes(hv)) S.view = hv;
render();

const configured = FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && !/^COLA/.test(FIREBASE_CONFIG.apiKey);
if (!configured){
  S.loaded = true;
  banner("Modo de teste: o Firebase ainda não está configurado, por isso nada fica guardado.");
  render();
} else {
  FB.app = initializeApp(FIREBASE_CONFIG);
  FB.auth = initializeAuth(FB.app, {persistence: [indexedDBLocalPersistence, browserLocalPersistence]});
  FB.auth.languageCode = "pt";
  try {
    FB.db = initializeFirestore(FB.app, {localCache: persistentLocalCache({tabManager: persistentMultipleTabManager()})});
  } catch(_) {
    FB.db = initializeFirestore(FB.app, {localCache: memoryLocalCache()});
  }
  onAuthStateChanged(FB.auth, user => {
    FB.unsub.forEach(u => u()); FB.unsub = [];
    if (!user){
      FB.uid = null; FB.email = ""; S.items = new Map(); S.cats = clone(DEFAULT_CATS); S.loaded = false;
      authMode = "login"; drawAuth(); authEl.hidden = false; render();
      return;
    }
    authEl.hidden = true; authEl.innerHTML = "";
    FB.uid = user.uid; FB.email = user.email || "";
    S.loaded = false; render();
    const slow = setTimeout(() => { if (!S.loaded){ S.loaded = true; render(); banner("A ligação está lenta. Mostro o que está guardado neste aparelho."); } }, 10000);
    FB.unsub.push(onSnapshot(doc(FB.db, "users", user.uid), s => {
      const d = s.exists() ? s.data() : null;
      if (d && Array.isArray(d.cats) && d.cats.length) S.cats = clone(d.cats);
      render();
    }, () => {}));
    FB.unsub.push(onSnapshot(collection(FB.db, "users", user.uid, "items"), snap => {
      S.items = new Map(snap.docs.map(d => [d.id, Object.assign(clone(d.data()), {id: d.id})]));
      S.loaded = true; clearTimeout(slow);
      netBanner(); render();
    }, err => {
      clearTimeout(slow); S.loaded = true;
      if (err && err.code === "permission-denied"){ writable = false; banner("O Firestore recusou o acesso. Confirma que as regras de segurança foram publicadas."); }
      else banner("Perdi a ligação aos teus dados. Fecha e volta a abrir a app.");
      render();
    }));
  });
}

/* ---------- service worker (funciona offline) ---------- */
if ("serviceWorker" in navigator && location.protocol === "https:"){
  window.addEventListener("load", () => { navigator.serviceWorker.register("./sw.js").catch(() => {}); });
}
