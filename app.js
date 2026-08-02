const COLORS=[
  {bg:'#EEEDFE',c:'#3C3489'},{bg:'#E1F5EE',c:'#085041'},
  {bg:'#FAECE7',c:'#712B13'},{bg:'#FBEAF0',c:'#72243E'},
  {bg:'#E6F1FB',c:'#0C447C'},{bg:'#EAF3DE',c:'#27500A'},
  {bg:'#FAEEDA',c:'#633806'},{bg:'#FCEBEB',c:'#791F1F'},
];
let families=[];
let events=[];
let nxtId=1,nxtFam=1,actYear='all',expanded=new Set();
let collapsedEvents=new Set(),collapsedGoals=new Set(),expandedArchGoals=new Set();
let expandedCumFamilies=new Set();
let expandedPotFamilies=new Set();
let addExpItemEvId=null,addExpItemFamId=null,addExpItemSharedWith=null,addExpItemSplitMode='equal',_editExpItemId=null,addExpItemFromPot=false;
const expandedExpItems=new Set();
const expandedFamShares=new Set();
let cumPotEvId=null,cumPotFamId=null;
let messages=[];
let calItems=[];
let birthdays=[];
let nxtMsg=1,nxtCal=1,nxtBday=1;
let currentShell='home';
let calYear=new Date().getFullYear(),calMonth=new Date().getMonth(),calSelDay=null,calHebrew=true;
let calHebRefDate=new Date();
let fundTxOpen=false;
let settleModalEvId=null,potModalEvId=null,potTrModalEvId=null;
let _cumPotFromFund=false;
let _ppEvId=null,_ppFrom=null,_ppFromFid=null,_ppTo=null,_ppToFid=null,_ppMax=0,_ppFund=false,_ppSettle=false,_ppPot=false;
let adminPass='';
let editMode=false;
function toggleEvCollapse(evId){
  if(collapsedEvents.has(evId)){collapsedEvents.delete(evId);history.replaceState(null,'','#event-'+evId);}
  else{collapsedEvents.add(evId);history.replaceState(null,'','#events');}
  renderOpenList();
}
function toggleGoalCollapse(goalId){
  if(collapsedGoals.has(goalId))collapsedGoals.delete(goalId);else collapsedGoals.add(goalId);
  renderGoalFunds();
}
// fund: יתרה פנימית לכל משפחה + היסטוריית תנועות
// famBalances: {famId: number} — כמה כל משפחה הפקידה פחות מה שיצא
// transactions: [{id,type:'deposit'|'payout',famId,toFamId?,amount,desc,date}]
let fund={ famBalances:{}, transactions:[] };
let nxtTx=1;
// סך הקופה = סכום כל היתרות החיוביות
const fundTotal=()=>Object.values(fund.famBalances).filter(v=>v>0).reduce((s,v)=>s+v,0);
const famFundBal=fid=>(fund.famBalances[String(fid)]||0);
// קופות למטרה: {id, name, target, contributions:{famId:amount}, closed}
let goalFunds=[];
let nxtGoal=1;
// קופת חיסכון כללית: {expenses:[{id,name,amt,date}], nxtExpId}
let savingsPot={expenses:[],nxtExpId:1};
const goalTotal=g=>Object.values(g.contributions||{}).reduce((s,v)=>s+v,0);
const col=id=>COLORS[(id-1)%COLORS.length];
const ini=n=>n.replace('משפחת','').trim().slice(0,2);
const getFam=id=>families.find(f=>f.id===id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const evCost=ev=>(ev.totalCost!=null?ev.totalCost:ev.participants.reduce((s,fid)=>s+(ev.expenses[fid]||0),0))+evPotExpTotal(ev);
const evShare=ev=>{ const n=ev.participants.length; return n?Math.round(evCost(ev)/n):0; };
const FAM_ADULTS=2;
const SPLIT_LABELS={equal:'שווה לכל משפחה',percapita:'לפי נפשות',weighted:'ילד = 50% ממבוגר'};
const famWeight=(f,method,childOverride,parentOverride)=>{
  if(!f) return 1;
  const ch=childOverride!=null?childOverride:(f.children||0);
  const adults=parentOverride!=null?parentOverride:FAM_ADULTS;
  if(method==='percapita') return adults+ch;
  if(method==='weighted') return adults+ch*0.5;
  return 1;
};
const evShares=ev=>{
  const method=ev.splitMethod||'equal';
  const totalCost=evCost(ev);
  const partialItems=(ev.expenseItems||[]).filter(it=>
    it.customSplit||
    (it.sharedWith&&it.sharedWith.length>0&&it.sharedWith.length<ev.participants.length)
  );
  const partialAmt=partialItems.reduce((s,it)=>s+it.amt,0);
  const globalCost=totalCost-partialAmt;
  let totalW=0; const w={};
  ev.participants.forEach(fid=>{ w[fid]=famWeight(getFam(fid),method,ev.childOverrides?.[fid],ev.parentOverrides?.[fid]); totalW+=w[fid]; });
  if(!totalW) return Object.fromEntries(ev.participants.map(fid=>[fid,0]));
  const exact={};
  ev.participants.forEach(fid=>{ exact[fid]=globalCost*(w[fid]/totalW); });
  partialItems.forEach(it=>{
    if(it.customSplit){
      Object.entries(it.customSplit).forEach(([fid,a])=>{const nfid=parseInt(fid);if(ev.participants.includes(nfid))exact[nfid]=(exact[nfid]||0)+a;});
    }else{
      const sw=it.sharedWith.filter(fid=>ev.participants.includes(fid));
      if(!sw.length)return;
      sw.forEach(fid=>{ exact[fid]=(exact[fid]||0)+it.amt/sw.length; });
    }
  });
  const floors={};
  ev.participants.forEach(fid=>{ floors[fid]=Math.floor(exact[fid]||0); });
  let remainder=Math.round(totalCost-ev.participants.reduce((s,fid)=>s+floors[fid],0));
  const sorted=[...ev.participants].sort((a,b)=>((exact[b]||0)-floors[b])-((exact[a]||0)-floors[a]));
  const hasSavings=!!(ev.savingsTotal||ev.savingsAmt);
  const shares={...floors};
  if(hasSavings){
    // When savings are set, round everyone up; the surplus over totalCost goes to the savings pot
    ev.participants.forEach(fid=>{ shares[fid]=Math.ceil(exact[fid]||0); });
  }else{
    for(let i=0;i<remainder&&i<sorted.length;i++) shares[sorted[i]]++;
  }
  const savingsPerFam=ev.savingsTotal?Math.round(ev.savingsTotal/(ev.participants.length||1)):(ev.savingsAmt||0);
  if(savingsPerFam>0) ev.participants.forEach(fid=>{shares[fid]=(shares[fid]||0)+savingsPerFam;});
  return shares;
};
// Returns the extra shekels from ceiling-rounding that flow into the savings pot for this event
const evSavingsSurplus=ev=>{
  if(!ev.savingsTotal&&!ev.savingsAmt)return 0;
  const _sh=evShares(ev);
  const _spf=ev.savingsTotal?Math.round(ev.savingsTotal/((ev.participants||[]).length||1)):(ev.savingsAmt||0);
  const _sum=(ev.participants||[]).reduce((s,fid)=>s+(_sh[fid]||0),0);
  return Math.max(0,Math.round(_sum-_spf*(ev.participants||[]).length-evCost(ev)));
};
const evBalance=ev=>{ const shares=evShares(ev); const res={}; ev.participants.forEach(fid=>{ res[fid]=(ev.expenses[fid]||0)-(shares[fid]||0); }); return res; };
const evPotTotal=ev=>(ev.potPayments||[]).reduce((s,p)=>s+p.amt,0);
const evPotExpTotal=ev=>(ev.potExpItems||[]).reduce((s,it)=>s+it.amt,0);
const evNetPotBal=ev=>Math.max(0,evPotTotal(ev)-evPotExpTotal(ev));
// Original deposit per family = remaining potPayments + already-transferred + excess-refunded settled entries
const evPotOrigByFam=ev=>{
  const r={};
  (ev.potPayments||[]).forEach(p=>{r[p.famId]=(r[p.famId]||0)+p.amt;});
  (ev.settled||[]).filter(s=>(s.method==='pot'||s.method==='pot-refund')&&s.fromFid!=null).forEach(s=>{r[s.fromFid]=(r[s.fromFid]||0)+s.amt;});
  return r;
};
// Amount transferred to creditors per depositing family
const evPotTransByFam=ev=>{
  const r={};
  (ev.settled||[]).filter(s=>s.method==='pot'&&s.fromFid!=null).forEach(s=>{r[s.fromFid]=(r[s.fromFid]||0)+s.amt;});
  return r;
};
// Excess amounts refunded back to depositing family
const evPotRefundByFam=ev=>{
  const r={};
  (ev.settled||[]).filter(s=>s.method==='pot-refund'&&s.fromFid!=null).forEach(s=>{r[s.fromFid]=(r[s.fromFid]||0)+s.amt;});
  return r;
};
// Savings pot helpers
const savingsPotContrib=()=>events.reduce((s,ev)=>
  s+(ev.savingsPaid||[]).reduce((ss,p)=>ss+p.amt,0)
   +(ev.potToSavings||[]).reduce((ss,p)=>ss+p.amt,0),0);
const savingsPotExpTotal=()=>(savingsPot.expenses||[]).reduce((s,e)=>s+e.amt,0);
const savingsPotBal=()=>savingsPotContrib()-savingsPotExpTotal();
function evEffectivePotPayments(ev){
  const payments=ev.potPayments||[];
  const expTotal=evPotExpTotal(ev);
  if(!expTotal)return payments;
  const total=payments.reduce((s,p)=>s+p.amt,0);
  if(!total)return payments;
  if(expTotal>=total)return payments.map(p=>({...p,amt:0}));
  const factor=(total-expTotal)/total;
  return payments.map(p=>({...p,amt:Math.round(p.amt*factor)}));
}
function evAdjBalance(ev){
  const adjBal=evBalance(ev);
  (ev.settled||[]).forEach(s=>{
    const fromFid=ev.participants.find(fid=>{ const f=getFam(fid); return f&&f.name.replace('משפחת','').trim()===s.from; });
    const toFid=ev.participants.find(fid=>{ const f=getFam(fid); return f&&f.name.replace('משפחת','').trim()===s.to; });
    if(fromFid!=null) adjBal[fromFid]=(adjBal[fromFid]||0)+s.amt;
    if(toFid!=null) adjBal[toFid]=(adjBal[toFid]||0)-s.amt;
  });
  (ev.potPayments||[]).forEach(p=>{ adjBal[p.famId]=(adjBal[p.famId]||0)+p.amt; });
  (ev.savingsPaid||[]).forEach(p=>{ adjBal[p.famId]=(adjBal[p.famId]||0)+p.amt; });
  return adjBal;
}
const shareLabel=ev=>{
  const method=ev.splitMethod||'equal';
  if(method==='equal') return 'חלק שווה: ₪'+evShare(ev).toLocaleString()+'/משפחה';
  return 'חלוקה: '+SPLIT_LABELS[method]+' · סה"כ ₪'+evCost(ev).toLocaleString();
};

const firebaseConfig = {
  apiKey: "AIzaSyA0MZMuGBBIXckhdiOZRZXRC_NPEte7pMA",
  authDomain: "yossi20361.firebaseapp.com",
  projectId: "yossi20361",
  storageBucket: "yossi20361.firebasestorage.app",
  messagingSenderId: "789621490367",
  appId: "1:789621490367:web:e62376e9d46a86903f7c0a"
};

let _fb=null,_fbApp=null;
const FCM_VAPID_KEY='BArxsmOWaMQFdVOKOxFczYqBOHMZxqLofJobilD5zslw5hHByEHpu4VU2PFTuDuqFQlauxjhVAoO4s6ob9vaj6w';
async function fbInit(){
  if(_fb) return _fb;
  const appMod=await import("https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js");
  const fsMod=await import("https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js");
  _fbApp=appMod.initializeApp(firebaseConfig);
  const db=fsMod.getFirestore(_fbApp);
  _fb={db,doc:fsMod.doc,getDoc:fsMod.getDoc,setDoc:fsMod.setDoc,onSnapshot:fsMod.onSnapshot};
  return _fb;
}

let _saving=false;

// EmailJS settings
async function loadEjsSettings(){
  try{
    const fb=await fbInit();
    const snap=await fb.getDoc(fb.doc(fb.db,'settings','emailjs'));
    if(snap.exists()){
      const d=snap.data();
      if(d.publicKey)  localStorage.setItem('ejsPublicKey', d.publicKey);
      if(d.serviceId)  localStorage.setItem('ejsServiceId', d.serviceId);
      if(d.templateId) localStorage.setItem('ejsTemplateId', d.templateId);
    }
  }catch(e){}
  const keyEl=document.getElementById('ejsPublicKey');
  const svcEl=document.getElementById('ejsServiceId');
  const tplEl=document.getElementById('ejsTemplateId');
  if(keyEl) keyEl.value=localStorage.getItem('ejsPublicKey')||'';
  if(svcEl) svcEl.value=localStorage.getItem('ejsServiceId')||'';
  if(tplEl) tplEl.value=localStorage.getItem('ejsTemplateId')||'';
  const key=localStorage.getItem('ejsPublicKey');
  if(key&&typeof emailjs!=='undefined') emailjs.init(key);
}
async function saveEjsSettings(){
  const key=document.getElementById('ejsPublicKey').value.trim();
  const svc=document.getElementById('ejsServiceId').value.trim();
  const tpl=document.getElementById('ejsTemplateId').value.trim();
  localStorage.setItem('ejsPublicKey',key);
  localStorage.setItem('ejsServiceId',svc);
  localStorage.setItem('ejsTemplateId',tpl);
  if(key&&typeof emailjs!=='undefined') emailjs.init(key);
  try{
    const fb=await fbInit();
    await fb.setDoc(fb.doc(fb.db,'settings','emailjs'),{publicKey:key,serviceId:svc,templateId:tpl});
  }catch(e){}
  const st=document.getElementById('ejsStatus');
  if(st){st.textContent='✓ נשמר';st.style.color='var(--green)';setTimeout(()=>{if(st)st.textContent='';},2500);}
}
function getPaymentSettings(){
  return{
    name:localStorage.getItem('payTreasurerName')||'',
    bank:localStorage.getItem('payBankName')||'',
    branch:localStorage.getItem('payBranch')||'',
    account:localStorage.getItem('payAccount')||'',
    bit:localStorage.getItem('payBitLink')||''
  };
}
async function loadPaymentSettings(){
  try{
    const fb=await fbInit();
    const snap=await fb.getDoc(fb.doc(fb.db,'settings','payment'));
    if(snap.exists()){
      const d=snap.data();
      if(d.name)    localStorage.setItem('payTreasurerName',d.name);
      if(d.bank)    localStorage.setItem('payBankName',d.bank);
      if(d.branch)  localStorage.setItem('payBranch',d.branch);
      if(d.account) localStorage.setItem('payAccount',d.account);
      if(d.bit)     localStorage.setItem('payBitLink',d.bit);
    }
  }catch(e){}
  localStorage.removeItem('payBitPhone'); // remove old key
  const ids=['payTreasurerName','payBankName','payBranch','payAccount','payBitLink'];
  const keys=['payTreasurerName','payBankName','payBranch','payAccount','payBitLink'];
  ids.forEach((id,i)=>{const el=document.getElementById(id);if(el)el.value=localStorage.getItem(keys[i])||'';});
}
async function savePaymentSettings(){
  const p={
    name:(document.getElementById('payTreasurerName').value||'').trim(),
    bank:(document.getElementById('payBankName').value||'').trim(),
    branch:(document.getElementById('payBranch').value||'').trim(),
    account:(document.getElementById('payAccount').value||'').trim(),
    bit:(document.getElementById('payBitLink').value||'').trim()
  };
  localStorage.setItem('payTreasurerName',p.name);
  localStorage.setItem('payBankName',p.bank);
  localStorage.setItem('payBranch',p.branch);
  localStorage.setItem('payAccount',p.account);
  localStorage.setItem('payBitLink',p.bit);
  try{
    const fb=await fbInit();
    await fb.setDoc(fb.doc(fb.db,'settings','payment'),p);
  }catch(e){}
  const st=document.getElementById('payStatus');
  if(st){st.textContent='✓ נשמר';st.style.color='var(--green)';setTimeout(()=>{if(st)st.textContent='';},2500);}
}
function _paymentBlock(owe,evName){
  const p=getPaymentSettings();
  const hasBank=p.bank&&p.account;
  const hasBit=p.bit;
  if(!hasBank&&!hasBit)return'';
  let html=`<div style="margin-top:14px;padding:12px 14px;background:#F0FDF4;border-radius:8px;border:1px solid #BBF7D0">`;
  html+=`<div style="font-weight:700;font-size:13px;color:#15803D;margin-bottom:8px">💸 לתשלום:</div>`;
  if(hasBank){
    html+=`<div style="font-size:12px;color:#166534;line-height:1.8">`;
    html+=`🏦 <b>${_esc(p.bank)}</b>`;
    if(p.branch) html+=` · סניף <b>${_esc(p.branch)}</b>`;
    html+=`<br>מספר חשבון: <b style="letter-spacing:1px;direction:ltr;display:inline-block">${_esc(p.account)}</b>`;
    html+=`</div>`;
  }
  if(hasBit){
    html+=`<div style="margin-top:${hasBank?10:0}px">`;
    html+=`<a href="${_esc(p.bit)}" style="display:inline-block;background:#1A3C40;color:#3BFFF0;text-decoration:none;padding:10px 22px;border-radius:20px;font-size:14px;font-weight:700">💙 שלם בביט · ₪${owe.toLocaleString()}</a>`;
    html+=`</div>`;
  }
  html+=`</div>`;
  return html;
}
function testEjsEmail(){
  const key=localStorage.getItem('ejsPublicKey');
  const svc=localStorage.getItem('ejsServiceId');
  const tpl=localStorage.getItem('ejsTemplateId');
  if(!key||!svc||!tpl){const st=document.getElementById('ejsStatus');if(st){st.textContent='נא לשמור הגדרות תחילה';st.style.color='var(--red)';}return;}
  const verified=new Set(JSON.parse(localStorage.getItem('verifiedEmails')||'[]'));
  const addrs=[];
  families.forEach(f=>{
    const name=f.name.replace('משפחת','').trim();
    if(_validEmail(f.email)&&!verified.has(f.email.trim())) addrs.push({email:f.email.trim(),name});
    if(_validEmail(f.email2)&&!verified.has(f.email2.trim())) addrs.push({email:f.email2.trim(),name});
  });
  if(!addrs.length){const st=document.getElementById('ejsStatus');if(st){st.textContent='✓ כל הכתובות כבר מאומתות';st.style.color='var(--green)';}return;}
  const st=document.getElementById('ejsStatus');if(st){st.textContent=`שולח ל-${addrs.length} כתובות חדשות...`;st.style.color='var(--text2)';}
  let done=0,failed=0;
  addrs.forEach((a,i)=>setTimeout(()=>{
    emailjs.send(svc,tpl,{to_email:a.email,to_name:a.name,subject:'בדיקת התראות · ינקלביץ',message:'מייל זה אישר שהתראות מוגדרות בהצלחה באפליקציית ינקלביץ.'})
      .then(()=>{done++;verified.add(a.email);localStorage.setItem('verifiedEmails',JSON.stringify([...verified]));if(done+failed===addrs.length&&st){st.textContent=`✓ נשלח ל-${done} כתובות${failed?` · ${failed} נכשלו`:''}`;st.style.color=failed?'var(--red)':'var(--green)';renderFamList();}})
      .catch(()=>{failed++;if(done+failed===addrs.length&&st){st.textContent=`נשלח ל-${done} · ${failed} נכשלו`;st.style.color='var(--red)';}});
  },i*600));
}
const _cleanEmail=e=>(e||'').replace(/[​-‏‪-‮⁠﻿ ]/g,'').trim().toLowerCase();
const _validEmail=e=>!!e&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(_cleanEmail(e));
function _ejsUrl(){return window.location.origin+window.location.pathname;}
function _esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function _emailWrap(bodyHtml,headerTitle,headerIcon,urlOverride,headerSubtitle){
  const url=urlOverride!=null?urlOverride:_ejsUrl();
  return`<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:6px;background:#eef0f8;font-family:-apple-system,Helvetica,Arial,sans-serif;direction:rtl"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" style="width:100%;max-width:480px" cellspacing="0" cellpadding="0"><tr><td style="background:linear-gradient(135deg,#0C447C 0%,#1E88D8 100%);padding:20px 16px;text-align:center;border-radius:10px 10px 0 0"><div style="font-size:32px;margin-bottom:4px">${headerIcon}</div><div style="color:#fff;font-size:18px;font-weight:700;letter-spacing:0.5px">${_esc(headerTitle)}</div>${headerSubtitle?`<div style="color:rgba(255,255,255,0.82);font-size:12px;margin-top:3px">${_esc(headerSubtitle)}</div>`:''}</td></tr><tr><td style="background:#fff;padding:16px;direction:rtl;color:#1a1a2e;font-size:14px;line-height:1.6">${bodyHtml}</td></tr>${url?`<tr><td style="background:#fff;padding:0 16px 16px;text-align:center"><a href="${_esc(url)}" style="display:inline-block;background:#1E88D8;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:700">קישור לאירוע ←</a></td></tr>`:''}<tr><td style="background:#f4f4f6;padding:8px 16px;text-align:center;border-radius:0 0 10px 10px;border-top:1px solid #e4e4e8"><span style="font-size:11px;color:#aaa">ינקלביץ · מערכת ניהול הוצאות משפחתית</span></td></tr></table></td></tr></table></body></html>`;
}
function _eCard(rows){
  return`<div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:10px 12px;margin-bottom:14px">`+rows.map(([l,v,hi],i)=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0${i<rows.length-1?';border-bottom:1px solid #DBEAFE':''}"><span style="color:#666;font-size:13px">${_esc(l)}</span><span style="font-weight:700;font-size:13px${hi?';color:#1E88D8':''}">${v}</span></div>`).join('')+`</div>`;
}
function _eTable(headers,rows){
  return`<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px"><tr style="background:#E0F2FE">${headers.map(h=>`<th style="padding:8px 10px;text-align:right;color:#555;font-weight:700;border-bottom:2px solid #7DD3FC">${_esc(h)}</th>`).join('')}</tr>${rows.map(r=>`<tr style="border-bottom:1px solid #f0f0f6">${r.map((c,i)=>`<td style="padding:7px 10px${i>0?';font-weight:600':''}">${c}</td>`).join('')}</tr>`).join('')}</table>`;
}
function _eBadge(text,color){return`<div style="display:inline-block;background:${color}1a;border:1px solid ${color}55;border-radius:20px;padding:4px 12px;font-size:13px;font-weight:700;color:${color}">${_esc(text)}</div>`;}
function _splitMethodBlock(ev,fid){
  const method=ev.splitMethod||'equal';
  const label=SPLIT_LABELS[method]||method;
  let compLine='';
  if(method!=='equal'&&fid!=null){
    const pf=getFam(fid);
    if(pf){
      const ch=ev.childOverrides?.[fid]!=null?ev.childOverrides[fid]:(pf.children||0);
      const adults=ev.parentOverrides?.[fid]!=null?ev.parentOverrides[fid]:FAM_ADULTS;
      const aLabel=adults===0?'0 הורים':adults===1?'הורה 1':'2 הורים';
      compLine=ch>0?` · ${aLabel} + ${ch} ילד${ch===1?'':'ים'}`:` · ${aLabel}`;
    }
  }
  return`<div style="margin:0 0 12px;padding:8px 12px;background:#F0F9FF;border-radius:8px;border:1px solid #BAE6FD;font-size:12px;color:#0369A1"><span style="font-weight:700">📊 שיטת חלוקה: ${_esc(label)}</span>${compLine?`<span style="color:#075985"> ${_esc(compLine)}</span>`:''}</div>`;
}
function sendSettledEmail(ev,famId){
  const f=getFam(famId);
  if(!f||(!f.email&&!f.email2)) return;
  const notifKey='settled-'+ev.id+'-'+famId;
  if(localStorage.getItem(notifKey)) return;
  localStorage.setItem(notifKey,'1');
  const name=f.name.replace('משפחת','').trim();
  const cost=evCost(ev);
  const shares=evShares(ev);
  const share=Math.round(shares[famId]||0);
  const spent=Math.round(ev.expenses?(ev.expenses[famId]||0):(ev.expenseItems||[]).filter(it=>it.famId===famId).reduce((s,it)=>s+it.amt,0));
  const lines=[];
  const _sfByName=n=>families.find(x=>x.name===n||x.name.replace(/^משפחת\s*/,'')===n);
  const _potTotal=Math.round((ev.potPayments||[]).filter(p=>p.famId===famId).reduce((s,p)=>s+p.amt,0));
  if(_potTotal>0.5) lines.push(`הפקדת לקופת האירוע: ₪${_potTotal.toLocaleString()}`);
  const _potRec=Math.round((ev.settled||[]).filter(s=>s.method==='pot'&&Number(s.toFid)===Number(famId)).reduce((s,t)=>s+t.amt,0));
  if(_potRec>0.5) lines.push(`קיבלת ₪${_potRec.toLocaleString()} מקופת האירוע`);
  (ev.settled||[]).forEach(s=>{
    if(s.method==='pot') return;
    const isFrom=s.fromFid!=null?Number(s.fromFid)===Number(famId):(_sfByName(s.from)||{}).id===famId;
    const isTo=s.toFid!=null?Number(s.toFid)===Number(famId):(_sfByName(s.to)||{}).id===famId;
    const sTo=(getFam(s.toFid)||{}).name?(getFam(s.toFid).name.replace('משפחת','').trim()):s.to;
    const sFrom=(getFam(s.fromFid)||{}).name?(getFam(s.fromFid).name.replace('משפחת','').trim()):s.from;
    if(isFrom){
      if(s.method==='fund') lines.push(`₪${s.amt.toLocaleString()} שולמו מהקופה הראשית ל${sTo}`);
      else lines.push(`העברה ישירה של ₪${s.amt.toLocaleString()} ל${sTo}`);
    } else if(isTo){
      if(s.method==='fund') lines.push(`₪${s.amt.toLocaleString()} מ${sFrom} – הועבר לקופה הראשית`);
      else lines.push(`קיבלת ₪${s.amt.toLocaleString()} ישירות מ${sFrom}`);
    }
  });
  const fundBal=Math.round(fund.famBalances[String(famId)]||0);
  const _savPF=ev.savingsTotal?Math.round(ev.savingsTotal/((ev.participants||[]).length||1)):(ev.savingsAmt||0);
  // plain text
  let msg=`האירוע "${ev.name}" – הסיכום שלך:\n\nעלות כוללת: ₪${cost.toLocaleString()}\nהחלק שלך: ₪${share.toLocaleString()}\n`;
  if(_savPF>0) msg+=`מתוכם ₪${_savPF.toLocaleString()} לקופת חיסכון 💎\n`;
  if(spent>0) msg+=`הוצאת: ₪${spent.toLocaleString()}\n`;
  if(lines.length) msg+=`\nאיך סודר:\n${lines.map(l=>'• '+l).join('\n')}`;
  if(fundBal>0) msg+=`\n\nיתרתך בקופה הראשית: ₪${fundBal.toLocaleString()}`;
  // HTML
  const cardRows=[['עלות כוללת האירוע',`₪${cost.toLocaleString()}`],['החלק שלך',`₪${share.toLocaleString()}`,true]];
  if(_savPF>0) cardRows.push(['💎 מתוכם לקופת חיסכון',`₪${_savPF.toLocaleString()}`]);
  if(spent>0) cardRows.push(['ההוצאות שלך',`₪${spent.toLocaleString()}`]);
  if(fundBal>0) cardRows.push(['💰 יתרה בקופה הראשית',`₪${fundBal.toLocaleString()}`]);
  let bodyHtml=_eCard(cardRows);
  bodyHtml+=_splitMethodBlock(ev,famId);
  if(lines.length){
    bodyHtml+=`<p style="font-weight:700;margin:0 0 8px;color:#333">⚖️ איך סודר:</p><ul style="margin:0 0 16px;padding-right:20px;color:#444">${lines.map(l=>`<li style="margin-bottom:4px">${_esc(l)}</li>`).join('')}</ul>`;
  }
  bodyHtml+=`<div style="text-align:center;margin-top:4px">${_eBadge('✅ החשבון שלך מסודר','#16a34a')}</div>`;
  const _evUrl=_ejsUrl()+'#'+(ev.open?'event-':'archive-')+ev.id;
  const html=_emailWrap(bodyHtml,ev.name,'✅',_evUrl,f.name);
  sendEmailNotif([{email:f.email,email2:f.email2,name}],`✅ סידרת את חלקך ב"${ev.name}" · ינקלביץ`,msg,html);
}
function testSingleEmail(inputId,btnId){
  const key=localStorage.getItem('ejsPublicKey');
  const svc=localStorage.getItem('ejsServiceId');
  const tpl=localStorage.getItem('ejsTemplateId');
  const email=_cleanEmail(document.getElementById(inputId)?.value||'');
  const btn=document.getElementById(btnId);
  if(!key||!svc||!tpl){if(btn){btn.textContent='הגדר EmailJS קודם';btn.style.color='var(--red)';}return;}
  if(!_validEmail(email)){if(btn){btn.textContent='✗ מייל לא תקין';btn.style.color='var(--red)';}setTimeout(()=>{if(btn){btn.textContent='בדוק';btn.style.color='var(--text2)';}},2500);return;}
  if(btn){btn.textContent='שולח...';btn.style.color='var(--text2)';btn.disabled=true;}
  const name=document.getElementById('famEditName')?.value.trim()||'';
  emailjs.send(svc,tpl,{to_email:email,to_name:name,subject:'בדיקת התראות · ינקלביץ',message:'מייל זה אישר שהתראות מוגדרות בהצלחה באפליקציית ינקלביץ.'})
    .then(()=>{
      const verified=new Set(JSON.parse(localStorage.getItem('verifiedEmails')||'[]'));
      verified.add(email);localStorage.setItem('verifiedEmails',JSON.stringify([...verified]));
      if(btn){btn.textContent='✓';btn.style.color='var(--green)';btn.style.fontWeight='700';btn.disabled=false;}
    })
    .catch(e=>{if(btn){btn.textContent='✗ שגיאה';btn.style.color='var(--red)';btn.disabled=false;}setTimeout(()=>{if(btn){btn.textContent='בדוק';btn.style.color='var(--text2)';btn.style.fontWeight='';}},3000);});
}
function sendEmailNotif(recipients,subject,message,html){
  const key=localStorage.getItem('ejsPublicKey');
  const svc=localStorage.getItem('ejsServiceId');
  const tpl=localStorage.getItem('ejsTemplateId');
  if(!key||!svc||!tpl||typeof emailjs==='undefined') return;
  const addrs=[];
  recipients.forEach(r=>{
    if(_validEmail(r.email)) addrs.push({email:r.email.trim(),name:r.name});
    if(_validEmail(r.email2)) addrs.push({email:r.email2.trim(),name:r.name});
  });
  const message_html=html||_emailWrap(`<p style="white-space:pre-wrap;margin:0">${_esc(message||'')}</p>`,subject,'📬');
  addrs.forEach((a,i)=>setTimeout(()=>{
    emailjs.send(svc,tpl,{to_email:a.email,to_name:a.name,subject,message,message_html})
      .then(()=>console.log('📧 מייל נשלח ל-'+a.email))
      .catch(e=>{console.error('📧 שגיאת מייל:',e);showToast('❌ שגיאה בשליחת מייל: '+(e?.text||e?.message||JSON.stringify(e)));});
  },i*600));
}
function sendFundUpdateEmail(famId,changeAmt,desc){
  const f=getFam(famId);
  if(!f||(!f.email&&!f.email2)){showToast('⚠️ לא הוגדר מייל למשפחה זו');return;}
  const key=localStorage.getItem('ejsPublicKey');
  const svc=localStorage.getItem('ejsServiceId');
  const tpl=localStorage.getItem('ejsTemplateId');
  if(!key||!svc||!tpl){showToast('⚠️ הגדרות מייל חסרות — כנס להגדרות משפחות');return;}
  const name=f.name.replace('משפחת','').trim();
  const newBal=Math.round(fund.famBalances[String(famId)]||0);
  const msg=`${desc}: ₪${Math.round(changeAmt).toLocaleString()}\n\nיתרתך החדשה בקופה הראשית: ₪${newBal.toLocaleString()}`;
  const html=_emailWrap(_eCard([[desc,`₪${Math.round(changeAmt).toLocaleString()}`],['💰 יתרה חדשה בקופה',`₪${newBal.toLocaleString()}`,true]]),'עדכון קופה הראשית','🏦',_ejsUrl()+'#fund');
  sendEmailNotif([{email:f.email,email2:f.email2,name}],'🏦 עדכון קופה הראשית · ינקלביץ',msg,html);
}

function saveLocal(){
  try{
    localStorage.setItem('fe',JSON.stringify(events));
    localStorage.setItem('ff',JSON.stringify(families));
    localStorage.setItem('fund',JSON.stringify(fund));
    localStorage.setItem('nxtTx',String(nxtTx));
    localStorage.setItem('goalFunds',JSON.stringify(goalFunds));
    localStorage.setItem('savingsPot',JSON.stringify(savingsPot));
    localStorage.setItem('adminPass',adminPass);
    localStorage.setItem('messages',JSON.stringify(messages));
    localStorage.setItem('calItems',JSON.stringify(calItems));
    localStorage.setItem('birthdays',JSON.stringify(birthdays));
  }catch(e){}
}

let _retryTimer=null;
async function save(){
  _skipNextNotif=true;
  saveLocal();
  localStorage.setItem('pendingSave','1');
  if(_saving) return;
  _saving=true;
  if(_retryTimer){clearTimeout(_retryTimer);_retryTimer=null;}
  showSyncStatus('שומר...');
  try{
    const {db,doc,setDoc}=await fbInit();
    await setDoc(doc(db,'appData','familyPayments'),{families,events,fund,goalFunds,savingsPot,adminPass,messages,calItems,birthdays});
    localStorage.removeItem('pendingSave');
    showSyncStatus('✓ נשמר',2000);
  }catch(e){
    console.warn('save failed, will retry:',e);
    showSyncStatus('⚠ שמור מקומי · מנסה שוב...');
    _retryTimer=setTimeout(()=>{_saving=false;save();},8000);
    return;
  }
  _saving=false;
}



async function load(){
  showSyncStatus('טוען...');
  try{
    const {db,doc,getDoc}=await fbInit();
    const snap=await getDoc(doc(db,'appData','familyPayments'));
    const d=snap.exists()?snap.data():{};
    families=d.families||[];
    events=d.events||[];
    fund=d.fund||{famBalances:{},transactions:[]};
    if(!fund.famBalances)fund.famBalances={};
    goalFunds=d.goalFunds||[];
    savingsPot=d.savingsPot||{expenses:[],nxtExpId:1};
    if(!savingsPot.nxtExpId)savingsPot.nxtExpId=(savingsPot.expenses||[]).length?Math.max(...savingsPot.expenses.map(e=>e.id))+1:1;
    adminPass=d.adminPass||'';
    messages=d.messages||[];
    calItems=d.calItems||[];
    birthdays=d.birthdays||[];
    nxtMsg=messages.length?Math.max(...messages.map(m=>m.id))+1:1;
    nxtCal=calItems.length?Math.max(...calItems.map(c=>c.id))+1:1;
    nxtBday=birthdays.length?Math.max(...birthdays.map(b=>b.id))+1:1;
    nxtId=events.length?Math.max(...events.map(e=>e.id))+1:1;
    nxtFam=families.length?Math.max(...families.map(f=>f.id))+1:1;
    nxtTx=(fund.transactions||[]).length?Math.max(...fund.transactions.map(t=>t.id))+1:1;
    nxtGoal=goalFunds.length?Math.max(...goalFunds.map(g=>g.id))+1:1;
    // if there's a pending local save, override firebase data with local and push
    if(localStorage.getItem('pendingSave')==='1'){
      const localFa=localStorage.getItem('ff');const localEv=localStorage.getItem('fe');
      const localFd=localStorage.getItem('fund');const localSp=localStorage.getItem('savingsPot');
      if(localFa)families=JSON.parse(localFa);
      if(localEv)events=JSON.parse(localEv);
      if(localFd){const p=JSON.parse(localFd);fund=p.famBalances?p:{famBalances:{},transactions:p.transactions||[]};}
      if(localSp){savingsPot=JSON.parse(localSp);if(!savingsPot.nxtExpId)savingsPot.nxtExpId=1;}
      nxtId=events.length?Math.max(...events.map(e=>e.id))+1:1;
      nxtFam=families.length?Math.max(...families.map(f=>f.id))+1:1;
      _saving=false;save();
    } else {
      showSyncStatus('✓ מסונכרן',2000);
    }
  }catch(e){
    console.warn('load failed:',e);
    try{
      const ev=localStorage.getItem('fe');if(ev)events=JSON.parse(ev);
      const fa=localStorage.getItem('ff');if(fa)families=JSON.parse(fa);
      const fd=localStorage.getItem('fund');if(fd){const p=JSON.parse(fd);fund=p.famBalances?p:{famBalances:{},transactions:p.transactions||[]};}
      const tx=localStorage.getItem('nxtTx');if(tx)nxtTx=parseInt(tx);
      const gf=localStorage.getItem('goalFunds');if(gf)goalFunds=JSON.parse(gf);
      const sp=localStorage.getItem('savingsPot');if(sp){savingsPot=JSON.parse(sp);if(!savingsPot.nxtExpId)savingsPot.nxtExpId=1;}
      const ap=localStorage.getItem('adminPass');if(ap)adminPass=ap;
      const msgs=localStorage.getItem('messages');if(msgs)messages=JSON.parse(msgs);
      const cals=localStorage.getItem('calItems');if(cals)calItems=JSON.parse(cals);
      const bds=localStorage.getItem('birthdays');if(bds)birthdays=JSON.parse(bds);
      nxtMsg=messages.length?Math.max(...messages.map(m=>m.id))+1:1;
      nxtCal=calItems.length?Math.max(...calItems.map(c=>c.id))+1:1;
      nxtBday=birthdays.length?Math.max(...birthdays.map(b=>b.id))+1:1;
      nxtId=events.reduce((a,e)=>Math.max(a,e.id),0)+1;
      nxtFam=families.reduce((a,f)=>Math.max(a,f.id),0)+1;
      nxtGoal=goalFunds.length?Math.max(...goalFunds.map(g=>g.id))+1:1;
      if(!fund.famBalances)fund.famBalances={};
    }catch(e2){}
    showSyncStatus('⚠ מקומי בלבד',3000);
  }finally{render();setTimeout(handleHash,100);}
}

function showSyncStatus(msg,hideAfter){
  let el=document.getElementById('syncStatus');
  if(!el){
    el=document.createElement('div');
    el.id='syncStatus';
    el.style.cssText='position:fixed;bottom:calc(130px + env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);background:#1A1A18;color:#fff;font-size:12px;font-weight:600;padding:6px 16px;border-radius:20px;z-index:500;transition:opacity 0.3s;white-space:nowrap;pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent=msg;
  el.style.opacity='1';
  if(hideAfter){
    clearTimeout(el._t);
    el._t=setTimeout(()=>{el.style.opacity='0';},hideAfter);
  }
}

function render(){
  applyEditMode();
  const fns=[renderHome,renderMetrics,renderOpenList,renderArchive,renderFamilies,renderFund,renderGoalFunds,renderFamilyHome];
  fns.forEach(fn=>{try{fn();}catch(e){console.error(fn.name,e);}});
  const debt=calcDebt();
  const open=events.filter(e=>e.open).length;
  const sub=document.getElementById('topSub');
  if(sub)sub.textContent=open+' פתוחים · חוב: ₪'+debt.toLocaleString()+' · קופות: ₪'+(fundTotal()+savingsPotBal()).toLocaleString();
}
function calcDebt(){
  let t=0;
  events.filter(e=>e.open).forEach(ev=>{
    const bal=evAdjBalance(ev);
    ev.participants.forEach(fid=>{ if(bal[fid]<-0.5) t+=Math.abs(bal[fid]); });
  });
  return t;
}
function renderMetrics(){
  const open=events.filter(e=>e.open).length,arch=events.filter(e=>!e.open).length,debt=calcDebt();
  const total=events.reduce((s,ev)=>s+evCost(ev),0);
  document.getElementById('metrics').innerHTML=`
    <div class="metric"><div class="metric-lbl">פעילים</div><div class="metric-val">${open}</div></div>
    <div class="metric"><div class="metric-lbl">ארכיון</div><div class="metric-val g">${arch}</div></div>
    <div class="metric"><div class="metric-lbl">חוב כולל</div><div class="metric-val r">₪${debt.toLocaleString()}</div></div>`;
}
function renderOpenList(){
  const open=events.filter(e=>e.open);
  document.getElementById('openList').innerHTML=open.length?open.map(evCard).join(''):`<div class="empty"><span class="empty-ico">📅</span>אין אירועים פעילים</div>`;
}
function switchShell(s){
  currentShell=s;
  closeChatSheet();
  document.body.classList.toggle('at-home',s==='home');
  document.getElementById('mn-home').classList.toggle('mn-active',s==='home');
  document.getElementById('mn-pay').classList.toggle('mn-active',s==='pay');
  if(s==='home'){renderFamilyHome();setTimeout(()=>{const sh=document.getElementById('shell-home');if(sh)sh.scrollTop=0;},10);}
  if(s==='pay')goTab('home',document.getElementById('nb-home'));
}

const HEB_MONTHS=['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const HEB_DAYS_SHORT=['א','ב','ג','ד','ה','ו','ש'];
const LAT_DAYS_SHORT=["א'","ב'","ג'","ד'","ה'","ו'","ש'"];
const HEB_DAY_NUM=['','א','ב','ג','ד','ה','ו','ז','ח','ט','י','יא','יב','יג','יד','טו','טז','יז','יח','יט','כ','כא','כב','כג','כד','כה','כו','כז','כח','כט','ל'];
const HEB_MONTHS_LIST=['תשרי','חשוון','כסלו','טבת','שבט','אדר','אדר ב\'','ניסן','אייר','סיון','תמוז','אב','אלול'];

function renderFamilyHome(){
  const sub=document.getElementById('fhSub');
  if(sub){
    const openCount=events.filter(e=>e.open).length;
    const famCount=families.length;
    sub.textContent=[famCount?famCount+' משפחות':'',openCount?openCount+' אירועים פעילים':''].filter(Boolean).join(' · ')||'ברוכים הבאים';
  }
  renderMessages();
  renderCalendar();
  renderNotifBtn();
  renderChatInput();
}

function fmtTs(ts){
  const d=new Date(ts);
  return d.toLocaleDateString('he-IL',{day:'numeric',month:'short'})+' '+d.toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'});
}

function openChatSheet(){
  const s=document.getElementById('chatSheet');
  if(!s)return;
  s.classList.add('open');
  const ml=document.getElementById('msgList');
  if(ml)setTimeout(()=>ml.scrollTop=ml.scrollHeight,50);
}
function closeChatSheet(){
  const s=document.getElementById('chatSheet');
  if(s)s.classList.remove('open');
}

function openMsgModal(){
  document.getElementById('msgModal').style.display='flex';
  setTimeout(()=>{const i=document.getElementById('msgAuthor');if(i)i.focus();},50);
}
function closeMsgModal(){
  document.getElementById('msgModal').style.display='none';
  document.getElementById('msgAuthor').value='';
  document.getElementById('msgText').value='';
  document.getElementById('msgCharCount').textContent='';
}
function sendMessage(){
  const aEl=document.getElementById('msgAuthor');
  const tEl=document.getElementById('msgText');
  const author=aEl.value.trim();
  const text=tEl.value.trim();
  if(!text)return;
  messages.push({id:nxtMsg++,author,text,ts:Date.now()});
  save();renderMessages();
  closeMsgModal();
}
function openCalModal(){
  const dEl=document.getElementById('calAddDate');
  if(calSelDay)dEl.value=calSelDay;
  document.getElementById('calModal').style.display='flex';
  setTimeout(()=>{const i=document.getElementById('calAddTitle');if(i)i.focus();},50);
}
function closeCalModal(){
  document.getElementById('calModal').style.display='none';
  document.getElementById('calAddTitle').value='';
  document.getElementById('calAddDate').value='';
}

function deleteMsg(id){
  if(!confirm('למחוק הודעה זו?'))return;
  messages=messages.filter(m=>m.id!==id);
  save();renderMessages();
}

function renderChatInput(){
  const area=document.getElementById('chatInputArea');if(!area)return;
  const saved=(localStorage.getItem('chatName')||'').trim();
  if(!saved){
    area.innerHTML=`
      <div style="font-size:12px;color:var(--text2);text-align:center;direction:rtl">מה שמך? (פעם אחת בלבד)</div>
      <div style="display:flex;gap:6px">
        <input id="chatName" placeholder="שמך" maxlength="20" onkeydown="if(event.key==='Enter')saveChatName()" style="flex:1;border:1.5px solid var(--blue-mid);border-radius:var(--r2);padding:9px 10px;font-size:14px;font-family:var(--font);background:var(--bg);color:var(--text);direction:rtl;box-sizing:border-box">
        <button onclick="saveChatName()" style="background:var(--blue-mid);color:#fff;border:none;border-radius:var(--r2);padding:9px 16px;font-size:14px;font-weight:700;font-family:var(--font);cursor:pointer">המשך</button>
      </div>`;
  } else {
    area.innerHTML=`
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px">
        <span style="font-size:11px;color:var(--text3)">מחובר כ: <b style="color:var(--text2)">${esc(saved)}</b></span>
        <button onclick="changeChatName()" style="background:none;border:none;font-size:11px;color:var(--text3);cursor:pointer;text-decoration:underline;font-family:var(--font)">שנה שם</button>
      </div>
      <div style="display:flex;gap:6px">
        <input id="chatText" placeholder="כתוב הודעה..." maxlength="300" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChatMsg()}" style="flex:1;border:1.5px solid var(--border);border-radius:var(--r2);padding:8px 10px;font-size:14px;font-family:var(--font);background:var(--bg);color:var(--text);direction:rtl;box-sizing:border-box">
        <button onclick="sendChatMsg()" style="background:var(--blue-mid);color:#fff;border:none;border-radius:var(--r2);padding:8px 16px;font-size:14px;font-weight:700;font-family:var(--font);cursor:pointer">שלח</button>
      </div>`;
  }
}

function saveChatName(){
  const n=(document.getElementById('chatName')?.value||'').trim();
  if(!n)return;
  localStorage.setItem('chatName',n);
  renderChatInput();
}

function changeChatName(){
  localStorage.removeItem('chatName');
  renderChatInput();
}

function sendChatMsg(){
  const author=(localStorage.getItem('chatName')||'').trim();
  const textEl=document.getElementById('chatText');
  const text=(textEl?.value||'').trim();
  if(!text||!author)return;
  messages.push({id:nxtMsg++,author,text,ts:Date.now()});
  if(textEl){textEl.value='';textEl.focus();}
  save();renderMessages();
}

// ── Notifications & Real-time ──────────────────────────────────────────────

let _skipNextNotif=false,_initialSync=true,_realtimeUnsub=null;

function _notifOk(){return 'Notification' in window&&Notification.permission==='granted';}

async function registerFCMToken(){
  if(!('serviceWorker' in navigator)) throw new Error('הדפדפן לא תומך ב-Service Worker');
  if(!_fbApp) await fbInit();
  const msgMod=await import('https://www.gstatic.com/firebasejs/12.14.0/firebase-messaging.js');
  const messaging=msgMod.getMessaging(_fbApp);
  const swReg=await navigator.serviceWorker.ready;
  const token=await msgMod.getToken(messaging,{vapidKey:FCM_VAPID_KEY,serviceWorkerRegistration:swReg});
  if(!token) throw new Error('getToken החזיר ריק — בדוק הגדרות דפדפן');
  const {db,doc,setDoc}=await fbInit();
  let did=localStorage.getItem('fcmDeviceId');
  if(!did){did=Math.random().toString(36).slice(2)+Date.now().toString(36);localStorage.setItem('fcmDeviceId',did);}
  await setDoc(doc(db,'fcmTokens',did),{token,ts:Date.now()});
  console.log('FCM token saved OK');
}

async function requestNotifPerm(){
  if(!('Notification' in window)){alert('הדפדפן שלך לא תומך בהתראות');return;}
  if(Notification.permission==='denied'){alert('הדפדפן חסם התראות. לאיפוס — לחץ על המנעול בסרגל הכתובת.');return;}
  const p=await Notification.requestPermission();
  renderNotifBtn();
  if(p==='granted'){
    showNotif('ינקלביץ 🔔','התראות הופעלו! תקבלו עדכונים על הודעות, הוצאות וימי הולדת.');
    checkBirthdayNotifs();
    registerFCMToken().then(()=>{}).catch(e=>alert('שגיאת התראות: '+e.message));
  }
}

function showNotif(title,body){
  if(!_notifOk())return;
  try{new Notification(title,{body,icon:'./icon-192.png',dir:'rtl',lang:'he'});}catch(e){}
}

function renderNotifBtn(){
  const btn=document.getElementById('notifBtn');if(!btn)return;
  if(!('Notification' in window)){btn.style.display='none';return;}
  const perm=Notification.permission;
  btn.textContent=perm==='granted'?'🔔':'🔕';
  btn.style.opacity=perm==='granted'?'1':'0.55';
  btn.title=perm==='granted'?'התראות פעילות':'לחץ להפעלת התראות';
  btn.onclick=perm==='denied'
    ?()=>alert('הדפדפן חסם התראות. לאיפוס דרך הגדרות האתר בסרגל הכתובת.')
    :perm==='granted'
      ?()=>alert('התראות פעילות. לביטול — הגדרות האתר בסרגל הכתובת.')
      :requestNotifPerm;
}

function checkBirthdayNotifs(){
  if(!_notifOk()||!birthdays.length)return;
  const today=new Date(),todayStr=today.toDateString();
  if(localStorage.getItem('bdayNotifDate')===todayStr)return;
  localStorage.setItem('bdayNotifDate',todayStr);
  const dayFmt=new Intl.DateTimeFormat('he-IL-u-ca-hebrew-nu-latn',{day:'numeric'});
  const monthFmt=new Intl.DateTimeFormat('he-IL-u-ca-hebrew',{month:'long'});
  for(let i=0;i<=7;i++){
    const d=new Date(today);d.setDate(d.getDate()+i);
    const hd=parseInt(dayFmt.format(d)),hm=monthFmt.format(d);
    birthdays.filter(b=>b.hebDay===hd&&b.hebMonth===hm).forEach(b=>{
      if(i===0)showNotif('🎂 יום הולדת היום!','יום הולדת שמח ל'+b.name+'!');
      else showNotif('🎂 יום הולדת בעוד '+i+' ימים','של '+b.name);
    });
  }
}

async function startRealtimeSync(){
  if(_realtimeUnsub)return;
  try{
    const {db,doc,onSnapshot}=await fbInit();
    _realtimeUnsub=onSnapshot(doc(db,'appData','familyPayments'),snap=>{
      if(!snap.exists())return;
      const d=snap.data();
      const snapMsgs=d.messages||[];
      const snapEvs=d.events||[];
      const snapExpCount=snapEvs.reduce((s,e)=>s+(e.expenseItems||[]).length,0);
      if(!_initialSync&&_notifOk()&&!_skipNextNotif&&!document.hidden){
        const lastMsgId=parseInt(localStorage.getItem('lastMsgId')||'0');
        const lastEvId=parseInt(localStorage.getItem('lastEvId')||'0');
        const lastExpCount=parseInt(localStorage.getItem('lastExpCount')||'0');
        const myName=(localStorage.getItem('chatName')||'').trim();
        snapMsgs.filter(m=>m.id>lastMsgId&&m.author!==myName)
          .forEach(m=>showNotif('💬 הודעה חדשה',(m.author?m.author+': ':'')+m.text));
        snapEvs.filter(e=>e.id>lastEvId)
          .forEach(e=>showNotif('📅 אירוע חדש',e.name));
        if(snapExpCount>lastExpCount&&lastExpCount>0)
          showNotif('💰 הוצאה חדשה','נוספה הוצאה חדשה לאירוע');
      }
      _skipNextNotif=false;
      if(snapMsgs.length)localStorage.setItem('lastMsgId',String(Math.max(...snapMsgs.map(m=>m.id))));
      if(snapEvs.length)localStorage.setItem('lastEvId',String(Math.max(...snapEvs.map(e=>e.id))));
      localStorage.setItem('lastExpCount',String(snapExpCount));
      if(!_initialSync&&!_saving){
        const snapMax=snapMsgs.length?Math.max(...snapMsgs.map(m=>m.id)):0;
        const localMax=messages.length?Math.max(...messages.map(m=>m.id)):0;
        if(snapMax!==localMax){
          messages=snapMsgs;
          nxtMsg=messages.length?Math.max(...messages.map(m=>m.id))+1:1;
          renderMessages();
        }
      }
      _initialSync=false;
    });
  }catch(e){console.warn('realtime sync:',e);}
}

function renderMessages(){
  const el=document.getElementById('msgList');if(!el)return;
  if(!messages.length){
    el.innerHTML='<div style="padding:20px;text-align:center;color:var(--text3);font-size:13px">עדיין אין הודעות — שלח את הראשון 💬</div>';
    return;
  }
  const myName=(localStorage.getItem('chatName')||'').trim();
  const timeFmt=new Intl.DateTimeFormat('he-IL',{hour:'2-digit',minute:'2-digit'});
  const dateFmt=new Intl.DateTimeFormat('he-IL',{day:'2-digit',month:'2-digit'});
  let lastDate='';
  el.innerHTML=messages.map(m=>{
    const ts=new Date(m.ts);
    const dateStr=dateFmt.format(ts);
    const timeStr=timeFmt.format(ts);
    const dateSep=dateStr!==lastDate?`<div style="text-align:center;margin:6px 0;font-size:10px;color:var(--text3)">${dateStr}</div>`:'';
    lastDate=dateStr;
    const mine=myName&&m.author===myName;
    const initials=m.author?(m.author.trim().split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase()):'?';
    const hue=m.author?[...m.author].reduce((h,c)=>h+c.charCodeAt(0),0)%360:180;
    const av=`<div style="width:28px;height:28px;border-radius:50%;background:hsl(${hue},45%,45%);color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">${initials}</div>`;
    const del=mine?`<button onclick="deleteMsg(${m.id})" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:11px;padding:0;opacity:.45;line-height:1">🗑</button>`:'';
    if(mine)return dateSep+`<div style="display:flex;flex-direction:column;align-items:flex-end;margin-bottom:8px">
      <div style="display:flex;align-items:flex-end;gap:6px">${av}<div style="background:var(--blue-mid);color:#fff;border-radius:14px 14px 4px 14px;padding:8px 12px;max-width:78%;word-break:break-word;font-size:14px;direction:rtl;line-height:1.4">${esc(m.text)}</div></div>
      <div style="display:flex;align-items:center;gap:4px;margin-top:2px;padding-left:34px;font-size:10px;color:var(--text3)">${timeStr} ${del}</div>
    </div>`;
    return dateSep+`<div style="display:flex;flex-direction:column;align-items:flex-start;margin-bottom:8px">
      <div style="display:flex;align-items:flex-end;gap:6px">${av}<div>${m.author?`<div style="font-size:10px;color:var(--text3);margin-bottom:2px">${esc(m.author)}</div>`:''}<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px 14px 14px 4px;padding:8px 12px;max-width:78%;word-break:break-word;font-size:14px;direction:rtl;line-height:1.4">${esc(m.text)}</div></div></div>
      <div style="display:flex;align-items:center;gap:4px;margin-top:2px;padding-right:34px;font-size:10px;color:var(--text3)">${timeStr} ${del}</div>
    </div>`;
  }).join('');
  setTimeout(()=>{el.scrollTop=el.scrollHeight;},30);
}

function prevCalMonth(){
  if(calHebrew){calHebRefDate=new Date(calHebRefDate);calHebRefDate.setDate(calHebRefDate.getDate()-29);}
  else{calMonth--;if(calMonth<0){calMonth=11;calYear--;}}
  renderCalendar();
}
function nextCalMonth(){
  if(calHebrew){calHebRefDate=new Date(calHebRefDate);calHebRefDate.setDate(calHebRefDate.getDate()+29);}
  else{calMonth++;if(calMonth>11){calMonth=0;calYear++;}}
  renderCalendar();
}

function setCalMode(hebrew){
  if(hebrew&&!calHebrew) calHebRefDate=new Date(calYear,calMonth,15);
  else if(!hebrew&&calHebrew){calYear=calHebRefDate.getFullYear();calMonth=calHebRefDate.getMonth();}
  calHebrew=hebrew;
  renderCalendar();
}

function getHebMonthDays(refDate){
  const mFmt=new Intl.DateTimeFormat('he-IL-u-ca-hebrew',{month:'long'});
  const target=mFmt.format(refDate);
  let start=new Date(refDate);
  for(let i=0;i<32;i++){
    const prev=new Date(start);prev.setDate(prev.getDate()-1);
    if(mFmt.format(prev)!==target)break;
    start=prev;
  }
  const days=[];
  let cur=new Date(start);
  while(mFmt.format(cur)===target){days.push(new Date(cur));cur=new Date(cur);cur.setDate(cur.getDate()+1);}
  return days;
}
function toHebrewYear(hy){
  const y=hy%1000;
  const ONES=['','א','ב','ג','ד','ה','ו','ז','ח','ט'];
  const TENS=['','י','כ','ל','מ','נ','ס','ע','פ','צ'];
  let s='',r=y;
  while(r>=400){s+='ת';r-=400;}
  if(r>=300){s+='ש';r-=300;}
  if(r>=200){s+='ר';r-=200;}
  if(r>=100){s+='ק';r-=100;}
  const t=Math.floor(r/10),o=r%10;
  if(t===1&&o===5)s+='טו';
  else if(t===1&&o===6)s+='טז';
  else{if(t)s+=TENS[t];if(o)s+=ONES[o];}
  return s.length===1?s+'׳':s.slice(0,-1)+'״'+s.slice(-1);
}
function _applyCalToggleStyle(){
  const hBtn=document.getElementById('calToggleHeb');
  const lBtn=document.getElementById('calToggleLat');
  if(!hBtn||!lBtn)return;
  hBtn.style.background=calHebrew?'var(--blue-mid)':'transparent';
  hBtn.style.color=calHebrew?'#fff':'var(--text2)';
  lBtn.style.background=!calHebrew?'var(--blue-mid)':'transparent';
  lBtn.style.color=!calHebrew?'#fff':'var(--text2)';
}
function renderCalendar(){
  const gridEl=document.getElementById('calGrid');
  const titleEl=document.getElementById('calTitle');
  if(!gridEl)return;
  _applyCalToggleStyle();
  const todayStr=new Date().toISOString().slice(0,10);
  let html='';
  let hebDays=null;
  if(calHebrew){
    hebDays=getHebMonthDays(calHebRefDate);
    const first=hebDays[0];
    const hebMonth=new Intl.DateTimeFormat('he-IL-u-ca-hebrew',{month:'long'}).format(first);
    const hebYearNum=parseInt(new Intl.DateTimeFormat('he-IL-u-ca-hebrew-nu-latn',{year:'numeric'}).format(first));
    titleEl.textContent=hebMonth+' '+toHebrewYear(hebYearNum);
    html=HEB_DAYS_SHORT.map(d=>`<div class="fh-cal-dow">${d}</div>`).join('');
    for(let i=0;i<first.getDay();i++)html+=`<div class="fh-cal-day other-m empty"></div>`;
    for(const dayDate of hebDays){
      const ds=dayDate.toISOString().slice(0,10);
      const hebDayNumInt=parseInt(new Intl.DateTimeFormat('he-IL-u-ca-hebrew-nu-latn',{day:'numeric'}).format(dayDate));
      const label=HEB_DAY_NUM[hebDayNumInt]||String(hebDayNumInt);
      const hebMonthName=new Intl.DateTimeFormat('he-IL-u-ca-hebrew',{month:'long'}).format(dayDate);
      const isToday=ds===todayStr;
      const isSel=calSelDay===ds&&!isToday;
      const evOnDay=calItems.filter(c=>c.date===ds);
      const bdayOnDay=birthdays.filter(b=>b.hebDay===hebDayNumInt&&b.hebMonth===hebMonthName);
      const hasEv=evOnDay.length>0;const hasBday=bdayOnDay.length>0;
      const cls=['fh-cal-day',isToday?'today':'',isSel?'sel':'',hasEv?'has-ev':(hasBday?'has-bday':'')].filter(Boolean).join(' ');
      html+=`<div class="${cls}" onclick="selectCalDay('${ds}')">
        <span style="font-size:10px;line-height:1">${label}</span>
        ${hasEv?`<span class="fh-cal-day-ev">${evOnDay.map(c=>c.title.slice(0,5)).join(',')}</span>`:''}
        ${!hasEv&&hasBday?`<span class="fh-cal-day-ev" style="color:#c0392b">🎂${bdayOnDay.map(b=>b.name.slice(0,4)).join(',')}</span>`:''}
      </div>`;
    }
  } else {
    titleEl.textContent=HEB_MONTHS[calMonth]+' '+calYear;
    html=LAT_DAYS_SHORT.map(d=>`<div class="fh-cal-dow">${d}</div>`).join('');
    const firstDay=new Date(calYear,calMonth,1).getDay();
    const daysInMonth=new Date(calYear,calMonth+1,0).getDate();
    for(let i=0;i<firstDay;i++)html+=`<div class="fh-cal-day other-m empty"></div>`;
    for(let d=1;d<=daysInMonth;d++){
      const ds=`${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dayDate=new Date(calYear,calMonth,d);
      const hebDayNumInt=parseInt(new Intl.DateTimeFormat('he-IL-u-ca-hebrew-nu-latn',{day:'numeric'}).format(dayDate));
      const hebMonthName=new Intl.DateTimeFormat('he-IL-u-ca-hebrew',{month:'long'}).format(dayDate);
      const isToday=ds===todayStr;
      const isSel=calSelDay===ds&&!isToday;
      const evOnDay=calItems.filter(c=>c.date===ds);
      const bdayOnDay=birthdays.filter(b=>b.hebDay===hebDayNumInt&&b.hebMonth===hebMonthName);
      const hasEv=evOnDay.length>0;const hasBday=bdayOnDay.length>0;
      const cls=['fh-cal-day',isToday?'today':'',isSel?'sel':'',hasEv?'has-ev':(hasBday?'has-bday':'')].filter(Boolean).join(' ');
      html+=`<div class="${cls}" onclick="selectCalDay('${ds}')">
        <span style="font-size:12px;line-height:1">${d}</span>
        ${hasEv?`<span class="fh-cal-day-ev">${evOnDay.map(c=>c.title.slice(0,5)).join(',')}</span>`:''}
        ${!hasEv&&hasBday?`<span class="fh-cal-day-ev" style="color:#c0392b">🎂${bdayOnDay.map(b=>b.name.slice(0,4)).join(',')}</span>`:''}
      </div>`;
    }
  }
  gridEl.innerHTML=html;
  renderCalEvList(hebDays);
}

function selectCalDay(ds){
  calSelDay=calSelDay===ds?null:ds;
  renderCalendar();
}

function renderCalEvList(hebDays){
  const el=document.getElementById('calEvList');if(!el)return;
  let list;
  if(calSelDay){
    list=calItems.filter(c=>c.date===calSelDay);
  } else if(hebDays){
    const ds=new Set(hebDays.map(d=>d.toISOString().slice(0,10)));
    list=calItems.filter(c=>ds.has(c.date)).sort((a,b)=>a.date.localeCompare(b.date));
  } else {
    const monthStr=`${calYear}-${String(calMonth+1).padStart(2,'0')}`;
    list=calItems.filter(c=>c.date.startsWith(monthStr)).sort((a,b)=>a.date.localeCompare(b.date));
  }
  if(!list.length){el.innerHTML='';return;}
  el.innerHTML=list.map(c=>{
    const d=new Date(c.date+'T00:00:00');
    const hebF=new Intl.DateTimeFormat('he-IL-u-ca-hebrew',{day:'numeric',month:'long'});
    const latF=new Intl.DateTimeFormat('he-IL-u-ca-hebrew-nu-latn',{year:'numeric'});
    const hebYNum=parseInt(latF.format(d));
    const lbl=calHebrew
      ?hebF.format(d)+' '+toHebrewYear(hebYNum)
      :d.toLocaleDateString('he-IL',{day:'numeric',month:'long'});
    return`<div class="fh-cal-ev">
      <div class="fh-cal-ev-dot" style="background:${c.color||'var(--blue-mid)'}"></div>
      <div class="fh-cal-ev-info">
        <div class="fh-cal-ev-name">${esc(c.title)}</div>
        <div class="fh-cal-ev-date">${lbl}</div>
      </div>
      <button onclick="deleteCalItem(${c.id})" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:16px;padding:0 4px;opacity:.5">✕</button>
    </div>`;
  }).join('');
}

function addCalItem(){
  const tEl=document.getElementById('calAddTitle');
  const dEl=document.getElementById('calAddDate');
  const title=tEl.value.trim();
  const date=dEl.value;
  if(!title||!date)return;
  const colors=['#1E88D8','#1D9E75','#E53935','#8E24AA','#F4511E','#F6BF26'];
  const color=colors[calItems.length%colors.length];
  calItems.push({id:nxtCal++,title,date,color});
  save();renderCalendar();
  closeCalModal();
}

function deleteCalItem(id){
  if(!confirm('למחוק אירוע זה?'))return;
  calItems=calItems.filter(c=>c.id!==id);
  save();renderCalendar();
}

function startEditCost(evId){
  const ev=events.find(e=>e.id===evId);if(!ev||ev.totalCost==null)return;
  const dispEl=document.getElementById('costdisp-'+evId);if(!dispEl)return;
  const inp=document.createElement('input');
  inp.type='number';inp.value=ev.totalCost;
  inp.style.cssText='width:90px;font-size:15px;font-weight:700;color:var(--green-mid);border:1.5px solid var(--blue-mid);border-radius:6px;padding:2px 6px;font-family:var(--font);background:var(--bg);direction:ltr';
  inp.onblur=()=>saveCostEdit(evId,inp.value);
  inp.onkeydown=e=>{if(e.key==='Enter')inp.blur();if(e.key==='Escape'){inp.replaceWith(dispEl);}};
  dispEl.replaceWith(inp);
  inp.focus();inp.select();
}
function saveCostEdit(evId,val){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  const newCost=parseFloat(val)||0;
  ev.totalCost=newCost;
  save();render();
}

function openBdayModal(){
  const mSel=document.getElementById('bdayMonth');
  const dSel=document.getElementById('bdayDay');
  if(mSel&&!mSel.options.length){
    HEB_MONTHS_LIST.forEach(m=>{const o=document.createElement('option');o.value=m;o.textContent=m;mSel.appendChild(o);});
  }
  if(dSel&&!dSel.options.length){
    for(let i=1;i<=30;i++){const o=document.createElement('option');o.value=i;o.textContent=HEB_DAY_NUM[i]+' ('+i+')';dSel.appendChild(o);}
  }
  document.getElementById('bdayName').value='';
  document.getElementById('bdayModal').style.display='flex';
  setTimeout(()=>{const i=document.getElementById('bdayName');if(i)i.focus();},50);
}
function closeBdayModal(){
  document.getElementById('bdayModal').style.display='none';
}
function saveBday(){
  const name=document.getElementById('bdayName').value.trim();
  const hebMonth=document.getElementById('bdayMonth').value;
  const hebDay=parseInt(document.getElementById('bdayDay').value);
  if(!name)return;
  birthdays.push({id:nxtBday++,name,hebMonth,hebDay});
  save();renderBdayList();renderCalendar();
  closeBdayModal();
}
function deleteBday(id){
  if(!confirm('למחוק יום הולדת זה?'))return;
  birthdays=birthdays.filter(b=>b.id!==id);
  save();renderBdayList();renderCalendar();
}
function renderBdayList(){
  const el=document.getElementById('bdayList');if(!el)return;
  if(!birthdays.length){
    el.innerHTML='<div style="padding:12px 16px;text-align:center;color:var(--text3);font-size:13px">עדיין אין ימי הולדת — הוסף את הראשון 🎂</div>';
    return;
  }
  el.innerHTML=birthdays.map(b=>`
    <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-top:1px solid var(--border)">
      <span style="font-size:18px">🎂</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700;color:var(--text)">${esc(b.name)}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:1px">${HEB_DAY_NUM[b.hebDay]} ${esc(b.hebMonth)}</div>
      </div>
      <button onclick="deleteBday(${b.id})" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:16px;padding:0;opacity:.5">✕</button>
    </div>`).join('');
}

function renderHome(){
  const open=events.filter(e=>e.open);

  // ── Banner ──
  const mainBal=fundTotal();
  const goalBal=goalFunds.filter(g=>!g.archived).reduce((s,g)=>s+goalTotal(g),0);
  const evPotsBal=open.reduce((s,ev)=>s+evNetPotBal(ev),0);
  const savBal=savingsPotBal();
  const allBal=mainBal+goalBal+evPotsBal+savBal;
  const bannerStats=[
    {label:'קופה ראשית',amt:mainBal},
    ...(goalBal>0?[{label:'קופות מטרה',amt:goalBal}]:[]),
    ...(evPotsBal>0?[{label:'קופות אירועים',amt:evPotsBal}]:[]),
    ...(savBal>0?[{label:'קופת חיסכון',amt:savBal}]:[]),
  ];
  document.getElementById('homeBanner').innerHTML=`
    <div class="home-banner" onclick="goTab('fund',document.getElementById('nb-fund'))" style="cursor:pointer">
      <div class="home-banner-lbl">סך כל הקופות</div>
      <div class="home-banner-amt">₪${allBal.toLocaleString()}</div>
      ${bannerStats.length>1?`<div class="home-banner-row">${bannerStats.map(s=>`
        <div class="home-bstat">
          <div class="home-bstat-val">₪${s.amt.toLocaleString()}</div>
          <div class="home-bstat-lbl">${s.label}</div>
        </div>`).join('')}</div>`:''}
    </div>`;

  // ── Families strip ──
  const famNet={};
  families.forEach(f=>{ famNet[f.id]=0; });
  open.forEach(ev=>{
    const bal=evAdjBalance(ev);
    ev.participants.forEach(fid=>{ const b=bal[fid]||0; if(Math.abs(b)>0.5) famNet[fid]=(famNet[fid]||0)+b; });
  });
  const famStripEl=document.getElementById('homeFamStrip');
  famStripEl.innerHTML=families.length?`
    <div style="font-size:13px;font-weight:700;color:var(--text2);margin-bottom:10px">👥 משפחות</div>
    <div class="home-fam-strip">${families.map(f=>{
      const cl=col(f.id);
      const netRaw=famNet[f.id]||0;
      const net=Math.round(netRaw);
      const cls=netRaw>0.5?'pill-get':netRaw<-0.5?'pill-owe':'';
      const amtColor=netRaw>0.5?'var(--green-mid)':netRaw<-0.5?'var(--red-mid)':'var(--text3)';
      const amtText=netRaw>0.5?'+₪'+net.toLocaleString():netRaw<-0.5?'-₪'+Math.abs(net).toLocaleString():'מסודר';
      const fundBal=Math.round(famFundBal(f.id));
      return`<div class="home-fam-pill ${cls}" data-famid="${f.id}" style="cursor:pointer;touch-action:manipulation">
        ${famAva(f, 36)}
        <div style="font-size:11px;font-weight:700;color:var(--text)">${esc(f.name.replace('משפחת','').trim())}</div>
        <div style="font-size:11px;font-weight:700;color:${amtColor}">${amtText}</div>
        ${fundBal!==0?`<div style="font-size:10px;font-weight:600;color:${fundBal>0?'var(--green-mid)':'var(--text3)'}">🏦 ₪${Math.abs(fundBal).toLocaleString()}</div>`:''}
      </div>`;
    }).join('')}</div>`:'';
  famStripEl.onclick=e=>{const p=e.target.closest('[data-famid]');if(p)openFamDetail(parseInt(p.dataset.famid));};

  // ── Event cards ──
  const splitShort={equal:'שווה',percapita:'לפי נפשות',weighted:'ילד 50%'};
  document.getElementById('homeEvSection').innerHTML=`
    <div style="font-size:13px;font-weight:700;color:var(--text2);margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
      <span>📅 אירועים פעילים</span>
      ${open.length?`<span style="font-size:11px;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:2px 9px;color:var(--text2);font-weight:600">${open.length}</span>`:''}
    </div>
    ${open.length?open.map(ev=>{
      const cl=col(ev.id);
      const cost=evCost(ev);
      const pending=calcTransfers(ev);
      const adjBals=evAdjBalance(ev);
      const settledFams=ev.participants.filter(fid=>Math.abs(adjBals[fid]||0)<=0.5).length;
      const total=ev.participants.length;
      const pct=total?Math.round(settledFams/total*100):100;
      const hasPot=evPotTotal(ev)>0;
      const balanced=!pending.length;
      const tags=[
        !balanced?`<span class="badge badge-amber">↔ ${pending.length} העברות</span>`:`<span class="badge badge-green">✅ מאוזן</span>`,
        hasPot?`<span class="badge" style="background:var(--amber-bg);color:var(--amber)">💰 ₪${evNetPotBal(ev).toLocaleString()}</span>`:''
      ].filter(Boolean).join('');
      const meta=[ev.date&&ev.date!=='לא צוין'?esc(ev.date):'',ev.participants.length+' משפחות',splitShort[ev.splitMethod||'equal']].filter(Boolean).join(' · ');
      return`<div class="hev" onclick="goToEvent(${ev.id})">
        <div class="hev-top">
          <div class="hev-bar" style="background:${cl.c}"></div>
          <div class="hev-body">
            <div class="hev-name">${esc(ev.name)}</div>
            <div class="hev-sub">${meta}</div>
            <div class="hev-tags">${tags}</div>
            <div class="pbar" style="margin-top:8px"><div class="pfill ${balanced?'full':'part'}" style="width:${pct}%"></div></div>
          </div>
        </div>
        <div class="hev-foot">
          <span style="font-size:12px;color:var(--text2)">עלות כוללת <b style="color:var(--text)">₪${cost.toLocaleString()}</b></span>
          <span style="font-size:14px;color:var(--text3)">‹</span>
        </div>
      </div>`;
    }).join(''):`<div class="empty"><span class="empty-ico">📅</span>אין אירועים פעילים</div>`}`;

  const openGoals=goalFunds.filter(g=>!g.closed&&!g.archived);
  const goalSection=document.getElementById('homeGoalSection');
  goalSection.style.display=openGoals.length?'block':'none';
  document.getElementById('homeGoalList').innerHTML=openGoals.map(g=>{
    const total=goalTotal(g);
    const pct=g.target>0?Math.min(100,Math.round(total/g.target*100)):0;
    const reached=g.target>0&&total>=g.target;
    const subText=g.target>0?`נאסף ₪${total.toLocaleString()} מתוך ₪${g.target.toLocaleString()}`:`נאסף ₪${total.toLocaleString()}`;
    return`<div class="home-row home-row-col" onclick="goToGoalFund(${g.id})">
      <div class="home-goal-top">
        <div class="home-row-icon" style="background:var(--amber-bg);color:var(--amber)">🎯</div>
        <div class="home-row-body">
          <div class="home-row-title">${esc(g.name)}</div>
          <div class="home-row-sub">${subText}</div>
        </div>
        ${reached?'<span class="badge badge-green">✅ הושלם</span>':''}
      </div>
      ${g.target>0?`<div class="pbar" style="margin-top:10px"><div class="pfill ${reached?'full':'part'}" style="width:${pct}%"></div></div>`:''}
    </div>`;
  }).join('');
}
function goToEvent(evId){
  goTab('events',document.getElementById('nb-events'));
  setTimeout(()=>{
    const el=document.getElementById('ecard-'+evId);
    if(el) el.scrollIntoView({behavior:'smooth',block:'start'});
  },50);
}
function goToGoalFund(goalId){
  collapsedGoals.delete(goalId);
  goTab('fund',document.getElementById('nb-fund'));
  setTimeout(()=>{
    const el=document.getElementById('gfund-'+goalId);
    if(el) el.scrollIntoView({behavior:'smooth',block:'start'});
  },100);
}
function stepFamChildren(delta){
  const inp=document.getElementById('famEditChildren');
  inp.value=Math.max(0,(parseInt(inp.value)||0)+delta);
}
function stepChild(id,delta){
  const inp=document.getElementById(id);
  if(!inp)return;
  inp.value=Math.max(0,(parseInt(inp.value)||0)+delta);
  if(expMode==='total')updateTotalPreview();
  updateChildPickSummary();
}
function calcTransfers(ev){
  const adjBal={...evAdjBalance(ev)};
  // Pre-apply pot releases to creditors so direct transfers only show the remaining gap
  if((ev.potPayments||[]).length>0){
    calcPotTransfers(ev).forEach(t=>{ adjBal[t.toFid]=(adjBal[t.toFid]||0)-t.amt; });
    // Subtract each pot payer's excess from their adjBal so it doesn't create spurious
    // direct transfers — the excess is returned to them from the pot separately
    const excess=calcPotExcessByFamily(ev);
    Object.entries(excess).forEach(([fid,exc])=>{
      const fidNum=parseInt(fid);const adj=adjBal[fidNum]||0;
      if(adj>0.5) adjBal[fidNum]=Math.max(0,adj-exc);
    });
  }
  const pos=[],neg=[];
  ev.participants.forEach(fid=>{
    const f=getFam(fid);if(!f)return;
    const name=f.name.replace('משפחת','').trim();
    if(adjBal[fid]>0.5) pos.push({name,fid,amt:adjBal[fid]});
    else if(adjBal[fid]<-0.5) neg.push({name,fid,amt:-adjBal[fid]});
  });
  // Add savings pot as virtual creditor (collects savings + ceiling-rounding surplus from debtors)
  const _savingsTotal=ev.savingsTotal||(ev.savingsAmt||0)*ev.participants.length;
  const _savingsPaidTotal=(ev.savingsPaid||[]).reduce((s,p)=>s+p.amt,0);
  const _savingsOwed=Math.round(_savingsTotal+evSavingsSurplus(ev)-_savingsPaidTotal);
  if(_savingsOwed>0.5) pos.push({name:'קופת חיסכון',fid:'__savings__',amt:_savingsOwed,isSavings:true});
  const transfers=[];
  // Sort largest first so big debtors match big creditors → fewer splits per person
  const pCopy=pos.map(x=>({...x})).sort((a,b)=>b.amt-a.amt);
  const nCopy=neg.map(x=>({...x})).sort((a,b)=>b.amt-a.amt);
  let pi=0,ni=0;
  while(pi<pCopy.length&&ni<nCopy.length){
    const give=Math.min(pCopy[pi].amt,nCopy[ni].amt);
    if(give>0.5) transfers.push({from:nCopy[ni].name,fromFid:nCopy[ni].fid,to:pCopy[pi].name,toFid:pCopy[pi].fid,amt:Math.round(give)});
    pCopy[pi].amt-=give; nCopy[ni].amt-=give;
    if(pCopy[pi].amt<=0.5)pi++;
    if(nCopy[ni].amt<=0.5)ni++;
  }
  return transfers;
}
function canPayFromFund(fromFid, amt){
  return (fund.famBalances[String(fromFid)]||0) >= amt;
}
function markTransferFromFund(evId, from, fromFid, to, toFid, amt){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  const key=String(fromFid);
  const bal=fund.famBalances[key]||0;
  if(bal<amt){ alert('אין מספיק יתרה בקופה עבור '+from+' (יתרה: ₪'+bal.toLocaleString()+')'); return; }
  if(!ev.settled)ev.settled=[];
  ev.settled.push({from,fromFid,to,toFid,amt,method:'fund'});
  fund.famBalances[key]=bal-amt;
  fund.transactions.push({id:nxtTx++,type:'payout',famId:fromFid,amount:amt,
    desc:'תשלום של '+from+' ל'+to+' · '+ev.name,
    date:new Date().toLocaleDateString('he-IL')});
  // credit the creditor's fund balance
  const toKey2=String(toFid);
  fund.famBalances[toKey2]=(fund.famBalances[toKey2]||0)+amt;
  fund.transactions.push({id:nxtTx++,type:'deposit',famId:toFid,amount:amt,
    desc:'קיבלת מ'+from+' עבור "'+ev.name+'" (מהקופה)',
    date:new Date().toLocaleDateString('he-IL')});
  save();render();
}
function openPartPayModal(evId,from,fromFid,to,toFid,amt,isFund,fromSettle){
  _ppEvId=evId;_ppFrom=from;_ppFromFid=fromFid;_ppTo=to;_ppToFid=toFid;
  _ppMax=amt;_ppFund=isFund||false;_ppSettle=fromSettle||false;_ppPot=false;
  let fundLine='';
  if(!isFund&&fromFid!=null){
    const fundBal=fund.famBalances[String(fromFid)]||0;
    if(fundBal>0){
      const fromFundAmt=Math.min(amt,fundBal);
      fundLine=`<br><span style="color:var(--blue-mid);font-size:11px">🏦 ${fromFundAmt<amt?`₪${fromFundAmt.toLocaleString()} מהקופה + ₪${(amt-fromFundAmt).toLocaleString()} ישיר`:`₪${fromFundAmt.toLocaleString()} מהקופה (כולו)`}</span>`;
    }
  }
  document.getElementById('partPayInfo').innerHTML=`<b>${esc(from)}</b> → <b>${esc(to)}</b><br>נדרש: <b style="color:var(--blue-mid)">₪${amt.toLocaleString()}</b>${fundLine}`;
  const amtEl=document.getElementById('partPayAmt');
  amtEl.value=amt;amtEl.max=amt;
  updatePartPayRemain();
  document.getElementById('partPayModal').style.display='flex';
  setTimeout(()=>{amtEl.focus();amtEl.select();},50);
}
function updatePartPayRemain(){
  const paid=parseFloat(document.getElementById('partPayAmt').value)||0;
  const rem=Math.round(_ppMax-paid);
  const el=document.getElementById('partPayRemain');
  if(paid<=0){el.textContent='';return;}
  if(paid>_ppMax+0.5){el.style.color='var(--red-mid)';el.textContent='הסכום גבוה מהנדרש';return;}
  if(!_ppFund&&!_ppPot&&_ppFromFid!=null){
    const fundBal=fund.famBalances[String(_ppFromFid)]||0;
    if(fundBal>0){
      const fromFund=Math.min(Math.round(paid),fundBal);
      const fromDirect=Math.round(paid)-fromFund;
      let breakdown='';
      if(fromFund>0) breakdown+=`🏦 ₪${fromFund.toLocaleString()} מהקופה`;
      if(fromDirect>0) breakdown+=(breakdown?' + ':'')+`✓ ₪${fromDirect.toLocaleString()} ישיר`;
      el.style.color='var(--text2)';
      el.innerHTML=breakdown+(rem>0.5?`<br><span style="color:var(--amber)">נשאר: ₪${rem.toLocaleString()}</span>`:'<br><span style="color:var(--green-mid)">תשלום מלא ✓</span>');
      return;
    }
  }
  if(rem>0.5){el.style.color='var(--amber)';el.textContent='נשאר לתשלום: ₪'+rem.toLocaleString();}
  else{el.style.color='var(--green-mid)';el.textContent='תשלום מלא ✓';}
}
function closePartPayModal(){document.getElementById('partPayModal').style.display='none';}
function confirmPartPay(){
  const paid=Math.round(parseFloat(document.getElementById('partPayAmt').value)||0);
  if(paid<=0)return;
  if(paid>_ppMax+0.5){alert('הסכום גבוה מהנדרש');return;}
  if(_ppPot) payToPot(_ppEvId,_ppFromFid,paid);
  else if(_ppFund) markTransferFromFund(_ppEvId,_ppFrom,_ppFromFid,_ppTo,_ppToFid,paid);
  else {
    const ev=events.find(e=>e.id===_ppEvId);if(!ev)return;
    const key=String(_ppFromFid);
    const fundBal=fund.famBalances[key]||0;
    const fromFund=Math.min(paid,fundBal);
    const fromDirect=paid-fromFund;
    if(!ev.settled)ev.settled=[];
    if(fromFund>0){
      ev.settled.push({from:_ppFrom,fromFid:_ppFromFid,to:_ppTo,toFid:_ppToFid,amt:fromFund,method:'fund'});
      fund.famBalances[key]=fundBal-fromFund;
      fund.transactions.push({id:nxtTx++,type:'payout',famId:_ppFromFid,amount:fromFund,
        desc:'תשלום של '+_ppFrom+' ל'+_ppTo+' (מהקופה) · '+ev.name,
        date:new Date().toLocaleDateString('he-IL')});
      // credit the creditor's fund balance
      const toKey=String(_ppToFid);
      fund.famBalances[toKey]=(fund.famBalances[toKey]||0)+fromFund;
      fund.transactions.push({id:nxtTx++,type:'deposit',famId:_ppToFid,amount:fromFund,
        desc:'קיבלת מ'+_ppFrom+' עבור "'+ev.name+'" (מהקופה)',
        date:new Date().toLocaleDateString('he-IL')});
    }
    if(fromDirect>0) ev.settled.push({from:_ppFrom,fromFid:_ppFromFid,to:_ppTo,toFid:_ppToFid,amt:fromDirect,method:'direct'});
    save();render();
    if(ev.closed){
      const adjAfter=evAdjBalance(ev);
      if((adjAfter[_ppFromFid]||0)>=-0.5)_sendCloseEvEmailOne(ev,_ppFromFid);
      if((adjAfter[_ppToFid]||0)<=0.5)_sendCloseEvEmailOne(ev,_ppToFid);
    }
  }
  if(_ppSettle){const ev=events.find(e=>e.id===_ppEvId);if(ev)renderSettleModal(ev);}
  closePartPayModal();
}
function openPotPayModal(evId,famId){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  const f=getFam(famId);if(!f)return;
  const adj=evAdjBalance(ev);
  const owed=Math.round(Math.max(0,-(adj[famId]||0)));
  if(owed<=0)return;
  _ppEvId=evId;_ppFromFid=famId;_ppMax=owed;_ppPot=true;_ppFund=false;_ppSettle=false;
  const name=f.name.replace('משפחת','').trim();
  document.getElementById('partPayInfo').innerHTML=`<b>${esc(name)}</b> משלם לקופת האירוע<br>נדרש: <b style="color:var(--blue-mid)">₪${owed.toLocaleString()}</b>`;
  const amtEl=document.getElementById('partPayAmt');
  amtEl.value=owed;amtEl.max=owed;
  updatePartPayRemain();
  document.getElementById('partPayModal').style.display='flex';
  setTimeout(()=>{amtEl.focus();amtEl.select();},50);
}

function evCard(ev){
  const cost=evCost(ev);
  const excl=families.filter(f=>ev.excluded.includes(f.id));
  const adjBal=evAdjBalance(ev);
  const transfers=calcTransfers(ev);
  const potPayments=ev.potPayments||[];
  const potOrigByFam=evPotOrigByFam(ev);
  const potTransByFam=evPotTransByFam(ev);
  const potRefundByFam=evPotRefundByFam(ev);
  const potTotal=evPotTotal(ev);
  const potExpTotalCard=evPotExpTotal(ev);
  const hasPot=potTotal>0;
  const potByFam={};
  potPayments.forEach(p=>{if(!potByFam[p.famId])potByFam[p.famId]=[];potByFam[p.famId].push(p);});
  const balanced=cost>0&&!ev.participants.some(fid=>(adjBal[fid]||0)<-0.5);
  const shares=evShares(ev);
  const _sMethod=ev.splitMethod||'equal';
  let _sTotalW=0;const _sW={};
  ev.participants.forEach(fid=>{_sW[fid]=famWeight(getFam(fid),_sMethod,ev.childOverrides?.[fid],ev.parentOverrides?.[fid]);_sTotalW+=_sW[fid];});
  const famItemBreakdown=fid=>{
    if(!ev.expenseItems||!ev.expenseItems.length)return[];
    return ev.expenseItems.flatMap(it=>{
      if(it.customSplit){const a=it.customSplit[String(fid)]||0;return a>0?[{name:it.name,amt:a}]:[];}
      if(it.sharedWith&&it.sharedWith.length>0&&it.sharedWith.length<ev.participants.length){
        const sw=it.sharedWith.filter(id=>ev.participants.includes(id));
        return sw.includes(fid)?[{name:it.name,amt:Math.round(it.amt/sw.length)}]:[];
      }
      return [];
    });
  };
  const mems=ev.participants.map(fid=>{
    const f=getFam(fid);if(!f)return'';
    const cl=col(fid);
    const spent=ev.expenses[fid]||0;
    const b=adjBal[fid];
    const share=shares[fid]||0;
    const tagClass=b>0.5?'exp-tag-neg':b<-0.5?'exp-tag-pos':'exp-tag-zero';
    const tagText=b>0.5?'מקבל ₪'+Math.round(b).toLocaleString():b<-0.5?'מחזיר ₪'+Math.round(Math.abs(b)).toLocaleString():'מסודר ✓';
    const isDebtor=b<-0.5;
    const tagTag=isDebtor?'button':'span';
    const tagClick=isDebtor?` onclick="openPotPayModal(${ev.id},${fid})"` : '';
    const tagCls='exp-tag '+tagClass+(isDebtor?' exp-tag-clickable':'');
    const famPotAmt=potOrigByFam[fid]||0;
    const famPotTransAmt=potTransByFam[fid]||0;
    const famPotRefundAmt=potRefundByFam[fid]||0;
    return`<div class="exp-input-row">
      <div style="flex:1;display:flex;align-items:center;gap:8px;min-width:0">
        ${famAva(f)}
        <div style="flex:1;min-width:0">
          <div class="mname" style="margin-bottom:1px">${esc(f.name.replace('משפחת','').trim())}</div>
          ${cost>0?`<div style="font-size:13px;font-weight:700;color:var(--text)">חלק: ₪${share.toLocaleString()}</div>`:''}
          ${(ev.savingsTotal||ev.savingsAmt)?`<div style="font-size:11px;color:var(--green-mid);margin-top:1px">מתוכם ₪${(ev.savingsTotal?Math.round(ev.savingsTotal/(ev.participants.length||1)):(ev.savingsAmt||0)).toLocaleString()} לקופת חיסכון 💎</div>`:''}
          ${famPotAmt>0?`<div style="font-size:11px;color:var(--amber);margin-top:1px">💰 הפקיד לקופה ₪${famPotAmt.toLocaleString()}</div>`:''}
          ${famPotRefundAmt>0?`<div style="font-size:11px;color:var(--blue-mid);margin-top:1px">↩ הוחזר עודף ₪${famPotRefundAmt.toLocaleString()}</div>`:''}
        </div>
      </div>
      <div style="width:64px;flex-shrink:0;text-align:center">
        ${spent>0?`<div style="font-size:13px;font-weight:700;color:var(--text)">₪${spent.toLocaleString()}</div><div style="font-size:10px;color:var(--text2)">הוצאות</div>`:''}
      </div>
      <div style="flex:1;display:flex;align-items:center;justify-content:flex-end">
        <${tagTag} class="${tagCls}" id="tag-${ev.id}-${fid}"${tagClick}>${tagText}</${tagTag}>
      </div>
    </div>`;
  }).join('');
  const cumRows=ev.participants.map(fid=>{
    const f=getFam(fid);if(!f)return'';
    const cl=col(fid);
    const items=(ev.expenseItems||[]).filter(it=>it.famId===fid);
    const spent=ev.expenses[fid]||0;
    const b=adjBal[fid];
    const share=shares[fid]||0;
    const tagClass=b>0.5?'exp-tag-neg':b<-0.5?'exp-tag-pos':'exp-tag-zero';
    const tagText=b>0.5?'מקבל ₪'+Math.round(b).toLocaleString():b<-0.5?'מחזיר ₪'+Math.round(Math.abs(b)).toLocaleString():'מסודר ✓';
    const isDebtor=b<-0.5;
    const tagTag=isDebtor?'button':'span';
    const tagClick=isDebtor?` onclick="openPotPayModal(${ev.id},${fid})"` : '';
    const tagCls='exp-tag '+tagClass+(isDebtor?' exp-tag-clickable':'');
    const famPotAmt=potOrigByFam[fid]||0;
    const famPotTransAmt=potTransByFam[fid]||0;
    const famPotRefundAmt=potRefundByFam[fid]||0;
    const key=ev.id+'-'+fid;
    const isExpanded=expandedCumFamilies.has(key);
    const shareKey=ev.id+'-share-'+fid;
    const isShareExpanded=expandedFamShares.has(shareKey);
    const shareItems=cost>0&&share>0?famItemBreakdown(fid):[];
    const hasShareDetail=shareItems.length>0;
    const shareBreakdownHtml=hasShareDetail&&isShareExpanded?`<div style="margin-top:3px;padding:4px 8px;background:var(--surface2);border-radius:6px">${shareItems.map(b=>`<div style="display:flex;align-items:center;gap:5px;padding:1px 0"><span style="flex:1;font-size:11px;color:var(--text2)">${esc(b.name)}</span><span style="font-size:11px;font-weight:700">₪${b.amt.toLocaleString()}</span></div>`).join('')}</div>`:'';
    const detailList=items.length&&isExpanded?`<div style="padding:4px 0 2px;border-top:1px solid var(--border);margin-top:4px">
      ${items.map(it=>{
        const swNames=it.sharedWith?it.sharedWith.map(sid=>{const sf=getFam(sid);return sf?sf.name.replace('משפחת','').trim():'';}).filter(Boolean).join(', '):'';
        const itemKey=ev.id+'-item-'+it.id;
        const isItemExpanded=expandedExpItems.has(itemKey);
        const itSubLabel=it.customSplit?
          `<span style="display:block;font-size:10px;color:var(--blue);margin-top:1px">⚖️ ידנית</span>`:
          (swNames?`<span style="display:block;font-size:10px;color:var(--blue);margin-top:1px">👥 ${esc(swNames)}</span>`:'');
        const breakdownHtml=it.customSplit&&isItemExpanded?
          `<div style="margin-top:4px;padding:4px 8px;background:var(--surface2);border-radius:6px">${
            Object.entries(it.customSplit).map(([sfid,a])=>{const sf=getFam(parseInt(sfid));if(!sf)return'';return`<div style="display:flex;align-items:center;gap:5px;padding:1px 0"><span style="flex:1;font-size:11px;color:var(--text2)">${esc(sf.name.replace('משפחת','').trim())}</span><span style="font-size:11px;font-weight:700">₪${a.toLocaleString()}</span></div>`;}).join('')
          }</div>`:'';
        return`<div style="padding:3px 0;font-size:11px">
          <div style="display:flex;align-items:center;gap:6px">
            <div style="flex:1;min-width:0"><span style="color:var(--text2)">${esc(it.name)}</span>${itSubLabel}</div>
            <span style="font-weight:600;color:var(--text);flex-shrink:0">₪${it.amt.toLocaleString()}${it.origAmt&&it.origCur?'<span style="font-size:10px;color:var(--text2);font-weight:400"> ('+it.origAmt+it.origCur+')</span>':''}</span>
            ${it.customSplit?`<button onclick="toggleExpItem(${ev.id},${it.id})" style="flex-shrink:0;padding:1px 5px;border-radius:4px;border:1px solid var(--border);background:none;font-size:10px;color:var(--text2);font-family:var(--font);cursor:pointer">${isItemExpanded?'▲':'▼'}</button>`:''}
            <button onclick="editExpItem(${ev.id},${it.id})" class="edit-only" style="flex-shrink:0;width:18px;height:18px;border-radius:50%;border:none;background:var(--blue-bg);color:var(--blue);font-size:10px;font-family:var(--font);cursor:pointer;padding:0;line-height:18px;text-align:center">✏</button>
            <button onclick="deleteExpItem(${ev.id},${it.id})" class="edit-only" style="flex-shrink:0;width:18px;height:18px;border-radius:50%;border:none;background:var(--red-bg);color:var(--red);font-size:10px;font-weight:700;font-family:var(--font);cursor:pointer;padding:0;line-height:18px;text-align:center">✕</button>
          </div>
          ${breakdownHtml}
        </div>`;}).join('')}
    </div>`:'';
    return`<div class="exp-input-row" style="flex-direction:column;align-items:stretch">
      <div style="display:flex;align-items:center;gap:8px">
        <div style="flex:1;display:flex;align-items:center;gap:8px;min-width:0">
          ${famAva(f)}
          <div style="flex:1;min-width:0">
            <div class="mname" style="margin-bottom:1px">${esc(f.name.replace('משפחת','').trim())}</div>
            ${cost>0&&share>0?hasShareDetail?`<button onclick="toggleFamShare(${ev.id},${fid})" style="background:none;border:none;padding:0;cursor:pointer;font-family:var(--font);display:flex;align-items:center;gap:3px"><span style="font-size:13px;font-weight:700;color:var(--text)">חלק: ₪${share.toLocaleString()}</span><span style="font-size:10px;color:var(--text3)">${isShareExpanded?'▲':'▼'}</span></button>${shareBreakdownHtml}`:`<div style="font-size:13px;font-weight:700;color:var(--text)">חלק: ₪${share.toLocaleString()}</div>`:''}
            ${(ev.savingsTotal||ev.savingsAmt)?`<div style="font-size:11px;color:var(--green-mid);margin-top:1px">מתוכם ₪${(ev.savingsTotal?Math.round(ev.savingsTotal/(ev.participants.length||1)):(ev.savingsAmt||0)).toLocaleString()} לקופת חיסכון 💎</div>`:''}
            ${famPotAmt>0?`<div style="font-size:11px;color:var(--amber);margin-top:1px">💰 הפקיד לקופה ₪${famPotAmt.toLocaleString()}</div>`:''}
            ${famPotRefundAmt>0?`<div style="font-size:11px;color:var(--blue-mid);margin-top:1px">↩ הוחזר עודף ₪${famPotRefundAmt.toLocaleString()}</div>`:''}
          </div>
        </div>
        <div style="width:64px;flex-shrink:0;text-align:center">
          ${spent>0?`<div style="font-size:13px;font-weight:700;color:var(--text)">₪${spent.toLocaleString()}</div><div style="font-size:10px;color:var(--text2)">הוצאות</div>`:''}
          ${items.length?`<button onclick="toggleCumFamily(${ev.id},${fid})" style="margin-top:${spent>0?'2':'0'}px;padding:2px 6px;border-radius:4px;border:1px solid var(--border);background:none;font-size:10px;color:var(--text2);font-family:var(--font);cursor:pointer">${isExpanded?'▲':'▼ '+items.length}</button>`:''}
        </div>
        <div style="flex:1;display:flex;align-items:center;justify-content:flex-end">
          <${tagTag} class="${tagCls}"${tagClick}>${tagText}</${tagTag}>
        </div>
      </div>
      ${detailList}
    </div>`;
  }).join('');
  const addExpBtn=`<div style="padding:8px 14px 10px;display:flex;gap:8px" class="edit-only">
    <button onclick="openAddExpItem(${ev.id})" style="flex:1;padding:9px;border-radius:var(--r2);border:1.5px dashed var(--border);background:transparent;color:var(--text2);font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer">➕ הוצאה</button>
    <button onclick="openCumPot(${ev.id})" style="flex:1;padding:9px;border-radius:var(--r2);border:1.5px dashed var(--amber);background:var(--amber-bg);color:var(--amber);font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer">💰 הפקד לקופה</button>
  </div>`;
  const exclLine=excl.length?`<div class="excl">לא משתתפים: ${excl.map(f=>esc(f.name.replace('משפחת','').trim())).join(', ')}</div>`:'';
  const settleLines=transfers.map(t=>{
    return`<div class="settle-row" style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;padding:6px 0">
      <span style="font-size:12px">👈 <b>${esc(t.from)}</b> מעביר ל<b>${esc(t.to)}</b> &nbsp;₪${t.amt.toLocaleString()}</span>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button style="padding:5px 10px;border-radius:6px;border:none;background:var(--blue-mid);color:#fff;font-size:11px;font-weight:700;font-family:var(--font);cursor:pointer;white-space:nowrap" onclick="openPartPayModal(${ev.id},'${esc(t.from)}',${t.fromFid},'${esc(t.to)}',${t.toFid},${t.amt},false,false)">✓ שולם</button>
      </div>
    </div>`;
  }).join('');
  const settledList=(ev.settled||[]);
  const _dPotByTo={};const _dNonPot=[];
  settledList.forEach(s=>{if(s.method==='pot'){const k=s.toFid!=null?String(s.toFid):s.to;if(!_dPotByTo[k])_dPotByTo[k]={to:s.to,amt:0};_dPotByTo[k].amt+=s.amt;}else _dNonPot.push(s);});
  const _dRow=(icon,badge,from,to,amt)=>'<div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-top:1px solid var(--border);font-size:12px;color:var(--text2)"><span style="color:var(--green-mid)">'+icon+'</span><span><b style="color:var(--text)">'+esc(from)+'</b> העביר ל<b style="color:var(--text)">'+esc(to)+'</b> ₪'+Math.round(amt).toLocaleString()+'</span>'+badge+'</div>';
  const _dPotBadge='<span style="font-size:10px;background:var(--amber-bg);color:var(--amber);padding:1px 7px;border-radius:10px">קופת אירוע</span>';
  const _dPotRows=Object.values(_dPotByTo).map(p=>_dRow('💰',_dPotBadge,'קופת האירוע',p.to,p.amt));
  const _dNonPotRows=_dNonPot.map(s=>{const icon=s.method==='fund'?'🏦':'✓';const badge=s.method==='fund'?'<span style="font-size:10px;background:var(--blue-bg);color:var(--blue);padding:1px 7px;border-radius:10px">קופה</span>':'<span style="font-size:10px;background:var(--green-bg);color:var(--green);padding:1px 7px;border-radius:10px">ישיר</span>';return _dRow(icon,badge,s.from,s.to,s.amt);});
  const doneHtml=settledList.length?'<div style="margin-top:8px;padding-top:4px">'+[..._dNonPotRows,..._dPotRows].join('')+'</div>':'';
  const creditorFids=ev.participants.filter(fid=>(adjBal[fid]||0)>0.5);
  const potTransfers=calcPotTransfers(ev);
  const potByCreditor={};
  potTransfers.forEach(t=>{if(!potByCreditor[t.toFid])potByCreditor[t.toFid]={name:t.to,fid:t.toFid,amt:0};potByCreditor[t.toFid].amt+=t.amt;});
  const creditorRowsHtml=Object.values(potByCreditor).map(c=>`<div style="display:flex;align-items:center;gap:5px;margin-bottom:4px">
    <div style="font-size:11px;color:var(--text);flex:1">👈 <b>${esc(c.name)}</b> ₪${c.amt.toLocaleString()}</div>
    <button onclick="releasePotToOne(${ev.id},${c.fid},false)" style="padding:3px 7px;border-radius:5px;border:none;background:var(--blue-mid);color:#fff;font-size:10px;font-weight:700;font-family:var(--font);cursor:pointer">↗ העבר</button>
    <button onclick="releasePotToOne(${ev.id},${c.fid},true)" style="padding:3px 7px;border-radius:5px;border:none;background:var(--green-mid);color:#fff;font-size:10px;font-weight:700;font-family:var(--font);cursor:pointer">🏦 לקופה</button>
  </div>`).join('');
  const famPayRows=families.filter(f=>(potOrigByFam[f.id]||0)>0).map(f=>{
    const fid=f.id;const pf=getFam(fid);if(!pf)return'';
    const name=pf.name.replace('משפחת','').trim();
    const origAmt=potOrigByFam[fid]||0;
    const transAmt=potTransByFam[fid]||0;
    const refundAmt=potRefundByFam[fid]||0;
    const payments=potByFam[fid]||[];
    const multi=payments.length>1;
    const key=ev.id+'-pot-'+fid;
    const isExp=expandedPotFamilies.has(key);
    const delBtn=(i)=>`<button class="edit-only" onclick="deletePotDeposit(${ev.id},${fid},${i})" style="background:none;border:none;color:var(--red-mid);cursor:pointer;font-size:11px;padding:0 2px;font-family:var(--font)" title="מחק הפקדה">🗑</button>`;
    const details=multi&&isExp?'<div style="padding:4px 0 2px 14px;border-top:1px solid rgba(180,130,0,.15);margin-top:3px">'
      +payments.map((p,i)=>`<div style="font-size:10px;color:var(--text2);padding:1px 0;display:flex;align-items:center;justify-content:space-between"><span>תשלום ${i+1}: ₪${p.amt.toLocaleString()}</span>${delBtn(i)}</div>`).join('')
      +'</div>':'';
    return`<div style="margin-bottom:2px">
      <div style="display:flex;align-items:center;gap:4px;font-size:11px">
        <span style="color:var(--green-mid)">✓</span>
        <span style="flex:1;color:var(--text2)"><b style="color:var(--text)">${esc(name)}</b> שילם ₪${origAmt.toLocaleString()}</span>
        ${payments.length===1?delBtn(0):payments.length>1?`<button onclick="togglePotFamily(${ev.id},${fid})" style="background:none;border:none;font-size:10px;color:var(--amber);cursor:pointer;padding:0 3px;font-weight:700;font-family:var(--font)">${isExp?'▲':'▼ '+payments.length}</button>`:''}
      </div>
      ${refundAmt>0?`<div style="font-size:10px;color:var(--blue-mid);padding-right:14px">↩ הוחזר עודף ₪${refundAmt.toLocaleString()}</div>`:''}
      ${details}
    </div>`;
  }).join('');
  const evExcessByFam=calcPotExcessByFamily(ev);
  const excessRowsCard=Object.entries(evExcessByFam).map(([fidStr,exc])=>{
    const fid=parseInt(fidStr);const pf=getFam(fid);if(!pf)return'';
    return`<div style="display:flex;align-items:center;gap:4px;font-size:11px;margin-bottom:2px">
      <span style="color:var(--blue-mid)">↩</span>
      <span style="flex:1;color:var(--text2)"><b style="color:var(--text)">${esc(pf.name.replace('משפחת','').trim())}</b> החזר ₪${exc.toLocaleString()}</span>
    </div>`;
  }).join('');
  const _potHasPending=potTransfers.length>0||Object.keys(evExcessByFam).length>0;
  const potHtml=hasPot?`<div style="margin:8px 0 0;background:var(--amber-bg);border-radius:var(--r2);padding:8px 10px">
    <div style="font-size:11px;font-weight:700;color:var(--amber);margin-bottom:4px">💰 קופת האירוע · ₪${potTotal.toLocaleString()}</div>
    ${famPayRows}
    ${_potHasPending?`<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(180,130,0,0.2)">
      <button class="edit-only" onclick="openPotModal(${ev.id})" style="width:100%;padding:7px 10px;border-radius:6px;border:none;background:var(--amber);color:#fff;font-size:12px;font-weight:700;font-family:var(--font);cursor:pointer">↗ העבר לזכאים${creditorFids.length>1?' ('+creditorFids.length+')':''}</button>
    </div>`:''}
    ${!_potHasPending&&potPayments.length?`<button onclick="releasePot(${ev.id})" style="margin-top:6px;padding:5px 10px;border-radius:6px;border:none;background:var(--blue-mid);color:#fff;font-size:11px;font-weight:700;font-family:var(--font);cursor:pointer">✓ סמן כהועבר</button>`:''}
  </div>`:'';
  const collapsed=collapsedEvents.has(ev.id);
  return`<div class="ecard" id="ecard-${ev.id}">
    <div class="ecard-head">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px">
        <div class="ecard-title">${esc(ev.name)}</div>
        <span class="badge ${balanced&&cost>0?'badge-green':'badge-amber'}">${balanced&&cost>0?'מאוזן':'פעיל'}</span>
      </div>
      ${ev.date&&ev.date!=='לא צוין'?`<div class="ecard-meta">${esc(ev.date)}</div>`:''}
    </div>
    <div class="total-cost-bar" id="totalbar-${ev.id}">
      <span>סה"כ עלות האירוע</span>
      <span style="display:flex;align-items:center;gap:4px">
        <span id="costdisp-${ev.id}" style="color:var(--green-mid);font-size:16px">₪${cost.toLocaleString()}</span>
        ${ev.totalCost!=null?`<button class="edit-only" onclick="startEditCost(${ev.id})" style="background:none;border:none;padding:2px 3px;cursor:pointer;font-size:12px;color:var(--text3);line-height:1;opacity:.55">✏️</button>`:''}
      </span>
    </div>
    <button class="exp-btn" onclick="toggleEvCollapse(${ev.id})">${collapsed?'▼ פרטים':'▲ סגור'}</button>
    ${collapsed?'':`
    <div class="members-list" id="mlist-${ev.id}">${ev.cumulative?cumRows:mems}</div>
    ${ev.cumulative?addExpBtn:`<div style="padding:0 14px 10px" class="edit-only">
      <button onclick="openCumPot(${ev.id})" style="width:100%;padding:9px;border-radius:var(--r2);border:1.5px dashed var(--amber);background:var(--amber-bg);color:var(--amber);font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer">💰 הפקד לקופת האירוע</button>
    </div>`}
    ${exclLine}
    <div class="card-actions">
      <button class="action-btn edit-only" onclick="editEv(${ev.id})">✏️ ערוך</button>
      ${cost>0?`<button class="action-btn" onclick="openSettleModal(${ev.id})" style="${transfers.length?'background:var(--blue-bg);border-color:var(--blue-mid);color:var(--blue)':''}">📊 ${transfers.length?`<b>(${transfers.length})</b> `:''} העברות</button>`:''}
      ${hasPot?`<button class="action-btn" onclick="openPotModal(${ev.id})" style="background:var(--amber-bg);border-color:var(--amber);color:var(--amber)">💰 ₪${(potTotal-potExpTotalCard).toLocaleString()}${potExpTotalCard>0?` <span style="font-size:10px;opacity:.7">(הוצאות ₪${potExpTotalCard.toLocaleString()})</span>`:''}</button>`:''}
      ${ev.cumulative&&cost>0?ev.closed?`<span style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:6px;background:var(--surface2);border:1.5px solid var(--border);font-size:12px;color:var(--text2);font-weight:600">🏁 הסתיים</span>${balanced?`<button class="action-btn edit-only" onclick="archiveEv(${ev.id})" style="background:var(--surface2);border-color:var(--border);color:var(--text2)">🗂 לארכיון</button>`:''}` :`<button class="action-btn blue edit-only" onclick="openCloseEvModal(${ev.id})">🏁 סיים אירוע</button>${balanced?`<button class="action-btn edit-only" onclick="archiveEv(${ev.id})" style="background:var(--surface2);border-color:var(--border);color:var(--text2)">🗂 לארכיון</button>`:''}`:balanced&&cost>0?`<button class="action-btn edit-only" onclick="archiveEv(${ev.id})" style="background:var(--surface2);border-color:var(--border);color:var(--text2)">🗂 לארכיון</button>`:''}
      ${cost>0?`<button class="action-btn edit-only" onclick="openEmailModal(${ev.id})" style="background:var(--amber-bg);border-color:var(--amber);color:var(--amber)">📧 מיילים</button>`:''}
      <button class="action-btn red edit-only" onclick="delEv(${ev.id})">🗑 מחק</button>
    </div>`}
  </div>`;
}
function payToPot(evId,famId,amt){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  const adj=evAdjBalance(ev);
  const owed=Math.round(Math.max(0,-(adj[famId]||0)));
  if(owed<=0)return;
  const payment=amt!=null?Math.min(Math.round(amt),owed):owed;
  if(!ev.potPayments)ev.potPayments=[];
  ev.potPayments.push({famId,amt:payment});
  save();render();
  if(ev.closed){const nb=evAdjBalance(ev)[famId]||0;if(nb>=-0.5)_sendCloseEvEmailOne(ev,famId);}
}

function calcPotTransfers(ev){
  const pots=evEffectivePotPayments(ev);if(!pots.length)return[];
  const adjBal=evAdjBalance(ev);
  const effByFam={};
  pots.forEach(p=>{effByFam[p.famId]=(effByFam[p.famId]||0)+p.amt;});
  const credFids=new Set(ev.participants.filter(fid=>(adjBal[fid]||0)>0.5));
  // Each creditor's amount = what they still need from non-creditors beyond their own effective pot
  const creds=ev.participants.filter(fid=>credFids.has(fid))
    .map(fid=>({name:getFam(fid).name.replace('משפחת','').trim(),fid,
      amt:Math.max(0,Math.round((adjBal[fid]||0)-(effByFam[fid]||0)))}))
    .filter(c=>c.amt>0.5);
  if(!creds.length)return[];
  const potByFam={};
  pots.forEach(p=>{potByFam[p.famId]=(potByFam[p.famId]||0)+p.amt;});
  const nCopy=Object.entries(potByFam).map(([fidStr,potAmt])=>{
    const fid=parseInt(fidStr);
    if(potAmt<=0.5)return null;
    const f=getFam(fid);if(!f)return null;
    // Creditors who over-deposited (potAmt > adjBal) contribute only the surplus;
    // creditors who under/exact-deposited contribute their full deposit so other
    // creditors get maximally covered from the pot (they collect their adjBal via direct).
    const adj=adjBal[fid]||0;
    const contrib=credFids.has(fid)?(potAmt>adj?Math.round(potAmt-adj):Math.round(potAmt)):Math.round(potAmt);
    if(contrib<=0.5)return null;
    return {name:f.name.replace('משפחת','').trim(),fid,amt:contrib};
  }).filter(n=>n);
  if(!nCopy.length)return[];
  const out=[],pCopy=creds.map(x=>({...x}));
  let pi=0,ni=0;
  while(pi<pCopy.length&&ni<nCopy.length){
    if(nCopy[ni].fid===pCopy[pi].fid){ni++;continue;} // skip self-routing
    const give=Math.min(pCopy[pi].amt,nCopy[ni].amt);
    if(give>0.5) out.push({from:nCopy[ni].name,fromFid:nCopy[ni].fid,to:pCopy[pi].name,toFid:pCopy[pi].fid,amt:Math.round(give)});
    pCopy[pi].amt-=give; nCopy[ni].amt-=give;
    if(pCopy[pi].amt<=0.5)pi++;
    if(nCopy[ni].amt<=0.5)ni++;
  }
  return out;
}
function calcPotExcessByFamily(ev){
  const pots=evEffectivePotPayments(ev);if(!pots.length)return{};
  // Group total pot per family
  const potByFam={};
  pots.forEach(p=>{potByFam[p.famId]=(potByFam[p.famId]||0)+p.amt;});
  // What was actually distributed from each family to creditors
  const distributed={};
  calcPotTransfers(ev).forEach(t=>{distributed[t.fromFid]=(distributed[t.fromFid]||0)+t.amt;});
  // Excess = what they put in - what actually went to creditors
  const result={};
  Object.entries(potByFam).forEach(([fidStr,potAmt])=>{
    const fid=parseInt(fidStr);
    const exc=Math.round(potAmt-(distributed[fid]||0));
    if(exc>0.5) result[fid]=exc;
  });
  return result;
}
function releasePot(evId){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  const pots=evEffectivePotPayments(ev);if(!pots.length)return;
  const baseBal=evAdjBalance({...ev,potPayments:[]});
  const creditors=ev.participants.filter(fid=>(baseBal[fid]||0)>0.5)
    .map(fid=>({name:getFam(fid).name.replace('משפחת','').trim(),fid,amt:baseBal[fid]}));
  if(!creditors.length){
    pots.forEach(p=>{ ev.expenses[p.famId]=(ev.expenses[p.famId]||0)+p.amt; });
  } else {
    if(!ev.settled)ev.settled=[];
    calcPotTransfers(ev).forEach(t=>{
      ev.settled.push({from:t.from,fromFid:t.fromFid,to:t.to,toFid:t.toFid,amt:t.amt,method:'pot'});
    });
  }
  ev.potPayments=[];
  save();render();
  if(ev.closed){const adjA=evAdjBalance(ev);ev.participants.forEach(fid=>{if(Math.abs(adjA[fid]||0)<=0.5)_sendCloseEvEmailOne(ev,fid);});}
}
function releasePotToOne(evId,creditorFid,toFund){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  if(!(ev.potPayments||[]).length)return;
  const transfers=calcPotTransfers(ev).filter(t=>t.toFid===creditorFid);
  if(!transfers.length)return;
  const totalAmt=transfers.reduce((s,t)=>s+t.amt,0);
  if(totalAmt<=0)return;
  if(!ev.settled)ev.settled=[];
  transfers.forEach(t=>{
    ev.settled.push({from:t.from,fromFid:t.fromFid,to:t.to,toFid:t.toFid,amt:t.amt,method:'pot'});
  });
  if(toFund){
    const fam=getFam(creditorFid);if(!fam)return;
    const key=String(creditorFid);
    fund.famBalances[key]=(fund.famBalances[key]||0)+totalAmt;
    const famName=fam.name.replace('משפחת','').trim();
    fund.transactions.push({id:nxtTx++,type:'deposit',famId:creditorFid,amount:totalAmt,
      desc:'מקופת אירוע · '+ev.name+' → '+famName,
      date:new Date().toLocaleDateString('he-IL')});
  }
  const potMap={};
  ev.potPayments.forEach(p=>{potMap[p.famId]=(potMap[p.famId]||0)+p.amt;});
  transfers.forEach(t=>{potMap[t.fromFid]=(potMap[t.fromFid]||0)-t.amt;});
  ev.potPayments=Object.entries(potMap).filter(([,a])=>a>0.5).map(([fid,amt])=>({famId:+fid,amt:Math.round(amt)}));
  save();render();
  if(ev.closed){const adjA=evAdjBalance(ev);ev.participants.forEach(fid=>{if(Math.abs(adjA[fid]||0)<=0.5)_sendCloseEvEmailOne(ev,fid);});}
}
function releasePotToSavings(evId,amt){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  amt=Math.round(amt);if(amt<=0)return;
  const potTotal=evPotTotal(ev);
  const toReduce=Math.min(amt,potTotal);
  if(toReduce>0.5){
    const ratio=toReduce/potTotal;
    ev.potPayments=(ev.potPayments||[]).map(p=>({...p,amt:Math.round(p.amt*(1-ratio))})).filter(p=>p.amt>0.5);
  }
  if(!ev.potToSavings)ev.potToSavings=[];
  ev.potToSavings.push({amt,date:new Date().toLocaleDateString('he-IL')});
  save();render();
  if(potModalEvId===evId){const te=events.find(e=>e.id===evId);if(te)renderPotModal(te);}
  if(potTrModalEvId===evId){const te=events.find(e=>e.id===evId);if(te&&evPotTotal(te)>0)renderPotTransferModal(te);else closePotTransferModal();}
}
function renderArchiveGoals(){
  const el=document.getElementById('archGoalList');
  if(!el)return;
  const archived=goalFunds.filter(g=>g.archived);
  if(!archived.length){el.innerHTML='';return;}
  el.innerHTML=`<div class="sec-ttl" style="margin-top:18px">קופות מטרה בארכיון</div>`+archived.map(g=>{
    const total=goalTotal(g);
    const isExp=expandedArchGoals.has(g.id);
    const rows=families.map(f=>{
      const cl=col(f.id);
      const c=g.contributions[f.id]||0;
      return`<div class="amrow">
        ${famAva(f, 30)}
        <span style="font-size:13px;font-weight:600;flex:1">${esc(f.name.replace('משפחת','').trim())}</span>
        <span style="font-size:12px;color:var(--text2)">הפקיד ₪${c.toLocaleString()}</span>
      </div>`;
    }).join('');
    return`<div class="acard">
      <div class="acard-head">
        <div style="flex:1">
          <div class="acard-title">🔒 🎯 ${esc(g.name)}</div>
          <div class="acard-meta">${g.target>0?`נאסף ₪${total.toLocaleString()} מתוך ₪${g.target.toLocaleString()}`:`נאסף ₪${total.toLocaleString()}`}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <span class="total-chip">₪${total.toLocaleString()}</span>
          <button class="exp-btn" onclick="toggleArchGoalExp(${g.id})">${isExp?'▲ סגור':'▼ פרטים'}</button>
        </div>
      </div>
      ${isExp?`<div class="acard-body">${rows}
        <div class="card-actions">
          <button class="action-btn edit-only" onclick="reopenGoalFund(${g.id})">🔓 פתח מחדש</button>
          <button class="action-btn red edit-only" onclick="delGoalFund(${g.id})">🗑 מחק</button>
        </div></div>`:''}
    </div>`;
  }).join('');
}
function renderArchive(){
  renderArchiveGoals();
  const closed=events.filter(e=>!e.open);
  const years=[...new Set(closed.map(e=>e.date.split(' ').pop()))].sort((a,b)=>b-a);
  document.getElementById('yearRow').innerHTML=['all',...years].map(y=>
    `<button class="ypill ${actYear===y?'active':''}" onclick="setYear('${esc(y)}')">${y==='all'?'הכל':esc(y)}</button>`).join('');
  const filtered=actYear==='all'?closed:closed.filter(e=>e.date.includes(actYear));
  if(!filtered.length){document.getElementById('archList').innerHTML=`<div class="empty"><span class="empty-ico">🗂️</span>${closed.length?'אין אירועים לשנה זו':'הארכיון ריק'}</div>`;return;}
  document.getElementById('archList').innerHTML=filtered.map(ev=>{
    const cost=evCost(ev);const isExp=expanded.has(ev.id);
    const excl=families.filter(f=>ev.excluded.includes(f.id));
    const mems=ev.participants.map(fid=>{
      const f=getFam(fid);if(!f)return'';const cl=col(fid);
      const spent=ev.expenses[fid]||0;
      const b=evBalance(ev)[fid];
      return`<div class="amrow">
        ${famAva(f, 30)}
        <span style="font-size:13px;font-weight:600;flex:1">${esc(f.name.replace('משפחת','').trim())}</span>
        <span style="font-size:12px;color:var(--text2)">שילם ₪${spent.toLocaleString()}</span>
        <span class="badge ${b>=0?'badge-green':'badge-amber'}" style="font-size:10px">${b>=0?'קיבל ₪'+b:'החזיר ₪'+Math.abs(b)}</span>
      </div>`;
    }).join('');
    const exclLine=excl.length?`<div class="excl">לא השתתפו: ${excl.map(f=>esc(f.name.replace('משפחת','').trim())).join(', ')}</div>`:'';
    return`<div class="acard">
      <div class="acard-head">
        <div style="flex:1">
          <div class="acard-title">🔒 ${esc(ev.name)}</div>
          <div class="acard-meta">${ev.date&&ev.date!=='לא צוין'?esc(ev.date)+' · ':''}${ev.participants.length} משפחות · ${shareLabel(ev)}</div>
          ${ev.closedOn?`<div class="acard-closed">נסגר: ${ev.closedOn}</div>`:''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <span class="total-chip">₪${cost.toLocaleString()}</span>
          <button class="exp-btn" onclick="toggleExp(${ev.id})">${isExp?'▲ סגור':'▼ פרטים'}</button>
        </div>
      </div>
      ${isExp?`<div class="acard-body">${mems}${exclLine}
        <div class="card-actions">
          <button class="action-btn edit-only" onclick="editEv(${ev.id})">✏️ ערוך</button>
          <button class="action-btn edit-only" onclick="reopenEv(${ev.id})">🔓 פתח מחדש</button>
          <button class="action-btn red edit-only" onclick="delEv(${ev.id})">🗑 מחק</button>
        </div></div>`:''}
    </div>`;
  }).join('');
}
function renderDebts(){
  const debts={};
  families.forEach(f=>{debts[f.id]={total:0,evs:[]};});
  events.filter(e=>e.open).forEach(ev=>{
    const bal=evAdjBalance(ev);
    ev.participants.forEach(fid=>{ if(bal[fid]<-0.5){debts[fid].total+=Math.abs(bal[fid]);debts[fid].evs.push(esc(ev.name));} });
  });
  const has=families.filter(f=>debts[f.id]?.total>0);
  const none=families.filter(f=>debts[f.id]?.total===0);
  if(!has.length){
    document.getElementById('debtList').innerHTML=`<div class="no-debt">✅<br><br>אין חובות פתוחים!<br><span style="font-size:12px">כולם מסודרים</span></div>`;return;
  }
  let html=`<div class="dcard">`;
  html+=has.map(f=>{const cl=col(f.id);const d=debts[f.id];
    return`<div class="drow">
      <div style="display:flex;align-items:center;gap:10px">
        ${famAva(f)}
        <div><div class="dname">${esc(f.name)}</div><div class="devents">${d.evs.join(' · ')}</div></div>
      </div>
      <div><div class="damt">₪${d.total.toLocaleString()}</div><div class="dcnt">${d.evs.length} אירוע${d.evs.length>1?'ות':''}</div></div>
    </div>`;
  }).join('');
  if(none.length)html+=`<div class="clean-row">✓ ללא חוב: ${none.map(f=>esc(f.name.replace('משפחת','').trim())).join(', ')}</div>`;
  html+=`</div>`;
  document.getElementById('debtList').innerHTML=html;
}
function renderFamilies(){
  document.getElementById('famList').innerHTML=families.map(f=>{
    const cl=col(f.id);const cnt=events.filter(e=>e.participants.includes(f.id)).length;
    return`<div class="fcard" onclick="openFamDetail(${f.id})" style="cursor:pointer">
      ${famAva(f, 38)}
      <div style="flex:1"><div class="fname">${esc(f.name)}</div><div class="fevents">${cnt} אירועים${f.children?' · '+f.children+' ילדים':''}<span class="edit-only">${(()=>{const v=new Set(JSON.parse(localStorage.getItem('verifiedEmails')||'[]'));const hasEmail=f.email||f.email2;const allOk=(f.email?v.has(f.email):true)&&(f.email2?v.has(f.email2):true);return hasEmail?(allOk?' · ✅':'· 📧'):'';})()}</span></div></div>
      <button class="action-btn edit-only" onclick="event.stopPropagation();openFamEditSheet(${f.id})">✏️ ערוך</button>
    </div>`;
  }).join('');
}
function famAva(f, size=34, extra=''){
  const cl=col(f.id);
  const fs=size<=24?'9px':size<=28?'10px':size<=32?'11px':'12px';
  if(f.photo) return `<img src="${f.photo}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0;${extra}" alt="">`;
  return `<div class="ava" style="background:${cl.bg};color:${cl.c};width:${size}px;height:${size}px;font-size:${fs};${extra}">${ini(f.name)}</div>`;
}
let _famEditId=null;
let _famEditPhoto=undefined;
let _reposImgSize=null,_reposOffset={x:0,y:0},_reposDragging=false,_reposStart=null;
let _reposZoom=1,_reposBaseW=0,_reposBaseH=0,_pinchStartDist=null,_pinchStartZoom=1;
function previewFamPhoto(inp){
  if(!inp.files||!inp.files[0])return;
  const reader=new FileReader();
  reader.onload=e=>openPhotoRepos(e.target.result);
  reader.readAsDataURL(inp.files[0]);
}
function getPinchDist(e){
  const dx=e.touches[0].clientX-e.touches[1].clientX;
  const dy=e.touches[0].clientY-e.touches[1].clientY;
  return Math.sqrt(dx*dx+dy*dy);
}
function updateReposZoom(z){
  const imgEl=document.getElementById('photoReposImg');
  if(!_reposBaseW)return;
  const sz=200;
  z=Math.min(4,Math.max(1,z));
  _reposZoom=z;
  const dw=_reposBaseW*z,dh=_reposBaseH*z;
  _reposImgSize={w:dw,h:dh,sz};
  imgEl.style.width=dw+'px';imgEl.style.height=dh+'px';
  let nx=Math.min(0,Math.max(sz-dw,_reposOffset.x));
  let ny=Math.min(0,Math.max(sz-dh,_reposOffset.y));
  _reposOffset={x:nx,y:ny};
  imgEl.style.transform=`translate(${nx}px,${ny}px)`;
  const zoomLbl=document.getElementById('reposZoomLbl');
  if(zoomLbl)zoomLbl.textContent=Math.round(z*100)+'%';
}
function openPhotoRepos(rawUrl){
  const modal=document.getElementById('photoReposModal');
  const imgEl=document.getElementById('photoReposImg');
  const circle=document.getElementById('photoReposCircle');
  const sz=200;
  _reposZoom=1;_reposBaseW=0;_reposBaseH=0;_pinchStartDist=null;
  imgEl.onload=()=>{
    const nw=imgEl.naturalWidth,nh=imgEl.naturalHeight;
    const scale=Math.max(sz/nw,sz/nh);
    _reposBaseW=nw*scale;_reposBaseH=nh*scale;
    const dw=_reposBaseW,dh=_reposBaseH;
    imgEl.style.width=dw+'px';imgEl.style.height=dh+'px';
    _reposOffset={x:(sz-dw)/2,y:(sz-dh)/2};
    imgEl.style.transform=`translate(${_reposOffset.x}px,${_reposOffset.y}px)`;
    _reposImgSize={w:dw,h:dh,sz};
    const zoomLbl=document.getElementById('reposZoomLbl');
    if(zoomLbl)zoomLbl.textContent='100%';
  };
  imgEl.src=rawUrl;
  modal.style.display='flex';
  const onDown=e=>{
    if(e.touches&&e.touches.length===2){
      _pinchStartDist=getPinchDist(e);
      _pinchStartZoom=_reposZoom;
      e.preventDefault();return;
    }
    _reposDragging=true;
    const p=e.touches?e.touches[0]:e;
    _reposStart={x:p.clientX-_reposOffset.x,y:p.clientY-_reposOffset.y};
    e.preventDefault();
  };
  const onMove=e=>{
    if(e.touches&&e.touches.length===2&&_pinchStartDist){
      const dist=getPinchDist(e);
      updateReposZoom(_pinchStartZoom*(dist/_pinchStartDist));
      e.preventDefault();return;
    }
    if(!_reposDragging||!_reposImgSize)return;
    const p=e.touches?e.touches[0]:e;
    const s=_reposImgSize;
    let nx=p.clientX-_reposStart.x,ny=p.clientY-_reposStart.y;
    nx=Math.min(0,Math.max(s.sz-s.w,nx));
    ny=Math.min(0,Math.max(s.sz-s.h,ny));
    _reposOffset={x:nx,y:ny};
    imgEl.style.transform=`translate(${nx}px,${ny}px)`;
    e.preventDefault();
  };
  const onUp=e=>{
    if(e&&e.touches&&e.touches.length<2)_pinchStartDist=null;
    _reposDragging=false;
  };
  circle.onmousedown=circle.ontouchstart=onDown;
  document.onmousemove=document.ontouchmove=onMove;
  document.onmouseup=document.ontouchend=onUp;
  circle.onwheel=e=>{
    e.preventDefault();
    updateReposZoom(_reposZoom*(e.deltaY<0?1.1:0.9));
  };
}
function confirmPhotoRepos(){
  const imgEl=document.getElementById('photoReposImg');
  const s=_reposImgSize;if(!s)return;
  const canvas=document.createElement('canvas');
  canvas.width=160;canvas.height=160;
  const ratio=160/s.sz;
  canvas.getContext('2d').drawImage(imgEl,_reposOffset.x*ratio,_reposOffset.y*ratio,s.w*ratio,s.h*ratio);
  _famEditPhoto=canvas.toDataURL('image/jpeg',0.75);
  const preview=document.getElementById('famEditPhotoPreview');
  const clearBtn=document.getElementById('famEditPhotoClear');
  if(preview) preview.innerHTML=`<img src="${_famEditPhoto}" style="width:100%;height:100%;object-fit:cover">`;
  if(clearBtn) clearBtn.style.display='inline-block';
  closePhotoRepos();
}
function closePhotoRepos(){
  document.getElementById('photoReposModal').style.display='none';
  _reposDragging=false;_pinchStartDist=null;
  document.onmousemove=document.ontouchmove=null;
  document.onmouseup=document.ontouchend=null;
}
function clearFamPhoto(){
  _famEditPhoto=null;
  const f=families.find(x=>x.id===_famEditId);
  const cl=f?col(f.id):{bg:'var(--surface2)',c:'var(--text2)'};
  const preview=document.getElementById('famEditPhotoPreview');
  const clearBtn=document.getElementById('famEditPhotoClear');
  const inp=document.getElementById('famEditPhoto');
  if(inp) inp.value='';
  if(preview) preview.innerHTML=f?`<span style="background:${cl.bg};color:${cl.c};width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700">${ini(f.name)}</span>`:'';
  if(clearBtn) clearBtn.style.display='none';
}
function openFamEditSheet(fid){
  const f=families.find(x=>x.id===fid);if(!f)return;
  _famEditId=fid;
  document.getElementById('famEditName').value=f.name.replace('משפחת','').trim();
  const cl=col(f.id);
  const preview=document.getElementById('famEditPhotoPreview');
  const clearBtn=document.getElementById('famEditPhotoClear');
  const inp=document.getElementById('famEditPhoto');
  if(inp)inp.value='';
  _famEditPhoto=undefined;
  if(preview){
    if(f.photo){ preview.innerHTML=`<img src="${f.photo}" style="width:100%;height:100%;object-fit:cover">`; }
    else { preview.innerHTML=`<span style="background:${cl.bg};color:${cl.c};width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700">${ini(f.name)}</span>`; }
  }
  if(clearBtn) clearBtn.style.display=f.photo?'inline-block':'none';
  document.getElementById('famEditChildren').value=f.children||0;
  document.getElementById('famEditEmailName').value=f.emailName||'';
  document.getElementById('famEditEmail').value=f.email||'';
  document.getElementById('famEditEmailName2').value=f.emailName2||'';
  document.getElementById('famEditEmail2').value=f.email2||'';
  const verified=new Set(JSON.parse(localStorage.getItem('verifiedEmails')||'[]'));
  const b1=document.getElementById('testBtn1');const b2=document.getElementById('testBtn2');
  if(b1){b1.textContent=f.email&&verified.has(f.email)?'✓':'בדוק';b1.style.color=f.email&&verified.has(f.email)?'var(--green)':'var(--text2)';b1.style.fontWeight=f.email&&verified.has(f.email)?'700':'';}
  if(b2){b2.textContent=f.email2&&verified.has(f.email2)?'✓':'בדוק';b2.style.color=f.email2&&verified.has(f.email2)?'var(--green)':'var(--text2)';b2.style.fontWeight=f.email2&&verified.has(f.email2)?'700':'';}

  document.getElementById('famEditOverlay').style.display='flex';
}
function openFamDetail(famId){
  const f=getFam(famId);if(!f)return;
  const name=f.name.replace('משפחת','').trim();
  const openEvs=events.filter(e=>e.open&&e.participants.includes(famId));
  const mainBal=Math.round(famFundBal(famId));
  const myGoals=goalFunds.filter(g=>!g.archived&&(g.contributions[famId]||0)>0);

  let html=`<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
    ${famAva(f,52)}
    <div>
      <div style="font-size:17px;font-weight:800;color:var(--text)">משפחת ${esc(name)}</div>
      ${f.children?`<div style="font-size:12px;color:var(--text2);margin-top:2px">👶 ${f.children} ילדים</div>`:'<div style="font-size:12px;color:var(--text3);margin-top:2px">ללא ילדים רשומים</div>'}
    </div>
  </div>`;

  // מיילים
  const emails=[f.email,f.email2].filter(Boolean);
  if(emails.length){
    html+=`<div style="margin-bottom:14px">
      <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:6px">📧 כתובות מייל</div>
      ${emails.map(e=>`<div style="font-size:13px;color:var(--text);padding:5px 0;border-bottom:1px solid var(--border)">${esc(e)}</div>`).join('')}
    </div>`;
  }

  // יתרת קופה ראשית
  html+=`<div style="margin-bottom:14px;padding:12px;background:var(--surface2);border-radius:var(--r2);display:flex;justify-content:space-between;align-items:center">
    <span style="font-size:13px;font-weight:600;color:var(--text2)">🏦 קופה ראשית</span>
    <span style="font-size:15px;font-weight:800;color:${mainBal>=0?'var(--green-mid)':'var(--red-mid)'}">₪${mainBal.toLocaleString()}</span>
  </div>`;

  // קופות מטרה
  if(myGoals.length){
    html+=`<div style="margin-bottom:14px">
      <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:6px">🎯 קופות מטרה</div>
      ${myGoals.map(g=>{
        const contrib=Math.round(g.contributions[famId]||0);
        return`<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:13px;color:var(--text)">${esc(g.name)}</span>
          <span style="font-size:13px;font-weight:700;color:var(--green-mid)">₪${contrib.toLocaleString()}</span>
        </div>`;
      }).join('')}
    </div>`;
  }

  // אירועים פתוחים
  if(openEvs.length){
    html+=`<div style="margin-bottom:6px">
      <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:6px">📅 אירועים פעילים</div>
      ${openEvs.map(ev=>{
        const bal=evAdjBalance(ev)[famId]||0;
        const balRound=Math.round(bal);
        const balColor=bal>0.5?'var(--green-mid)':bal<-0.5?'var(--red-mid)':'var(--text3)';
        const balText=bal>0.5?`+₪${balRound.toLocaleString()}`:bal<-0.5?`-₪${Math.abs(balRound).toLocaleString()}`:'מסודר';
        return`<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:13px;color:var(--text)">${esc(ev.name)}</span>
          <span style="font-size:13px;font-weight:700;color:${balColor}">${balText}</span>
        </div>`;
      }).join('')}
    </div>`;
  }else{
    html+=`<div style="font-size:12px;color:var(--text3);text-align:center;padding:8px 0">אין אירועים פעילים</div>`;
  }

  document.getElementById('famDetailContent').innerHTML=html;
  document.getElementById('famDetailOverlay').style.display='flex';
}
function closeFamDetail(){
  document.getElementById('famDetailOverlay').style.display='none';
}

function closeFamEditSheet(){
  document.getElementById('famEditOverlay').style.display='none';
  _famEditId=null;
}
function saveFamEdit(){
  if(_famEditId==null)return;
  const f=families.find(x=>x.id===_famEditId);if(!f)return;
  let name=document.getElementById('famEditName').value.trim();
  if(!name){ alert('נא להזין שם'); return; }
  if(!name.startsWith('משפחת'))name='משפחת '+name;
  f.name=name;
  f.children=Math.max(0,parseInt(document.getElementById('famEditChildren').value)||0);
  const prevEmail=f.email,prevEmail2=f.email2;
  f.email=_cleanEmail(document.getElementById('famEditEmail').value)||'';
  f.email2=_cleanEmail(document.getElementById('famEditEmail2').value)||'';
  f.emailName=(document.getElementById('famEditEmailName').value||'').trim()||'';
  f.emailName2=(document.getElementById('famEditEmailName2').value||'').trim()||'';
  const verified=new Set(JSON.parse(localStorage.getItem('verifiedEmails')||'[]'));
  if(prevEmail&&prevEmail!==f.email) verified.delete(prevEmail);
  if(prevEmail2&&prevEmail2!==f.email2) verified.delete(prevEmail2);
  localStorage.setItem('verifiedEmails',JSON.stringify([...verified]));
  if(_famEditPhoto!==undefined) f.photo=_famEditPhoto||undefined;
  _famEditPhoto=undefined;
  closeFamEditSheet();
  save();render();
}
function delFamFromEdit(){
  if(_famEditId==null)return;
  if(events.some(e=>e.participants.includes(_famEditId))){alert('לא ניתן למחוק משפחה שמשתתפת באירועים');return;}
  if(!confirm('להסיר את המשפחה?'))return;
  families=families.filter(f=>f.id!==_famEditId);
  closeFamEditSheet();
  save();render();
}

// Form
let expMode='total';
let editingId=null;
let splitMethod='equal';
function setSplitMethod(method){
  splitMethod=method;
  ['splitEqual','splitPercapita','splitWeighted'].forEach(id=>document.getElementById(id).classList.remove('active'));
  const ids={equal:'splitEqual',percapita:'splitPercapita',weighted:'splitWeighted'};
  document.getElementById(ids[method]).classList.add('active');
  updateChildOverrideInputs();
  if(expMode==='total') updateTotalPreview();
}
function formChildOverride(fid){
  const inp=document.getElementById('fchild-'+fid);
  if(inp&&inp.value!=='') return Math.max(0,parseInt(inp.value)||0);
  return undefined;
}
function formParentOverride(fid){
  const inp=document.getElementById('fparent-'+fid);
  if(inp&&inp.value!=='') return Math.min(2,Math.max(0,parseInt(inp.value)||0));
  return undefined;
}
function stepParent(id,delta){
  const inp=document.getElementById(id);if(!inp)return;
  inp.value=Math.min(2,Math.max(0,(parseInt(inp.value)||0)+delta));
  if(expMode==='total')updateTotalPreview();updateChildPickSummary();
}
function updateChildOverrideInputs(){
  const sec=document.getElementById('childOverrideSection');
  const selected=families.filter(f=>{ const c=document.getElementById('chip-'+f.id); return c&&c.classList.contains('on'); });
  if(splitMethod==='equal'||!selected.length){ sec.style.display='none'; return; }
  sec.style.display='block';
  const ev=editingId!=null?events.find(e=>e.id===editingId):null;
  const btnStyle='width:30px;height:30px;border:none;background:var(--bg);color:var(--text);font-size:17px;font-weight:300;cursor:pointer;font-family:var(--font)';
  const inpStyle='border:none;border-right:1.5px solid var(--border);border-left:1.5px solid var(--border);border-radius:0;width:36px;height:30px;padding:0';
  const stepperWrap='display:flex;align-items:center;border:1.5px solid var(--border);border-radius:var(--r2);overflow:hidden';
  document.getElementById('childOverrideInputs').innerHTML=selected.map(f=>{
    const valCh=ev&&ev.childOverrides&&ev.childOverrides[f.id]!=null?ev.childOverrides[f.id]:(f.children||0);
    const valPa=ev&&ev.parentOverrides&&ev.parentOverrides[f.id]!=null?ev.parentOverrides[f.id]:FAM_ADULTS;
    return`<div style="margin-bottom:10px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--r2)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        ${famAva(f, 28, 'flex-shrink:0')}
        <span style="flex:1;font-size:13px;font-weight:700">${esc(f.name.replace('משפחת','').trim())}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:12px;color:var(--text2);width:44px">הורים</span>
        <div style="${stepperWrap}">
          <button type="button" onclick="stepParent('fparent-${f.id}',-1)" style="${btnStyle}">−</button>
          <input class="children-inp" type="number" min="0" max="2" inputmode="numeric" id="fparent-${f.id}" value="${valPa}" oninput="if(expMode==='total')updateTotalPreview();updateChildPickSummary()" style="${inpStyle}">
          <button type="button" onclick="stepParent('fparent-${f.id}',1)" style="${btnStyle}">+</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:12px;color:var(--text2);width:44px">ילדים</span>
        <div style="${stepperWrap}">
          <button type="button" onclick="stepChild('fchild-${f.id}',-1)" style="${btnStyle}">−</button>
          <input class="children-inp" type="number" min="0" inputmode="numeric" id="fchild-${f.id}" value="${valCh}" oninput="if(expMode==='total')updateTotalPreview();updateChildPickSummary()" style="${inpStyle}">
          <button type="button" onclick="stepChild('fchild-${f.id}',1)" style="${btnStyle}">+</button>
        </div>
      </div>
    </div>`;
  }).join('');
  updateChildPickSummary();
}
function openChildOverridePicker(){
  document.getElementById('childOverrideOverlay').style.display='flex';
}
function closeChildOverridePicker(){
  document.getElementById('childOverrideOverlay').style.display='none';
  updateChildPickSummary();
  if(expMode==='total')updateTotalPreview();
}
function updateChildPickSummary(){
  const el=document.getElementById('childPickSummary');if(!el)return;
  const selected=families.filter(f=>{ const c=document.getElementById('chip-'+f.id); return c&&c.classList.contains('on'); });
  if(!selected.length){el.textContent='הגדר הרכב לפי משפחה';return;}
  const totalCh=selected.reduce((s,f)=>{ const v=formChildOverride(f.id); return s+(v!=null?v:(f.children||0)); },0);
  const totalPa=selected.reduce((s,f)=>{ const v=formParentOverride(f.id); return s+(v!=null?v:FAM_ADULTS); },0);
  el.textContent=`${totalPa} הורים · ${totalCh} ילדים`;
}
function openExpensePicker(){
  document.getElementById('expenseOverlay').style.display='flex';
}
function closeExpensePicker(){
  document.getElementById('expenseOverlay').style.display='none';
  updateExpensePickSummary();
}
function updateExpensePickSummary(){
  const el=document.getElementById('expensePickSummary');if(!el)return;
  let total=0;
  families.forEach(f=>{ const inp=document.getElementById('fexp-'+f.id); if(inp) total+=parseFloat(inp.value)||0; });
  el.textContent=total>0?`הוזן ₪${total.toLocaleString()}`:'כמה כל משפחה שילמה';
}
function setExpMode(mode){
  expMode=mode;
  const isTotal=mode==='total';
  const isCumulative=mode==='cumulative';
  document.getElementById('totalModeDiv').style.display=isTotal?'block':'none';
  document.getElementById('customModeDiv').style.display=(!isTotal&&!isCumulative)?'block':'none';
  document.getElementById('cumulativeModeDiv').style.display=isCumulative?'block':'none';
  ['modeTotal','modeCustom','modeCumulative'].forEach(btnId=>{
    const btn=document.getElementById(btnId);if(!btn)return;
    const active=(btnId==='modeTotal'&&isTotal)||(btnId==='modeCustom'&&mode==='custom')||(btnId==='modeCumulative'&&isCumulative);
    btn.style.background=active?'var(--blue-mid)':'transparent';
    btn.style.color=active?'#fff':'var(--text2)';
    btn.style.borderColor=active?'var(--blue-mid)':'var(--border)';
  });
  if(isTotal) updateTotalPreview();
}
function updateTotalPreview(){
  const total=parseFloat(document.getElementById('f-total')?.value)||0;
  const selected=families.filter(f=>{ const c=document.getElementById('chip-'+f.id); return c&&c.classList.contains('on'); });
  if(!selected.length||!total){ document.getElementById('totalPreview').innerHTML=''; return; }
  let totalW=0; const w={};
  selected.forEach(f=>{ w[f.id]=famWeight(f,splitMethod,formChildOverride(f.id),formParentOverride(f.id)); totalW+=w[f.id]; });
  document.getElementById('totalPreview').innerHTML=
    '<div style="background:var(--surface2);border-radius:var(--r2);padding:10px 12px">'
    +'<div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:6px">'+SPLIT_LABELS[splitMethod]+'</div>'
    +selected.map(f=>{ const cl=col(f.id); const share=totalW?Math.round(total*w[f.id]/totalW):0; return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0">'
      +famAva(f, 26, 'flex-shrink:0')
      +'<span style="font-size:13px;flex:1">'+esc(f.name.replace('משפחת','').trim())+'</span>'
      +'<span style="font-size:13px;font-weight:700;color:var(--green-mid)">₪'+share.toLocaleString()+'</span>'
      +'</div>'; }).join('')
    +'</div>';
}
function showForm(){
  editingId=null;
  document.getElementById('formTitle').textContent='➕ אירוע חדש';
  document.getElementById('formSaveBtn').textContent='✓ צור אירוע';
  document.getElementById('f-name').value='';
  document.getElementById('f-date').value='';
  ['e-name','e-cost','e-fams'].forEach(id=>{ const el=document.getElementById(id); if(el) el.classList.remove('show'); });
  document.getElementById('famChips').innerHTML=families.map(f=>
    `<button class="chip on" id="chip-${f.id}" onclick="toggleChip(${f.id})">${esc(f.name.replace('משפחת','').trim())}</button>`
  ).join('');
  updateFamPickSummary();
  setSplitMethod('equal');
  expMode='total';
  setExpMode('total');
  if(document.getElementById('f-total')) document.getElementById('f-total').value='';
  document.getElementById('expensesSection').style.display='none';
  updateExpenseInputs();updateExpensePickSummary();
  document.getElementById('newFormOverlay').style.display='flex';
  goTab('events',document.getElementById('nb-events'));
}
function editEv(evId){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  editingId=evId;
  document.getElementById('formTitle').textContent='✏️ עריכת אירוע';
  document.getElementById('formSaveBtn').textContent='✓ שמור שינויים';
  document.getElementById('f-name').value=ev.name;
  document.getElementById('f-date').value=(ev.date==='לא צוין'?'':ev.date)||'';
  ['e-name','e-cost','e-fams'].forEach(id=>{ const el=document.getElementById(id); if(el) el.classList.remove('show'); });
  document.getElementById('famChips').innerHTML=families.map(f=>
    `<button class="chip ${ev.participants.includes(f.id)?'on':''}" id="chip-${f.id}" onclick="toggleChip(${f.id})">${esc(f.name.replace('משפחת','').trim())}</button>`
  ).join('');
  updateFamPickSummary();
  setSplitMethod(ev.splitMethod||'equal');
  if(ev.cumulative){
    expMode='cumulative';
    setExpMode('cumulative');
  } else if(ev.totalCost!=null){
    expMode='total';
    setExpMode('total');
    document.getElementById('f-total').value=ev.totalCost;
    updateTotalPreview();
  } else {
    expMode='custom';
    setExpMode('custom');
    ev.participants.forEach(fid=>{ const inp=document.getElementById('fexp-'+fid); if(inp) inp.value=ev.expenses[fid]||''; });
    updateFormTotal();
  }
  const savEl=document.getElementById('f-savings');
  const savTotal=ev.savingsTotal||((ev.savingsAmt||0)*ev.participants.length)||0;
  if(savEl)savEl.value=savTotal||'';
  const savHint=document.getElementById('savingsHint');
  if(savHint)savHint.textContent=savTotal&&ev.participants.length?'≈ ₪'+Math.round(savTotal/ev.participants.length)+' לכל משפחה':'';
  document.getElementById('newFormOverlay').style.display='flex';
  goTab('events',document.getElementById('nb-events'));
}
function hideForm(){
  document.getElementById('newFormOverlay').style.display='none';
  closeFamPicker();closeChildOverridePicker();closeExpensePicker();
  editingId=null;
  document.getElementById('formTitle').textContent='➕ אירוע חדש';
  document.getElementById('formSaveBtn').textContent='✓ צור אירוע';
  const savEl=document.getElementById('f-savings');if(savEl)savEl.value='';
  const savHint=document.getElementById('savingsHint');if(savHint)savHint.textContent='';
}
function toggleChip(fid){
  const el=document.getElementById('chip-'+fid);
  if(el){ el.classList.toggle('on'); updateFamPickSummary(); updateChildOverrideInputs(); if(expMode==='total') updateTotalPreview(); else updateExpenseInputs(); }
}
function openFamPicker(){
  document.getElementById('famPickOverlay').style.display='flex';
}
function closeFamPicker(){
  document.getElementById('famPickOverlay').style.display='none';
}
function updateFamPickSummary(){
  const el=document.getElementById('famPickSummary');if(!el)return;
  const selected=families.filter(f=>{ const c=document.getElementById('chip-'+f.id); return c&&c.classList.contains('on'); });
  el.textContent=selected.length?selected.length+' מתוך '+families.length+' משפחות נבחרו':'מי משתתף';
}
function updateExpenseInputs(){
  const selected=families.filter(f=>{ const c=document.getElementById('chip-'+f.id); return c&&c.classList.contains('on'); });
  if(!selected.length){ document.getElementById('expensesSection').style.display='none'; return; }
  document.getElementById('expensesSection').style.display='block';
  document.getElementById('expenseInputs').innerHTML=selected.map(f=>{
    const cl=col(f.id);
    return`<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      ${famAva(f, 30, 'flex-shrink:0')}
      <span style="flex:1;font-size:13px;font-weight:600">${esc(f.name.replace('משפחת','').trim())}</span>
      <input class="exp-inp" type="number" min="0" inputmode="numeric" placeholder="0" id="fexp-${f.id}" oninput="_updateCustomTotal()">
    </div>`;
  }).join('');
  updateFormTotal();
}
function updateFormTotal(){_updateCustomTotal();}
async function doCreate(){
  const name=document.getElementById('f-name').value.trim();
  const date=document.getElementById('f-date').value.trim()||'';
  let ok=true;
  if(!name){document.getElementById('e-name').classList.add('show');ok=false;}
  else document.getElementById('e-name').classList.remove('show');
  const participants=[],excluded=[];
  families.forEach(f=>{
    const ch=document.getElementById('chip-'+f.id);
    if(ch){if(ch.classList.contains('on'))participants.push(f.id);else excluded.push(f.id);}
  });
  if(!participants.length){document.getElementById('e-fams').classList.add('show');ok=false;}
  else document.getElementById('e-fams').classList.remove('show');
  const expenses={};
  let anyExpense=false;
  if(expMode==='total'){
    const total=parseFloat(document.getElementById('f-total')?.value)||0;
    if(!total){document.getElementById('e-cost').classList.add('show');ok=false;}
    else{
      document.getElementById('e-cost').classList.remove('show');
      participants.forEach(fid=>{ expenses[fid]=0; });
      anyExpense=true;
    }
  } else if(expMode==='cumulative'){
    participants.forEach(fid=>{ expenses[fid]=0; });
    document.getElementById('e-cost').classList.remove('show');
    anyExpense=true;
  } else {
    const _cSym=document.getElementById('customCur')?.value||'₪';
    const _cRate=_cSym==='₪'?1:((await _getRate(_cSym))||1);
    for(const fid of participants){const inp=document.getElementById('fexp-'+fid);const v=Math.round((parseFloat(inp&&inp.value)||0)*_cRate);expenses[fid]=v;if(v>0)anyExpense=true;}
    if(!anyExpense){document.getElementById('e-cost').classList.add('show');ok=false;}
    else document.getElementById('e-cost').classList.remove('show');
  }
  if(!ok)return;
  const totalCost=expMode==='total'?(await _toILS('f-total','fTotalCur')):null;
  const isCumulative=expMode==='cumulative';
  const savingsTotal=Math.round(parseFloat(document.getElementById('f-savings')?.value)||0);
  const childOverrides={};const parentOverrides={};
  if(splitMethod!=='equal') participants.forEach(fid=>{
    childOverrides[fid]=formChildOverride(fid)??(getFam(fid)?.children||0);
    parentOverrides[fid]=formParentOverride(fid)??FAM_ADULTS;
  });
  if(editingId!=null){
    const ev=events.find(e=>e.id===editingId);
    if(ev){
      ev.name=name; ev.date=date; ev.participants=participants; ev.excluded=excluded;
      ev.splitMethod=splitMethod; ev.childOverrides=childOverrides; ev.parentOverrides=parentOverrides;
      if(!ev.cumulative){ ev.expenses=expenses; ev.totalCost=totalCost; }
      if(savingsTotal>0){ev.savingsTotal=savingsTotal;delete ev.savingsAmt;}else{delete ev.savingsTotal;delete ev.savingsAmt;}
    }
  } else {
    const newEv={id:nxtId++,name,date,open:true,closedOn:null,participants,excluded,expenses,totalCost:isCumulative?null:totalCost,splitMethod,childOverrides,parentOverrides};
    if(isCumulative){newEv.cumulative=true;newEv.expenseItems=[];newEv.expItemId=0;}
    if(savingsTotal>0)newEv.savingsTotal=savingsTotal;
    events.unshift(newEv);
    // notify participants only for non-cumulative events (personalized per family)
    (()=>{
      if(newEv.cumulative) return;
      const cost=evCost(newEv);
      const shares=evShares(newEv);
      newEv.participants.forEach(fid=>{
        const f=getFam(fid);if(!f||((!f.email)&&(!f.email2)))return;
        const share=Math.round(shares[fid]||0);
        const msg=`משפחת ${f.name.replace('משפחת','').trim()} רשומה לאירוע "${newEv.name}".\n\nעלות כוללת: ₪${cost.toLocaleString()}\nהחלק שלכם: ₪${share.toLocaleString()}`;
        sendEmailNotif([{email:f.email,email2:f.email2,name:f.name.replace('משפחת','').trim()}],'📅 אירוע חדש · ינקלביץ',msg);
      });
    })();
  }
  hideForm();save();render();
}

// Actions
let _closeEvPendingId=null;
function openCloseEvModal(evId){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  _closeEvPendingId=evId;
  const adjBal=evAdjBalance(ev);
  const settled=ev.participants.filter(fid=>{const f=getFam(fid);return f&&(f.email||f.email2)&&Math.abs(adjBal[fid]||0)<=0.5;});
  const info=document.getElementById('closeEvInfo');
  if(info){
    const rows=settled.map(fid=>{
      const f=getFam(fid);
      const name=f.name.replace('משפחת','').trim();
      const alreadySent=!!localStorage.getItem('closemail-'+ev.id+'-'+fid);
      return`<label style="display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;border-bottom:1px solid var(--border)">
        <input type="checkbox" id="closeev-chk-${fid}" ${alreadySent?'':'checked'} style="width:16px;height:16px;cursor:pointer;flex-shrink:0">
        <span style="flex:1;font-size:13px">${esc(name)}</span>
        ${alreadySent?`<span style="font-size:11px;color:var(--text3)">נשלח</span>`:''}
      </label>`;
    }).join('');
    info.innerHTML=`<div style="font-weight:700;margin-bottom:8px">${esc(ev.name)}</div>`
      +(settled.length?`<div style="font-size:12px;color:var(--text2);margin-bottom:8px">בחר למי לשלוח מייל סיכום:</div>${rows}`
      :`<div style="color:var(--text2);font-size:12px">אין משפחות מסודרות עם כתובת מייל.</div>`);
  }
  const modal=document.getElementById('closeEvModal');
  if(modal)modal.style.display='flex';
}
function closeCloseEvModal(){
  _closeEvPendingId=null;
  const modal=document.getElementById('closeEvModal');
  if(modal)modal.style.display='none';
}
function confirmCloseEv(){
  const evId=_closeEvPendingId;
  closeCloseEvModal();
  if(evId==null)return;
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  ev.closed=true;
  const adjBal=evAdjBalance(ev);
  ev.participants.forEach(fid=>{
    if(Math.abs(adjBal[fid]||0)>0.5)return;
    const chk=document.getElementById('closeev-chk-'+fid);
    if(chk&&chk.checked){
      localStorage.removeItem('closemail-'+ev.id+'-'+fid);
      _sendCloseEvEmailOne(ev,fid);
    } else {
      localStorage.setItem('closemail-'+ev.id+'-'+fid,'1');
    }
  });
  save();render();
}
function _sendCloseEvEmailOne(ev,fid){
  const notifKey='closemail-'+ev.id+'-'+fid;
  if(localStorage.getItem(notifKey))return;
  const f=getFam(fid);if(!f||(!f.email&&!f.email2))return;
  const adjBal=evAdjBalance(ev);
  if(Math.abs(adjBal[fid]||0)>0.5)return;
  localStorage.setItem(notifKey,'1');
  const cost=evCost(ev);
  const shares=evShares(ev);
  const share=Math.round(shares[fid]||0);
  const name=f.name.replace('משפחת','').trim();
  const myItems=(ev.expenseItems||[]).filter(it=>it.famId===fid);
  const mySpent=Math.round(myItems.reduce((s,it)=>s+it.amt,0));
  const settleLines=[];
  if(mySpent>0) settleLines.push(`הוצאות שלך באירוע: ₪${mySpent.toLocaleString()}`);
  const _myPotPend=Math.round((ev.potPayments||[]).filter(p=>p.famId===fid).reduce((s,p)=>s+p.amt,0));
  const _myPotDist=Math.round((ev.settled||[]).filter(s=>s.method==='pot'&&s.fromFid===fid).reduce((s,t)=>s+t.amt,0));
  const _excessToFund=Math.round((fund.transactions||[]).filter(t=>t.famId===fid&&t.type==='deposit'&&(t.desc||'').includes('החזר עודף מקופת האירוע')&&(t.desc||'').includes(ev.name)).reduce((s,t)=>s+t.amount,0));
  const _myTotalPot=_myPotPend+_myPotDist+_excessToFund;
  const _fromFundToPot=Math.round((fund.transactions||[])
    .filter(t=>Number(t.famId)===Number(fid)&&t.type==='payout'&&(t.desc||'').includes('העברה לקופת האירוע')&&(t.desc||'').includes(ev.name))
    .reduce((s,t)=>s+t.amount,0));
  if(_myTotalPot>0.5){
    if(_fromFundToPot>0.5&&_fromFundToPot===_myTotalPot){
      settleLines.push(`העברת מהקופה הראשית ₪${_myTotalPot.toLocaleString()} לקופת האירוע`);
    } else {
      settleLines.push(`הפקדת לקופת האירוע: ₪${_myTotalPot.toLocaleString()}`);
      if(_fromFundToPot>0.5) settleLines.push(`מתוכם ₪${_fromFundToPot.toLocaleString()} הועברו מהקופה הראשית`);
    }
    if(_excessToFund>0.5) settleLines.push(`היתרה ₪${_excessToFund.toLocaleString()} עברה לקופה הראשית`);
  } else if(_fromFundToPot>0.5){
    settleLines.push(`העברת מהקופה הראשית ₪${_fromFundToPot.toLocaleString()} לתשלום האירוע`);
  }
  const _myPotRec=Math.round((ev.settled||[]).filter(s=>s.method==='pot'&&s.toFid===fid).reduce((s,t)=>s+t.amt,0));
  if(_myPotRec>0.5) settleLines.push(`קיבלת ₪${_myPotRec.toLocaleString()} מקופת האירוע`);
  const _sfByName=n=>families.find(x=>x.name===n||x.name.replace(/^משפחת\s*/,'')===n);
  (ev.settled||[]).forEach(s=>{
    if(s.method==='pot') return;
    const isFrom=s.fromFid!=null?Number(s.fromFid)===Number(fid):(_sfByName(s.from)||{}).id===fid;
    const isTo=s.toFid!=null?Number(s.toFid)===Number(fid):(_sfByName(s.to)||{}).id===fid;
    const sFrom=(getFam(s.fromFid)||{}).name?(getFam(s.fromFid).name.replace('משפחת','').trim()):s.from;
    const sTo=(getFam(s.toFid)||{}).name?(getFam(s.toFid).name.replace('משפחת','').trim()):s.to;
    if(isFrom){
      if(s.method==='fund') settleLines.push(`₪${s.amt.toLocaleString()} שולמו מהקופה הראשית שלך ל${sTo}`);
      else settleLines.push(`העברה ישירה של ₪${s.amt.toLocaleString()} ל${sTo}`);
    } else if(isTo){
      if(s.method==='fund') settleLines.push(`₪${s.amt.toLocaleString()} מ${sFrom} – הועבר לקופה הראשית שלך`);
      else settleLines.push(`קיבלת ₪${s.amt.toLocaleString()} ישירות מ${sFrom}`);
    }
  });
  const fundBal=Math.round(fund.famBalances[String(fid)]||0);
  let msg=`האירוע "${ev.name}" הסתיים!\n\nעלות כוללת: ₪${cost.toLocaleString()}\nהחלק שלך: ₪${share.toLocaleString()}${_savingsPerFam>0?`\n💎 לקופת חיסכון: ₪${_savingsPerFam.toLocaleString()}`:''}
`;
  if(mySpent>0){
    const itemLines=myItems.map(it=>`  - ${it.name}: ₪${it.amt.toLocaleString()}`).join('\n');
    msg+=`\n💳 ההוצאות שלך (${name}):\n${itemLines}\n  סה"כ: ₪${mySpent.toLocaleString()}`;
  }
  if(settleLines.length) msg+=`\n\nאיך סודר:\n${settleLines.map(l=>'• '+l).join('\n')}`;
  if(fundBal>0) msg+=`\n\nיתרתך בקופה הראשית: ₪${fundBal.toLocaleString()}`;
  msg+=`\n\n✅ החשבון שלך מסודר.`;
  const _savingsPerFam=ev.savingsTotal?Math.round(ev.savingsTotal/(ev.participants.length||1)):(ev.savingsAmt||0);
  const _cRows=[['עלות כוללת האירוע',`₪${cost.toLocaleString()}`],['החלק שלך',`₪${share.toLocaleString()}`,true]];
  if(_savingsPerFam>0) _cRows.push(['💎 לקופת חיסכון',`₪${_savingsPerFam.toLocaleString()}`]);
  if(fundBal>0) _cRows.push(['💰 יתרה בקופה הראשית',`₪${fundBal.toLocaleString()}`]);
  let bodyHtml=_eCard(_cRows);
  const _isPerFam=!ev.cumulative&&ev.totalCost==null;
  if(_isPerFam){
    const _famExpRows=ev.participants.map(fid2=>{
      const amt=Math.round((ev.expenses||{})[fid2]||0);if(!amt)return'';
      const pf=getFam(fid2);if(!pf)return'';
      const pname=_esc(pf.name.replace('משפחת','').trim());
      const isMine=fid2===fid;
      return`<tr style="border-bottom:1px solid #f0f0f6${isMine?';background:#FEFCE8':''}"><td style="padding:7px 10px${isMine?';font-weight:700':''}">${pname}</td><td style="padding:7px 10px;font-weight:700;text-align:left${isMine?';color:#D97706':''}">₪${amt.toLocaleString()}</td></tr>`;
    }).join('');
    if(_famExpRows)bodyHtml+=`<p style="font-weight:700;margin:0 0 8px;color:#333">💳 הוצאות לפי משפחה:</p><table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px"><tr style="background:#E0F2FE"><th style="padding:8px 10px;text-align:right;color:#555;font-weight:700;border-bottom:2px solid #7DD3FC">משפחה</th><th style="padding:8px 10px;text-align:left;color:#555;font-weight:700;border-bottom:2px solid #7DD3FC">הוצאה</th></tr>${_famExpRows}</table>`;
  } else {
    bodyHtml+=_splitMethodBlock(ev,fid);
  }
  const allItems=ev.expenseItems||[];
  if(!_isPerFam&&(allItems.length||(ev.potExpItems||[]).length)){
    bodyHtml+=`<p style="font-weight:700;margin:0 0 8px;color:#333">💳 פירוט כל ההוצאות:</p>`;
    const itemsByFam={};
    ev.participants.forEach(fid2=>{itemsByFam[fid2]=[];});
    allItems.forEach(it=>{if(itemsByFam[it.famId])itemsByFam[it.famId].push(it);});
    const _em=ev.splitMethod||'equal';
    let _eTotalW=0;const _eW={};
    ev.participants.forEach(p=>{_eW[p]=famWeight(getFam(p),_em,ev.childOverrides?.[p]);_eTotalW+=_eW[p];});
    const _itemShare=(it,rfid)=>{
      if(it.customSplit)return it.customSplit[String(rfid)]||0;
      const sw=it.sharedWith?it.sharedWith.filter(p=>ev.participants.includes(p)):ev.participants;
      if(!sw.includes(rfid))return 0;
      if(it.sharedWith)return Math.round(it.amt/sw.length);
      const swW=sw.reduce((s,p)=>s+(_eW[p]||0),0);
      return swW?Math.round(it.amt*(_eW[rfid]||0)/swW):0;
    };
    let itemRows='';
    ev.participants.forEach(fid2=>{
      const its=itemsByFam[fid2];if(!its||!its.length)return;
      const isMine=fid2===fid;
      const visibleIts=isMine?its:its.filter(it=>_itemShare(it,fid)>0);
      if(!visibleIts.length)return;
      const pf=getFam(fid2);
      const pname=pf?pf.name.replace('משפחת','').trim():'?';
      visibleIts.forEach(it=>{
        const myShare=_itemShare(it,fid);
        itemRows+=`<tr style="border-bottom:1px solid #f0f0f6${isMine?';background:#FEFCE8':''}">
          <td style="padding:5px 6px">${_esc(it.name)}</td>
          <td style="padding:5px 6px;font-size:11px;color:#666">${_esc(pname)}</td>
          <td style="padding:5px 6px;font-weight:600;${isMine?'color:#D97706':''}">₪${it.amt.toLocaleString()}</td>
          <td style="padding:5px 6px;font-weight:700;color:#D97706">${myShare?'₪'+myShare.toLocaleString():'—'}</td>
        </tr>`;
      });
      if(visibleIts.length>1){
        const _totAmt=visibleIts.reduce((s,it)=>s+it.amt,0);
        const _totShare=visibleIts.reduce((s,it)=>s+_itemShare(it,fid),0);
        itemRows+=`<tr style="border-bottom:2px solid #BFDBFE${isMine?';background:#FEF9C3':''}">
          <td colspan="2" style="padding:3px 6px;font-size:11px;color:#888;text-align:left">סה"כ ${_esc(pname)}</td>
          <td style="padding:3px 6px;font-size:11px;font-weight:700;${isMine?'color:#D97706':'color:#555'}">₪${_totAmt.toLocaleString()}</td>
          <td style="padding:3px 6px;font-size:11px;font-weight:700;color:#D97706">₪${_totShare.toLocaleString()}</td>
        </tr>`;
      }
    });
    const _potExpItems=ev.potExpItems||[];
    if(_potExpItems.length){
      const _pMethod=ev.splitMethod||'equal';
      let _pTotalW=0; const _pW={};
      ev.participants.forEach(p=>{ _pW[p]=famWeight(getFam(p),_pMethod,ev.childOverrides?.[p]); _pTotalW+=_pW[p]; });
      _potExpItems.forEach(it=>{
        const myShare=_pTotalW>0?Math.round(it.amt*(_pW[fid]||0)/_pTotalW):0;
        itemRows+=`<tr style="border-bottom:1px solid #EDE9FE;background:#F5F3FF">
          <td style="padding:5px 6px">${_esc(it.name)}</td>
          <td style="padding:5px 6px;font-size:11px;color:#7C3AED">קופת האירוע</td>
          <td style="padding:5px 6px;font-weight:600;color:#7C3AED">₪${it.amt.toLocaleString()}</td>
          <td style="padding:5px 6px;font-weight:700;color:#6D28D9">₪${myShare.toLocaleString()}</td>
        </tr>`;
      });
    }
    bodyHtml+=`<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px"><tr style="background:#E0F2FE"><th style="padding:6px;text-align:right;color:#555;font-weight:700;border-bottom:2px solid #7DD3FC">פריט</th><th style="padding:6px;text-align:right;color:#555;font-weight:700;border-bottom:2px solid #7DD3FC">שילם</th><th style="padding:6px;text-align:right;color:#555;font-weight:700;border-bottom:2px solid #7DD3FC">סכום</th><th style="padding:6px;text-align:right;color:#D97706;font-weight:700;border-bottom:2px solid #7DD3FC">החלק שלך</th></tr>${itemRows}</table>`;
    if(mySpent>0) bodyHtml+=`<p style="font-size:11px;color:#888;margin:0 0 12px;text-align:center">שורות בסגול = הוצאות שלך</p>`;
  }
  if(settleLines.length){
    bodyHtml+=`<p style="font-weight:700;margin:16px 0 8px;color:#333">⚖️ איך סודר:</p><ul style="margin:0 0 16px;padding-right:20px;color:#444">${settleLines.map(l=>`<li style="margin-bottom:5px">${_esc(l)}</li>`).join('')}</ul>`;
  }
  bodyHtml+=`<div style="text-align:center;margin-top:4px">${_eBadge('✅ החשבון שלך מסודר','#16a34a')}</div>`;
  const html=_emailWrap(bodyHtml,ev.name,'🏁',_ejsUrl()+'#archive-'+ev.id,f.name);
  sendEmailNotif([{email:f.email,email2:f.email2,name}],'🏁 האירוע הסתיים · ינקלביץ',msg,html);
}
function closeEv(evId){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  if(ev.cumulative){
    ev.closed=true;
    const adjBal=evAdjBalance(ev);
    ev.participants.forEach(fid=>{
      if(Math.abs(adjBal[fid]||0)<=0.5) _sendCloseEvEmailOne(ev,fid);
    });
    save();render();
  } else {
    // regular event: send closing summary only to families that didn't get a settled email yet (i.e. creditors)
    const cost=evCost(ev);
    const shares=evShares(ev);
    const adjBal=evAdjBalance(ev);
    ev.participants.forEach(fid=>{
      const f=getFam(fid);if(!f||(!f.email&&!f.email2))return;
      if(localStorage.getItem('settled-'+ev.id+'-'+fid)) return; // debtor already got settled email
      const name=f.name.replace('משפחת','').trim();
      const share=Math.round(shares[fid]||0);
      const spent=Math.round(ev.expenses[fid]||0);
      const bal=Math.round(adjBal[fid]||0);
      // what this family received from others
      const received=(ev.settled||[]).filter(s=>{const tf=families.find(x=>x.name.replace('משפחת','').trim()===s.to.replace('משפחת','').trim());return tf&&tf.id===fid;});
      let msg=`האירוע "${ev.name}" נסגר.\n\nעלות כוללת: ₪${cost.toLocaleString()}\nהחלק שלך: ₪${share.toLocaleString()}`;
      if(spent>0) msg+=`\nשילמת: ₪${spent.toLocaleString()}`;
      if(received.length){
        const recLines=received.map(s=>`• קיבלת ₪${s.amt.toLocaleString()} מ${s.from}`).join('\n');
        msg+=`\n\n${recLines}`;
      }
      msg+=`\n\n${Math.abs(bal)<=0.5?'✅ החשבון שלך מסודר.':bal>0.5?`💰 מגיע לך עוד ₪${bal.toLocaleString()}.`:`⚠️ יתרת חוב: ₪${Math.abs(bal).toLocaleString()}.`}`;
      const cCardRows=[['עלות כוללת האירוע',`₪${cost.toLocaleString()}`],['החלק שלך',`₪${share.toLocaleString()}`,true]];
      if(spent>0) cCardRows.push(['שילמת',`₪${spent.toLocaleString()}`]);
      let cBodyHtml=_eCard(cCardRows);
      if(received.length){
        cBodyHtml+=`<p style="font-weight:700;margin:0 0 8px;color:#333">מה קיבלת:</p><ul style="margin:0 0 16px;padding-right:20px;color:#444">${received.map(s=>`<li style="margin-bottom:4px">₪${s.amt.toLocaleString()} מ${_esc(s.from)}</li>`).join('')}</ul>`;
      }
      const statusBadge=Math.abs(bal)<=0.5?_eBadge('✅ החשבון שלך מסודר','#16a34a'):bal>0.5?_eBadge(`💰 מגיע לך עוד ₪${bal.toLocaleString()}`,'#2563eb'):_eBadge(`⚠️ יתרת חוב ₪${Math.abs(bal).toLocaleString()}`,'#ef4444');
      cBodyHtml+=`<div style="text-align:center;margin-top:4px">${statusBadge}</div>`;
      const cHtml=_emailWrap(cBodyHtml,ev.name,'🗂',_ejsUrl()+'#archive-'+ev.id,f.name);
      sendEmailNotif([{email:f.email,email2:f.email2,name}],'🗂 האירוע נסגר · ינקלביץ',msg,cHtml);
    });
    ev.open=false;ev.closedOn='היום';save();render();
    goTab('archive',null);
  }
}
function archiveEv(evId){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  ev.open=false;ev.closedOn='היום';save();render();
  goTab('archive',null);
}
function sendEmailToFam(evId,fid){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  const f=getFam(fid);if(!f||(!f.email&&!f.email2))return;
  const adjBal=evAdjBalance(ev);
  const b=adjBal[fid]||0;
  if(b<-0.5){
    // debtor — send reminder
    const cost=evCost(ev);
    const shares=evShares(ev);
    const name=f.name.replace('משפחת','').trim();
    const share=Math.round(shares[fid]||0);
    const spent=Math.round(ev.expenses[fid]||0);
    const owe=Math.round(Math.abs(b));
    const potDep=Math.round((ev.potPayments||[]).filter(p=>p.famId===fid).reduce((s,p)=>s+p.amt,0)+(ev.settled||[]).filter(s=>s.method==='pot'&&s.fromFid===fid).reduce((s,t)=>s+t.amt,0));
    const _fromFundToPot1=potDep>0.5?Math.round((fund.transactions||[]).filter(t=>Number(t.famId)===Number(fid)&&t.type==='payout'&&(t.desc||'').includes('העברה לקופת האירוע')&&(t.desc||'').includes(ev.name)).reduce((s,t)=>s+t.amount,0)):0;
    const _potIsFromFund1=_fromFundToPot1>0.5&&Math.abs(_fromFundToPot1-potDep)<1;
    const msgPot=potDep>0.5?(_potIsFromFund1?`\nהעברת מהקופה הראשית ₪${potDep.toLocaleString()} לקופת האירוע`:`\nהפקדת לקופת האירוע: ₪${potDep.toLocaleString()}`):'';
    const _savPerFam1=ev.savingsTotal?Math.round(ev.savingsTotal/(ev.participants.length||1)):(ev.savingsAmt||0);
    const msg=`תזכורת: האירוע "${ev.name}"\n\nעלות כוללת: ₪${cost.toLocaleString()}\nהחלק שלך: ₪${share.toLocaleString()}${spent>0?`\nשילמת: ₪${spent.toLocaleString()}`:''}${msgPot}${_savPerFam1>0?`\n💎 לקופת חיסכון: ₪${_savPerFam1.toLocaleString()}`:''}\n\n⚠️ יתרת חוב: ₪${owe.toLocaleString()}`;
    const cardRows=[['עלות כוללת האירוע',`₪${cost.toLocaleString()}`],['החלק שלך',`₪${share.toLocaleString()}`,true]];
    if(spent>0) cardRows.push(['שילמת',`₪${spent.toLocaleString()}`]);
    if(_savPerFam1>0) cardRows.push(['💎 לקופת חיסכון',`₪${_savPerFam1.toLocaleString()}`]);
    if(potDep>0.5) cardRows.push([_potIsFromFund1?'העברת מהקופה הראשית':'הפקדת לקופת האירוע',`₪${potDep.toLocaleString()}`]);
    let bodyHtml=_eCard(cardRows);
    bodyHtml+=_splitMethodBlock(ev,fid);
    // Expense breakdown table
    const _rAllItems=ev.expenseItems||[];
    const _rPotExpItems=ev.potExpItems||[];
    if(_rAllItems.length||_rPotExpItems.length){
      bodyHtml+=`<p style="font-weight:700;margin:12px 0 8px;color:#333">💳 פירוט הוצאות:</p>`;
      const _rByFam={};ev.participants.forEach(f2=>{_rByFam[f2]=[];});
      _rAllItems.forEach(it=>{if(_rByFam[it.famId])_rByFam[it.famId].push(it);});
      const _rM=ev.splitMethod||'equal';let _rTW=0;const _rW={};
      ev.participants.forEach(p=>{_rW[p]=famWeight(getFam(p),_rM,ev.childOverrides?.[p]);_rTW+=_rW[p];});
      const _rShare=(it,rfid)=>{if(it.customSplit)return it.customSplit[String(rfid)]||0;const sw=it.sharedWith?it.sharedWith.filter(p=>ev.participants.includes(p)):ev.participants;if(!sw.includes(rfid))return 0;if(it.sharedWith)return Math.round(it.amt/sw.length);const swW=sw.reduce((s,p)=>s+(_rW[p]||0),0);return swW?Math.round(it.amt*(_rW[rfid]||0)/swW):0;};
      let _rRows='';
      ev.participants.forEach(f2=>{
        const its=_rByFam[f2];if(!its||!its.length)return;
        const isMine=f2===fid;
        const vis=isMine?its:its.filter(it=>_rShare(it,fid)>0);if(!vis.length)return;
        const pf=getFam(f2);const pn=pf?pf.name.replace('משפחת','').trim():'?';
        vis.forEach(it=>{const ms=_rShare(it,fid);_rRows+=`<tr style="border-bottom:1px solid #f0f0f6${isMine?';background:#FEFCE8':''}"><td style="padding:5px 6px">${_esc(it.name)}</td><td style="padding:5px 6px;font-size:11px;color:#666">${_esc(pn)}</td><td style="padding:5px 6px;font-weight:600;${isMine?'color:#D97706':''}">₪${it.amt.toLocaleString()}</td><td style="padding:5px 6px;font-weight:700;color:#D97706">${ms?'₪'+ms.toLocaleString():'—'}</td></tr>`;});
      });
      _rPotExpItems.forEach(it=>{const ms=_rTW>0?Math.round(it.amt*(_rW[fid]||0)/_rTW):0;_rRows+=`<tr style="border-bottom:1px solid #EDE9FE;background:#F5F3FF"><td style="padding:5px 6px">${_esc(it.name)}</td><td style="padding:5px 6px;font-size:11px;color:#7C3AED">קופת האירוע</td><td style="padding:5px 6px;font-weight:600;color:#7C3AED">₪${it.amt.toLocaleString()}</td><td style="padding:5px 6px;font-weight:700;color:#6D28D9">₪${ms.toLocaleString()}</td></tr>`;});
      if(_rRows) bodyHtml+=`<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px"><tr style="background:#E0F2FE"><th style="padding:6px;text-align:right;color:#555;font-weight:700;border-bottom:2px solid #7DD3FC">פריט</th><th style="padding:6px;text-align:right;color:#555;font-weight:700;border-bottom:2px solid #7DD3FC">שילם</th><th style="padding:6px;text-align:right;color:#555;font-weight:700;border-bottom:2px solid #7DD3FC">סכום</th><th style="padding:6px;text-align:right;color:#D97706;font-weight:700;border-bottom:2px solid #7DD3FC">החלק שלך</th></tr>${_rRows}</table>`;
    }
    bodyHtml+=`<div style="text-align:center;margin-top:4px">${_eBadge('⚠️ יתרת חוב ₪'+owe.toLocaleString(),'#ef4444')}</div>`;
    bodyHtml+=_paymentBlock(owe,ev.name);
    // Other debts
    const _otherDebts=events.filter(e=>e.id!==ev.id&&e.open&&(e.participants||[]).includes(fid)).map(e=>{const _d=Math.round(-(evAdjBalance(e)[fid]||0));return _d>0.5?{name:e.name,owe:_d}:null;}).filter(Boolean);
    if(_otherDebts.length){bodyHtml+=`<div style="margin-top:14px;padding:10px 14px;background:#FEF2F2;border-radius:8px;border:1px solid #FECACA">${_otherDebts.map(d=>`<div style="font-size:12px;color:#991B1B;margin-bottom:2px">⚠️ תזכורת: קיים גם חוב של ₪${d.owe.toLocaleString()} עבור "${_esc(d.name)}"</div>`).join('')}</div>`;}
    const html=_emailWrap(bodyHtml,ev.name,'⚠️',_ejsUrl()+'#'+(ev.open?'event-':'archive-')+ev.id,f.name);
    sendEmailNotif([{email:f.email,email2:f.email2,name}],`⚠️ תזכורת: חוב ב"${ev.name}" · ינקלביץ`,msg,html);
  } else if(Math.abs(b)<=0.5){
    // settled — send summary
    if(ev.cumulative){
      localStorage.removeItem('closemail-'+ev.id+'-'+fid);
      _sendCloseEvEmailOne(ev,fid);
    } else {
      localStorage.removeItem('settled-'+ev.id+'-'+fid);
      sendSettledEmail(ev,fid);
    }
  }
}
let _emailModalEvId=null;
function openEmailModal(evId){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  _emailModalEvId=evId;
  const adjBal=evAdjBalance(ev);
  const debtors=ev.participants.filter(fid=>{const f=getFam(fid);return f&&(f.email||f.email2)&&(adjBal[fid]||0)<-0.5;});
  const settled=ev.participants.filter(fid=>{const f=getFam(fid);return f&&(f.email||f.email2)&&Math.abs(adjBal[fid]||0)<=0.5;});
  const btnStyle=`padding:4px 10px;border-radius:6px;border:none;background:var(--blue-mid);color:#fff;font-size:12px;font-weight:700;font-family:var(--font);cursor:pointer;flex-shrink:0`;
  let html=`<div style="font-weight:700;margin-bottom:12px;font-size:14px">${esc(ev.name)}</div>`;
  if(debtors.length){
    html+=`<div style="font-size:12px;font-weight:700;color:var(--amber);margin-bottom:4px">⚠️ חייבים:</div>`;
    debtors.forEach(fid=>{
      const f=getFam(fid);
      const name=f.name.replace('משפחת','').trim();
      const owe=Math.round(Math.abs(adjBal[fid]||0));
      html+=`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)"><button id="em-btn-${fid}" style="${btnStyle}" onclick="sendEmailFromModal(${evId},${fid},this)">שלח</button><span style="flex:1;font-size:13px">${esc(name)}</span><span style="font-size:11px;color:var(--amber);font-weight:700">₪${owe.toLocaleString()}</span></div>`;
    });
  }
  if(settled.length){
    html+=`<div style="font-size:12px;font-weight:700;color:#16a34a;margin:${debtors.length?'12px':'0'} 0 4px">✅ מסודרים:</div>`;
    settled.forEach(fid=>{
      const f=getFam(fid);
      const name=f.name.replace('משפחת','').trim();
      const notifKey=ev.cumulative?'closemail-'+ev.id+'-'+fid:'settled-'+ev.id+'-'+fid;
      const alreadySent=!!localStorage.getItem(notifKey);
      html+=`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)"><button id="em-btn-${fid}" style="${btnStyle}" onclick="sendEmailFromModal(${evId},${fid},this)">שלח</button><span style="flex:1;font-size:13px">${esc(name)}</span>${alreadySent?`<span style="font-size:11px;color:var(--text3)">נשלח</span>`:''}</div>`;
    });
  }
  if(!debtors.length&&!settled.length) html+=`<div style="color:var(--text2);font-size:12px">אין משפחות עם כתובת מייל.</div>`;
  document.getElementById('emailModalContent').innerHTML=html;
  document.getElementById('emailModal').style.display='flex';
}
function closeEmailModal(){
  _emailModalEvId=null;
  document.getElementById('emailModal').style.display='none';
}
function sendEmailFromModal(evId,fid,btnEl){
  sendEmailToFam(evId,fid);
  if(btnEl){btnEl.textContent='✓';btnEl.disabled=true;btnEl.style.background='var(--surface2)';btnEl.style.color='var(--text3)';btnEl.style.border='1px solid var(--border)';}
}
function sendDebtReminderEmails(evId){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  const cost=evCost(ev);
  const shares=evShares(ev);
  const adjBal=evAdjBalance(ev);
  const debtors=ev.participants.filter(fid=>(adjBal[fid]||0)<-0.5);
  const withEmail=debtors.filter(fid=>{const f=getFam(fid);return f&&(f.email||f.email2);});
  if(!withEmail.length){alert('אין חייבים עם כתובת מייל');return;}
  withEmail.forEach(fid=>{
    const f=getFam(fid);if(!f)return;
    const name=f.name.replace('משפחת','').trim();
    const share=Math.round(shares[fid]||0);
    const spent=Math.round(ev.expenses[fid]||0);
    const owe=Math.round(Math.abs(adjBal[fid]||0));
    const potDep2=Math.round((ev.potPayments||[]).filter(p=>p.famId===fid).reduce((s,p)=>s+p.amt,0)+(ev.settled||[]).filter(s=>s.method==='pot'&&s.fromFid===fid).reduce((s,t)=>s+t.amt,0));
    const _fromFundToPot2=potDep2>0.5?Math.round((fund.transactions||[]).filter(t=>Number(t.famId)===Number(fid)&&t.type==='payout'&&(t.desc||'').includes('העברה לקופת האירוע')&&(t.desc||'').includes(ev.name)).reduce((s,t)=>s+t.amount,0)):0;
    const _potIsFromFund2=_fromFundToPot2>0.5&&Math.abs(_fromFundToPot2-potDep2)<1;
    const msgPot2=potDep2>0.5?(_potIsFromFund2?`\nהעברת מהקופה הראשית ₪${potDep2.toLocaleString()} לקופת האירוע`:`\nהפקדת לקופת האירוע: ₪${potDep2.toLocaleString()}`):'';
    const _savPerFam2=ev.savingsTotal?Math.round(ev.savingsTotal/(ev.participants.length||1)):(ev.savingsAmt||0);
    const msg=`תזכורת: האירוע "${ev.name}"\n\nעלות כוללת: ₪${cost.toLocaleString()}\nהחלק שלך: ₪${share.toLocaleString()}${spent>0?`\nשילמת: ₪${spent.toLocaleString()}`:''}${msgPot2}${_savPerFam2>0?`\n💎 לקופת חיסכון: ₪${_savPerFam2.toLocaleString()}`:''}\n\n⚠️ יתרת חוב: ₪${owe.toLocaleString()}`;
    const _cRows2=[['עלות כוללת האירוע',`₪${cost.toLocaleString()}`],['החלק שלך',`₪${share.toLocaleString()}`,true]];
    if(spent>0) _cRows2.push(['שילמת',`₪${spent.toLocaleString()}`]);
    if(_savPerFam2>0) _cRows2.push(['💎 לקופת חיסכון',`₪${_savPerFam2.toLocaleString()}`]);
    if(potDep2>0.5) _cRows2.push([_potIsFromFund2?'העברת מהקופה הראשית':'הפקדת לקופת האירוע',`₪${potDep2.toLocaleString()}`]);
    let bodyHtml=_eCard(_cRows2);
    bodyHtml+=_splitMethodBlock(ev,fid);
    bodyHtml+=`<div style="text-align:center;margin-top:4px">${_eBadge('⚠️ יתרת חוב ₪'+owe.toLocaleString(),'#ef4444')}</div>`;
    bodyHtml+=_paymentBlock(owe,ev.name);
    const _otherDebts2=events.filter(e=>e.id!==ev.id&&e.open&&(e.participants||[]).includes(fid)).map(e=>{const _d=Math.round(-(evAdjBalance(e)[fid]||0));return _d>0.5?{name:e.name,owe:_d}:null;}).filter(Boolean);
    if(_otherDebts2.length){bodyHtml+=`<div style="margin-top:14px;padding:10px 14px;background:#FEF2F2;border-radius:8px;border:1px solid #FECACA">${_otherDebts2.map(d=>`<div style="font-size:12px;color:#991B1B;margin-bottom:2px">⚠️ תזכורת: קיים גם חוב של ₪${d.owe.toLocaleString()} עבור "${_esc(d.name)}"</div>`).join('')}</div>`;}
    const html=_emailWrap(bodyHtml,ev.name,'⚠️',_ejsUrl()+'#'+(ev.open?'event-':'archive-')+ev.id,f.name);
    sendEmailNotif([{email:f.email,email2:f.email2,name}],`⚠️ תזכורת: חוב ב"${ev.name}" · ינקלביץ`,msg,html);
  });
  alert(`נשלח מייל ל-${withEmail.length} משפחות`);
}
function reopenEv(evId){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  ev.open=true;ev.closedOn=null;expanded.delete(evId);save();render();
  goTab('events',document.getElementById('nb-events'));
}
function delEv(evId){
  if(!confirm('למחוק את האירוע?'))return;
  events=events.filter(e=>e.id!==evId);expanded.delete(evId);save();render();
}
function toggleExp(evId){
  if(expanded.has(evId)){expanded.delete(evId);history.replaceState(null,'','#archive');}
  else{expanded.add(evId);history.replaceState(null,'','#archive-'+evId);}
  renderArchive();
}
function setYear(y){actYear=y;renderArchive();}
function addFam(){
  const inp=document.getElementById('famInput');
  let name=inp.value.trim();if(!name)return;
  if(!name.startsWith('משפחת'))name='משפחת '+name;
  families.push({id:nxtFam++,name,children:0});inp.value='';save();render();
}
function goTab(tab,el,skipHash,swipeDir){
  const next=document.getElementById('view-'+tab);if(!next)return;
  const prev=document.querySelector('.view.active');
  // abort any in-progress transition
  document.querySelectorAll('.view.sv-out').forEach(v=>{v.classList.remove('sv-out');v.style.cssText='';});
  document.querySelectorAll('.view').forEach(v=>{v.classList.remove('active');v.style.cssText='';});
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  if(el)el.classList.add('active');
  if(tab==='families'){loadEjsSettings();loadPaymentSettings();}
  if(!skipHash) history.replaceState(null,'','#'+tab);
  if(!swipeDir||!prev||prev===next){next.classList.add('active');return;}
  const DUR=260,EASE='cubic-bezier(0.4,0,0.2,1)';
  const right=swipeDir==='right'; // finger went right → new view from left
  // outgoing: stays in flow position → slide out
  prev.classList.add('sv-out');
  prev.style.willChange='transform';
  // incoming: starts off-screen
  next.style.transform=`translateX(${right?'-100%':'100%'})`;
  next.style.willChange='transform';
  next.classList.add('active');
  next.getBoundingClientRect(); // force reflow
  const tr=`transform ${DUR}ms ${EASE}`;
  prev.style.transition=tr;prev.style.transform=`translateX(${right?'100%':'-100%'})`;
  next.style.transition=tr;next.style.transform='translateX(0)';
  setTimeout(()=>{prev.classList.remove('sv-out');prev.style.cssText='';next.style.cssText='';},DUR+20);
}
function _enterPayShell(){
  if(currentShell==='pay')return;
  currentShell='pay';
  document.body.classList.remove('at-home');
  document.getElementById('mn-home').classList.remove('mn-active');
  document.getElementById('mn-pay').classList.add('mn-active');
}
function handleHash(){
  const h=(window.location.hash||'').replace('#','');
  if(!h||h==='home'){goTab('home',document.getElementById('nb-home'),true);return;}
  const tabMap={events:'nb-events',fund:'nb-fund',families:'nb-families'};
  if(tabMap[h]){_enterPayShell();goTab(h,document.getElementById(tabMap[h]),true);return;}
  if(h.startsWith('event-')){
    const id=parseInt(h.slice(6));if(isNaN(id))return;
    _enterPayShell();
    const _hEv=events.find(e=>e.id===id);
    if(_hEv&&!_hEv.open){
      goTab('archive',null,true);
      expanded.add(id);renderArchive();
    } else {
      goTab('events',document.getElementById('nb-events'),true);
      collapsedEvents.delete(id);renderOpenList();
    }
    setTimeout(()=>{const el=document.getElementById('ecard-'+id);if(el)el.scrollIntoView({behavior:'smooth',block:'center'});},150);
  } else if(h.startsWith('archive-')){
    const id=parseInt(h.slice(8));if(isNaN(id))return;
    _enterPayShell();
    goTab('archive',null);
    expanded.add(id);renderArchive();
    setTimeout(()=>{const el=document.getElementById('ecard-'+id);if(el)el.scrollIntoView({behavior:'smooth',block:'center'});},150);
  }
}

function renderSavingsPot(){
  const el=document.getElementById('savingsPotSection');
  if(!el)return;
  const contrib=savingsPotContrib();
  const expTotal=savingsPotExpTotal();
  const bal=contrib-expTotal;
  const contribEvs=events.filter(ev=>(ev.savingsTotal||ev.savingsAmt)>0);
  if(!contrib&&!expTotal&&!contribEvs.length){el.innerHTML='';return;}
  const expRows=(savingsPot.expenses||[]).map(e=>
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <div style="flex:1">
        <div style="font-size:13px;font-weight:600">${esc(e.name)}</div>
        ${e.date?`<div style="font-size:11px;color:var(--text2)">${esc(e.date)}</div>`:''}
      </div>
      <div style="font-size:13px;font-weight:700;color:var(--red-mid)">-₪${e.amt.toLocaleString()}</div>
      <button class="edit-only" onclick="delSavingsPotExp(${e.id})" style="background:none;border:none;cursor:pointer;color:var(--text3);font-size:16px;padding:2px 4px;line-height:1">🗑</button>
    </div>`
  ).join('');
  const addForm=`<div class="edit-only" style="display:flex;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
    <input id="savExpName" type="text" placeholder="שם ההוצאה" style="flex:2;min-width:0;border:1.5px solid var(--border);border-radius:var(--r2);padding:8px 10px;font-size:13px;font-family:var(--font);background:var(--bg);color:var(--text)">
    <input id="savExpAmt" type="number" min="0" inputmode="numeric" placeholder="₪" style="flex:1;min-width:0;border:1.5px solid var(--border);border-radius:var(--r2);padding:8px 10px;font-size:13px;font-family:var(--font);background:var(--bg);color:var(--text);direction:ltr;text-align:center">
    <button onclick="addSavingsPotExp()" style="padding:8px 12px;border-radius:var(--r2);border:none;background:var(--green-mid);color:#fff;font-size:13px;font-weight:700;font-family:var(--font);cursor:pointer">+</button>
  </div>`;
  const evList=contribEvs.length?`<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:10px">
    <div style="font-size:11px;color:var(--text2);margin-bottom:6px">תרומות מאירועים</div>
    ${contribEvs.map(ev=>`<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
      <span style="color:var(--text)">${esc(ev.name)}</span>
      <span style="font-weight:700;color:var(--green-mid)">+₪${(ev.savingsTotal||(ev.savingsAmt||0)*(ev.participants||[]).length).toLocaleString()}</span>
    </div>`).join('')}
  </div>`:'';
  el.innerHTML=`<div class="fund-section-title">💎 קופת חיסכון</div>
    <div style="background:var(--surface);border-radius:var(--r);border:1px solid var(--border);padding:16px;margin-bottom:8px">
      <div style="text-align:center;margin-bottom:4px">
        <div style="font-size:11px;color:var(--text2);margin-bottom:2px">יתרה</div>
        <div style="font-size:32px;font-weight:800;color:var(--text);letter-spacing:-0.5px">₪${bal.toLocaleString()}</div>
      </div>
      ${contrib>0?`<div style="font-size:12px;color:var(--text2);text-align:center;margin-top:4px">נאסף: ₪${contrib.toLocaleString()} · הוצא: ₪${expTotal.toLocaleString()}</div>`:''}
      ${expTotal>0?`<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:12px">${expRows}</div>`:''}
      ${evList}
      ${addForm}
    </div>`;
}
function renderFund(){
  const mainTotal=fundTotal();
  const goalTotal2=goalFunds.filter(g=>!g.archived&&!g.closed).reduce((s,g)=>s+goalTotal(g),0);
  const evPotsTotal=events.filter(e=>e.open).reduce((s,ev)=>s+evNetPotBal(ev),0);
  const grandTotal=mainTotal+goalTotal2+evPotsTotal;

  // Grand total card
  document.getElementById('grandTotalAmt').textContent='₪'+grandTotal.toLocaleString();
  document.getElementById('grandTotalBreakdown').innerHTML=[
    {label:'ראשית',amt:mainTotal,color:'rgba(255,255,255,0.8)'},
    {label:'מטרה',amt:goalTotal2,color:'#6ee7b7'},
    {label:'אירועים',amt:evPotsTotal,color:'#fbbf24'},
  ].map(({label,amt,color})=>`<div style="text-align:center">
    <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-bottom:2px">${label}</div>
    <div style="font-size:15px;font-weight:700;color:${color}">₪${amt.toLocaleString()}</div>
  </div>`).join('');

  // Main fund balance
  document.getElementById('fundBalAmt').textContent='₪'+mainTotal.toLocaleString();

  const famSumEl=document.getElementById('fundFamSummary');
  if(famSumEl){
    const withBal=families.filter(f=>famFundBal(f.id)>0);
    if(!withBal.length){
      famSumEl.innerHTML='';
    } else {
      famSumEl.innerHTML=withBal.map(f=>{
        const cl=col(f.id);
        const bal=famFundBal(f.id);
        return`<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          ${famAva(f, 28, 'flex-shrink:0')}
          <div style="flex:1;font-size:13px;font-weight:600">${esc(f.name.replace('משפחת','').trim())}</div>
          <div style="font-size:13px;font-weight:700;color:var(--green-mid)">₪${bal.toLocaleString()}</div>
        </div>`;
      }).join('');
    }
  }

  // Event pots section
  const evPotsEl=document.getElementById('eventPotsSection');
  if(evPotsEl){
    const potsWithFunds=events.filter(e=>e.open&&evPotTotal(e)>0);
    if(!potsWithFunds.length){
      evPotsEl.innerHTML='';
    } else {
      evPotsEl.innerHTML=`<div class="fund-section-title">📅 קופות אירועים</div>`+
        potsWithFunds.map(ev=>{
          const pot=evNetPotBal(ev);
          const cl=col(ev.id);
          return`<div style="background:var(--surface);border-radius:var(--r);border:1px solid var(--amber);padding:11px 14px;margin-bottom:8px;display:flex;align-items:center;gap:10px;cursor:pointer" onclick="openPotModal(${ev.id})">
            <div class="ava" style="background:${cl.bg};color:${cl.c};width:32px;height:32px;font-size:11px;flex-shrink:0">📅</div>
            <div style="flex:1">
              <div style="font-size:14px;font-weight:700">${esc(ev.name)}</div>
              ${ev.date&&ev.date!=='לא צוין'?`<div style="font-size:11px;color:var(--text2);margin-top:1px">${esc(ev.date)}</div>`:''}
            </div>
            <div style="font-size:15px;font-weight:800;color:var(--amber)">₪${pot.toLocaleString()}</div>
          </div>`;
        }).join('');
    }
  }

  renderSavingsPot();

  // היסטוריית תנועות
  const txEl=document.getElementById('fundTxList');
  const arrow=document.getElementById('fundTxArrow');
  if(txEl) txEl.style.display=fundTxOpen?'block':'none';
  if(arrow) arrow.textContent=fundTxOpen?'▲':'▼';
  if(!fundTxOpen||!txEl) return;
  if(!fund.transactions.length){
    txEl.innerHTML=`<div class="empty"><span class="empty-ico">📋</span>אין תנועות עדיין</div>`;
    return;
  }
  txEl.innerHTML=`<div class="fund-tx-card" style="margin-top:6px">${[...fund.transactions].reverse().map(tx=>{
    const isDeposit=tx.type==='deposit';const isWithdraw=tx.type==='withdraw';
    return`<div class="fund-tx-row">
      <span class="fund-tx-type ${isDeposit?'fund-tx-dep':isWithdraw?'fund-tx-with':'fund-tx-pay'}">${isDeposit?'הפקדה':isWithdraw?'משיכה':'תשלום'}</span>
      <span class="fund-tx-desc">${esc(tx.desc)}</span>
      <span class="fund-tx-amt ${isDeposit?'':'neg'}">${isDeposit?'+':'-'}₪${tx.amount.toLocaleString()}</span>
    </div>`;
  }).join('')}</div>`;
}
function addSavingsPotExp(){
  const name=document.getElementById('savExpName')?.value.trim();
  const amt=Math.round(parseFloat(document.getElementById('savExpAmt')?.value)||0);
  if(!name||!amt)return;
  if(!savingsPot.expenses)savingsPot.expenses=[];
  if(!savingsPot.nxtExpId)savingsPot.nxtExpId=1;
  const d=new Date();
  savingsPot.expenses.push({id:savingsPot.nxtExpId++,name,amt,date:d.toLocaleDateString('he-IL',{day:'2-digit',month:'2-digit',year:'numeric'})});
  save();renderFund();
}
function delSavingsPotExp(id){
  savingsPot.expenses=(savingsPot.expenses||[]).filter(e=>e.id!==id);
  save();renderFund();
}
function toggleFundTx(){
  fundTxOpen=!fundTxOpen;
  const txEl=document.getElementById('fundTxList');
  const arrow=document.getElementById('fundTxArrow');
  if(txEl) txEl.style.display=fundTxOpen?'block':'none';
  if(arrow) arrow.textContent=fundTxOpen?'▲':'▼';
  if(fundTxOpen){
    if(!fund.transactions.length){
      txEl.innerHTML=`<div class="empty"><span class="empty-ico">📋</span>אין תנועות עדיין</div>`;
    } else {
      txEl.innerHTML=`<div class="fund-tx-card" style="margin-top:6px">${[...fund.transactions].reverse().map(tx=>{
        const isDeposit=tx.type==='deposit';const isWithdraw=tx.type==='withdraw';
        return`<div class="fund-tx-row">
          <span class="fund-tx-type ${isDeposit?'fund-tx-dep':isWithdraw?'fund-tx-with':'fund-tx-pay'}">${isDeposit?'הפקדה':isWithdraw?'משיכה':'תשלום'}</span>
          <span class="fund-tx-desc">${esc(tx.desc)}</span>
          <span class="fund-tx-amt ${isDeposit?'':'neg'}">${isDeposit?'+':'-'}₪${tx.amount.toLocaleString()}</span>
        </div>`;
      }).join('')}</div>`;
    }
  }
}

function openGoalForm(){
  document.getElementById('goalFormOverlay').style.display='flex';
}
function closeGoalForm(){
  document.getElementById('goalFormOverlay').style.display='none';
  document.getElementById('goalName').value='';
  document.getElementById('goalTarget').value='';
}
function addGoalFund(){
  const name=document.getElementById('goalName').value.trim();
  if(!name){ alert('נא להזין שם לקופה'); return; }
  const target=Math.max(0,parseFloat(document.getElementById('goalTarget').value)||0);
  goalFunds.push({id:nxtGoal++,name,target,contributions:{},closed:false,archived:false});
  closeGoalForm();
  save();render();
}
let _goalDepositGoalId=null;
let _goalDepositFamId=null;
function openGoalDepositSheet(goalId){
  _goalDepositGoalId=goalId;
  _goalDepositFamId=null;
  const g=goalFunds.find(x=>x.id===goalId);if(!g)return;
  const titleEl=document.getElementById('goalDepositTitle');
  if(titleEl) titleEl.textContent='הפקדה ל"'+g.name+'"';
  document.getElementById('goalDepositFields').innerHTML=`
    <input type="number" min="0" inputmode="numeric" id="goalDepositAmt" placeholder="סכום להפקדה (₪)"
      style="width:100%;border:1.5px solid var(--blue-mid);border-radius:var(--r2);padding:12px;font-size:18px;font-family:var(--font);background:var(--bg);color:var(--text);direction:ltr;text-align:center;margin-bottom:14px;box-sizing:border-box">
    <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:8px">מי מפקיד?</div>
    ${families.map(f=>{
      const cl=col(f.id);
      const c=g.contributions[f.id]||0;
      return`<div id="gdepfam-${f.id}" onclick="selectGoalDepFam(${f.id})" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--r2);border:1.5px solid var(--border);margin-bottom:6px;cursor:pointer;box-sizing:border-box">
        ${famAva(f, 32, 'flex-shrink:0')}
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700">${esc(f.name.replace('משפחת','').trim())}</div>
          <div style="font-size:11px;color:var(--blue-mid);margin-top:1px">הפקיד עד כה: ₪${c.toLocaleString()}</div>
        </div>
      </div>`;
    }).join('')}
  `;
  document.getElementById('goalDepositOverlay').style.display='flex';
  setTimeout(()=>{ const el=document.getElementById('goalDepositAmt'); if(el)el.focus(); },100);
}
function selectGoalDepFam(famId){
  _goalDepositFamId=famId;
  families.forEach(f=>{
    const el=document.getElementById('gdepfam-'+f.id);
    if(el){
      const sel=f.id===famId;
      el.style.borderColor=sel?'var(--blue-mid)':'var(--border)';
      el.style.background=sel?'var(--blue-bg)':'transparent';
    }
  });
}
function closeGoalDepositSheet(){
  document.getElementById('goalDepositOverlay').style.display='none';
  _goalDepositGoalId=null;_goalDepositFamId=null;
}
function confirmGoalDeposit(){
  if(_goalDepositGoalId==null){ return; }
  if(_goalDepositFamId==null){ alert('נא לבחור משפחה'); return; }
  const amt=parseFloat(document.getElementById('goalDepositAmt')?.value)||0;
  if(amt<=0){ alert('נא להזין סכום'); return; }
  const g=goalFunds.find(x=>x.id===_goalDepositGoalId);if(!g)return;
  g.contributions[_goalDepositFamId]=(g.contributions[_goalDepositFamId]||0)+amt;
  closeGoalDepositSheet();
  save();render();
}
function toggleGoalClosed(goalId){
  const g=goalFunds.find(x=>x.id===goalId);if(!g)return;
  g.closed=!g.closed;
  save();render();
}
function delGoalFund(goalId){
  if(!confirm('למחוק את הקופה? כל ההפקדות יימחקו'))return;
  goalFunds=goalFunds.filter(g=>g.id!==goalId);
  save();render();
}
function archiveGoalFund(goalId){
  const g=goalFunds.find(x=>x.id===goalId);if(!g)return;
  g.archived=true;collapsedGoals.delete(goalId);
  save();render();
  goTab('archive',null);
}
function reopenGoalFund(goalId){
  const g=goalFunds.find(x=>x.id===goalId);if(!g)return;
  g.archived=false;expandedArchGoals.delete(goalId);
  save();render();
  goTab('fund',document.getElementById('nb-fund'));
}
function toggleArchGoalExp(goalId){
  if(expandedArchGoals.has(goalId))expandedArchGoals.delete(goalId);else expandedArchGoals.add(goalId);
  renderArchive();
}
function renderGoalFunds(){
  const el=document.getElementById('goalFundsList');
  if(!el)return;
  const activeGoals=goalFunds.filter(g=>!g.archived);
  if(!activeGoals.length){
    el.innerHTML=`<div class="empty" style="padding:30px 20px"><span class="empty-ico">🎯</span>אין קופות למטרה<br><span style="font-size:12px">לדוגמה: קופה למתנה לסבא</span></div>`;
    return;
  }
  el.innerHTML=activeGoals.map(g=>{
    const total=goalTotal(g);
    const pct=g.target>0?Math.min(100,Math.round(total/g.target*100)):0;
    const reached=g.target>0&&total>=g.target;
    const contributors=families.filter(f=>(g.contributions[f.id]||0)>0);
    const contribHtml=contributors.length?`
      <div style="border-top:1px solid rgba(255,255,255,0.15);padding-top:9px;margin-top:10px">
        ${contributors.map(f=>{
          const cl=col(f.id);
          const c=g.contributions[f.id]||0;
          return`<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
            ${famAva(f, 24, 'flex-shrink:0')}
            <div style="flex:1;font-size:12px;font-weight:600;color:rgba(255,255,255,0.8)">${esc(f.name.replace('משפחת','').trim())}</div>
            <div style="font-size:12px;font-weight:700;color:#6ee7b7">₪${c.toLocaleString()}</div>
          </div>`;
        }).join('')}
      </div>`:'';
    return`<div class="fund-settle-card" id="gfund-${g.id}" style="margin-bottom:14px;${g.closed?'opacity:.6':''}">
      <div style="background:var(--text);border-radius:var(--r) var(--r) 0 0;padding:16px 16px 13px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px">
          <div style="font-size:15px;font-weight:800;color:#fff">🎯 ${esc(g.name)}</div>
          ${reached?'<span class="badge badge-green" style="margin-top:2px">✅ הושלם</span>':g.closed?'<span class="badge badge-gray" style="margin-top:2px">סגור</span>':''}
        </div>
        <div style="font-size:11px;color:rgba(255,255,255,0.55);margin-bottom:3px">נאסף עד כה</div>
        <div style="font-size:30px;font-weight:800;color:#fff;letter-spacing:-0.5px">${total>0?'₪'+total.toLocaleString():'₪0'}</div>
        ${g.target>0?`
          <div class="pbar" style="margin:8px 0 3px;background:rgba(255,255,255,0.2)"><div class="pfill ${reached?'full':'part'}" style="width:${pct}%"></div></div>
          <div style="font-size:11px;color:rgba(255,255,255,0.55)">מתוך ₪${g.target.toLocaleString()} · ${pct}%</div>`:''}
        ${contribHtml}
      </div>
      <div style="padding:10px 12px">
        ${!g.closed?`<button class="edit-only" onclick="openGoalDepositSheet(${g.id})" style="width:100%;padding:11px;border-radius:var(--r2);border:none;background:var(--blue-mid);color:#fff;font-size:14px;font-weight:700;font-family:var(--font);cursor:pointer;margin-bottom:8px">↓ הפקדה</button>`:''}
        <div class="card-actions edit-only" style="margin:0">
          <button class="action-btn" onclick="toggleGoalClosed(${g.id})">${g.closed?'↩️ פתח מחדש':'✓ סגור קופה'}</button>
          <button class="action-btn blue" onclick="archiveGoalFund(${g.id})">🗂 לארכיון</button>
          <button class="action-btn red" onclick="delGoalFund(${g.id})">🗑 מחק</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

let _depositFamId=null;
let _depositMode='deposit';
function openDepositSheet(mode){
  _depositFamId=null;
  _depositMode=mode||'deposit';
  const isDeposit=_depositMode==='deposit';
  const acc=isDeposit?'var(--blue-mid)':'var(--red-mid)';
  const titleEl=document.getElementById('depositTitle');
  if(titleEl) titleEl.textContent=isDeposit?'הפקדה לקופה':'משיכה מהקופה';
  document.getElementById('depositFields').innerHTML=`
    <input type="number" min="0" inputmode="numeric" id="depositAmt" placeholder="${isDeposit?'סכום להפקדה':'סכום למשיכה'} (₪)"
      style="width:100%;border:1.5px solid ${acc};border-radius:var(--r2);padding:12px;font-size:18px;font-family:var(--font);background:var(--bg);color:var(--text);direction:ltr;text-align:center;margin-bottom:14px;box-sizing:border-box">
    <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:8px">${isDeposit?'מי מפקיד?':'מי מושך?'}</div>
    ${families.map(f=>{
      const cl=col(f.id);
      const bal=famFundBal(f.id);
      const balColor=bal>0?'var(--green-mid)':bal===0?'var(--text3)':'var(--red-mid)';
      const balText=bal>0?'₪'+bal.toLocaleString():bal===0?'₪0':'חוב ₪'+Math.abs(bal).toLocaleString();
      return`<div id="depfam-${f.id}" onclick="selectDepFam(${f.id})" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--r2);border:1.5px solid var(--border);margin-bottom:6px;cursor:pointer;box-sizing:border-box">
        ${famAva(f, 32, 'flex-shrink:0')}
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700">${esc(f.name.replace('משפחת','').trim())}</div>
          <div style="font-size:11px;color:${balColor};margin-top:1px">יתרה: ${balText}</div>
        </div>
      </div>`;
    }).join('')}
  `;
  const btn=document.querySelector('#depositSheet .fund-dep-btn');
  if(btn){
    btn.textContent=isDeposit?'✓ אשר הפקדה':'✓ אשר משיכה';
    btn.style.background=acc;
  }
  document.getElementById('depositOverlay').style.display='flex';
  setTimeout(()=>{ const el=document.getElementById('depositAmt'); if(el)el.focus(); },100);
}
function selectDepFam(famId){
  _depositFamId=famId;
  const isDeposit=_depositMode==='deposit';
  const acc=isDeposit?'var(--blue-mid)':'var(--red-mid)';
  const accBg=isDeposit?'var(--blue-bg)':'var(--red-bg)';
  families.forEach(f=>{
    const el=document.getElementById('depfam-'+f.id);
    if(el){
      const sel=f.id===famId;
      el.style.borderColor=sel?acc:'var(--border)';
      el.style.background=sel?accBg:'transparent';
    }
  });
}
function closeDepositSheet(){
  document.getElementById('depositOverlay').style.display='none';
  _depositFamId=null;
}
function confirmDeposit(){
  if(!_depositFamId){ alert('נא לבחור משפחה'); return; }
  const amt=parseFloat(document.getElementById('depositAmt')?.value)||0;
  if(amt<=0){ alert('נא להזין סכום'); return; }
  const f=getFam(_depositFamId);
  const key=String(_depositFamId);
  const name=f.name.replace('משפחת','').trim();
  if(!fund.famBalances) fund.famBalances={};
  const isDeposit=_depositMode==='deposit';
  if(!isDeposit){
    const bal=fund.famBalances[key]||0;
    if(amt>bal){ alert('לא ניתן למשוך יותר מהיתרה (₪'+bal.toLocaleString()+')'); return; }
  }
  const delta=isDeposit?amt:-amt;
  fund.famBalances[key]=(fund.famBalances[key]||0)+delta;
  fund.transactions.push({id:nxtTx++,
    type:isDeposit?'deposit':'withdraw',
    famId:_depositFamId,amount:amt,
    desc:isDeposit?name+' הפקיד לקופה':name+' משך מהקופה',
    date:new Date().toLocaleDateString('he-IL')});
  const _notifyFamId=_depositFamId;
  closeDepositSheet();
  save();render();
  sendFundUpdateEmail(_notifyFamId,amt,isDeposit?'הפקדה לקופה הראשית':'משיכה מהקופה הראשית');
}



function openAddExpItem(evId){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  addExpItemEvId=evId; addExpItemFamId=null;
  addExpItemSharedWith=new Set(ev.participants);
  addExpItemSplitMode='equal'; _editExpItemId=null; addExpItemFromPot=false;
  const potWrap=document.getElementById('expFromPotToggleWrap');
  if(potWrap)potWrap.style.display=evPotTotal(ev)>0?'block':'none';
  const potBtn=document.getElementById('expFromPotToggle');
  if(potBtn){potBtn.style.background='transparent';potBtn.style.color='var(--text2)';potBtn.style.borderColor='var(--border)';}
  const famSec=document.getElementById('expItemFamSection');if(famSec)famSec.style.display='block';
  const splitSec=document.getElementById('expItemSplitSection');if(splitSec)splitSec.style.display='block';
  const titleEl=document.getElementById('addExpItemTitle');
  if(titleEl)titleEl.textContent='➕ הוסף הוצאה';
  document.getElementById('expItemName').value='';
  document.getElementById('expItemAmt').value='';
  const errEl=document.getElementById('expItemErr');if(errEl)errEl.style.display='none';
  const picker=document.getElementById('expItemFamPicker');
  picker.innerHTML=ev.participants.map(fid=>{
    const f=getFam(fid);if(!f)return'';
    return`<button onclick="selectAddExpFam(${fid})" id="expfam-${fid}" style="padding:5px 12px;border-radius:20px;border:1.5px solid var(--border);background:transparent;color:var(--text2);font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer">${esc(f.name.replace('משפחת','').trim())}</button>`;
  }).join('');
  const sharePicker=document.getElementById('expItemSharePicker');
  sharePicker.innerHTML=ev.participants.map(fid=>{
    const f=getFam(fid);if(!f)return'';
    return`<button onclick="toggleExpShareFam(${fid})" id="expshare-${fid}" style="padding:5px 12px;border-radius:20px;border:1.5px solid var(--blue-mid);background:var(--blue-bg);color:var(--blue);font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer">${esc(f.name.replace('משפחת','').trim())}</button>`;
  }).join('');
  const custInps=document.getElementById('expItemCustomInputs');
  if(custInps){
    custInps.innerHTML=ev.participants.map(fid=>{
      const f=getFam(fid);if(!f)return'';
      return`<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        ${famAva(f,30,'flex-shrink:0')}
        <span style="flex:1;font-size:13px;font-weight:600">${esc(f.name.replace('משפחת','').trim())}</span>
        <input type="number" min="0" inputmode="numeric" placeholder="0" id="csplit-${fid}" oninput="_updateExpItemCustomTotal()" style="width:72px;border:1.5px solid var(--border);border-radius:var(--r2);padding:7px 8px;font-size:14px;font-family:var(--font);background:var(--bg);color:var(--text);text-align:center;direction:ltr;box-sizing:border-box">
      </div>`;
    }).join('');
  }
  setExpItemSplitMode('equal');
  _updateExpItemCustomTotal();
  document.getElementById('addExpItemOverlay').style.display='flex';
}
function toggleExpShareFam(famId){
  if(addExpItemSharedWith.has(famId))addExpItemSharedWith.delete(famId);
  else addExpItemSharedWith.add(famId);
  const btn=document.getElementById('expshare-'+famId);if(!btn)return;
  if(addExpItemSharedWith.has(famId)){btn.style.background='var(--blue-bg)';btn.style.color='var(--blue)';btn.style.borderColor='var(--blue-mid)';}
  else{btn.style.background='transparent';btn.style.color='var(--text2)';btn.style.borderColor='var(--border)';}
}
function selectAddExpFam(famId){
  addExpItemFamId=famId;
  const ev=events.find(e=>e.id===addExpItemEvId);if(!ev)return;
  ev.participants.forEach(fid=>{
    const btn=document.getElementById('expfam-'+fid);if(!btn)return;
    const cl=col(fid);
    if(fid===famId){btn.style.background=cl.bg;btn.style.color=cl.c;btn.style.borderColor=cl.c;}
    else{btn.style.background='transparent';btn.style.color='var(--text2)';btn.style.borderColor='var(--border)';}
  });
}
function toggleExpFromPot(){
  addExpItemFromPot=!addExpItemFromPot;
  const btn=document.getElementById('expFromPotToggle');
  const famSec=document.getElementById('expItemFamSection');
  const splitSec=document.getElementById('expItemSplitSection');
  const shareWrap=document.getElementById('expItemSharePickerWrap');
  if(btn){btn.style.background=addExpItemFromPot?'var(--amber-mid)':'transparent';btn.style.color=addExpItemFromPot?'#fff':'var(--text2)';btn.style.borderColor=addExpItemFromPot?'var(--amber-mid)':'var(--border)';}
  if(famSec)famSec.style.display=addExpItemFromPot?'none':'block';
  if(splitSec)splitSec.style.display=addExpItemFromPot?'none':'block';
  if(shareWrap)shareWrap.style.display=addExpItemFromPot?'none':'block';
  if(addExpItemFromPot){
    document.getElementById('expItemSplitEqualDiv').style.display='block';
    document.getElementById('expItemSplitCustomDiv').style.display='none';
  }
}
function closeAddExpItem(){
  document.getElementById('addExpItemOverlay').style.display='none';
  addExpItemEvId=null; addExpItemFamId=null; addExpItemSplitMode='equal'; _editExpItemId=null; addExpItemFromPot=false;
}
function setExpItemSplitMode(mode){
  addExpItemSplitMode=mode;
  const isCustom=mode==='custom';
  document.getElementById('expItemSplitEqualDiv').style.display=isCustom?'none':'block';
  document.getElementById('expItemSplitCustomDiv').style.display=isCustom?'block':'none';
  const b1=document.getElementById('expSplitEqualBtn');
  const b2=document.getElementById('expSplitCustomBtn');
  if(b1){b1.style.background=isCustom?'transparent':'var(--blue-mid)';b1.style.color=isCustom?'var(--text2)':'#fff';b1.style.borderColor=isCustom?'var(--border)':'var(--blue-mid)';}
  if(b2){b2.style.background=isCustom?'var(--blue-mid)':'transparent';b2.style.color=isCustom?'#fff':'var(--text2)';b2.style.borderColor=isCustom?'var(--blue-mid)':'var(--border)';}
}
function _updateExpItemCustomTotal(){
  const ev=events.find(e=>e.id===addExpItemEvId);if(!ev)return;
  let total=0;
  ev.participants.forEach(fid=>{const inp=document.getElementById('csplit-'+fid);if(inp)total+=parseFloat(inp.value)||0;});
  const el=document.getElementById('expItemCustomTotal');
  if(el)el.textContent='₪'+Math.round(total).toLocaleString();
}
async function doAddExpItem(){
  const name=document.getElementById('expItemName').value.trim();
  const errEl=document.getElementById('expItemErr');
  const ev=events.find(e=>e.id===addExpItemEvId);if(!ev)return;
  if(addExpItemFromPot){
    const rawAmt=parseFloat(document.getElementById('expItemAmt').value)||0;
    if(!name||rawAmt<=0){if(errEl)errEl.style.display='block';return;}
    if(errEl)errEl.style.display='none';
    const amt=await _toILS('expItemAmt','expItemCurHint','expItemCur');
    if(!ev.potExpItems)ev.potExpItems=[];
    ev.potExpItemId=(ev.potExpItemId||0)+1;
    ev.potExpItems.push({id:ev.potExpItemId,name,amt:Math.round(amt),date:new Date().toLocaleDateString('he-IL')});
    closeAddExpItem();save();render();
    return;
  }
  if(addExpItemSplitMode==='custom'){
    if(!name||!addExpItemFamId){if(errEl)errEl.style.display='block';return;}
    const customSplit={};let total=0;
    ev.participants.forEach(fid=>{
      const inp=document.getElementById('csplit-'+fid);
      const v=Math.round(parseFloat(inp&&inp.value)||0);
      if(v>0){customSplit[String(fid)]=v;total+=v;}
    });
    if(!total){if(errEl)errEl.style.display='block';return;}
    if(errEl)errEl.style.display='none';
    if(_editExpItemId!=null){
      const old=(ev.expenseItems||[]).find(it=>it.id===_editExpItemId);
      if(old){ev.expenses[old.famId]=Math.max(0,(ev.expenses[old.famId]||0)-old.amt);old.famId=addExpItemFamId;old.name=name;old.amt=total;old.customSplit=customSplit;delete old.sharedWith;delete old.origAmt;delete old.origCur;ev.expenses[addExpItemFamId]=(ev.expenses[addExpItemFamId]||0)+total;}
    }else{
      if(!ev.expenseItems)ev.expenseItems=[];
      ev.expItemId=(ev.expItemId||0)+1;
      ev.expenseItems.push({id:ev.expItemId,famId:addExpItemFamId,name,amt:total,customSplit});
      ev.expenses[addExpItemFamId]=(ev.expenses[addExpItemFamId]||0)+total;
    }
    closeAddExpItem();save();render();
    return;
  }
  const rawAmt=parseFloat(document.getElementById('expItemAmt').value)||0;
  if(!name||!addExpItemFamId||rawAmt<=0){if(errEl)errEl.style.display='block';return;}
  if(errEl)errEl.style.display='none';
  const amt=await _toILS('expItemAmt','expItemCur');
  const origCur=document.getElementById('expItemCur')?.value||'₪';
  const sw=[...(addExpItemSharedWith||new Set(ev.participants))].filter(fid=>ev.participants.includes(fid));
  const isPartial=sw.length>0&&sw.length<ev.participants.length;
  if(_editExpItemId!=null){
    const old=(ev.expenseItems||[]).find(it=>it.id===_editExpItemId);
    if(old){ev.expenses[old.famId]=Math.max(0,(ev.expenses[old.famId]||0)-old.amt);old.famId=addExpItemFamId;old.name=name;old.amt=amt;delete old.customSplit;if(origCur!=='₪'){old.origAmt=rawAmt;old.origCur=origCur;}else{delete old.origAmt;delete old.origCur;}if(isPartial)old.sharedWith=sw;else delete old.sharedWith;ev.expenses[addExpItemFamId]=(ev.expenses[addExpItemFamId]||0)+amt;}
  }else{
    if(!ev.expenseItems)ev.expenseItems=[];
    ev.expItemId=(ev.expItemId||0)+1;
    const item={id:ev.expItemId,famId:addExpItemFamId,name,amt};
    if(origCur!=='₪'){item.origAmt=rawAmt;item.origCur=origCur;}
    if(isPartial)item.sharedWith=sw;
    ev.expenseItems.push(item);
    ev.expenses[addExpItemFamId]=(ev.expenses[addExpItemFamId]||0)+amt;
  }
  closeAddExpItem();
  save();render();
}
function deleteExpItem(evId,itemId){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  const item=(ev.expenseItems||[]).find(it=>it.id===itemId);if(!item)return;
  ev.expenses[item.famId]=Math.max(0,(ev.expenses[item.famId]||0)-item.amt);
  ev.expenseItems=ev.expenseItems.filter(it=>it.id!==itemId);
  save();render();
}
function toggleExpItem(evId,itemId){
  const key=evId+'-item-'+itemId;
  if(expandedExpItems.has(key))expandedExpItems.delete(key);else expandedExpItems.add(key);
  const el=document.getElementById('ecard-'+evId);
  const ev=events.find(e=>e.id===evId);
  if(el&&ev)el.outerHTML=evCard(ev);
}
function toggleFamShare(evId,famId){
  const key=evId+'-share-'+famId;
  if(expandedFamShares.has(key))expandedFamShares.delete(key);else expandedFamShares.add(key);
  const el=document.getElementById('ecard-'+evId);
  const ev=events.find(e=>e.id===evId);
  if(el&&ev)el.outerHTML=evCard(ev);
}
function editExpItem(evId,itemId){
  openAddExpItem(evId);
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  const item=(ev.expenseItems||[]).find(it=>it.id===itemId);if(!item)return;
  _editExpItemId=itemId;
  const titleEl=document.getElementById('addExpItemTitle');
  if(titleEl)titleEl.textContent='✏️ ערוך הוצאה';
  document.getElementById('expItemName').value=item.name;
  selectAddExpFam(item.famId);
  if(item.customSplit){
    setExpItemSplitMode('custom');
    ev.participants.forEach(fid=>{
      const inp=document.getElementById('csplit-'+fid);
      if(inp)inp.value=item.customSplit[String(fid)]||'';
    });
    _updateExpItemCustomTotal();
  } else {
    setExpItemSplitMode('equal');
    addExpItemSharedWith=new Set(item.sharedWith||ev.participants);
    ev.participants.forEach(fid=>{
      const btn=document.getElementById('expshare-'+fid);if(!btn)return;
      if(addExpItemSharedWith.has(fid)){btn.style.background='var(--blue-bg)';btn.style.color='var(--blue)';btn.style.borderColor='var(--blue-mid)';}
      else{btn.style.background='transparent';btn.style.color='var(--text2)';btn.style.borderColor='var(--border)';}
    });
    document.getElementById('expItemAmt').value=item.origAmt||item.amt;
    const curEl=document.getElementById('expItemCur');
    if(curEl)curEl.value=item.origCur||'₪';
  }
}
function toggleCumFamily(evId,famId){
  const key=evId+'-'+famId;
  if(expandedCumFamilies.has(key))expandedCumFamilies.delete(key);
  else expandedCumFamilies.add(key);
  const el=document.getElementById('ecard-'+evId);
  const ev=events.find(e=>e.id===evId);
  if(el&&ev)el.outerHTML=evCard(ev);
}
function togglePotFamily(evId,famId){
  const key=evId+'-pot-'+famId;
  if(expandedPotFamilies.has(key))expandedPotFamilies.delete(key);
  else expandedPotFamilies.add(key);
  const el=document.getElementById('ecard-'+evId);
  const ev=events.find(e=>e.id===evId);
  if(el&&ev)el.outerHTML=evCard(ev);
}
function togglePotModalFamily(evId,famId){
  const key=evId+'-pot-'+famId;
  if(expandedPotFamilies.has(key))expandedPotFamilies.delete(key);
  else expandedPotFamilies.add(key);
  const ev=events.find(e=>e.id===evId);
  if(ev)renderPotModal(ev);
}
// ── Settle modal ──────────────────────────────
function openSettleModal(evId){
  settleModalEvId=evId;
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  renderSettleModal(ev);
  document.getElementById('settleModal').style.display='flex';
}
function confirmSavingsTransfer(evId,famId,amt){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  if(!ev.savingsPaid)ev.savingsPaid=[];
  ev.savingsPaid.push({famId,amt});
  save();render();
  if(settleModalEvId===evId)renderSettleModal(ev);
}
function closeSettleModal(){
  document.getElementById('settleModal').style.display='none';
  settleModalEvId=null;
}
function renderSettleModal(ev){
  const el=document.getElementById('settleModalContent');if(!el)return;
  const transfers=calcTransfers(ev);
  const settledList=ev.settled||[];
  const settleLines=transfers.map(t=>{
    if(t.toFid==='__savings__'){
      return`<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--border)">
        <span style="font-size:13px">💎 <b>${esc(t.from)}</b> מעביר לקופת חיסכון ₪${t.amt.toLocaleString()}</span>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="edit-only" style="padding:6px 12px;border-radius:6px;border:none;background:var(--green-mid);color:#fff;font-size:12px;font-weight:700;font-family:var(--font);cursor:pointer" onclick="confirmSavingsTransfer(${ev.id},${t.fromFid},${t.amt})">💎 שולם</button>
        </div>
      </div>`;
    }
    return`<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--border)">
      <span style="font-size:13px">👈 <b>${esc(t.from)}</b> מעביר ל<b>${esc(t.to)}</b> ₪${t.amt.toLocaleString()}</span>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="edit-only" style="padding:6px 12px;border-radius:6px;border:none;background:var(--blue-mid);color:#fff;font-size:12px;font-weight:700;font-family:var(--font);cursor:pointer" onclick="openPartPayModal(${ev.id},'${esc(t.from)}',${t.fromFid},'${esc(t.to)}',${t.toFid},${t.amt},false,true)">✓ שולם</button>
      </div>
    </div>`;
  }).join('');
  const _potByTo={};const _nonPot=[];
  settledList.forEach(s=>{if(s.method==='pot'){const k=s.toFid!=null?String(s.toFid):s.to;if(!_potByTo[k])_potByTo[k]={to:s.to,amt:0};_potByTo[k].amt+=s.amt;}else _nonPot.push(s);});
  const _rowHtml=(icon,badge,from,to,amt)=>`<div style="display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;color:var(--text2)"><span style="color:var(--green-mid)">${icon}</span><span><b style="color:var(--text)">${esc(from)}</b> העביר ל<b style="color:var(--text)">${esc(to)}</b> ₪${Math.round(amt).toLocaleString()}</span>${badge}</div>`;
  const _potBadge='<span style="font-size:10px;background:var(--amber-bg);color:var(--amber);padding:1px 6px;border-radius:10px">קופת אירוע</span>';
  const _potRows=Object.values(_potByTo).map(p=>_rowHtml('💰',_potBadge,'קופת האירוע',p.to,p.amt));
  const _nonPotRows=_nonPot.map(s=>{const icon=s.method==='fund'?'🏦':'✓';const badge=s.method==='fund'?'<span style="font-size:10px;background:var(--blue-bg);color:var(--blue);padding:1px 6px;border-radius:10px">קופה</span>':'<span style="font-size:10px;background:var(--green-bg);color:var(--green);padding:1px 6px;border-radius:10px">ישיר</span>';return _rowHtml(icon,badge,s.from,s.to,s.amt);});
  const _savBadge='<span style="font-size:10px;background:var(--green-bg);color:var(--green);padding:1px 6px;border-radius:10px">חיסכון</span>';
  const _savPaidRows=(ev.savingsPaid||[]).map(p=>{const f=getFam(p.famId);if(!f)return'';return _rowHtml('💎',_savBadge,f.name.replace('משפחת','').trim(),'קופת חיסכון',p.amt);}).join('');
  const doneRows=(settledList.length||(ev.savingsPaid||[]).length)?
    `<div style="padding:12px 16px 4px;border-top:2px solid var(--border);margin-top:${transfers.length?'8':'0'}px">
      <div style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:6px">✅ בוצעו</div>
      ${[..._nonPotRows,..._potRows].join('')}${_savPaidRows}
    </div>`:'';
  el.innerHTML=`
    <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
      <div><div style="font-size:14px;font-weight:700">📊 העברות לאיזון</div><div style="font-size:11px;color:var(--text2);margin-top:2px">${shareLabel(ev)} · ${esc(ev.name)}</div></div>
      <button onclick="closeSettleModal()" style="border:none;background:none;font-size:20px;color:var(--text2);cursor:pointer;font-family:var(--font);padding:0">✕</button>
    </div>
    ${transfers.length?`<div style="padding:4px 0 4px">${settleLines}</div>`:`<div style="padding:20px;text-align:center;font-size:15px;color:var(--green)">✅ כולם מסודרים!</div>`}
    ${doneRows}
    <div style="padding:10px 16px">
      <button onclick="closeSettleModal()" style="width:100%;padding:10px;border-radius:var(--r2);border:1.5px solid var(--border);background:transparent;color:var(--text2);font-size:13px;font-weight:700;font-family:var(--font);cursor:pointer">סגור</button>
    </div>`;
}
// ── Pot modal ──────────────────────────────
function openPotModal(evId){
  potModalEvId=evId;
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  renderPotModal(ev);
  document.getElementById('potModal').style.display='flex';
}
function closePotModal(){
  document.getElementById('potModal').style.display='none';
  potModalEvId=null;
}
function openPotTransferModal(evId){
  potTrModalEvId=evId;
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  renderPotTransferModal(ev);
  document.getElementById('potTrModal').style.display='flex';
}
function closePotTransferModal(){
  document.getElementById('potTrModal').style.display='none';
  potTrModalEvId=null;
}
function _refreshPotTransferModal(evId){
  if(potTrModalEvId!==evId)return;
  const te=events.find(e=>e.id===evId);if(!te||evPotTotal(te)<=0)return closePotTransferModal();
  const adjBal=evAdjBalance(te);
  if(te.participants.some(fid=>(adjBal[fid]||0)>0.5))renderPotTransferModal(te);else closePotTransferModal();
}
function renderPotTransferModal(ev){
  const el=document.getElementById('potTrModalContent');if(!el)return;
  const adjBal=evAdjBalance(ev);
  const potTransfers=calcPotTransfers(ev);
  const excessByFam=calcPotExcessByFamily(ev);
  const creditorFids=ev.participants.filter(fid=>(adjBal[fid]||0)>0.5);
  if(!creditorFids.length){closePotTransferModal();return;}
  const potByCreditor={};
  potTransfers.forEach(t=>{if(!potByCreditor[t.toFid])potByCreditor[t.toFid]={amt:0};potByCreditor[t.toFid].amt+=t.amt;});
  const _sug=fid=>{const fromOthers=(potByCreditor[fid]||{amt:0}).amt;const ownExc=excessByFam[fid]||0;const c=Math.min(Math.round(adjBal[fid]||0),fromOthers+ownExc);return c>0.5?c:Math.round(adjBal[fid]||0);};
  const creditorRows=creditorFids.map(fid=>{
    const pf=getFam(fid);if(!pf)return'';
    const name=pf.name.replace('משפחת','').trim();
    const sug=_sug(fid);
    return`<div style="display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700">${esc(name)}</div>
        <div style="font-size:11px;color:var(--text2)">מגיע לו ₪${sug.toLocaleString()}</div>
      </div>
      <button onclick="releasePotToOneM(${ev.id},${fid},false)" style="padding:7px 12px;border-radius:8px;border:none;background:var(--blue-mid);color:#fff;font-size:12px;font-weight:700;font-family:var(--font);cursor:pointer;white-space:nowrap">↗ העבר</button>
      <button onclick="releasePotToOneM(${ev.id},${fid},true)" style="padding:7px 12px;border-radius:8px;border:none;background:var(--green-mid);color:#fff;font-size:12px;font-weight:700;font-family:var(--font);cursor:pointer;white-space:nowrap">🏦 קופה</button>
    </div>`;
  }).join('');
  const manualSection='';
  el.innerHTML=`
    <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-size:14px;font-weight:700">↗ העברה מהקופה</div>
        <div style="font-size:11px;color:var(--text2);margin-top:2px">${esc(ev.name)}</div>
      </div>
      <button onclick="closePotTransferModal()" style="border:none;background:none;font-size:20px;color:var(--text2);cursor:pointer;font-family:var(--font);padding:0">✕</button>
    </div>
    <div style="padding:8px 16px 0"><div style="font-size:11px;font-weight:700;color:var(--text2)">זכאים לקבל</div></div>
    ${creditorRows}
    ${manualSection}
    <div style="padding:8px 16px 12px">
      <button onclick="closePotTransferModal()" style="width:100%;padding:10px;border-radius:var(--r2);border:1.5px solid var(--border);background:transparent;color:var(--text2);font-size:13px;font-weight:700;font-family:var(--font);cursor:pointer">סגור</button>
    </div>`;
}
function renderPotModal(ev){
  const el=document.getElementById('potModalContent');if(!el)return;
  const potPayments=ev.potPayments||[];
  const potTotal=evPotTotal(ev);
  const potExpItems=ev.potExpItems||[];
  const potExpTot=evPotExpTotal(ev);
  const effBal=Math.round(potTotal-potExpTot);
  const potTransfers=calcPotTransfers(ev);
  const adjBal=evAdjBalance(ev);
  const creditorFids=ev.participants.filter(fid=>(adjBal[fid]||0)>0.5);
  const potByCreditor={};
  potTransfers.forEach(t=>{if(!potByCreditor[t.toFid])potByCreditor[t.toFid]={name:t.to,fid:t.toFid,amt:0};potByCreditor[t.toFid].amt+=t.amt;});
  const excessByFam=calcPotExcessByFamily(ev);
  const _potSuggest=fid=>{
    const fromOthers=(potByCreditor[fid]||{amt:0}).amt;
    const ownExcess=excessByFam[fid]||0;
    const calc=Math.min(Math.round(adjBal[fid]||0),fromOthers+ownExcess);
    return calc>0.5?calc:Math.round(adjBal[fid]||0);
  };
  const potTransferBtn=creditorFids.length?`<div class="edit-only" style="padding:10px 16px;border-bottom:1px solid var(--border)">
    <button onclick="openPotTransferModal(${ev.id})" style="width:100%;padding:10px;border-radius:var(--r2);border:none;background:var(--blue-mid);color:#fff;font-size:13px;font-weight:700;font-family:var(--font);cursor:pointer">↗ העברה לזכאים${creditorFids.length>1?' ('+creditorFids.length+')':''}</button>
  </div>`:'';

  const potDistributed=potTransfers.reduce((s,t)=>s+t.amt,0)+Object.entries(excessByFam).filter(([fidStr])=>(adjBal[parseInt(fidStr)]||0)>0.5).reduce((s,[,e])=>s+e,0);
  const potExcess=Math.round(potTotal-potDistributed);
  const settledList=ev.settled||[];
  const _potByTo={};const _nonPot=[];
  settledList.forEach(s=>{
    if(s.method==='pot'){const k=s.toFid!=null?String(s.toFid):s.to;if(!_potByTo[k])_potByTo[k]={to:s.to,amt:0};_potByTo[k].amt+=s.amt;}
    else _nonPot.push(s);
  });
  const _savingsXfers=(ev.potToSavings||[]).map(p=>({method:'pot-savings',to:'קופת חיסכון',amt:p.amt,date:p.date}));
  const _mergedDone=[...Object.values(_potByTo).map(p=>({method:'pot',to:p.to,amt:p.amt})),..._nonPot,..._savingsXfers];
  const doneRows=_mergedDone.length?`<div style="border-top:1px solid var(--border)"><div style="font-size:11px;font-weight:700;color:var(--text2);padding:8px 16px 4px">העברות שבוצעו:</div><div style="padding:0 16px 4px">`+_mergedDone.map(s=>{
    const icon=s.method==='fund'?'🏦':s.method==='pot'?'💰':s.method==='pot-savings'?'💎':'✓';
    const badge=s.method==='fund'?`<span style="font-size:10px;background:var(--blue-bg);color:var(--blue);padding:1px 6px;border-radius:10px">קופה</span>`:s.method==='pot'?`<span style="font-size:10px;background:var(--amber-bg);color:var(--amber);padding:1px 6px;border-radius:10px">קופת אירוע</span>`:s.method==='pot-savings'?`<span style="font-size:10px;background:var(--green-bg);color:var(--green-mid);padding:1px 6px;border-radius:10px">חיסכון</span>`:`<span style="font-size:10px;background:var(--green-bg);color:var(--green);padding:1px 6px;border-radius:10px">ישיר</span>`;
    const fromLabel=(s.method==='pot'||s.method==='pot-savings')?'קופת האירוע':s.from;
    return`<div style="display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;color:var(--text2)"><span style="color:var(--green-mid)">${icon}</span><span style="flex:1"><b style="color:var(--text)">${esc(fromLabel)}</b> הועבר ל<b style="color:var(--text)">${esc(s.to)}</b> ₪${s.amt.toLocaleString()}</span>${badge}</div>`;
  }).join('')+'</div></div>':'';
  const expRows=potExpItems.length?`<div style="border-bottom:1px solid var(--border)">
    <div style="font-size:11px;font-weight:700;color:var(--text2);padding:8px 16px 4px">הוצאות מהקופה:</div>
    ${potExpItems.map(it=>`<div style="border-top:1px solid var(--border);display:flex;align-items:center;gap:10px;padding:10px 16px">
      <div style="width:32px;height:32px;border-radius:50%;background:var(--amber-bg);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">🛒</div>
      <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700">${esc(it.name)}</div>${it.date?`<div style="font-size:11px;color:var(--text2);margin-top:1px">${esc(it.date)}</div>`:''}</div>
      <div style="font-size:14px;font-weight:700;color:var(--amber)">₪${it.amt.toLocaleString()}</div>
      <button class="edit-only" onclick="deletePotExpItem(${ev.id},${it.id})" style="background:none;border:none;color:var(--red-mid);cursor:pointer;font-size:14px;padding:0 4px;font-family:var(--font)" title="מחק">🗑</button>
    </div>`).join('')}
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 16px;border-top:1px solid var(--border);background:var(--surface2)">
      <span style="font-size:12px;font-weight:700;color:var(--text2)">יתרה אחרי הוצאות</span>
      <span style="font-size:13px;font-weight:700;color:var(--amber)">₪${effBal.toLocaleString()}</span>
    </div>
  </div>`:'';
  el.innerHTML=`
    <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
      <div><div style="font-size:14px;font-weight:700">💰 קופת האירוע</div><div style="font-size:11px;color:var(--text2);margin-top:2px">₪${potTotal.toLocaleString()}${potExpTot>0?` · הוצאות ₪${potExpTot.toLocaleString()} · יתרה ₪${effBal.toLocaleString()}`:''} · ${esc(ev.name)}</div></div>
      <button onclick="closePotModal()" style="border:none;background:none;font-size:20px;color:var(--text2);cursor:pointer;font-family:var(--font);padding:0">✕</button>
    </div>
    <div style="border-bottom:1px solid var(--border)">
      <div style="font-size:11px;font-weight:700;color:var(--text2);padding:8px 16px 4px">הפקדות:</div>
      ${(()=>{const byFam={};potPayments.forEach(p=>{if(!byFam[p.famId])byFam[p.famId]=[];byFam[p.famId].push(p);});(ev.settled||[]).filter(s=>(s.method==='pot'||s.method==='pot-refund')&&s.fromFid!=null).forEach(s=>{if(!byFam[s.fromFid])byFam[s.fromFid]=[];});const ord=families.map(f=>f.id).filter(fid=>byFam[fid]);return ord.map(fid=>{const pmnts=byFam[fid]||[];const pf=getFam(fid);if(!pf)return'';const name=pf.name.replace('משפחת','').trim();const distFromThis=(ev.settled||[]).filter(s=>s.method==='pot'&&s.fromFid===fid).reduce((s,t)=>s+t.amt,0);const refundFromThis=(ev.settled||[]).filter(s=>s.method==='pot-refund'&&s.fromFid===fid).reduce((s,t)=>s+t.amt,0);const tot=pmnts.reduce((s,p)=>s+p.amt,0)+distFromThis+refundFromThis;const multi=pmnts.length>1;const key=ev.id+'-pot-'+fid;const isExp=expandedPotFamilies.has(key);const delBtn=(i)=>`<button class="edit-only" onclick="deletePotDeposit(${ev.id},${fid},${i})" style="background:none;border:none;color:var(--red-mid);cursor:pointer;font-size:14px;padding:0 4px;font-family:var(--font)" title="מחק">🗑</button>`;const details=multi&&isExp?'<div style="background:var(--surface2);padding:6px 16px 6px 32px">'+pmnts.map((p,i)=>`<div style="font-size:12px;color:var(--text2);padding:3px 0;display:flex;justify-content:space-between;align-items:center"><span>תשלום ${i+1} · ₪${p.amt.toLocaleString()}</span>${delBtn(i)}</div>`).join('')+'</div>':'';return`<div style="border-top:1px solid var(--border)"><div style="display:flex;align-items:center;gap:10px;padding:10px 16px"><div style="width:32px;height:32px;border-radius:50%;background:var(--green-bg);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">✓</div><div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:700;color:var(--text)">${esc(name)}</div><div style="font-size:12px;color:var(--green-mid);font-weight:600;margin-top:1px">₪${tot.toLocaleString()}</div>${refundFromThis>0.5?`<div style="font-size:11px;color:var(--blue-mid);margin-top:1px">↩ הוחזר עודף ₪${refundFromThis.toLocaleString()}</div>`:''}</div>${multi?`<button onclick="togglePotModalFamily(${ev.id},${fid})" style="background:var(--surface2);border:1px solid var(--border);border-radius:20px;font-size:11px;color:var(--text2);cursor:pointer;padding:3px 8px;font-weight:700;font-family:var(--font)">${isExp?'▲ סגור':'▼ '+pmnts.length+' תשלומים'}</button>`:delBtn(0)}</div>${details}</div>`;}).join('');})()}
    </div>
    ${expRows}
    ${potTransferBtn}
    ${(()=>{const _sTotal=(ev.savingsTotal||(ev.savingsAmt||0)*ev.participants.length);const _sPaid=(ev.savingsPaid||[]).reduce((s,p)=>s+p.amt,0);const _sOwed=Math.round(_sTotal+evSavingsSurplus(ev)-_sPaid);const _sAmt=Math.min(effBal,Math.max(0,_sOwed));return _sAmt>0?`<div class="edit-only" style="padding:10px 16px;border-bottom:1px solid var(--border)"><button onclick="releasePotToSavings(${ev.id},${_sAmt})" style="width:100%;padding:10px;border-radius:var(--r2);border:none;background:var(--green-mid);color:#fff;font-size:13px;font-weight:700;font-family:var(--font);cursor:pointer">💎 העבר לקופת חיסכון (₪${_sAmt.toLocaleString()})</button></div>`:'';})()
    ${!creditorFids.length&&potPayments.length&&potExcess<=0.5?`<div style="padding:10px 16px"><button class="edit-only" onclick="releasePotM(${ev.id})" style="width:100%;padding:10px;border-radius:var(--r2);border:none;background:var(--blue-mid);color:#fff;font-size:13px;font-weight:700;font-family:var(--font);cursor:pointer">✓ סמן כהועבר</button></div>`:''}
    ${doneRows}
    <div style="padding:4px 16px 10px">
      <button onclick="closePotModal()" style="width:100%;padding:10px;border-radius:var(--r2);border:1.5px solid var(--border);background:transparent;color:var(--text2);font-size:13px;font-weight:700;font-family:var(--font);cursor:pointer">סגור</button>
    </div>`;
}
function _potFillAmt(selId,amtId){
  const sel=document.getElementById(selId);const amtEl=document.getElementById(amtId);
  if(!sel||!amtEl)return;
  const o=sel.selectedOptions[0];
  if(o)amtEl.value=o.dataset.max||'';
}
function potManualTransfer(evId,toFund){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  const sel=document.getElementById('potToFid-'+evId);
  const amtEl=document.getElementById('potTrAmt-'+evId);
  const toFid=parseInt(sel?.value);
  const amt=Math.round(parseFloat(amtEl?.value)||0);
  if(!toFid||isNaN(toFid)){showToast('בחר זכאי');return;}
  if(amt<1){showToast('הזן סכום');return;}
  const toFam=getFam(toFid);if(!toFam)return;
  const toName=toFam.name.replace('משפחת','').trim();
  const potTot=evPotTotal(ev);if(potTot<0.5){showToast('אין כסף בקופה');return;}
  const give=Math.min(amt,Math.round(potTot));
  if(!ev.settled)ev.settled=[];
  let rem=give;const newPots=[];
  for(const p of(ev.potPayments||[])){
    if(rem<=0.5){newPots.push(p);continue;}
    const take=Math.min(p.amt,rem);
    if(take>0.5){const fromFam=getFam(p.famId);ev.settled.push({from:fromFam?fromFam.name.replace('משפחת','').trim():'',fromFid:p.famId,to:toName,toFid,amt:Math.round(take),method:'pot'});}
    rem-=take;
    const left=p.amt-take;if(left>0.5)newPots.push({...p,amt:left});
  }
  ev.potPayments=newPots;
  if(toFund){
    const key=String(toFid);
    fund.famBalances[key]=(fund.famBalances[key]||0)+give;
    fund.transactions.push({id:nxtTx++,type:'deposit',famId:toFid,amount:give,desc:'מקופת אירוע · '+ev.name+' → '+toName,date:new Date().toLocaleDateString('he-IL')});
  }
  save();render();
  if(ev.closed){const adjA=evAdjBalance(ev);ev.participants.forEach(fid=>{if(Math.abs(adjA[fid]||0)<=0.5)_sendCloseEvEmailOne(ev,fid);});}
  const newEv=events.find(e=>e.id===evId);
  if(newEv&&evPotTotal(newEv)>0)renderPotModal(newEv);else closePotModal();
  _refreshPotTransferModal(evId);
}
function releasePotToOneM(evId,creditorFid,toFund){
  releasePotToOne(evId,creditorFid,toFund);
  const ev=events.find(e=>e.id===evId);
  if(ev&&evPotTotal(ev)>0)renderPotModal(ev);else closePotModal();
  _refreshPotTransferModal(evId);
}
function releasePotM(evId){
  releasePot(evId);
  closePotModal();
  closePotTransferModal();
}
function releasePotExcessToOne(evId,famId,toFund){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  const excessByFam=calcPotExcessByFamily(ev);
  const exc=excessByFam[famId];if(!exc||exc<0.5)return;
  if(toFund){
    const fam=getFam(famId);if(!fam)return;
    const key=String(famId);
    fund.famBalances[key]=(fund.famBalances[key]||0)+exc;
    fund.transactions.push({id:nxtTx++,type:'deposit',famId,amount:exc,
      desc:'החזר עודף מקופת האירוע · '+ev.name,
      date:new Date().toLocaleDateString('he-IL')});
  }
  // Record excess refund in settled so evPotOrigByFam can reconstruct original deposit
  if(!ev.settled)ev.settled=[];
  const famRef=getFam(famId);
  const fromName=famRef?famRef.name.replace('משפחת','').trim():'';
  ev.settled.push({from:fromName,fromFid:famId,to:toFund?'קופה':'החזר עודף',amt:Math.round(exc),method:'pot-refund'});
  // Trim this family's potPayments to only the amount that was actually distributed to creditors
  const distributed={};
  calcPotTransfers(ev).forEach(t=>{distributed[t.fromFid]=(distributed[t.fromFid]||0)+t.amt;});
  const effAmt=Math.round(distributed[famId]||0);
  ev.potPayments=(ev.potPayments||[]).filter(p=>p.famId!==famId);
  if(effAmt>0.5) ev.potPayments.push({famId,amt:effAmt});
  save();render();
}
function releasePotExcessToOneM(evId,famId,toFund){
  releasePotExcessToOne(evId,famId,toFund);
  const ev=events.find(e=>e.id===evId);
  if(ev&&evPotTotal(ev)>0)renderPotModal(ev);else closePotModal();
  _refreshPotTransferModal(evId);
}
function releasePotCombinedM(evId,creditorFid,toFund){
  releasePotToOne(evId,creditorFid,toFund);
  releasePotExcessToOne(evId,creditorFid,toFund);
  const ev=events.find(e=>e.id===evId);
  if(ev&&evPotTotal(ev)>0)renderPotModal(ev);else closePotModal();
  _refreshPotTransferModal(evId);
}
function deletePotDeposit(evId,famId,localIdx){
  const ev=events.find(e=>e.id===evId);if(!ev||!ev.potPayments)return;
  let count=0;
  const gi=ev.potPayments.findIndex(p=>{
    if(p.famId===famId){if(count===localIdx)return true;count++;}
    return false;
  });
  if(gi<0)return;
  ev.potPayments.splice(gi,1);
  save();render();
  // refresh pot modal if open
  const modal=document.getElementById('potModal');
  if(modal&&modal.style.display==='flex'){
    if(evPotTotal(ev)>0)renderPotModal(ev);else closePotModal();
  }
}
function deletePotExpItem(evId,itemId){
  const ev=events.find(e=>e.id===evId);if(!ev||!ev.potExpItems)return;
  ev.potExpItems=ev.potExpItems.filter(it=>it.id!==itemId);
  save();render();
  const modal=document.getElementById('potModal');
  if(modal&&modal.style.display==='flex'){
    if(evPotTotal(ev)>0)renderPotModal(ev);else closePotModal();
  }
}
// ──────────────────────────────────────────
function openCumPot(evId){
  const ev=events.find(e=>e.id===evId);if(!ev)return;
  cumPotEvId=evId; cumPotFamId=null;
  document.getElementById('cumPotAmt').value='';
  const errEl=document.getElementById('cumPotErr');if(errEl)errEl.style.display='none';
  const picker=document.getElementById('cumPotFamPicker');
  picker.innerHTML=ev.participants.map(fid=>{
    const f=getFam(fid);if(!f)return'';
    return`<button onclick="selectCumPotFam(${fid})" id="cumpotfam-${fid}" style="padding:5px 12px;border-radius:20px;border:1.5px solid var(--border);background:transparent;color:var(--text2);font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer">${esc(f.name.replace('משפחת','').trim())}</button>`;
  }).join('');
  document.getElementById('cumPotOverlay').style.display='flex';
}
function selectCumPotFam(famId){
  cumPotFamId=famId;
  _cumPotFromFund=false;
  const ev=events.find(e=>e.id===cumPotEvId);if(!ev)return;
  ev.participants.forEach(fid=>{
    const btn=document.getElementById('cumpotfam-'+fid);if(!btn)return;
    const cl=col(fid);
    if(fid===famId){btn.style.background=cl.bg;btn.style.color=cl.c;btn.style.borderColor=cl.c;}
    else{btn.style.background='transparent';btn.style.color='var(--text2)';btn.style.borderColor='var(--border)';}
  });
  const fundBal=Math.round(famFundBal(famId));
  const fundLine=document.getElementById('cumPotFundLine');
  const fundText=document.getElementById('cumPotFundText');
  if(fundLine&&fundText){
    if(fundBal>0){
      const ev2=events.find(e=>e.id===cumPotEvId);
      const share=ev2?Math.round(evShares(ev2)[famId]||0):fundBal;
      const suggested=share>0?Math.min(fundBal,share):fundBal;
      const extra=fundBal>suggested?` (יתרה: ₪${fundBal.toLocaleString()})` :'';
      fundText.textContent=`🏦 יועבר מהקופה: ₪${suggested.toLocaleString()}${extra}`;
      fundLine.style.display='flex';
    } else {
      fundLine.style.display='none';
    }
  }
}
function closeCumPot(){
  document.getElementById('cumPotOverlay').style.display='none';
  cumPotEvId=null; cumPotFamId=null; _cumPotFromFund=false;
  const fl=document.getElementById('cumPotFundLine');if(fl)fl.style.display='none';
}
function useFundForCumPot(){
  if(!cumPotFamId)return;
  const fundBal=Math.round(famFundBal(cumPotFamId));
  if(fundBal<=0)return;
  const ev=events.find(e=>e.id===cumPotEvId);
  const share=ev?Math.round(evShares(ev)[cumPotFamId]||0):fundBal;
  const suggested=Math.min(fundBal,share);
  const el=document.getElementById('cumPotAmt');
  if(el)el.value=suggested>0?suggested:fundBal;
  _cumPotFromFund=true;
  const fundText=document.getElementById('cumPotFundText');
  if(fundText)fundText.textContent=`🏦 יועבר מהקופה הראשית: ₪${(suggested>0?suggested:fundBal).toLocaleString()} ✓`;
}
function doDepositToCumPot(){
  const amt=parseFloat(document.getElementById('cumPotAmt').value)||0;
  const errEl=document.getElementById('cumPotErr');
  if(!cumPotFamId||amt<=0){if(errEl)errEl.style.display='block';return;}
  if(errEl)errEl.style.display='none';
  const ev=events.find(e=>e.id===cumPotEvId);if(!ev)return;
  if(!ev.potPayments)ev.potPayments=[];
  const roundAmt=Math.round(amt);
  const savedFamId=cumPotFamId;
  const savedEvId=cumPotEvId;
  const fromFund=_cumPotFromFund;
  if(fromFund){
    const key=String(savedFamId);
    const bal=fund.famBalances[key]||0;
    if(bal<roundAmt){alert('אין מספיק יתרה בקופה הראשית (₪'+Math.round(bal).toLocaleString()+')');return;}
    fund.famBalances[key]=bal-roundAmt;
    fund.transactions.push({id:nxtTx++,type:'payout',famId:savedFamId,amount:roundAmt,
      desc:'העברה לקופת האירוע · '+ev.name,
      date:new Date().toLocaleDateString('he-IL')});
  }
  ev.potPayments.push({famId:savedFamId,amt:roundAmt});
  closeCumPot();
  save();render();
  const _potF=getFam(savedFamId);
  const _potEv=events.find(e=>e.id===savedEvId);
  // If deposit settles the family's balance, skip deposit email — the close email covers it
  const _isSettled=_potEv&&(evAdjBalance(_potEv)[savedFamId]||0)>=-0.5;
  if(!fromFund&&!_isSettled&&_potEv&&_potF&&(_potF.email||_potF.email2)){
    const _potTotal=(_potEv.potPayments||[]).filter(p=>p.famId===savedFamId).reduce((s,p)=>s+p.amt,0);
    const _potShare=Math.round(evShares(_potEv)[savedFamId]||0);
    const _potMsg=`הפקדה של ₪${roundAmt.toLocaleString()} לקופת האירוע "${_potEv.name}" נרשמה.\n\nסה"כ הפקדות שלך לקופה זו: ₪${_potTotal.toLocaleString()}\n\n💓 נכון להיום, החלק שלך לפי ההוצאות הנוכחיות: ₪${_potShare.toLocaleString()}`;
    const _potBody=_eCard([['הפקדה',`<span style="color:#1E88D8;font-weight:700">₪${roundAmt.toLocaleString()}</span>`,false],['סה"כ הפקדות שלך',`₪${_potTotal.toLocaleString()}`,true]])+`<p style="text-align:center;margin:4px 0 0;font-size:14px;color:#555">💓 נכון להיום, החלק שלך לפי ההוצאות הנוכחיות: <strong>₪${_potShare.toLocaleString()}</strong></p>`;
    const _potHtml=_emailWrap(_potBody,_potEv.name,'💰',_ejsUrl()+'#event-'+savedEvId,_potF.name);
    sendEmailNotif([{email:_potF.email,email2:_potF.email2,name:_potF.name.replace('משפחת','').trim()}],'💰 הפקדה לקופת האירוע · ינקלביץ',_potMsg,_potHtml);
  }
}

function applyEditMode(){
  document.body.classList.toggle('edit-mode',editMode);
  const icon=document.getElementById('lockIcon');
  if(icon)icon.textContent=editMode?'🔓':'🔒';
  if(currentShell==='home')renderFamilyHome();
}
function openLockModal(){
  renderLockModal(editMode?'lock':adminPass?'unlock':'set');
  document.getElementById('lockModal').style.display='flex';
}
function closeLockModal(){document.getElementById('lockModal').style.display='none';}
function renderLockModal(mode){
  const el=document.getElementById('lockModalContent');if(!el)return;
  if(mode==='lock'){
    const hasBio=!!localStorage.getItem('biometricCredId');
    el.innerHTML=`<div style="font-size:15px;font-weight:700;margin-bottom:12px;text-align:center">🔓 מצב עריכה פעיל</div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:16px;text-align:center">רוצה לנעול את האפליקציה?</div>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <button onclick="lockApp()" style="flex:1;padding:12px;border-radius:var(--r2);border:none;background:var(--text);color:#fff;font-size:14px;font-weight:700;font-family:var(--font);cursor:pointer">🔒 נעל</button>
        <button onclick="closeLockModal()" style="flex:1;padding:12px;border-radius:var(--r2);border:1.5px solid var(--border);background:transparent;color:var(--text2);font-size:14px;font-weight:700;font-family:var(--font);cursor:pointer">ביטול</button>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:12px">
        <button id="biometricToggleBtn" onclick="${hasBio?'disableBiometric':'enableBiometric'}()" style="width:100%;padding:10px;border-radius:var(--r2);border:1.5px solid var(--border);background:transparent;color:var(--text2);font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer">${hasBio?'🗑️ בטל טביעת אצבע':'👆 הפעל טביעת אצבע'}</button>
        <div id="biometricStatus" style="font-size:11px;color:var(--green);text-align:center;margin-top:5px">${hasBio?'✓ טביעת אצבע פעילה':''}</div>
      </div>`;
  } else if(mode==='set'){
    el.innerHTML=`<div style="font-size:15px;font-weight:700;margin-bottom:8px;text-align:center">🔐 הגדר סיסמה</div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:14px;text-align:center">רק מי שיש לו סיסמה יוכל לשנות נתונים. כולם יוכלו לראות הכל.</div>
      <input id="newPassInp" type="password" placeholder="סיסמה חדשה" style="width:100%;border:1.5px solid var(--border);border-radius:var(--r2);padding:10px 12px;font-size:15px;font-family:var(--font);background:var(--bg);color:var(--text);margin-bottom:8px;box-sizing:border-box;direction:ltr;text-align:center">
      <input id="newPassConf" type="password" placeholder="אשר סיסמה" style="width:100%;border:1.5px solid var(--border);border-radius:var(--r2);padding:10px 12px;font-size:15px;font-family:var(--font);background:var(--bg);color:var(--text);margin-bottom:8px;box-sizing:border-box;direction:ltr;text-align:center" onkeydown="if(event.key==='Enter')setAdminPass()">
      <div id="passSetErr" style="font-size:12px;color:var(--red-mid);margin-bottom:8px;display:none;text-align:center"></div>
      <div style="display:flex;gap:8px">
        <button onclick="setAdminPass()" style="flex:1;padding:12px;border-radius:var(--r2);border:none;background:var(--text);color:#fff;font-size:14px;font-weight:700;font-family:var(--font);cursor:pointer">✓ הגדר</button>
        <button onclick="closeLockModal()" style="flex:1;padding:12px;border-radius:var(--r2);border:1.5px solid var(--border);background:transparent;color:var(--text2);font-size:14px;font-weight:700;font-family:var(--font);cursor:pointer">ביטול</button>
      </div>`;
    setTimeout(()=>{const i=document.getElementById('newPassInp');if(i)i.focus();},50);
  } else {
    const hasBio=!!localStorage.getItem('biometricCredId');
    el.innerHTML=`<div style="font-size:15px;font-weight:700;margin-bottom:14px;text-align:center">🔒 הזן סיסמה</div>
      ${hasBio?`<button id="biometricBtn" onclick="doBiometricUnlock()" style="width:100%;padding:14px;border-radius:var(--r2);border:none;background:var(--blue-mid);color:#fff;font-size:15px;font-weight:700;font-family:var(--font);cursor:pointer;margin-bottom:10px">👆 כניסה עם טביעת אצבע</button><div style="text-align:center;font-size:11px;color:var(--text2);margin-bottom:10px">— או עם סיסמה —</div>`:''}
      <input id="unlockInp" type="password" placeholder="סיסמה" style="width:100%;border:1.5px solid var(--border);border-radius:var(--r2);padding:10px 12px;font-size:15px;font-family:var(--font);background:var(--bg);color:var(--text);margin-bottom:8px;box-sizing:border-box;direction:ltr;text-align:center" onkeydown="if(event.key==='Enter')submitUnlock()">
      <div id="passErr" style="font-size:12px;color:var(--red-mid);margin-bottom:8px;display:none;text-align:center">סיסמה שגויה ❌</div>
      <div style="display:flex;gap:8px">
        <button onclick="submitUnlock()" style="flex:1;padding:12px;border-radius:var(--r2);border:none;background:var(--text);color:#fff;font-size:14px;font-weight:700;font-family:var(--font);cursor:pointer">כניסה</button>
        <button onclick="closeLockModal()" style="flex:1;padding:12px;border-radius:var(--r2);border:1.5px solid var(--border);background:transparent;color:var(--text2);font-size:14px;font-weight:700;font-family:var(--font);cursor:pointer">ביטול</button>
      </div>`;
    if(hasBio) setTimeout(()=>doBiometricUnlock(),300);
    else setTimeout(()=>{const i=document.getElementById('unlockInp');if(i)i.focus();},50);
  }
}
function setAdminPass(){
  const p1=(document.getElementById('newPassInp')||{}).value||'';
  const p2=(document.getElementById('newPassConf')||{}).value||'';
  const err=document.getElementById('passSetErr');
  if(!p1){if(err){err.textContent='נא להזין סיסמה';err.style.display='block';}return;}
  if(p1!==p2){if(err){err.textContent='הסיסמאות אינן תואמות';err.style.display='block';}return;}
  adminPass=p1;editMode=true;
  // editMode is in-memory only — resets on each page load
  applyEditMode();save();closeLockModal();
}
function submitUnlock(){
  const val=(document.getElementById('unlockInp')||{}).value||'';
  if(val===adminPass){
    editMode=true;// editMode is in-memory only — resets on each page load
    applyEditMode();closeLockModal();
  } else {
    const err=document.getElementById('passErr');if(err)err.style.display='block';
    const inp=document.getElementById('unlockInp');if(inp){inp.value='';inp.focus();}
  }
}
function lockApp(){
  editMode=false;
  applyEditMode();closeLockModal();
}
function _ab2b64(buf){return btoa(String.fromCharCode(...new Uint8Array(buf)));}
function _b642ab(b64){const bin=atob(b64);const arr=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);return arr.buffer;}
async function registerBiometric(){
  try{
    const cred=await navigator.credentials.create({publicKey:{
      challenge:crypto.getRandomValues(new Uint8Array(32)),
      rp:{name:'ינקלביץ',id:location.hostname},
      user:{id:crypto.getRandomValues(new Uint8Array(16)),name:'admin',displayName:'מנהל'},
      pubKeyCredParams:[{alg:-7,type:'public-key'},{alg:-257,type:'public-key'}],
      authenticatorSelection:{authenticatorAttachment:'platform',userVerification:'required'},
      timeout:60000
    }});
    localStorage.setItem('biometricCredId',_ab2b64(cred.rawId));
    return true;
  }catch(e){return false;}
}
async function enableBiometric(){
  if(!window.PublicKeyCredential){alert('הדפדפן שלך לא תומך באימות ביומטרי');return;}
  const btn=document.getElementById('biometricToggleBtn');
  if(btn){btn.disabled=true;btn.textContent='⏳...';}
  const ok=await registerBiometric();
  if(btn){btn.disabled=false;}
  if(ok){
    if(btn){btn.textContent='🗑️ בטל טביעת אצבע';btn.onclick=disableBiometric;}
    const st=document.getElementById('biometricStatus');if(st){st.textContent='✓ טביעת אצבע פעילה';st.style.color='var(--green)';}
  } else {
    if(btn){btn.textContent='👆 הפעל טביעת אצבע';btn.onclick=enableBiometric;}
  }
}
function disableBiometric(){
  localStorage.removeItem('biometricCredId');
  const btn=document.getElementById('biometricToggleBtn');
  if(btn){btn.textContent='👆 הפעל טביעת אצבע';btn.onclick=enableBiometric;}
  const st=document.getElementById('biometricStatus');if(st)st.textContent='';
}
async function tryBiometric(){
  const b64=localStorage.getItem('biometricCredId');
  if(!b64||!window.PublicKeyCredential)return false;
  try{
    await navigator.credentials.get({publicKey:{
      challenge:crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials:[{id:_b642ab(b64),type:'public-key'}],
      userVerification:'required',
      timeout:60000
    }});
    return true;
  }catch(e){return false;}
}
async function doBiometricUnlock(){
  const btn=document.getElementById('biometricBtn');
  if(btn){btn.disabled=true;btn.textContent='⏳ מאמת...';}
  const ok=await tryBiometric();
  if(ok){editMode=true;applyEditMode();closeLockModal();}
  else if(btn){btn.disabled=false;btn.textContent='👆 כניסה עם טביעת אצבע';}
}
async function autoUnlockBiometric(){
  if(!adminPass||editMode||!localStorage.getItem('biometricCredId'))return;
  const ok=await tryBiometric();
  if(ok){editMode=true;applyEditMode();}
}
const _CURMAP={'₪':'ILS','$':'USD','€':'EUR','£':'GBP'};
let _rateCache={};
async function _getRate(sym){
  if(!sym||sym==='₪')return 1;
  const today=new Date().toISOString().slice(0,10);
  if(_rateCache[sym]?.date===today)return _rateCache[sym].rate;
  try{
    const code=_CURMAP[sym]||sym;
    const r=await fetch('https://open.er-api.com/v6/latest/'+code);
    const d=await r.json();
    const rate=d.rates?.ILS;
    if(rate)_rateCache[sym]={rate,date:today};
    return rate||null;
  }catch(e){return null;}
}
async function _updateCurHint(amtId,hintId,curId){
  const amt=parseFloat(document.getElementById(amtId)?.value)||0;
  const sym=document.getElementById(curId)?.value||'₪';
  const hint=document.getElementById(hintId);
  if(!hint)return;
  if(!amt||sym==='₪'){hint.textContent='';return;}
  hint.textContent='מחשב שער...';
  const rate=await _getRate(sym);
  if(!rate){hint.textContent='לא ניתן לקבל שער';return;}
  hint.textContent=amt+sym+' = ₪'+Math.round(amt*rate).toLocaleString()+' (שער '+rate.toFixed(3)+')';
}
async function _toILS(amtId,curId){
  const amt=parseFloat(document.getElementById(amtId)?.value)||0;
  const sym=document.getElementById(curId)?.value||'₪';
  if(sym==='₪'||!amt)return amt;
  const rate=await _getRate(sym);
  return rate?Math.round(amt*rate):amt;
}
async function _updateCustomTotal(){
  const sym=document.getElementById('customCur')?.value||'₪';
  const rate=sym==='₪'?1:((await _getRate(sym))||1);
  let total=0;
  families.forEach(f=>{const inp=document.getElementById('fexp-'+f.id);if(inp)total+=Math.round((parseFloat(inp.value)||0)*rate);});
  const el=document.getElementById('formTotalCost');
  if(el)el.textContent='₪'+total.toLocaleString();
  updateExpensePickSummary();
}

applyEditMode();
load().then(async()=>{await autoUnlockBiometric();if(window.location.hash)handleHash();startRealtimeSync();renderNotifBtn();if(_notifOk()){checkBirthdayNotifs();registerFCMToken();}});
loadEjsSettings();
loadPaymentSettings();
window.addEventListener('hashchange',handleHash);

// Swipe between tabs
(function(){
  const TABS=['home','events','archive','fund'];
  const NAV={home:'nb-home',events:'nb-events',fund:'nb-fund'};
  const OVERLAYS=['newFormOverlay','famPickOverlay','childOverrideOverlay','expenseOverlay','famEditOverlay','depositOverlay','goalFormOverlay','goalDepositOverlay','addExpItemOverlay','cumPotOverlay'];
  let sx=0,sy=0,st=0,hBlocked=false;
  function _isHScroll(el){while(el&&el!==document.body){const ox=getComputedStyle(el).overflowX;if((ox==='auto'||ox==='scroll')&&el.scrollWidth>el.clientWidth+2)return true;el=el.parentElement;}return false;}
  document.addEventListener('touchstart',e=>{
    if(e.touches.length!==1)return;
    sx=e.touches[0].clientX;sy=e.touches[0].clientY;st=Date.now();
    hBlocked=_isHScroll(e.target);
  },{passive:true});
  document.addEventListener('touchend',e=>{
    if(e.changedTouches.length!==1)return;
    const dx=e.changedTouches[0].clientX-sx;
    const dy=e.changedTouches[0].clientY-sy;
    if(Date.now()-st>600||Math.abs(dx)<50||Math.abs(dx)<Math.abs(dy)*1.3)return;
    if(hBlocked&&Math.abs(dx)>Math.abs(dy))return;
    if(OVERLAYS.some(id=>{const o=document.getElementById(id);return o&&o.style.display==='flex';}))return;
    if(document.getElementById('chatSheet')?.classList.contains('open'))return;
    // Home shell ↔ pay shell
    if(document.body.classList.contains('at-home')){
      if(dx>0){switchShell('pay');goTab('home',document.getElementById('nb-home'));}
      return;
    }
    // Swipe between tabs
    const cur=TABS.findIndex(t=>document.getElementById('view-'+t)?.classList.contains('active'));
    if(cur<0)return;
    // swipe right → next tab (higher index), swipe left → previous tab (lower index)
    const next=dx>0?Math.min(cur+1,TABS.length-1):Math.max(cur-1,0);
    if(next===cur){
      // At left boundary of home tab → back to home shell
      if(dx<0&&cur===0)switchShell('home');
      return;
    }
    goTab(TABS[next],document.getElementById(NAV[TABS[next]]),false,dx<0?'left':'right');
  },{passive:true});
})();

// ──────────────────────────────────────────────────────────────────────────


if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
}
history.scrollRestoration = 'manual';
window.addEventListener('load', () => {
  const sh = document.getElementById('shell-home');
  if (sh) sh.scrollTop = 0;
  window.scrollTo(0, 0);
});
