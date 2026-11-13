// ── Family conclusions ("מסקנות משפחתיות") ─────────────────────────────────
// A shared notebook of lessons learned: anyone opens a topic (an event, a trip,
// "Pesach 2026"…) and every participant adds conclusions to it. Conclusions
// show as anonymous to the family; the admin page (editMode) sees who wrote
// each one. Any topic can produce a printable / shareable report.
//
// Self-contained like poker.js: it builds its own overlay (#cnOverlay) on
// first open, so index.html / admin.html only need the css + script tags and
// a tile calling openConclusionsOverlay().
//
// Storage — one doc under appData/* (already open in the Firestore rules):
//   appData/conclusions {
//     topics:{id:{id,title,emoji,desc,ts,by,closed}},
//     items:{id:{id,tid,text,kind,ts,by,agree:{dev:{name,ts}},disagree:{dev:{name,ts}},pin,edited}}
//   }
//   by = {fid,name,dev}   (dev = this device's random id, so the writer can
//                          edit/delete their own conclusion)
// Every write runs in a Firestore transaction so two phones can't clobber
// each other.
(function(){
'use strict';

const FS_URL='https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js';
const KINDS=[
  {k:'good',ico:'✅',lbl:'מה עבד טוב',c:'#15803D'},
  {k:'fix', ico:'🔧',lbl:'מה לשפר',c:'#C2410C'},
  {k:'next',ico:'💡',lbl:'לפעם הבאה',c:'#B45309'},
  {k:'gen', ico:'📌',lbl:'כללי',c:'#1D4ED8'}
];
const EMOJIS=['📝','🎉','✈️','🏕️','🍷','🕯️','🎂','🏠','💰','👨‍👩‍👧‍👦','🎁','📚'];
const MAX_LEN=600;

const S={D:{topics:{},items:{}},loaded:false,view:'list',tid:null,q:'',filter:'open',sort:'top',
  kind:'good',editId:null,modal:null,unsub:null,fs:null,busy:false,reportNames:true,anon:false};

// ── helpers ────────────────────────────────────────────────────────────────
const $=id=>document.getElementById(id);
function E(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function lsGet(k,def){try{const v=localStorage.getItem(k);return v==null?def:JSON.parse(v);}catch(e){return def;}}
function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}}
function toast(m,ms){if(typeof showToast==='function')showToast(m,ms);else console.log(m);}
function isAdmin(){try{return typeof editMode!=='undefined'&&!!editMode;}catch(e){return false;}}
function allFams(){try{return typeof families!=='undefined'?families:[];}catch(e){return [];}}
function famName(id){const f=allFams().find(x=>x.id===id);return f?String(f.name||''):'';}
function rid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6);}
function now(){return Date.now();}
function dev(){let d=lsGet('cnDev',null);if(!d){d='d'+rid();lsSet('cnDev',d);}return d;}
function fmtDate(ts){try{return new Date(ts).toLocaleDateString('he-IL',{day:'numeric',month:'numeric',year:'2-digit'});}catch(e){return '';}}
function fmtLong(ts){try{return new Date(ts).toLocaleDateString('he-IL',{day:'numeric',month:'long',year:'numeric'});}catch(e){return '';}}
function ago(ts){
  const m=Math.round((now()-ts)/60000);
  if(m<1)return 'עכשיו';if(m<60)return 'לפני '+m+' דק׳';
  const h=Math.round(m/60);if(h<24)return 'לפני '+h+' שע׳';
  const d=Math.round(h/24);if(d<8)return d===1?'אתמול':'לפני '+d+' ימים';
  return fmtDate(ts);
}
function kindOf(k){return KINDS.find(x=>x.k===k)||KINDS[3];}
function clean(o){return JSON.parse(JSON.stringify(o));}

// Who is writing — the name the admin will see next to the conclusion.
function myName(){
  const saved=(lsGet('cnName','')||'').trim();if(saved)return saved;
  try{if(typeof _fcmRegistrantName==='function'){const n=_fcmRegistrantName();if(n)return n;}}catch(e){}
  try{const c=(localStorage.getItem('chatName')||'').trim();if(c)return c;}catch(e){}
  return '';
}
function myFid(){try{return typeof _myFamId==='function'?_myFamId():null;}catch(e){return null;}}
function me(){return {fid:myFid(),name:myName()||(isAdmin()?'מנהל':'לא ידוע'),dev:dev()};}
function byLabel(by){
  if(!by)return 'לא ידוע';
  const fn=by.fid!=null?famName(by.fid):'';
  if(by.name&&by.name!=='לא ידוע')return by.name+(fn&&!by.name.includes(fn.replace('משפחת','').trim())?' · '+fn:'');
  return fn||'לא ידוע';
}
function mine(x){return x&&x.by&&x.by.dev===dev();}

// ── data views ─────────────────────────────────────────────────────────────
function topics(){return Object.values(S.D.topics||{});}
function itemsOf(tid){return Object.values(S.D.items||{}).filter(i=>i.tid===tid);}
function agreeN(i){return Object.keys(i.agree||{}).length;}
function disN(i){return Object.keys(i.disagree||{}).length;}
// net support, for "most agreed" ordering
function score(i){return agreeN(i)-disN(i);}
// who reacted — older entries stored just 1 instead of {name}
function reactNames(map){
  return Object.keys(map||{}).map(d=>{const v=map[d];return d===dev()?'אתם':(v&&v.name)||'לא ידוע';});
}
function tipFor(map,label){const n=reactNames(map);return n.length?label+': '+n.join(', '):'';}
function lastActivity(t){return itemsOf(t.id).reduce((a,i)=>Math.max(a,i.ts),t.ts);}
function sortItems(list){
  const by=S.sort==='new'?(a,b)=>b.ts-a.ts:(a,b)=>score(b)-score(a)||agreeN(b)-agreeN(a)||b.ts-a.ts;
  return list.slice().sort((a,b)=>(b.pin?1:0)-(a.pin?1:0)||by(a,b));
}
// "new since I last looked" — per device
function seenMap(){return lsGet('cnSeen',{});}
function newCount(t){const s=seenMap()[t.id]||0;return itemsOf(t.id).filter(i=>i.ts>s&&!mine(i)).length;}
function markSeen(tid){const s=seenMap();s[tid]=now();lsSet('cnSeen',s);}

// ── Firestore ──────────────────────────────────────────────────────────────
async function fsCtx(){
  if(S.fs)return S.fs;
  if(window.CN_FAKE_FS)return S.fs=window.CN_FAKE_FS;
  const fb=await fbInit();const mod=await import(FS_URL);
  return S.fs={db:fb.db,doc:fb.doc,onSnapshot:fb.onSnapshot,runTransaction:mod.runTransaction};
}
const ref=fs=>fs.doc(fs.db,'appData','conclusions');
function subscribe(){
  if(S.unsub)return;
  fsCtx().then(fs=>{
    if(S.unsub)return;
    S.unsub=fs.onSnapshot(ref(fs),snap=>{
      const d=snap.exists()?snap.data():{};
      S.D={topics:d.topics||{},items:d.items||{}};S.loaded=true;
      render();homeUpdate();
    },e=>{console.warn('conclusions sync:',e);S.loaded=true;render();});
  }).catch(e=>console.warn('conclusions:',e));
}
async function txn(fn,okMsg){
  if(S.busy)return false;
  S.busy=true;
  try{
    const fs=await fsCtx();
    await fs.runTransaction(fs.db,async tx=>{
      const sn=await tx.get(ref(fs));
      const D=sn.exists()?clean(sn.data()):{};
      D.topics=D.topics||{};D.items=D.items||{};
      if(fn(D)===false)throw new Error('abort');
      tx.set(ref(fs),D);
    });
    if(okMsg)toast(okMsg);
    return true;
  }catch(e){
    if(e.message!=='abort'){console.warn(e);toast('⚠️ השמירה נכשלה — בדקו את החיבור');}
    return false;
  }finally{S.busy=false;}
}

// ── actions ────────────────────────────────────────────────────────────────
async function saveTopic(){
  const m=S.modal;if(!m)return;
  const title=($('cnTTitle').value||'').trim();
  const desc=($('cnTDesc').value||'').trim();
  if(!title){toast('כתבו שם לנושא');$('cnTTitle').focus();return;}
  const emoji=m.emoji||'📝';
  if(m.id){
    const ok=await txn(D=>{const t=D.topics[m.id];if(!t)return false;Object.assign(t,{title,desc,emoji});},'✅ הנושא עודכן');
    if(ok){S.modal=null;render();}
    return;
  }
  const id='t'+rid();
  const T={id,title,desc,emoji,ts:now(),by:me(),closed:false};
  const ok=await txn(D=>{D.topics[id]=T;},'✅ הנושא נפתח — אפשר להוסיף מסקנות');
  // show it right away, before the snapshot catches up
  if(ok){S.modal=null;S.D.topics[id]=S.D.topics[id]||T;openTopic(id);}
}
async function addItem(){
  const ta=$('cnText');if(!ta)return;
  const text=(ta.value||'').trim();
  if(!text){ta.focus();return;}
  if(text.length>MAX_LEN){toast('עד '+MAX_LEN+' תווים');return;}
  if(!myName()&&!isAdmin()){S.modal={kind:'name',then:'add'};render();return;}
  const tid=S.tid;const t=S.D.topics[tid];
  if(!t||t.closed){toast('הנושא סגור להוספה');return;}
  if(S.editId){
    const id=S.editId;
    const ok=await txn(D=>{const i=D.items[id];if(!i)return false;i.text=text;i.kind=S.kind;i.anon=!!S.anon;i.edited=now();},'✅ המסקנה עודכנה');
    if(ok){S.editId=null;S.anon=false;lsSet('cnDraft_'+tid,'');const t2=$('cnText');if(t2)t2.value='';render();}
    return;
  }
  const id='c'+rid();
  const ok=await txn(D=>{
    if(!D.topics[tid]||D.topics[tid].closed)return false;
    D.items[id]={id,tid,text,kind:S.kind,anon:!!S.anon,ts:now(),by:me(),agree:{},disagree:{}};
  },'✅ המסקנה נשמרה — תודה!');
  if(ok){S.anon=false;lsSet('cnDraft_'+tid,'');const t2=$('cnText');if(t2)t2.value='';markSeen(tid);render();}
}
function toggleAgree(id){
  const d=dev();
  react(id,'agree');
}
// 👍 / 👎 — one of the two per device; tapping the same one again removes it
function react(id,field){
  const d=dev();const other=field==='agree'?'disagree':'agree';
  const m=me();
  txn(D=>{const i=D.items[id];if(!i)return false;
    i[field]=i[field]||{};i[other]=i[other]||{};
    if(i[field][d])delete i[field][d];else{i[field][d]={name:m.name,fid:m.fid,ts:now()};delete i[other][d];}
  });
}
function delItem(id){
  const i=S.D.items[id];if(!i)return;
  if(!(mine(i)||isAdmin()))return;
  if(!confirm('למחוק את המסקנה?'))return;
  txn(D=>{delete D.items[id];},'🗑️ נמחקה');
}
function pinItem(id){if(!isAdmin())return;txn(D=>{const i=D.items[id];if(!i)return false;i.pin=!i.pin;});}
function editItem(id){
  const i=S.D.items[id];if(!i||!(mine(i)||isAdmin()))return;
  S.editId=id;S.kind=i.kind;S.anon=!!i.anon;render();
  const ta=$('cnText');if(ta){ta.value=i.text;ta.focus();cnCount();ta.scrollIntoView({block:'center',behavior:'smooth'});}
}
function toggleClosed(tid){
  if(!isAdmin())return;const t=S.D.topics[tid];if(!t)return;
  txn(D=>{D.topics[tid].closed=!D.topics[tid].closed;},t.closed?'🔓 הנושא נפתח מחדש':'🔒 הנושא נסגר — אפשר עדיין להפיק דוח');
}
function delTopic(tid){
  if(!isAdmin())return;const t=S.D.topics[tid];if(!t)return;
  const n=itemsOf(tid).length;
  if(!confirm(`למחוק את הנושא "${t.title}"${n?` ואת ${n} המסקנות שבו`:''}? אי אפשר לשחזר.`))return;
  txn(D=>{delete D.topics[tid];Object.keys(D.items).forEach(k=>{if(D.items[k].tid===tid)delete D.items[k];});},'🗑️ הנושא נמחק').then(ok=>{if(ok){S.view='list';S.tid=null;render();}});
}

// ── views ──────────────────────────────────────────────────────────────────
function ensureOverlay(){
  let o=$('cnOverlay');if(o)return o;
  o=document.createElement('div');o.id='cnOverlay';
  o.innerHTML='<div class="cn-top"><button class="cn-x" onclick="cnUI.back()" aria-label="חזרה">✕</button><div class="cn-title" id="cnTitle"></div><div id="cnTopAct"></div></div><div class="cn-body" id="cnBody"></div><div id="cnModal"></div>';
  document.body.appendChild(o);
  // long press on 👍/👎 (phones, incl. iPhone which has no contextmenu) → who reacted
  let lp=null,fired=false;
  o.addEventListener('touchstart',e=>{const b=e.target.closest('.cn-agree');if(!b)return;fired=false;
    lp=setTimeout(()=>{fired=true;cnUI.who(null,b);},500);},{passive:true});
  const stop=()=>{clearTimeout(lp);lp=null;};
  o.addEventListener('touchend',stop);o.addEventListener('touchmove',stop,{passive:true});
  o.addEventListener('click',e=>{if(fired&&e.target.closest('.cn-agree')){e.stopPropagation();e.preventDefault();fired=false;}},true);
  return o;
}
function render(){
  const o=$('cnOverlay');if(!o||!o.classList.contains('open'))return;
  // keep what's being typed across live re-renders
  const key=S.view+'|'+S.tid;const same=key===S._rk;S._rk=key;
  const ta=$('cnText');const draft=ta&&same?ta.value:null;const hadFocus=ta&&document.activeElement===ta;
  const sIn=$('cnSearch');const sFocus=sIn&&document.activeElement===sIn;
  if(S.view==='topic'&&!S.D.topics[S.tid]&&S.loaded){S.view='list';S.tid=null;}
  if(S.view==='report'&&!S.D.topics[S.tid]){S.view='list';}
  $('cnTitle').textContent=S.view==='list'?'📒 מסקנות משפחתיות':S.view==='report'?'📄 דוח מסקנות':(S.D.topics[S.tid]||{}).title||'';
  $('cnTopAct').innerHTML=S.view==='list'?`<button class="cn-btn cn-pri cn-sm" onclick="cnUI.newTopic()">+ נושא חדש</button>`
    :S.view==='topic'?`<button class="cn-btn cn-ghost cn-sm" onclick="cnUI.report()">📄 דוח</button>`:'';
  $('cnBody').innerHTML=!S.loaded?'<div class="cn-empty">טוען…</div>':S.view==='list'?listView():S.view==='topic'?topicView():reportView();
  $('cnModal').innerHTML=S.modal?modalView():'';
  const ta2=$('cnText');
  if(ta2){ta2.value=draft!=null?draft:(lsGet('cnDraft_'+S.tid,'')||'');cnCount();if(hadFocus){ta2.focus();ta2.setSelectionRange(ta2.value.length,ta2.value.length);}}
  if(sFocus){const s2=$('cnSearch');if(s2){s2.focus();s2.setSelectionRange(s2.value.length,s2.value.length);}}
}
function listView(){
  const all=topics();
  const q=S.q.trim();
  let list=all.filter(t=>S.filter==='all'||(S.filter==='open'?!t.closed:t.closed));
  if(q)list=list.filter(t=>(t.title+' '+(t.desc||'')).includes(q)||itemsOf(t.id).some(i=>i.text.includes(q)));
  list.sort((a,b)=>lastActivity(b)-lastActivity(a));
  const nOpen=all.filter(t=>!t.closed).length,nClosed=all.length-nOpen;
  const totalItems=Object.keys(S.D.items||{}).length;
  const hero=`<div class="cn-hero"><div class="cn-hero-ico">📒</div><div><b>מה למדנו?</b><small>פותחים נושא — כל אחד מוסיף מה עבד, מה לשפר ומה לזכור לפעם הבאה.</small></div></div>`;
  if(!all.length)return hero+`<div class="cn-empty"><div style="font-size:40px">🗒️</div><p>עוד אין נושאים.</p><button class="cn-btn cn-pri" onclick="cnUI.newTopic()">+ פותחים נושא ראשון</button></div>`;
  return hero+`
  <div class="cn-stats"><span><b>${all.length}</b> נושאים</span><span><b>${totalItems}</b> מסקנות</span></div>
  <input id="cnSearch" class="cn-input cn-search" placeholder="🔍 חיפוש בנושאים ובמסקנות" value="${E(S.q)}" oninput="cnUI.search(this.value)">
  <div class="cn-seg">
    <button class="${S.filter==='open'?'on':''}" onclick="cnUI.filter('open')">פתוחים (${nOpen})</button>
    <button class="${S.filter==='closed'?'on':''}" onclick="cnUI.filter('closed')">סגורים (${nClosed})</button>
    <button class="${S.filter==='all'?'on':''}" onclick="cnUI.filter('all')">הכול</button>
  </div>
  ${list.length?list.map(topicCard).join(''):'<div class="cn-empty"><p>לא נמצאו נושאים.</p></div>'}`;
}
function topicCard(t){
  const its=itemsOf(t.id);const nw=newCount(t);
  const counts=KINDS.map(k=>({k,n:its.filter(i=>i.kind===k.k).length})).filter(x=>x.n);
  return `<button class="cn-tcard ${t.closed?'closed':''}" onclick="cnUI.open('${t.id}')">
    <span class="cn-tico">${E(t.emoji||'📝')}</span>
    <span class="cn-tmain"><b>${E(t.title)}${t.closed?' <i class="cn-lock">🔒 סגור</i>':''}</b>
      ${t.desc?`<small class="cn-tdesc">${E(t.desc)}</small>`:''}
      <small class="cn-tmeta">${its.length?`${its.length} מסקנות · ${counts.map(x=>x.k.ico+x.n).join(' ')} · `:'אין עדיין מסקנות · '}${ago(lastActivity(t))}</small></span>
    ${nw?`<span class="cn-new">${nw} חדשות</span>`:''}
  </button>`;
}
function topicView(){
  const t=S.D.topics[S.tid];if(!t)return '';
  const its=sortItems(itemsOf(t.id));
  const admin=isAdmin();
  const writers=new Set(itemsOf(t.id).map(i=>i.by&&i.by.dev)).size;
  const head=`<div class="cn-thead">
    <div class="cn-thead-ico">${E(t.emoji||'📝')}</div>
    <div class="cn-thead-main">${t.desc?`<p>${E(t.desc)}</p>`:''}<small>נפתח ${fmtLong(t.ts)} · ${its.length} מסקנות · ${writers} משתתפים · פתח: ${E(byLabel(t.by))}</small></div>
  </div>
  ${(admin||mine(t))?`<div class="cn-admbar">
    <button class="cn-btn cn-ghost cn-sm" onclick="cnUI.editTopic('${t.id}')">✏️ עריכת נושא</button>
    ${admin?`<button class="cn-btn cn-ghost cn-sm" onclick="cnUI.toggleClosed('${t.id}')">${t.closed?'🔓 פתיחה מחדש':'🔒 סגירת הנושא'}</button>
    <button class="cn-btn cn-ghost cn-sm cn-danger" onclick="cnUI.delTopic('${t.id}')">🗑️ מחיקה</button>`:''}
  </div>`:''}
  ${admin?'<div class="cn-admnote">👁️ מצב מנהל — אתם רואים גם מי כתב את המסקנות האנונימיות</div>':''}`;
  const add=t.closed?`<div class="cn-closedbox">🔒 הנושא סגור להוספת מסקנות. אפשר עדיין לקרוא ולהפיק דוח.</div>`:`
  <div class="cn-add ${S.editId?'editing':''}">
    <div class="cn-add-h">${S.editId?'✏️ עריכת מסקנה':'✍️ הוסיפו מסקנה'}<span class="cn-anon">${E(myName()?'בשם: '+myName():'')}</span></div>
    <div class="cn-kinds">${KINDS.map(k=>`<button class="${S.kind===k.k?'on':''}" style="--k:${k.c}" onclick="cnUI.kind('${k.k}')">${k.ico} ${k.lbl}</button>`).join('')}</div>
    <textarea id="cnText" class="cn-input" rows="3" maxlength="${MAX_LEN}" placeholder="${E(placeholderFor(S.kind))}" oninput="cnUI.draft(this.value)"></textarea>
    <div class="cn-add-f"><small id="cnCount"></small>
      ${S.editId?`<button class="cn-btn cn-ghost cn-sm" onclick="cnUI.cancelEdit()">ביטול</button>`:''}
      <button class="cn-anon-tg ${S.anon?'on':''}" onclick="cnUI.anon()" title="רק המנהל יראה מי כתב">🕶️ ${S.anon?'אנונימי ✓':'אנונימי'}</button>
      <button class="cn-btn cn-pri" onclick="cnUI.add()">${S.editId?'שמירה':'הוספה'}</button></div>
  </div>`;
  const tools=its.length?`<div class="cn-tools"><span>${its.length} מסקנות</span>
    <div class="cn-seg cn-seg-sm"><button class="${S.sort==='top'?'on':''}" onclick="cnUI.sort('top')">👍 מוסכמות</button><button class="${S.sort==='new'?'on':''}" onclick="cnUI.sort('new')">🕒 חדשות</button></div></div>`:'';
  const list=its.length?its.map(itemCard).join(''):`<div class="cn-empty"><div style="font-size:34px">💭</div><p>עוד אין מסקנות. תהיו הראשונים!</p></div>`;
  return head+add+tools+list+(its.length?`<button class="cn-btn cn-pri cn-big" onclick="cnUI.report()">📄 הפקת דוח מסקנות</button>`:'');
}
function placeholderFor(k){
  return {good:'למשל: ההתארגנות מראש על חלוקת התפקידים עבדה מצוין',fix:'למשל: להתחיל את ההכנות לפחות שבוע לפני',next:'למשל: להזמין את המקום חודשיים מראש',gen:'כתבו כאן את המסקנה…'}[k]||'';
}
function itemCard(i){
  const k=kindOf(i.kind);const n=agreeN(i),nd=disN(i);const iAgree=!!(i.agree||{})[dev()],iDis=!!(i.disagree||{})[dev()];
  const admin=isAdmin();const own=mine(i);
  return `<div class="cn-item ${i.pin?'pinned':''}" style="--k:${k.c}">
    <div class="cn-item-top"><span class="cn-kind" style="color:${k.c}">${k.ico} ${k.lbl}</span>${i.pin?'<span class="cn-pin">⭐ מסקנה מרכזית</span>':''}</div>
    <div class="cn-item-txt">${E(i.text).replace(/\n/g,'<br>')}</div>
    <div class="cn-item-f">
      <span class="cn-reacts">
        <button class="cn-agree ${iAgree?'on':''}" data-tip="${E(tipFor(i.agree,'👍 מסכימים'))}" onclick="cnUI.agree('${i.id}')" oncontextmenu="return cnUI.who(event,this)">👍 ${iAgree?'מסכימים':'מסכים'}${n?` · ${n}`:''}</button>
        <button class="cn-agree cn-dis ${iDis?'on':''}" data-tip="${E(tipFor(i.disagree,'👎 לא מסכימים'))}" onclick="cnUI.disagree('${i.id}')" oncontextmenu="return cnUI.who(event,this)">👎${nd?` ${nd}`:''}</button>
      </span>
      <span class="cn-who">${whoHtml(i,admin,own)}${ago(i.ts)}${i.edited?' · נערך':''}</span>
      <span class="cn-item-act">
        ${admin?`<button title="מסקנה מרכזית" onclick="cnUI.pin('${i.id}')">${i.pin?'★':'☆'}</button>`:''}
        ${own||admin?`<button title="עריכה" onclick="cnUI.edit('${i.id}')">✏️</button><button title="מחיקה" onclick="cnUI.del('${i.id}')">🗑️</button>`:''}
      </span>
    </div>
  </div>`;
}

// Writer line on a conclusion: the name for everyone, unless it was posted
// anonymously — then only the admin sees who wrote it.
function whoHtml(i,admin,own){
  if(i.anon)return admin?`🕶️ <b>${E(byLabel(i.by))}</b> (אנונימי) · `:own?'🕶️ <b>כתבתם</b> (אנונימי) · ':'🕶️ אנונימי · ';
  return `✍️ <b>${E(byLabel(i.by))}</b> · `;
}
function reportBy(i){return i.anon&&!isAdmin()?'אנונימי':byLabel(i.by)+(i.anon?' (אנונימי)':'');}

// ── the report ─────────────────────────────────────────────────────────────
function reportData(tid){
  const t=S.D.topics[tid];const its=itemsOf(tid);
  const byAgree=(a,b)=>score(b)-score(a)||agreeN(b)-agreeN(a)||a.ts-b.ts;
  const groups=KINDS.map(k=>({k,list:its.filter(i=>i.kind===k.k).sort(byAgree)})).filter(g=>g.list.length);
  const pinned=its.filter(i=>i.pin).sort(byAgree);
  const top=its.filter(i=>!i.pin&&score(i)>0).sort(byAgree).slice(0,3);
  const writers=new Set(its.map(i=>i.by&&i.by.dev)).size;
  const first=its.length?Math.min(...its.map(i=>i.ts)):t.ts,last=its.length?Math.max(...its.map(i=>i.ts)):t.ts;
  return {t,its,groups,pinned,top,writers,first,last};
}
function reportView(){
  const R=reportData(S.tid);const t=R.t;
  const names=S.reportNames;
  const line=i=>`<li><span>${E(i.text).replace(/\n/g,'<br>')}</span>${agreeN(i)?`<em>👍 ${agreeN(i)}</em>`:''}${disN(i)?`<em class="dis">👎 ${disN(i)}</em>`:''}${names?`<small>— ${E(reportBy(i))}</small>`:''}</li>`;
  return `<div class="cn-report-tools">
    <button class="cn-btn cn-pri" onclick="cnUI.print()">🖨️ הדפסה / PDF</button>
    <button class="cn-btn cn-ghost" onclick="cnUI.share()">📤 שיתוף</button>
    <button class="cn-btn cn-ghost" onclick="cnUI.copy()">📋 העתקה</button>
    <label class="cn-chk"><input type="checkbox" ${S.reportNames?'checked':''} onchange="cnUI.reportNames(this.checked)"> כולל שמות הכותבים</label>
  </div>
  <div class="cn-report" id="cnReport">
    <div class="cn-r-head">
      <div class="cn-r-brand">משפחת ינקלביץ · מסקנות משפחתיות</div>
      <h1>${E(t.emoji||'📝')} ${E(t.title)}</h1>
      ${t.desc?`<p class="cn-r-desc">${E(t.desc)}</p>`:''}
      <div class="cn-r-meta">הופק ב-${fmtLong(now())} · ${R.its.length} מסקנות מ-${R.writers} משתתפים${R.its.length?` · נכתבו בין ${fmtDate(R.first)} ל-${fmtDate(R.last)}`:''}</div>
    </div>
    ${R.its.length?`
    <div class="cn-r-sum">${R.groups.map(g=>`<div style="--k:${g.k.c}"><b>${g.list.length}</b><span>${g.k.ico} ${g.k.lbl}</span></div>`).join('')}</div>
    ${R.pinned.length?`<section class="cn-r-sec cn-r-key"><h2>⭐ מסקנות מרכזיות</h2><ol>${R.pinned.map(line).join('')}</ol></section>`:''}
    ${R.top.length?`<section class="cn-r-sec cn-r-top"><h2>👍 הכי מוסכמות במשפחה</h2><ol>${R.top.map(line).join('')}</ol></section>`:''}
    ${R.groups.map(g=>`<section class="cn-r-sec" style="--k:${g.k.c}"><h2>${g.k.ico} ${g.k.lbl} <small>(${g.list.length})</small></h2><ul>${g.list.map(line).join('')}</ul></section>`).join('')}
    `:'<p class="cn-empty">אין עדיין מסקנות בנושא הזה.</p>'}
    <div class="cn-r-foot">נוצר באפליקציית ינקלביץ</div>
  </div>`;
}
function reportText(){
  const R=reportData(S.tid);const t=R.t;const names=S.reportNames;
  const ln=(i,j,b)=>`${b?b:(j+1)+'.'} ${i.text}${agreeN(i)||disN(i)?` (${agreeN(i)?'👍'+agreeN(i):''}${agreeN(i)&&disN(i)?' ':''}${disN(i)?'👎'+disN(i):''})`:''}${names?` — ${reportBy(i)}`:''}`;
  let s=`📒 *דוח מסקנות: ${t.emoji||''} ${t.title}*\n`;
  if(t.desc)s+=`${t.desc}\n`;
  s+=`${R.its.length} מסקנות מ-${R.writers} משתתפים · ${fmtLong(now())}\n`;
  if(R.pinned.length)s+=`\n⭐ *מסקנות מרכזיות*\n`+R.pinned.map((i,j)=>ln(i,j)).join('\n')+'\n';
  R.groups.forEach(g=>{s+=`\n${g.k.ico} *${g.k.lbl}*\n`+g.list.map((i,j)=>ln(i,j,'•')).join('\n')+'\n';});
  return s.trim();
}
function doPrint(){
  document.body.classList.add('cn-printing');
  const done=()=>{document.body.classList.remove('cn-printing');window.removeEventListener('afterprint',done);};
  window.addEventListener('afterprint',done);
  setTimeout(()=>{window.print();setTimeout(done,1500);},50);
}
async function doShare(){
  const text=reportText();
  if(navigator.share){try{await navigator.share({text});return;}catch(e){if(e&&e.name==='AbortError')return;}}
  window.open('https://wa.me/?text='+encodeURIComponent(text),'_blank');
}
async function doCopy(){
  const text=reportText();
  try{await navigator.clipboard.writeText(text);toast('📋 הדוח הועתק');}
  catch(e){const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');toast('📋 הדוח הועתק');}catch(_){toast('ההעתקה נכשלה');}ta.remove();}
}

// ── modals ─────────────────────────────────────────────────────────────────
function modalView(){
  const m=S.modal;
  if(m.kind==='topic'){
    return `<div class="cn-mback" onclick="if(event.target===this)cnUI.closeModal()"><div class="cn-mbox">
      <h3>${m.id?'✏️ עריכת נושא':'📒 נושא חדש'}</h3>
      <label class="cn-lbl">על מה מסיקים מסקנות?</label>
      <input id="cnTTitle" class="cn-input" maxlength="60" placeholder="למשל: חתונה של שירה / טיול בצפון / פסח תשפ״ז" value="${E(m.title||'')}">
      <label class="cn-lbl">כמה מילים (לא חובה)</label>
      <textarea id="cnTDesc" class="cn-input" rows="2" maxlength="200" placeholder="מה קרה, מתי, מי היה">${E(m.desc||'')}</textarea>
      <label class="cn-lbl">סמל</label>
      <div class="cn-emojis">${EMOJIS.map(e=>`<button class="${(m.emoji||'📝')===e?'on':''}" onclick="cnUI.pickEmoji('${e}')">${e}</button>`).join('')}</div>
      <div class="cn-mf"><button class="cn-btn cn-ghost" onclick="cnUI.closeModal()">ביטול</button><button class="cn-btn cn-pri" onclick="cnUI.saveTopic()">${m.id?'שמירה':'פתיחת הנושא'}</button></div>
    </div></div>`;
  }
  if(m.kind==='name'){
    return `<div class="cn-mback" onclick="if(event.target===this)cnUI.closeModal()"><div class="cn-mbox">
      <h3>🕶️ רגע לפני</h3>
      <p class="cn-muted">השם יופיע ליד המסקנות שתכתבו. אם תבחרו <b>🕶️ אנונימי</b> — רק מנהל האפליקציה יראה מי כתב.</p>
      <label class="cn-lbl">מה השם שלך?</label>
      <input id="cnNameIn" class="cn-input" maxlength="30" placeholder="שם פרטי ומשפחה" onkeydown="if(event.key==='Enter')cnUI.saveName()">
      <div class="cn-mf"><button class="cn-btn cn-ghost" onclick="cnUI.closeModal()">ביטול</button><button class="cn-btn cn-pri" onclick="cnUI.saveName()">המשך</button></div>
    </div></div>`;
  }
  return '';
}

// ── home tile ──────────────────────────────────────────────────────────────
function homeUpdate(){
  const sub=$('homeTileCnSub'),badge=$('cnHomeBadge');
  if(!sub&&!badge)return;
  const ts=topics();const open=ts.filter(t=>!t.closed);
  const nw=ts.reduce((a,t)=>a+newCount(t),0);
  if(sub)sub.textContent=!ts.length?'מה למדנו? פותחים נושא ומוסיפים מסקנות':nw?`${nw} מסקנות חדשות מאז הביקור האחרון`:`${open.length} נושאים פתוחים · ${Object.keys(S.D.items||{}).length} מסקנות`;
  if(badge){badge.style.display=nw?'flex':'none';badge.textContent=nw;}
}

// ── navigation ─────────────────────────────────────────────────────────────
function open(tid){
  const o=ensureOverlay();
  o.classList.add('open');document.body.style.overflow='hidden';
  if(typeof _setHash==='function')_setHash('conclusions');
  subscribe();
  if(typeof tid==='string'&&tid)openTopic(tid);else{S.view='list';render();}
}
function openTopic(tid){
  S.view='topic';S.tid=tid;S.editId=null;S.modal=null;
  render();markSeen(tid);homeUpdate();
  const b=$('cnBody');if(b)b.scrollTop=0;
}
function back(){
  if(S.modal){S.modal=null;render();return;}
  if(S.view==='report'){S.view='topic';render();return;}
  if(S.view==='topic'){markSeen(S.tid);S.view='list';S.tid=null;S.editId=null;render();homeUpdate();return;}
  close();
}
function close(){
  const o=$('cnOverlay');if(o)o.classList.remove('open');
  document.body.style.overflow='';
  if(typeof _clearHash==='function')_clearHash('conclusions');
  homeUpdate();
}
function cnCount(){const ta=$('cnText'),c=$('cnCount');if(ta&&c)c.textContent=ta.value.length?`${ta.value.length}/${MAX_LEN}`:'';}

// background sync for the home tile (badge for new conclusions)
setTimeout(()=>{subscribe();},1500);

window.openConclusionsOverlay=open;
window.closeConclusionsOverlay=close;
window.cnUI={
  back,open:openTopic,
  newTopic(){S.modal={kind:'topic',emoji:'📝'};render();setTimeout(()=>{const i=$('cnTTitle');if(i)i.focus();},50);},
  editTopic(tid){const t=S.D.topics[tid];if(!t)return;S.modal={kind:'topic',id:tid,title:t.title,desc:t.desc,emoji:t.emoji};render();},
  pickEmoji(e){const m=S.modal;m.title=$('cnTTitle').value;m.desc=$('cnTDesc').value;m.emoji=e;render();},
  saveTopic,toggleClosed,delTopic,
  closeModal(){S.modal=null;render();},
  saveName(){const v=($('cnNameIn').value||'').trim();if(!v){$('cnNameIn').focus();return;}lsSet('cnName',v);const then=S.modal&&S.modal.then;S.modal=null;render();if(then==='add')addItem();},
  search(v){S.q=v;render();},
  filter(f){S.filter=f;render();},
  sort(s){S.sort=s;render();},
  kind(k){S.kind=k;render();},
  anon(){S.anon=!S.anon;render();},
  draft(v){lsSet('cnDraft_'+S.tid,v);cnCount();},
  add:addItem,agree:toggleAgree,disagree(id){react(id,'disagree');},
  // phones have no hover: a long press shows who reacted
  who(ev,el){if(ev)ev.preventDefault();const t=el.getAttribute('data-tip');toast(t||'עוד אף אחד לא סימן',3500);return false;},del:delItem,pin:pinItem,edit:editItem,
  cancelEdit(){S.editId=null;const ta=$('cnText');if(ta)ta.value='';lsSet('cnDraft_'+S.tid,'');render();},
  report(){S.view='report';S.modal=null;render();const b=$('cnBody');if(b)b.scrollTop=0;},
  reportNames(v){S.reportNames=!!v;render();},
  print:doPrint,share:doShare,copy:doCopy
};
window.__cn={S,reportText};
})();
