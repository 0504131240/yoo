// ── Family poker ("פוקר משפחתי") ───────────────────────────────────────────
// Texas Hold'em between the families, with play chips (no real money).
// Self-contained like contest.js: it builds its own overlay (#pokerOverlay)
// on first open, so index.html only needs the script tag + a tile calling
// openPokerOverlay().
//
// Storage (everything under appData/*, which the Firestore rules already
// open to the client):
//   appData/pokerLobby   { bal:{famId:chips}, tables:{id:{host,players,invited,created,status}},
//                          invites:{famId:{tableId:{from,ts}}},
//                          loans:{id:{id,by,to,amt,status,ts,done}} }
//   appData/poker_<id>   one table: seats, the hand in progress and a short log
// Every family starts with START chips in its bank. Sitting at a table moves
// a buy-in from the bank to the table; leaving moves the stack back.
// All game moves run in Firestore transactions, so two phones pressing at
// the same moment can't break the hand.
//
// Inviting a family sends a push (api/notify.js onlyFamIds) and, while the
// app is open, a banner on the home page. A family that ran out of chips can
// ask another family for a loan (same push + banner); the lender approves or
// declines, and the borrower pays it back from its bank later.
// "איך משחקים?" opens a short animated video (with Hebrew narration when the
// device has a Hebrew voice) that teaches the game.
(function(){
'use strict';

const FS_URL='https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js';
const START=10000;          // every family's opening bank
const SB=50,BB=100;         // blinds
const MAX_SEATS=6;
const TURN_SECS=60;         // after this, the others may fold a player who doesn't answer
const NEXT_HAND_SECS=7;     // pause on the result before the next deal
const BUYINS=[1000,2000,5000];
const LOAN_AMTS=[1000,2000,5000];
const LOAN_KEEP=7*864e5;    // finished loans stay listed this long
const INVITE_TTL=6*3600e3;  // invites older than this are ignored

const S={fid:null,view:'lobby',tid:null,L:{},T:null,unsubL:null,unsubT:null,fs:null,tick:null,raise:null,busy:false,modal:null,bannerShown:{}};

// ── small helpers ──────────────────────────────────────────────────────────
const $=id=>document.getElementById(id);
function E(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function lsGet(k,def){try{const v=localStorage.getItem(k);return v==null?def:JSON.parse(v);}catch(e){return def;}}
function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}}
function toast(m,ms){if(typeof showToast==='function')showToast(m,ms);else console.log(m);}
function isAdmin(){try{return typeof editMode!=='undefined'&&!!editMode;}catch(e){return false;}}
function allFams(){try{return typeof families!=='undefined'?families:[];}catch(e){return [];}}
function fam(id){return allFams().find(f=>f.id===id)||null;}
function short(id){const f=fam(id);return f?String(f.name||'').replace('משפחת','').trim():'?';}
function ava(id,size){
  const f=fam(id);
  if(f&&typeof famAva==='function')return famAva(f,size);
  return `<span class="pk-ava0" style="width:${size}px;height:${size}px">${E(short(id).slice(0,1))}</span>`;
}
function fmt(n){return Math.round(n||0).toLocaleString('he-IL');}
function now(){return Date.now();}
function myDeviceFam(){try{return typeof _myFamId==='function'?_myFamId():null;}catch(e){return null;}}
function bal(L,fid){const b=(L.bal||{})[fid];return b==null?START:b;}
function rid(){return now().toString(36)+Math.random().toString(36).slice(2,6);}

// ── cards ──────────────────────────────────────────────────────────────────
const RANKS='23456789TJQKA';
const SUIT_SYM={s:'♠',h:'♥',d:'♦',c:'♣'};
function newDeck(){
  const d=[];for(const r of RANKS)for(const s of 'shdc')d.push(r+s);
  const rnd=new Uint32Array(d.length);
  (window.crypto||{getRandomValues:a=>{for(let i=0;i<a.length;i++)a[i]=Math.random()*4294967296>>>0;return a;}}).getRandomValues(rnd);
  for(let i=d.length-1;i>0;i--){const j=rnd[i]%(i+1);[d[i],d[j]]=[d[j],d[i]];}
  return d;
}
const rv=c=>RANKS.indexOf(c[0])+2;
function cardHtml(c,cls){
  if(!c)return `<span class="pk-card pk-back ${cls||''}"></span>`;
  const red=c[1]==='h'||c[1]==='d';
  const r=c[0]==='T'?'10':c[0];
  return `<span class="pk-card ${red?'red':''} ${cls||''}"><b>${r}</b><i>${SUIT_SYM[c[1]]}</i></span>`;
}

// ── hand strength ──────────────────────────────────────────────────────────
const HAND_NAMES=['קלף גבוה','זוג','שני זוגות','שלישייה','רצף','צבע','פול האוס','רביעייה','רצף בצבע','רויאל פלאש'];
function eval5(cs){
  const v=cs.map(rv).sort((a,b)=>b-a);
  const flush=cs.every(c=>c[1]===cs[0][1]);
  const uniq=[...new Set(v)];
  let straightHi=0;
  if(uniq.length===5){
    if(v[0]-v[4]===4)straightHi=v[0];
    else if(v[0]===14&&v[1]===5)straightHi=5; // A-2-3-4-5
  }
  const cnt={};v.forEach(x=>cnt[x]=(cnt[x]||0)+1);
  const groups=Object.keys(cnt).map(Number).sort((a,b)=>cnt[b]-cnt[a]||b-a);
  const shape=groups.map(g=>cnt[g]).join('');
  let cat,tie;
  if(straightHi&&flush){cat=8;tie=[straightHi];}
  else if(shape==='41'){cat=7;tie=groups;}
  else if(shape==='32'){cat=6;tie=groups;}
  else if(flush){cat=5;tie=v;}
  else if(straightHi){cat=4;tie=[straightHi];}
  else if(shape==='311'){cat=3;tie=groups;}
  else if(shape==='221'){cat=2;tie=groups;}
  else if(shape==='2111'){cat=1;tie=groups;}
  else{cat=0;tie=v;}
  let score=cat;for(let i=0;i<5;i++)score=score*15+(tie[i]||0);
  return {score,cat:cat===8&&straightHi===14?9:cat};
}
function best7(cards){
  let best=null;const n=cards.length;
  for(let a=0;a<n;a++)for(let b=a+1;b<n;b++){
    const five=cards.filter((_,i)=>i!==a&&i!==b);
    if(five.length!==5)continue;
    const r=eval5(five);if(!best||r.score>best.score)best=r;
  }
  if(!best&&n===5)best=eval5(cards);
  return best;
}

// ── the game engine (pure functions on the table object) ──────────────────
// T.seats: [{fid,stack}] in seat order. T.hand while a hand runs:
//   {n,dealer,deck,board,street,order,turn,turnAt,cur,minRaise,p:{fid:{hole,bet,total,folded,allin,acted}},result}
function seatOf(T,fid){return (T.seats||[]).find(s=>s.fid===fid)||null;}
function logPush(T,txt){T.log=(T.log||[]).concat([{t:now(),txt}]).slice(-30);}
function nextIdx(order,i){return (i+1)%order.length;}

function canStart(T){
  if(T.hand&&T.hand.street!=='done')return false;
  return (T.seats||[]).filter(s=>s.stack>0).length>=2;
}
function startHand(T){
  const live=(T.seats||[]).filter(s=>s.stack>0).map(s=>s.fid);
  if(live.length<2)return false;
  const prev=T.hand;
  // Dealer button moves one seat on from the last hand's dealer.
  let dealer=live[0];
  if(prev&&prev.dealerFid!=null){
    const seatsOrder=T.seats.map(s=>s.fid);
    let i=seatsOrder.indexOf(prev.dealerFid);
    for(let k=0;k<seatsOrder.length;k++){i=(i+1)%seatsOrder.length;if(live.includes(seatsOrder[i])){dealer=seatsOrder[i];break;}}
  }
  // order = live players starting from the dealer
  const di=live.indexOf(dealer);
  const order=live.slice(di).concat(live.slice(0,di));
  const deck=newDeck();
  const p={};
  order.forEach(fid=>{p[fid]={hole:[deck.pop(),deck.pop()],bet:0,total:0,folded:false,allin:false,acted:false};});
  const H={n:((prev&&prev.n)||0)+1,dealerFid:dealer,deck,board:[],street:'pre',order,p,cur:0,minRaise:BB,turn:null,turnAt:now(),result:null};
  T.hand=H;
  const heads=order.length===2;
  const sbF=heads?order[0]:order[1];
  const bbF=heads?order[1]:order[2%order.length];
  post(T,sbF,SB);post(T,bbF,BB);
  H.cur=BB;
  H.sbFid=sbF;H.bbFid=bbF;
  // first to act preflop: the one after the big blind
  const first=order[nextIdx(order,order.indexOf(bbF))];
  H.turn=findActor(H,order.indexOf(first));
  logPush(T,`יד #${H.n} · חלוקה: ${short(dealer)} 🔘`);
  if(H.turn==null)advanceStreet(T); // everyone all-in from the blinds
  return true;
}
function post(T,fid,amt){
  const s=seatOf(T,fid),pp=T.hand.p[fid];
  const a=Math.min(amt,s.stack);
  s.stack-=a;pp.bet+=a;pp.total+=a;
  if(s.stack===0)pp.allin=true;
}
// First player from order index i (inclusive) who still has to act.
function findActor(H,i){
  const o=H.order;
  for(let k=0;k<o.length;k++){
    const fid=o[(i+k)%o.length],pp=H.p[fid];
    if(pp.folded||pp.allin)continue;
    if(!pp.acted||pp.bet<H.cur)return fid;
  }
  return null;
}
function activeFids(H){return H.order.filter(f=>!H.p[f].folded);}

// type: fold|check|call|raise (amount = total bet this street)|allin
function act(T,fid,type,amount){
  const H=T.hand;if(!H||H.street==='done')throw new Error('אין יד פעילה');
  const pp=H.p[fid];if(!pp)throw new Error('אתם לא ביד הזאת');
  const s=seatOf(T,fid);
  if(type==='fold'){
    if(pp.folded)return;
    pp.folded=true;pp.acted=true;
    logPush(T,`${short(fid)} קיפלו`);
    if(H.turn===fid)afterAction(T,fid);else if(activeFids(H).length===1)finishFold(T);
    return;
  }
  if(H.turn!==fid)throw new Error('זה לא התור שלכם');
  const toCall=H.cur-pp.bet;
  if(type==='allin'){amount=pp.bet+s.stack;type=amount>H.cur?'raise':'call';}
  if(type==='check'){
    if(toCall>0)throw new Error('אי אפשר צ׳ק — צריך להשוות');
    logPush(T,`${short(fid)} צ׳ק`);
  }else if(type==='call'){
    const a=Math.min(toCall,s.stack);
    s.stack-=a;pp.bet+=a;pp.total+=a;if(s.stack===0)pp.allin=true;
    logPush(T,`${short(fid)} השוו ${fmt(a)}${pp.allin?' (אול-אין)':''}`);
  }else if(type==='raise'){
    amount=Math.floor(amount);
    const max=pp.bet+s.stack;
    if(amount>max)amount=max;
    const isAllin=amount===max;
    if(amount<=H.cur)throw new Error('ההעלאה קטנה מדי');
    if(amount-H.cur<H.minRaise&&!isAllin)throw new Error('העלאה מינימלית: '+fmt(H.cur+H.minRaise));
    const a=amount-pp.bet;
    s.stack-=a;pp.bet+=a;pp.total+=a;if(s.stack===0)pp.allin=true;
    if(amount-H.cur>=H.minRaise)H.minRaise=amount-H.cur;
    H.cur=amount;
    H.order.forEach(f=>{if(f!==fid&&!H.p[f].folded&&!H.p[f].allin)H.p[f].acted=false;});
    logPush(T,`${short(fid)} ${pp.allin?'אול-אין':'העלו'} ל-${fmt(amount)}`);
  }else throw new Error('פעולה לא מוכרת');
  pp.acted=true;
  afterAction(T,fid);
}
function afterAction(T,fid){
  const H=T.hand;
  if(activeFids(H).length===1){finishFold(T);return;}
  const nxt=findActor(H,nextIdx(H.order,H.order.indexOf(fid)));
  // Only one player left who can still bet, and they already match: no more betting.
  const canBet=H.order.filter(f=>!H.p[f].folded&&!H.p[f].allin);
  if(nxt==null||(canBet.length===1&&nxt===canBet[0]&&H.p[nxt].bet>=H.cur&&H.p[nxt].acted)){advanceStreet(T);return;}
  H.turn=nxt;H.turnAt=now();
}
function advanceStreet(T){
  const H=T.hand;
  for(;;){
    H.order.forEach(f=>{H.p[f].bet=0;H.p[f].acted=false;});
    H.cur=0;H.minRaise=BB;
    if(H.street==='river'){showdown(T);return;}
    if(H.street==='pre'){H.board.push(H.deck.pop(),H.deck.pop(),H.deck.pop());H.street='flop';}
    else if(H.street==='flop'){H.board.push(H.deck.pop());H.street='turn';}
    else if(H.street==='turn'){H.board.push(H.deck.pop());H.street='river';}
    const canBet=H.order.filter(f=>!H.p[f].folded&&!H.p[f].allin);
    if(canBet.length>=2){
      // after the flop the first to act is the first live player after the dealer
      H.turn=findActor(H,1%H.order.length);
      if(H.turn==null)H.turn=findActor(H,0);
      H.turnAt=now();
      return;
    }
    // nobody left to bet against — deal the rest of the board
  }
}
function pot(H){return H.order.reduce((a,f)=>a+H.p[f].total,0);}
function finishFold(T){
  const H=T.hand;const w=activeFids(H)[0];
  const amt=pot(H);
  seatOf(T,w).stack+=amt;
  H.result={winners:[{fid:w,amt}],shown:{},fold:true};
  H.street='done';H.turn=null;H.doneAt=now();
  logPush(T,`🏆 ${short(w)} לקחו ${fmt(amt)}`);
}
function showdown(T){
  const H=T.hand;
  const live=activeFids(H);
  const strength={};
  live.forEach(f=>{strength[f]=best7(H.p[f].hole.concat(H.board));});
  // side pots, from the distinct amounts each player put in
  const levels=[...new Set(H.order.map(f=>H.p[f].total).filter(x=>x>0))].sort((a,b)=>a-b);
  const won={};let prev=0,carry=0,lastWin=null;
  levels.forEach(lv=>{
    let amt=carry;carry=0;
    H.order.forEach(f=>{const t=H.p[f].total;amt+=Math.max(0,Math.min(t,lv)-prev);});
    const elig=live.filter(f=>H.p[f].total>=lv);
    prev=lv;
    if(!elig.length){carry=amt;return;}
    const top=Math.max(...elig.map(f=>strength[f].score));
    const ws=elig.filter(f=>strength[f].score===top);
    // odd chips go to the first winner after the dealer
    const each=Math.floor(amt/ws.length);let rem=amt-each*ws.length;
    H.order.filter(f=>ws.includes(f)).forEach(f=>{won[f]=(won[f]||0)+each+(rem>0?1:0);if(rem>0)rem--;});
    lastWin=ws;
  });
  if(carry&&lastWin)lastWin.forEach((f,i)=>{won[f]=(won[f]||0)+(i===0?carry:0);});
  Object.keys(won).forEach(f=>{seatOf(T,+f).stack+=won[f];});
  const shown={};live.forEach(f=>{shown[f]={hole:H.p[f].hole,cat:strength[f].cat};});
  H.result={winners:Object.keys(won).map(f=>({fid:+f,amt:won[f],cat:strength[f].cat})),shown,fold:false};
  H.street='done';H.turn=null;H.doneAt=now();
  H.result.winners.forEach(w=>logPush(T,`🏆 ${short(w.fid)} לקחו ${fmt(w.amt)} עם ${HAND_NAMES[w.cat]}`));
}

// ── Firestore ──────────────────────────────────────────────────────────────
async function fsCtx(){
  if(S.fs)return S.fs;
  if(window.POKER_FAKE_FS)return S.fs=window.POKER_FAKE_FS;
  const fb=await fbInit();const mod=await import(FS_URL);
  return S.fs={db:fb.db,doc:fb.doc,onSnapshot:fb.onSnapshot,runTransaction:mod.runTransaction,deleteField:mod.deleteField};
}
const lobbyRef=fs=>fs.doc(fs.db,'appData','pokerLobby');
const tableRef=(fs,id)=>fs.doc(fs.db,'appData','poker_'+id);
// Firestore can't hold undefined; JSON round-trip also drops it.
const clean=o=>JSON.parse(JSON.stringify(o));
function lobbyRow(T){return {host:T.host,players:T.seats.map(s=>s.fid),invited:T.invited||[],created:T.created,status:T.status,stake:T.seats.reduce((a,s)=>a+s.stack,0),stacks:Object.fromEntries(T.seats.map(s=>[s.fid,s.stack]))};}

// Runs fn(L,T) inside a transaction; fn mutates the copies; both are written back.
async function txn(tid,fn){
  if(S.busy)return false;
  S.busy=true;
  try{
    const fs=await fsCtx();
    await fs.runTransaction(fs.db,async tx=>{
      const ls=await tx.get(lobbyRef(fs));
      const L=ls.exists()?clean(ls.data()):{};
      let T=null;
      if(tid){const ts=await tx.get(tableRef(fs,tid));T=ts.exists()?clean(ts.data()):null;}
      const r=fn(L,T);
      const outT=(r&&r.T)||T;
      if(outT){
        L.tables=L.tables||{};
        if(outT.status==='closed')delete L.tables[outT.id];else L.tables[outT.id]=lobbyRow(outT);
        tx.set(tableRef(fs,outT.id),clean(outT));
      }
      tx.set(lobbyRef(fs),clean(L));
    });
    return true;
  }catch(e){
    console.warn('poker:',e);
    toast('⚠️ '+(e&&e.message&&/[֐-׿]/.test(e.message)?e.message:'הפעולה נכשלה — בדקו את החיבור'),3500);
    return false;
  }finally{S.busy=false;render();}
}

function subscribeLobby(){
  if(S.unsubL)return;
  fsCtx().then(fs=>{
    if(S.unsubL)return;
    S.unsubL=fs.onSnapshot(lobbyRef(fs),snap=>{S.L=snap.exists()?snap.data():{};render();homeUpdate();},e=>console.warn('poker lobby sync:',e));
  }).catch(e=>console.warn('poker:',e));
}
function subscribeTable(tid){
  if(S.unsubT){S.unsubT();S.unsubT=null;}
  S.T=null;
  if(!tid)return;
  fsCtx().then(fs=>{
    S.unsubT=fs.onSnapshot(tableRef(fs,tid),snap=>{
      if(S.tid!==tid)return;
      S.T=snap.exists()?snap.data():null;
      if(S.T&&S.T.status==='closed'){S.view='lobby';S.tid=null;toast('השולחן נסגר');}
      render();
    },e=>console.warn('poker table sync:',e));
  });
}

// ── push ───────────────────────────────────────────────────────────────────
function pushTo(fids,title,body){
  if(!fids.length)return;
  let pass='';try{pass=typeof adminPass!=='undefined'?adminPass:'';}catch(e){}
  if(window.POKER_FAKE_FS){console.log('poker push →',fids,title,body);return;}
  fetch('/api/notify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    adminPass:pass,title,body,onlyFamIds:fids,relatedFamIds:fids,kind:'poker',noPhone:true,linkHash:'poker'
  })}).catch(()=>{});
}
function sendInvitePush(fids){
  pushTo(fids,'🃏 הזמנה לפוקר',`משפחת ${short(S.fid)} מזמינה אתכם לשולחן פוקר — לחצו כדי להצטרף`);
}

// ── actions ────────────────────────────────────────────────────────────────
function myInvites(L){
  const inv=((L.invites||{})[S.fid])||{};
  return Object.keys(inv).filter(tid=>{
    const t=(L.tables||{})[tid];
    return t&&t.status==='open'&&now()-inv[tid].ts<INVITE_TTL&&!(t.players||[]).includes(S.fid);
  }).map(tid=>({tid,from:inv[tid].from,ts:inv[tid].ts}));
}
async function createTable(invitees,buyIn){
  const id=rid();
  const ok=await txn(null,L=>{
    const b=bal(L,S.fid);
    if(buyIn>b)throw new Error('אין מספיק צ׳יפים בקופה');
    L.bal=L.bal||{};L.bal[S.fid]=b-buyIn;
    L.invites=L.invites||{};
    invitees.forEach(f=>{L.invites[f]=L.invites[f]||{};L.invites[f][id]={from:S.fid,ts:now()};});
    const T={id,host:S.fid,created:now(),status:'open',seats:[{fid:S.fid,stack:buyIn}],invited:invitees,hand:null,log:[]};
    logPush(T,`${short(S.fid)} פתחו שולחן עם ${fmt(buyIn)}`);
    return {T};
  });
  if(ok){sendInvitePush(invitees,id);openTable(id);if(invitees.length)toast('📨 נשלחה הזמנה ל'+invitees.map(short).join(', '));}
}
async function inviteMore(invitees){
  const tid=S.tid;
  const ok=await txn(tid,(L,T)=>{
    if(!T)throw new Error('השולחן לא קיים');
    T.invited=[...new Set((T.invited||[]).concat(invitees))];
    L.invites=L.invites||{};
    invitees.forEach(f=>{L.invites[f]=L.invites[f]||{};L.invites[f][tid]={from:S.fid,ts:now()};});
    logPush(T,`${short(S.fid)} הזמינו את ${invitees.map(short).join(', ')}`);
  });
  if(ok){sendInvitePush(invitees,tid);toast('📨 נשלחה הזמנה');}
}
async function joinTable(tid,buyIn){
  const ok=await txn(tid,(L,T)=>{
    if(!T||T.status!=='open')throw new Error('השולחן כבר לא פתוח');
    if(seatOf(T,S.fid))return;
    if(T.seats.length>=MAX_SEATS)throw new Error('השולחן מלא');
    const b=bal(L,S.fid);
    if(buyIn>b)throw new Error('אין מספיק צ׳יפים בקופה');
    L.bal=L.bal||{};L.bal[S.fid]=b-buyIn;
    T.seats.push({fid:S.fid,stack:buyIn});
    if(L.invites&&L.invites[S.fid])delete L.invites[S.fid][tid];
    logPush(T,`${short(S.fid)} הצטרפו עם ${fmt(buyIn)}`);
  });
  if(ok)openTable(tid);
}
async function rebuy(amount){
  await txn(S.tid,(L,T)=>{
    const s=seatOf(T,S.fid);if(!s)throw new Error('אתם לא יושבים בשולחן');
    const H=T.hand;
    if(H&&H.street!=='done'&&H.p[S.fid]&&!H.p[S.fid].folded)throw new Error('אפשר להוסיף צ׳יפים רק בין ידיים');
    const b=bal(L,S.fid);if(amount>b)throw new Error('אין מספיק צ׳יפים בקופה');
    L.bal=L.bal||{};L.bal[S.fid]=b-amount;s.stack+=amount;
    logPush(T,`${short(S.fid)} הוסיפו ${fmt(amount)} צ׳יפים`);
  });
}
async function leaveTable(){
  if(!confirm('לקום מהשולחן? הצ׳יפים שנשארו לכם יחזרו לקופה המשפחתית.'))return;
  const tid=S.tid;
  const ok=await txn(tid,(L,T)=>{
    if(!T)return;
    const s=seatOf(T,S.fid);if(!s)return;
    const H=T.hand;
    if(H&&H.street!=='done'&&H.p[S.fid]&&!H.p[S.fid].folded)act(T,S.fid,'fold');
    L.bal=L.bal||{};L.bal[S.fid]=bal(L,S.fid)+s.stack;
    T.seats=T.seats.filter(x=>x.fid!==S.fid);
    logPush(T,`${short(S.fid)} קמו מהשולחן`);
    if(!T.seats.length)T.status='closed';
    else if(T.host===S.fid)T.host=T.seats[0].fid;
    // a running hand can't continue with one player — let them take the pot
    if(T.hand&&T.hand.street!=='done'&&activeFids(T.hand).length===1)finishFold(T);
  });
  if(ok){closeTableView();}
}
async function doAct(type,amount){
  const hn=S.T&&S.T.hand&&S.T.hand.n;
  await txn(S.tid,(L,T)=>{
    if(!T||!T.hand||T.hand.n!==hn)throw new Error('היד התחלפה — נסו שוב');
    act(T,S.fid,type,amount);
  });
  S.raise=null;
}
async function deal(auto){
  const hn=S.T&&S.T.hand?S.T.hand.n:0;
  await txn(S.tid,(L,T)=>{
    if(!T)return;
    const cur=T.hand?T.hand.n:0;
    if(cur!==hn)return;            // someone else already dealt
    if(!canStart(T)){if(!auto)throw new Error('צריך לפחות שתי משפחות עם צ׳יפים');return;}
    startHand(T);
  });
}
async function kickSlow(){
  const H=S.T&&S.T.hand;if(!H||!H.turn)return;
  const who=H.turn,hn=H.n;
  await txn(S.tid,(L,T)=>{
    const h=T&&T.hand;
    if(!h||h.n!==hn||h.turn!==who)return;
    if(now()-h.turnAt<TURN_SECS*1000)throw new Error('עוד לא עברה דקה');
    const pp=h.p[who];
    act(T,who,pp.bet>=h.cur?'check':'fold');
    logPush(T,`⏱️ ${short(who)} לא ענו בזמן`);
  });
}
async function dismissInvite(tid){
  await txn(null,L=>{if(L.invites&&L.invites[S.fid])delete L.invites[S.fid][tid];});
}
// ── loans between families ─────────────────────────────────────────────────
function loansOf(L){return Object.values(L.loans||{});}
function pruneLoans(L){
  const keep={};
  loansOf(L).forEach(l=>{if(l.status==='pending'||l.status==='active'||now()-(l.done||l.ts)<LOAN_KEEP)keep[l.id]=l;});
  L.loans=keep;
}
function moveChips(L,from,to,amt){
  L.bal=L.bal||{};
  const b=bal(L,from);
  L.bal[from]=b-amt;L.bal[to]=bal(L,to)+amt;
}
async function requestLoan(to,amt){
  const id=rid();
  const ok=await txn(null,L=>{
    pruneLoans(L);
    if(loansOf(L).some(l=>l.by===S.fid&&l.to===to&&l.status==='pending'))throw new Error('כבר ביקשתם מהם — מחכים לתשובה');
    L.loans[id]={id,by:S.fid,to,amt,status:'pending',ts:now()};
  });
  if(ok){pushTo([to],'🙏 בקשת הלוואה בפוקר',`משפחת ${short(S.fid)} מבקשת מכם הלוואה של ${fmt(amt)} צ׳יפים`);toast('📨 הבקשה נשלחה ל'+short(to));}
}
async function answerLoan(id,yes){
  let done=null;
  const ok=await txn(null,L=>{
    const l=(L.loans||{})[id];
    if(!l||l.status!=='pending')throw new Error('הבקשה כבר לא פעילה');
    if(l.to!==S.fid)throw new Error('הבקשה לא מופנית אליכם');
    if(yes){
      if(l.amt>bal(L,S.fid))throw new Error('אין לכם מספיק צ׳יפים בקופה כדי להלוות');
      moveChips(L,S.fid,l.by,l.amt);l.status='active';
    }else l.status='declined';
    l.done=now();done=Object.assign({},l);
  });
  if(ok&&done){
    if(yes){pushTo([done.by],'✅ ההלוואה אושרה',`משפחת ${short(S.fid)} הלוו לכם ${fmt(done.amt)} צ׳יפים — הם כבר בקופה שלכם`);toast('✅ הלוויתם '+fmt(done.amt)+' צ׳יפים');}
    else pushTo([done.by],'ההלוואה לא אושרה',`משפחת ${short(S.fid)} לא יכולים להלוות לכם הפעם`);
  }
}
async function repayLoan(id){
  let done=null;
  const ok=await txn(null,L=>{
    const l=(L.loans||{})[id];
    if(!l||l.status!=='active'||l.by!==S.fid)throw new Error('אין הלוואה פתוחה כזאת');
    if(l.amt>bal(L,S.fid))throw new Error('אין מספיק צ׳יפים בקופה להחזר של '+fmt(l.amt));
    moveChips(L,S.fid,l.to,l.amt);l.status='repaid';l.done=now();done=Object.assign({},l);
  });
  if(ok&&done){pushTo([done.to],'💰 החזר הלוואה',`משפחת ${short(S.fid)} החזירו לכם ${fmt(done.amt)} צ׳יפים`);toast('✅ ההלוואה הוחזרה');}
}
async function forgiveLoan(id){
  if(!confirm('למחול על ההלוואה? הם לא יצטרכו להחזיר אותה.'))return;
  let done=null;
  const ok=await txn(null,L=>{
    const l=(L.loans||{})[id];
    if(!l||l.status!=='active'||l.to!==S.fid)throw new Error('אין הלוואה פתוחה כזאת');
    l.status='forgiven';l.done=now();done=Object.assign({},l);
  });
  if(ok&&done)pushTo([done.by],'🎁 מחלו לכם על ההלוואה',`משפחת ${short(S.fid)} מחלו לכם על ההלוואה של ${fmt(done.amt)} צ׳יפים`);
}
async function cancelLoan(id){
  await txn(null,L=>{const l=(L.loans||{})[id];if(l&&l.status==='pending'&&l.by===S.fid)delete L.loans[id];});
}
function loanRow(fid,title,sub,btns){
  return `<div class="pk-trow">${ava(fid,30)}<div class="pk-tinfo"><b>${title}</b>${sub?`<small>${sub}</small>`:''}</div>${btns||''}</div>`;
}
function loansSection(L){
  const ls=loansOf(L).sort((a,b)=>b.ts-a.ts);
  const me=S.fid;
  const rows=[];
  ls.filter(l=>l.to===me&&l.status==='pending').forEach(l=>rows.push(loanRow(l.by,`${E(short(l.by))} מבקשים ${fmt(l.amt)} צ׳יפים`,'בקשת הלוואה מכם',
    `<div class="pk-tbtns"><button class="pk-btn pk-green" onclick="pokerUI.answerLoan('${l.id}',true)">להלוות</button><button class="pk-btn pk-ghost" onclick="pokerUI.answerLoan('${l.id}',false)">לא הפעם</button></div>`)));
  ls.filter(l=>l.by===me&&l.status==='active').forEach(l=>rows.push(loanRow(l.to,`אתם חייבים ${fmt(l.amt)} ל${E(short(l.to))}`,'מחזירים מהקופה מתי שרוצים',
    `<button class="pk-btn pk-gold" onclick="pokerUI.repayLoan('${l.id}')">להחזיר</button>`)));
  ls.filter(l=>l.to===me&&l.status==='active').forEach(l=>rows.push(loanRow(l.by,`${E(short(l.by))} חייבים לכם ${fmt(l.amt)}`,'',
    `<button class="pk-btn pk-ghost" onclick="pokerUI.forgiveLoan('${l.id}')">למחול</button>`)));
  ls.filter(l=>l.by===me&&l.status==='pending').forEach(l=>rows.push(loanRow(l.to,`ביקשתם ${fmt(l.amt)} מ${E(short(l.to))}`,'מחכים לתשובה…',
    `<button class="pk-btn pk-ghost" onclick="pokerUI.cancelLoan('${l.id}')">ביטול</button>`)));
  const msg={declined:'לא אישרו את הבקשה',repaid:'ההלוואה הוחזרה ✓',forgiven:'מחלו על ההלוואה 🎁'};
  ls.filter(l=>(l.by===me||l.to===me)&&msg[l.status]&&now()-(l.done||0)<864e5).forEach(l=>{
    const other=l.by===me?l.to:l.by;
    rows.push(loanRow(other,`${fmt(l.amt)} · ${l.by===me?'מ':'ל'}${E(short(other))}`,msg[l.status],''));
  });
  return `<div class="pk-sec"><h4>🙏 הלוואות</h4>${rows.join('')}
    ${rows.length?'':'<p class="pk-muted" style="margin-bottom:8px">נגמרו הצ׳יפים? אפשר לבקש הלוואה ממשפחה אחרת. הם יקבלו התראה ויחליטו אם להלוות.</p>'}
    <button class="pk-btn pk-ghost pk-big" style="margin-top:6px" onclick="pokerUI.openLoan()">🙏 לבקש הלוואה ממשפחה אחרת</button></div>`;
}
async function resetBanks(){
  if(!isAdmin())return;
  if(!confirm('לאפס את הקופות של כל המשפחות ל-'+fmt(START)+', לסגור את כל השולחנות ולמחוק את כל ההלוואות?'))return;
  const fs=await fsCtx();
  const tids=Object.keys((S.L||{}).tables||{});
  try{
    await fs.runTransaction(fs.db,async tx=>{
      const snaps=[];for(const t of tids)snaps.push([t,await tx.get(tableRef(fs,t))]);
      snaps.forEach(([t,sn])=>{if(sn.exists()){const T=clean(sn.data());T.status='closed';tx.set(tableRef(fs,t),T);}});
      tx.set(lobbyRef(fs),{bal:{},tables:{},invites:{},loans:{}});
    });
    toast('✅ כל הקופות אופסו');
  }catch(e){console.warn(e);toast('⚠️ האיפוס נכשל');}
}

// ── views ──────────────────────────────────────────────────────────────────
function ensureOverlay(){
  let o=$('pokerOverlay');if(o)return o;
  o=document.createElement('div');o.id='pokerOverlay';
  o.innerHTML='<div class="pk-top"><button class="pk-x" onclick="pokerUI.back()" aria-label="סגירה">✕</button><div class="pk-title" id="pkTitle">♠️ פוקר משפחתי</div><div class="pk-mybal" id="pkMyBal"></div></div><div class="pk-body" id="pkBody"></div><div id="pkModal"></div>';
  document.body.appendChild(o);
  return o;
}
function render(){
  const o=$('pokerOverlay');if(!o||!o.classList.contains('open'))return;
  const L=S.L||{};
  $('pkMyBal').innerHTML=S.fid!=null?`<span class="pk-chip-ico"></span>${fmt(bal(L,S.fid))}`:'';
  $('pkTitle').textContent=S.view==='table'?'♠️ שולחן פוקר':'♠️ פוקר משפחתי';
  $('pkBody').innerHTML=S.fid==null?pickFamView():S.view==='table'?tableView():lobbyView();
  if(S.view==='table')fitTable();
  $('pkModal').innerHTML=S.modal?modalView():'';
}
function pickFamView(){
  return `<div class="pk-card-box"><h3>מי משחק מהמכשיר הזה?</h3><p class="pk-muted">בחרו את המשפחה שלכם — כל משפחה מתחילה עם ${fmt(START)} צ׳יפים.</p>
  <div class="pk-fams">${allFams().map(f=>`<button class="pk-fam" onclick="pokerUI.setFam(${f.id})">${ava(f.id,30)}<span>${E(short(f.id))}</span></button>`).join('')}</div></div>`;
}
function lobbyView(){
  const L=S.L||{};
  const tables=Object.keys(L.tables||{}).map(id=>Object.assign({id},L.tables[id])).filter(t=>t.status==='open').sort((a,b)=>b.created-a.created);
  const inv=myInvites(L);
  const mine=tables.filter(t=>(t.players||[]).includes(S.fid));
  const others=tables.filter(t=>!(t.players||[]).includes(S.fid)&&!inv.some(i=>i.tid===t.id));
  const fams=allFams();
  // a family's total = its bank + whatever it has sitting on tables
  const onT={};
  tables.forEach(t=>Object.keys(t.stacks||{}).forEach(f=>{onT[f]=(onT[f]||0)+t.stacks[f];}));
  const board=fams.map(f=>({fid:f.id,bank:bal(L,f.id),onT:onT[f.id]||0})).map(r=>Object.assign(r,{tot:r.bank+r.onT}));
  board.sort((a,b)=>b.tot-a.tot);
  const debt={};loansOf(L).filter(l=>l.status==='active').forEach(l=>{debt[l.by]=(debt[l.by]||0)+l.amt;});
  const row=(t,btn)=>`<div class="pk-trow"><div class="pk-tavas">${(t.players||[]).map(f=>ava(f,28)).join('')}</div>
    <div class="pk-tinfo"><b>השולחן של ${E(short(t.host))}</b><small>${(t.players||[]).length}/${MAX_SEATS} משפחות · ${fmt(t.stake)} צ׳יפים על השולחן</small></div>${btn}</div>`;
  return `
  <div class="pk-hero"><div class="pk-hero-suits">♠ ♥ ♦ ♣</div>
    <div class="pk-hero-me">${ava(S.fid,44)}<div><b>משפחת ${E(short(S.fid))}</b><small>בקופה: ${fmt(bal(L,S.fid))} צ׳יפים <button class="pk-link" onclick="pokerUI.changeFam()">החלפה</button></small></div></div>
    <button class="pk-btn pk-gold pk-big" onclick="pokerUI.openNew()">🃏 שולחן חדש והזמנת משפחות</button>
    <button class="pk-btn pk-ghost pk-big pk-howto" onclick="pokerUI.tutorial()">🎬 איך משחקים פוקר? · סרטון הסבר</button>
  </div>
  ${inv.length?`<div class="pk-sec"><h4>📨 הזמנות בשבילכם</h4>${inv.map(i=>{const t=L.tables[i.tid];return row(Object.assign({id:i.tid},t),`<div class="pk-tbtns"><button class="pk-btn pk-green" onclick="pokerUI.askJoin('${i.tid}')">הצטרפו</button><button class="pk-btn pk-ghost" onclick="pokerUI.dismiss('${i.tid}')">לא עכשיו</button></div>`);}).join('')}</div>`:''}
  ${loansOf(L).some(l=>l.to===S.fid&&l.status==='pending')?loansSection(L):''}
  ${mine.length?`<div class="pk-sec"><h4>🪑 השולחנות שלכם</h4>${mine.map(t=>row(t,`<button class="pk-btn pk-green" onclick="pokerUI.openTable('${t.id}')">לשולחן</button>`)).join('')}</div>`:''}
  ${others.length?`<div class="pk-sec"><h4>🟢 שולחנות פתוחים</h4>${others.map(t=>row(t,`<button class="pk-btn pk-ghost" onclick="pokerUI.askJoin('${t.id}')">${(t.players||[]).length>=MAX_SEATS?'מלא':'הצטרפו'}</button>`)).join('')}</div>`:''}
  ${!tables.length&&!inv.length?`<div class="pk-empty">אין כרגע שולחנות פתוחים.<br>פתחו שולחן והזמינו משפחה לשחק!</div>`:''}
  ${loansOf(L).some(l=>l.to===S.fid&&l.status==='pending')?'':loansSection(L)}
  <div class="pk-sec"><h4>💰 הקופות של המשפחות</h4>
    <div class="pk-board">${board.map((r,i)=>`<div class="pk-brow ${r.fid===S.fid?'me':''}"><span class="pk-rank">${i<3?['🥇','🥈','🥉'][i]:i+1}</span>${ava(r.fid,26)}<span class="pk-bname">${E(short(r.fid))}</span><span class="pk-bval">${fmt(r.tot)}${r.onT?`<small>${fmt(r.onT)} על שולחן</small>`:''}${debt[r.fid]?`<small class="pk-debt">חוב ${fmt(debt[r.fid])}</small>`:''}</span></div>`).join('')}</div>
    <p class="pk-muted" style="margin-top:8px">צ׳יפים שיושבים על שולחן חוזרים לקופה כשקמים מהשולחן. משחק בצ׳יפים בלבד — בלי כסף אמיתי.</p>
    ${isAdmin()?`<button class="pk-btn pk-ghost" style="margin-top:8px" onclick="pokerUI.resetBanks()">♻️ איפוס כל הקופות ל-${fmt(START)}</button>`:''}
  </div>`;
}

// seat positions around the oval (percent of the felt), seat 0 = me at the bottom
const POS={
  2:[[50,100],[50,0]],
  3:[[50,100],[6,30],[94,30]],
  4:[[50,100],[3,50],[50,0],[97,50]],
  5:[[50,100],[4,68],[18,4],[82,4],[96,68]],
  6:[[50,100],[4,72],[8,16],[50,0],[92,16],[96,72]]
};
function tableView(){
  const T=S.T;
  if(!T)return `<div class="pk-empty">טוען שולחן…</div>`;
  const H=T.hand;
  const seats=T.seats||[];
  const meI=seats.findIndex(s=>s.fid===S.fid);
  const rot=meI<0?seats:seats.slice(meI).concat(seats.slice(0,meI));
  const pos=POS[Math.max(2,rot.length)]||POS[6];
  const live=H&&H.street!=='done';
  const potAmt=H?(live?pot(H):0):0;
  const seatHtml=rot.map((s,i)=>{
    const [x,y]=pos[i]||[50,50];
    const pp=H&&H.p[s.fid];
    const isTurn=live&&H.turn===s.fid;
    const me=s.fid===S.fid;
    let cards='';
    if(pp){
      const shown=H.street==='done'&&H.result&&H.result.shown[s.fid];
      if(me||shown)cards=pp.hole.map(c=>cardHtml(c,me?'':'sm')).join('');
      else if(!pp.folded)cards=cardHtml(null,'sm')+cardHtml(null,'sm');
    }
    const win=H&&H.street==='done'&&H.result&&H.result.winners.find(w=>w.fid===s.fid);
    const status=pp?(pp.folded?'קיפלו':pp.allin?'אול-אין':''):(live?'מחכים ליד הבאה':'');
    const handName=H&&H.street==='done'&&H.result&&H.result.shown[s.fid]?HAND_NAMES[H.result.shown[s.fid].cat]:'';
    const left=isTurn?Math.max(0,TURN_SECS-Math.floor((now()-H.turnAt)/1000)):0;
    return `<div class="pk-seat ${me?'me':''} ${isTurn?'turn':''} ${pp&&pp.folded?'folded':''} ${win?'win':''}" style="left:${x}%;top:${y}%">
      ${pp&&pp.bet>0&&live?`<div class="pk-bet">${fmt(pp.bet)}</div>`:''}
      <div class="pk-cards ${me?'mine':''}">${cards}</div>
      <div class="pk-plate">${ava(s.fid,me?34:28)}<div class="pk-pinfo"><b>${E(short(s.fid))}${H&&H.dealerFid===s.fid?' <span class="pk-dealer">D</span>':''}</b><small>${fmt(s.stack)}</small></div></div>
      ${win?`<div class="pk-wintag">+${fmt(win.amt)}</div>`:status||handName?`<div class="pk-status">${E(handName||status)}</div>`:''}
      ${isTurn&&!me?`<div class="pk-timer">${left}</div>`:''}
    </div>`;
  }).join('');
  const board=H?H.board:[];
  const boardHtml=[0,1,2,3,4].map(i=>board[i]?cardHtml(board[i]):`<span class="pk-card pk-slot"></span>`).join('');
  let center='';
  if(H&&H.street==='done'&&H.result){
    const ws=H.result.winners;
    center=`<div class="pk-result">${ws.map(w=>`🏆 ${E(short(w.fid))} +${fmt(w.amt)}${w.cat!=null&&!H.result.fold?' · '+HAND_NAMES[w.cat]:''}`).join('<br>')}</div>`;
  }else if(live){
    center=`<div class="pk-pot"><span class="pk-chip-ico"></span>קופה ${fmt(potAmt)}</div>`;
  }else{
    center=`<div class="pk-pot">${seats.length<2?'מחכים למשפחה נוספת…':'מוכנים לחלוקה'}</div>`;
  }
  return `<div class="pk-tablewrap"><div class="pk-felt" id="pkFelt">
      <div class="pk-felt-in"><div class="pk-boardcards">${boardHtml}</div>${center}</div>
      ${seatHtml}
    </div></div>
    ${actionBar()}
    <div class="pk-tools">
      <button class="pk-btn pk-ghost" onclick="pokerUI.openInvite()">📨 הזמנת משפחה</button>
      <button class="pk-btn pk-ghost" onclick="pokerUI.openRebuy()">➕ צ׳יפים</button>
      <button class="pk-btn pk-ghost" onclick="pokerUI.leave()">🚪 לקום</button>
      <button class="pk-btn pk-ghost pk-q" onclick="pokerUI.tutorial()" title="איך משחקים?">🎬</button>
    </div>
    <div class="pk-sec"><h4>מה קרה</h4><div class="pk-log">${(T.log||[]).slice().reverse().slice(0,12).map(l=>`<div>${E(l.txt)}</div>`).join('')}</div>
    <p class="pk-muted" style="margin-top:8px">בליינדים ${SB}/${BB} · מי שלא עונה ${TURN_SECS} שניות — אפשר לדלג עליו</p></div>`;
}
function actionBar(){
  const T=S.T,H=T&&T.hand;
  const mySeat=seatOf(T,S.fid);
  if(!mySeat)return `<div class="pk-actions"><button class="pk-btn pk-gold pk-big" onclick="pokerUI.askJoin('${T.id}')">🪑 לשבת בשולחן</button></div>`;
  if(!H||H.street==='done'){
    const can=canStart(T);
    const wait=H&&H.doneAt?Math.max(0,NEXT_HAND_SECS-Math.floor((now()-H.doneAt)/1000)):0;
    return `<div class="pk-actions">${can?`<button class="pk-btn pk-gold pk-big" onclick="pokerUI.deal()">🃏 ${H?'יד הבאה'+(wait?` (${wait})`:''):'חלקו קלפים'}</button>`:`<div class="pk-wait">${(T.seats||[]).length<2?'מחכים שמשפחה נוספת תצטרף — הזמינו מישהו 👇':'למישהו נגמרו הצ׳יפים — הוסיפו צ׳יפים כדי להמשיך'}</div>`}</div>`;
  }
  const pp=H.p[S.fid];
  if(!pp)return `<div class="pk-actions"><div class="pk-wait">אתם נכנסים ביד הבאה</div></div>`;
  if(pp.folded)return `<div class="pk-actions"><div class="pk-wait">קיפלתם — מחכים לסוף היד</div></div>`;
  if(H.turn!==S.fid){
    const late=H.turn!=null&&now()-H.turnAt>TURN_SECS*1000;
    return `<div class="pk-actions"><div class="pk-wait">${pp.allin?'אתם באול-אין 🤞':'התור של '+E(short(H.turn))+'…'}</div>${late?`<button class="pk-btn pk-ghost" onclick="pokerUI.kick()">⏱️ לדלג על ${E(short(H.turn))}</button>`:''}</div>`;
  }
  const toCall=Math.min(H.cur-pp.bet,mySeat.stack);
  const maxTo=pp.bet+mySeat.stack;
  const minTo=Math.min(H.cur+H.minRaise,maxTo);
  const canRaise=maxTo>H.cur;
  if(S.raise!=null){
    const potNow=pot(H);
    const v=Math.max(minTo,Math.min(maxTo,S.raise));
    const pre=[['מינימום',minTo],['½ קופה',H.cur+Math.floor((potNow+toCall)/2)],['קופה',H.cur+potNow+toCall],['אול-אין',maxTo]]
      .map(([l,a])=>[l,Math.max(minTo,Math.min(maxTo,a))]);
    return `<div class="pk-actions pk-raise">
      <div class="pk-raise-val">העלאה ל-<b>${fmt(v)}</b></div>
      <input type="range" min="${minTo}" max="${maxTo}" step="${Math.min(BB/2,Math.max(1,maxTo-minTo))}" value="${v}" oninput="pokerUI.setRaise(+this.value,true)">
      <div class="pk-pre">${pre.map(([l,a])=>`<button class="pk-btn pk-ghost" onclick="pokerUI.setRaise(${a})">${l}</button>`).join('')}</div>
      <div class="pk-arow"><button class="pk-btn pk-ghost" onclick="pokerUI.setRaise(null)">ביטול</button><button class="pk-btn pk-gold" onclick="pokerUI.act('raise',${v})">${v===maxTo?'אול-אין':'העלו ל-'+fmt(v)}</button></div>
    </div>`;
  }
  return `<div class="pk-actions"><div class="pk-yourturn">התור שלכם!</div><div class="pk-arow">
    <button class="pk-btn pk-red" onclick="pokerUI.act('fold')">קיפול</button>
    ${toCall>0?`<button class="pk-btn pk-green" onclick="pokerUI.act('call')">${toCall>=mySeat.stack?'אול-אין '+fmt(toCall):'השוואה '+fmt(toCall)}</button>`:`<button class="pk-btn pk-green" onclick="pokerUI.act('check')">צ׳ק</button>`}
    ${canRaise&&toCall<mySeat.stack?`<button class="pk-btn pk-gold" onclick="pokerUI.setRaise(${minTo})">${H.cur>0?'העלאה':'הימור'}</button>`:''}
  </div></div>`;
}
function fitTable(){
  const f=$('pkFelt');if(!f)return;
  const w=f.parentElement.clientWidth;
  f.style.height=Math.round(Math.min(420,Math.max(260,w*0.78)))+'px';
}

// modals: new table / invite more / buy-in
function modalView(){
  const m=S.modal,L=S.L||{};
  const b=bal(L,S.fid);
  const buyBtns=(fn)=>{
    const opts=BUYINS.filter(x=>x<=b);
    if(b>0&&!opts.includes(b))opts.push(b);
    if(!opts.length)return `<p class="pk-muted">אין לכם צ׳יפים בקופה 😅</p><button class="pk-btn pk-ghost pk-big" style="margin-top:8px" onclick="pokerUI.openLoan()">🙏 לבקש הלוואה ממשפחה אחרת</button>`;
    return `<div class="pk-buyins">${opts.map(x=>`<button class="pk-btn ${m.buy===x?'pk-gold':'pk-ghost'}" onclick="pokerUI.pickBuy(${x})">${x===b&&!BUYINS.includes(x)?'הכל · ':''}${fmt(x)}</button>`).join('')}</div>`;
  };
  let inner='';
  if(m.kind==='new'||m.kind==='invite'){
    const T=S.T;
    const taken=new Set(m.kind==='invite'&&T?T.seats.map(s=>s.fid):[S.fid]);
    const list=allFams().filter(f=>!taken.has(f.id));
    inner=`<h3>${m.kind==='new'?'🃏 שולחן חדש':'📨 הזמנת משפחות'}</h3>
      <p class="pk-muted">את מי להזמין? הם יקבלו התראה לטלפון.</p>
      <div class="pk-fams">${list.map(f=>`<button class="pk-fam ${m.sel.includes(f.id)?'on':''}" onclick="pokerUI.toggleSel(${f.id})">${ava(f.id,30)}<span>${E(short(f.id))}</span>${m.sel.includes(f.id)?'<em>✓</em>':''}</button>`).join('')}</div>
      ${m.kind==='new'?`<p class="pk-muted" style="margin-top:12px">עם כמה צ׳יפים יושבים? (בקופה: ${fmt(b)})</p>${buyBtns()}`:''}
      <div class="pk-arow" style="margin-top:14px"><button class="pk-btn pk-ghost" onclick="pokerUI.closeModal()">ביטול</button>
      <button class="pk-btn pk-gold" ${m.kind==='new'?(m.buy?'':'disabled'):(m.sel.length?'':'disabled')} onclick="pokerUI.confirmModal()">${m.kind==='new'?(m.sel.length?'פתחו והזמינו':'פתחו שולחן'):'שלחו הזמנה'}</button></div>`;
  }else if(m.kind==='join'||m.kind==='rebuy'){
    inner=`<h3>${m.kind==='join'?'🪑 הצטרפות לשולחן':'➕ עוד צ׳יפים לשולחן'}</h3>
      <p class="pk-muted">כמה צ׳יפים להעביר מהקופה המשפחתית? (בקופה: ${fmt(b)})</p>${buyBtns()}
      <div class="pk-arow" style="margin-top:14px"><button class="pk-btn pk-ghost" onclick="pokerUI.closeModal()">ביטול</button>
      <button class="pk-btn pk-gold" ${m.buy?'':'disabled'} onclick="pokerUI.confirmModal()">${m.kind==='join'?'לשבת':'להוסיף'}</button></div>`;
  }
  else if(m.kind==='loan'){
    const list=allFams().filter(f=>f.id!==S.fid);
    inner=`<h3>🙏 בקשת הלוואה</h3>
      <p class="pk-muted">ממי לבקש? הם יקבלו התראה ויחליטו אם להלוות. מחזירים מהקופה מתי שרוצים.</p>
      <div class="pk-fams">${list.map(f=>`<button class="pk-fam ${m.to===f.id?'on':''}" onclick="pokerUI.pickTo(${f.id})">${ava(f.id,30)}<span>${E(short(f.id))}<small class="pk-fam-bal">${fmt(bal(L,f.id))}</small></span>${m.to===f.id?'<em>✓</em>':''}</button>`).join('')}</div>
      <p class="pk-muted" style="margin-top:12px">כמה צ׳יפים?</p>
      <div class="pk-buyins">${LOAN_AMTS.map(x=>`<button class="pk-btn ${m.buy===x?'pk-gold':'pk-ghost'}" onclick="pokerUI.pickBuy(${x})">${fmt(x)}</button>`).join('')}</div>
      <div class="pk-arow" style="margin-top:14px"><button class="pk-btn pk-ghost" onclick="pokerUI.closeModal()">ביטול</button>
      <button class="pk-btn pk-gold" ${m.to!=null&&m.buy?'':'disabled'} onclick="pokerUI.confirmModal()">שלחו בקשה</button></div>`;
  }
  return `<div class="pk-mbg" onclick="if(event.target===this)pokerUI.closeModal()"><div class="pk-mbox">${inner}</div></div>`;
}
function defaultBuy(){const b=bal(S.L||{},S.fid);return b>=2000?2000:b>0?b:null;}

// ── home page: tile subtitle, invite badge and banner ─────────────────────
function myLoanReqs(L){return loansOf(L).filter(l=>l.to===S.fid&&l.status==='pending');}
function homeUpdate(){
  if(S.fid==null)S.fid=resolveFam();
  const sub=$('homeTilePokerSub'),badge=$('pokerInviteBadge');
  if(S.fid==null){if(sub)sub.textContent='כל משפחה מתחילה עם '+fmt(START)+' צ׳יפים';return;}
  const L=S.L||{};
  const inv=myInvites(L),reqs=myLoanReqs(L);
  const n=inv.length+reqs.length;
  if(sub)sub.textContent=inv.length?('📨 '+short(inv[0].from)+' מזמינים אתכם לשחק!'):reqs.length?('🙏 '+short(reqs[0].by)+' מבקשים מכם הלוואה'):('בקופה: '+fmt(bal(L,S.fid))+' צ׳יפים');
  if(badge){badge.style.display=n?'flex':'none';badge.textContent=n;}
  // banner for something new while the app is open (once per item)
  const o=$('pokerOverlay');
  if(o&&o.classList.contains('open'))return;
  const seen=lsGet('pkSeenInv',{});
  const items=inv.map(i=>({key:i.tid+':'+i.ts,ico:'🃏',title:'הזמנה לפוקר!',txt:`משפחת ${short(i.from)} מזמינה אתכם לשחק`,go:'לשחק',tid:i.tid}))
    .concat(reqs.map(l=>({key:'loan:'+l.id,ico:'🙏',title:'בקשת הלוואה',txt:`משפחת ${short(l.by)} מבקשת ${fmt(l.amt)} צ׳יפים`,go:'לראות'})));
  const fresh=items.find(i=>!seen[i.key]);
  const cur=$('pkBanner');
  if(!fresh){if(cur)cur.remove();return;}
  if(cur&&cur.dataset.key===fresh.key)return;
  if(cur)cur.remove();
  const bn=document.createElement('div');bn.id='pkBanner';bn.dataset.key=fresh.key;
  bn.innerHTML=`<div class="pk-bn-ico">${fresh.ico}</div><div class="pk-bn-txt"><b>${fresh.title}</b><small>${E(fresh.txt)}</small></div>
    <button class="pk-bn-go" onclick="pokerUI.bannerGo('${fresh.key}','${fresh.tid||''}')">${fresh.go}</button><button class="pk-bn-x" onclick="pokerUI.bannerX('${fresh.key}')">✕</button>`;
  document.body.appendChild(bn);
}
function markSeen(key){const seen=lsGet('pkSeenInv',{});seen[key]=1;lsSet('pkSeenInv',seen);const bn=$('pkBanner');if(bn)bn.remove();}
function resolveFam(){
  const saved=lsGet('pkFam',null);
  const id=saved!=null?saved:myDeviceFam();
  return fam(id)?id:null;
}

// ── open / close ───────────────────────────────────────────────────────────
function open(){
  const o=ensureOverlay();
  S.fid=resolveFam();
  o.classList.add('open');document.body.style.overflow='hidden';
  if(typeof _setHash==='function')_setHash('poker');
  const bn=$('pkBanner');if(bn)bn.remove();
  subscribeLobby();
  // a table I'm sitting at opens straight away
  if(S.view==='table'&&S.tid)subscribeTable(S.tid);
  render();
  clearInterval(S.tick);
  S.tick=setInterval(tick,1000);
}
function tick(){
  const o=$('pokerOverlay');if(!o||!o.classList.contains('open'))return;
  if(S.view!=='table'||!S.T)return;
  const H=S.T.hand;
  // auto next hand a few seconds after the result (any seated phone may do it; the
  // transaction makes sure only one deal happens)
  if(H&&H.street==='done'&&H.doneAt&&now()-H.doneAt>NEXT_HAND_SECS*1000&&seatOf(S.T,S.fid)&&canStart(S.T)&&!S.busy&&S.autoFor!==H.n){
    S.autoFor=H.n;deal(true);return;
  }
  // refresh countdowns without disturbing the raise slider
  if(S.raise==null&&!S.modal)render();
}
function openTable(tid){S.view='table';S.tid=tid;S.raise=null;S.modal=null;subscribeTable(tid);render();}
function closeTableView(){if(S.unsubT){S.unsubT();S.unsubT=null;}S.view='lobby';S.tid=null;S.T=null;render();}
function close(){
  const o=$('pokerOverlay');if(o)o.classList.remove('open');
  document.body.style.overflow='';clearInterval(S.tick);
  if(S.unsubT){S.unsubT();S.unsubT=null;}
  tutClose();
  if(typeof _clearHash==='function')_clearHash('poker');
  homeUpdate();
}
function back(){if($('pkTut')){tutClose();return;}if(S.modal){S.modal=null;render();return;}if(S.view==='table'){closeTableView();return;}close();}

// ── "איך משחקים?" — a short animated video ─────────────────────────────────
// Built from the game's own cards and avatars (no video file to load), with
// subtitles and, where the device has a Hebrew voice, spoken narration.
// Each scene is a stage (animated with CSS delays) + the line read out.
const T_={i:0,playing:false,muted:lsGet('pkTutMute',false),t0:0,el:0,timer:null,utt:null,spoke:false,voice:null};
function A(html,d,cls){return `<span class="pt-a ${cls||''}" style="--d:${d}s">${html}</span>`;}
function cards(list,d0,step,cls){return list.map((c,i)=>A(cardHtml(c,cls),d0+i*step)).join('');}
function chipStack(n,d){return A(`<span class="pt-chips">${'<span class="pk-chip-ico"></span>'.repeat(n)}</span>`,d);}
function demoFams(){const f=allFams().slice(0,3).map(x=>x.id);return f.length?f:[null,null,null];}
function demoAva(fid,size){return fid==null?`<span class="pk-ava0" style="width:${size}px;height:${size}px">🙂</span>`:ava(fid,size);}
const TUT=[
  {t:'♠ ♥ פוקר משפחתי ♦ ♣',say:'ברוכים הבאים לפוקר המשפחתי! בסרטון קצר נלמד איך משחקים טקסס הולדם — המשחק הכי מפורסם בעולם.',
   stage:()=>`<div class="pt-row">${cards(['As','Kh','Qd','Jc','Ts'],.2,.25)}</div>${A('<div class="pt-big">טקסס הולדם</div>',1.6)}`},
  {t:'🎯 המטרה',say:'המטרה היא לזכות בצ׳יפים שבאמצע השולחן — הקופה. מי שמחזיק את היד הכי טובה בסוף, או מי שנשאר אחרון כשכל השאר ויתרו, לוקח את כל הקופה.',
   stage:()=>`<div class="pt-felt">${chipStack(3,.2)}${chipStack(5,.5)}${chipStack(4,.8)}${A('<div class="pt-pot">הקופה</div>',1.2)}</div>${A('<div class="pt-note">🏆 היד הכי טובה לוקחת הכל</div>',3)}`},
  {t:'🂠 שני קלפים לכל משפחה',say:'כל משפחה מקבלת שני קלפים סגורים. רק אתם רואים אותם — אל תגלו לאף אחד!',
   stage:()=>{const f=demoFams();return `<div class="pt-players">${[1,2].map((k,i)=>`<div class="pt-pl">${A(demoAva(f[k],32),.1)}<div class="pt-row">${A(cardHtml(null,'sm'),.4+i*.2)}${A(cardHtml(null,'sm'),.5+i*.2)}</div></div>`).join('')}</div>
     <div class="pt-pl me">${A('<b class="pt-you">אתם</b>',.2)}<div class="pt-row">${A(cardHtml('Ah'),1.2,'pt-flip')}${A(cardHtml('Kd'),1.5,'pt-flip')}</div></div>${A('<div class="pt-note">🤫 סודי!</div>',2.5)}`;}},
  {t:'🔘 דילר ובליינדים',say:'לפני כל יד, שתי המשפחות שאחרי הדילר שמות סכום קבוע מראש: חמישים ומאה. זה נקרא בליינדים, וככה תמיד יש על מה לשחק. הכפתור של הדילר עובר משפחה בכל יד.',
   stage:()=>{const f=demoFams();return `<div class="pt-players">
     <div class="pt-pl">${A(demoAva(f[0],34),.1)}${A('<span class="pk-dealer pt-d">D</span>',.6)}<small>דילר</small></div>
     <div class="pt-pl">${A(demoAva(f[1],34),.1)}${A('<span class="pt-blind">50</span>',2.4)}<small>בליינד קטן</small></div>
     <div class="pt-pl">${A(demoAva(f[2],34),.1)}${A('<span class="pt-blind">100</span>',3.4)}<small>בליינד גדול</small></div></div>`;}},
  {t:'👆 מה עושים בתור שלכם?',say:'כשמגיע התור שלכם יש ארבע אפשרויות. קיפול — מוותרים על היד. צ׳ק — ממשיכים בלי לשים כלום, אם אף אחד עוד לא הימר. השוואה — שמים בדיוק כמו ההימור הגבוה. והעלאה — מגדילים את ההימור, ואז כל השאר צריכים להשוות או לקפל.',
   stage:()=>`<div class="pt-acts">
     ${A('<div><span class="pk-btn pk-red">קיפול</span><small>מוותרים על היד</small></div>',.5)}
     ${A('<div><span class="pk-btn pk-green">צ׳ק</span><small>ממשיכים בלי לשים (אם אף אחד לא הימר)</small></div>',2.6)}
     ${A('<div><span class="pk-btn pk-green">השוואה</span><small>שמים כמו ההימור הגבוה</small></div>',6)}
     ${A('<div><span class="pk-btn pk-gold">העלאה</span><small>מגדילים את ההימור</small></div>',8.6)}</div>`},
  {t:'🃏 הפלופ — 3 קלפים באמצע',say:'אחרי סבב ההימורים הראשון נפתחים שלושה קלפים באמצע — זה נקרא הפלופ. הקלפים האלה משותפים לכולם. ושוב יש סבב הימורים.',
   stage:()=>`<div class="pt-felt"><div class="pt-row">${cards(['9c','Kh','4s'],.6,.35,'pt-flip')}${A('<span class="pk-card pk-slot"></span>',.2)}${A('<span class="pk-card pk-slot"></span>',.2)}</div></div>${A('<div class="pt-note">משותפים לכל המשפחות</div>',2.4)}`},
  {t:'🃏 הטרן והריבר',say:'אחר כך נפתח קלף רביעי — הטרן — ועוד סבב הימורים. ובסוף קלף חמישי — הריבר — והסבב האחרון.',
   stage:()=>`<div class="pt-felt"><div class="pt-row">${cardHtml('9c')}${cardHtml('Kh')}${cardHtml('4s')}${A(cardHtml('Kd'),.8,'pt-flip')}${A(cardHtml('2h'),4,'pt-flip')}</div></div>
     <div class="pt-row pt-lbls">${A('<small>טרן ←</small>',1.2)}${A('<small>ריבר ←</small>',4.4)}</div>`},
  {t:'✋ היד שלכם',say:'היד שלכם היא חמשת הקלפים הכי טובים מתוך שבעה: שני הקלפים שלכם, וחמשת הקלפים שבאמצע. כאן, למשל, יש לכם פול האוס — שלוש תשיעיות ושני מלכים!',
   stage:()=>`<div class="pt-felt"><div class="pt-row">${A(cardHtml('9c'),.1,'pt-hl')}${A(cardHtml('Kh'),.1,'pt-hl')}${A(cardHtml('4s'),.1,'pt-dim')}${A(cardHtml('Kd'),.1,'pt-hl')}${A(cardHtml('2h'),.1,'pt-dim')}</div></div>
     <div class="pt-pl me"><b class="pt-you">שלכם</b><div class="pt-row">${A(cardHtml('9s'),.1,'pt-hl')}${A(cardHtml('9d'),.1,'pt-hl')}</div></div>${A('<div class="pt-big">פול האוס! 🎉</div>',5.5)}`},
  {t:'🏅 סדר הידיים — מהחזקה לחלשה',dur:16,say:'וזה הסדר של הידיים, מהחזקה לחלשה: רויאל פלאש, רצף בצבע, רביעייה, פול האוס, צבע, רצף, שלישייה, שני זוגות, זוג, ובסוף — קלף גבוה.',
   stage:()=>{const H=[['רויאל פלאש','As Ks Qs Js Ts'],['רצף בצבע','9h 8h 7h 6h 5h'],['רביעייה','Qc Qd Qh Qs 3d'],['פול האוס','9c 9d 9s Kh Kd'],['צבע','Ad Jd 8d 5d 2d'],['רצף','Ts 9h 8c 7d 6s'],['שלישייה','7c 7d 7s Kh 2c'],['שני זוגות','Jc Jd 4s 4h Ad'],['זוג','Ac Ad 9s 6h 3c'],['קלף גבוה','Ah Jc 8d 5s 2c']];
     return `<div class="pt-ranks">${H.map(([n,c],i)=>A(`<div class="pt-rk"><span class="pt-rkn">${i+1}. ${n}</span><span class="pt-row">${c.split(' ').map(x=>cardHtml(x,'sm')).join('')}</span></div>`,1+i*1.05)).join('')}</div>`;}},
  {t:'🏆 מי מנצח?',say:'בסוף, מי שעוד במשחק חושפים את הקלפים, והיד הכי טובה לוקחת את הקופה. ואם כל השאר קיפלו — לוקחים את הקופה בלי להראות כלום!',
   stage:()=>{const f=demoFams();return `<div class="pt-players">
     <div class="pt-pl">${demoAva(f[1],32)}<div class="pt-row">${A(cardHtml('Qc','sm'),.8,'pt-flip')}${A(cardHtml('Jd','sm'),1,'pt-flip')}</div>${A('<small>זוג</small>',1.6)}</div>
     <div class="pt-pl">${demoAva(f[0],32)}<div class="pt-row">${A(cardHtml('9s','sm'),.8,'pt-flip')}${A(cardHtml('9d','sm'),1,'pt-flip')}</div>${A('<small class="pt-win">פול האוס 🏆</small>',2.6)}</div></div>
     ${A('<div class="pt-note">+ הקופה עוברת למנצחים</div>',3.4)}`;}},
  {t:'💡 עוד כמה דברים',say:'אול-אין זה לשים את כל הצ׳יפים שלכם בבת אחת. ואם נגמרו לכם הצ׳יפים — אפשר לבקש הלוואה ממשפחה אחרת. זהו, אתם מוכנים! בהצלחה, ושיהיה משחק כיף!',
   stage:()=>`<div class="pt-acts">
     ${A('<div><span class="pk-btn pk-gold">אול-אין</span><small>כל הצ׳יפים בבת אחת</small></div>',.5)}
     ${A('<div><span class="pk-btn pk-ghost">🙏 הלוואה</span><small>נגמרו הצ׳יפים? מבקשים ממשפחה אחרת</small></div>',4)}</div>
     ${A('<div class="pt-big">בהצלחה! 🍀</div>',8)}`}
];
function tutDur(sc){return (sc.dur||Math.max(6,sc.say.length*0.075+1.5))*1000;}
function heVoice(){
  if(T_.voice!==null)return T_.voice;
  try{const vs=speechSynthesis.getVoices();if(!vs.length)return null;T_.voice=vs.find(v=>/^he|^iw/i.test(v.lang))||false;}catch(e){T_.voice=false;}
  return T_.voice;
}
function canSpeak(){return !!(window.speechSynthesis&&heVoice());}
function stopSpeech(){try{if(window.speechSynthesis)speechSynthesis.cancel();}catch(e){}T_.utt=null;}
function speak(text){
  stopSpeech();T_.spoke=false;
  if(T_.muted||!canSpeak())return;
  try{const u=new SpeechSynthesisUtterance(text);u.lang='he-IL';u.voice=heVoice();u.rate=1;
    u.onend=()=>{if(T_.utt===u){T_.spoke=true;}};T_.utt=u;speechSynthesis.speak(u);}catch(e){}
}
function tutOpen(){
  ensureOverlay();
  let el=$('pkTut');
  if(!el){el=document.createElement('div');el.id='pkTut';$('pokerOverlay').appendChild(el);}
  el.innerHTML=`<div class="pt-bars">${TUT.map((_,i)=>`<span class="pt-bar" onclick="pokerUI.tut.go(${i})"><i></i></span>`).join('')}</div>
    <button class="pt-x" onclick="pokerUI.tut.close()" aria-label="סגירה">✕</button>
    <div class="pt-screen"><div class="pt-title" id="ptTitle"></div><div class="pt-stage" id="ptStage"></div></div>
    <div class="pt-cap" id="ptCap"></div>
    <div class="pt-ctl"><button onclick="pokerUI.tut.prev()" aria-label="הקודם">⏭</button><button class="pt-play" id="ptPlay" onclick="pokerUI.tut.play()">⏸</button><button onclick="pokerUI.tut.next()" aria-label="הבא">⏮</button><button id="ptMute" onclick="pokerUI.tut.mute()"></button></div>`;
  // voices load asynchronously on some browsers
  try{if(window.speechSynthesis&&!speechSynthesis.getVoices().length)speechSynthesis.onvoiceschanged=()=>{T_.voice=null;tutMuteUI();};}catch(e){}
  T_.playing=true;tutGo(0);
}
function tutMuteUI(){const b=$('ptMute');if(!b)return;const ok=canSpeak();b.textContent=!ok?'🔇':T_.muted?'🔇':'🔊';b.title=ok?'קול':'אין קול עברי במכשיר — יש כתוביות';b.style.opacity=ok?1:.4;}
function tutGo(i){
  if(!$('pkTut'))return;
  if(i<0)i=0;
  if(i>=TUT.length){T_.playing=false;T_.i=TUT.length-1;tutBars();$('ptPlay').textContent='↻';stopSpeech();return;}
  T_.i=i;T_.el=0;T_.t0=now();
  const sc=TUT[i];
  $('ptTitle').textContent=sc.t;
  $('ptStage').innerHTML=sc.stage();
  $('ptCap').textContent=sc.say;
  $('pkTut').classList.toggle('paused',!T_.playing);
  $('ptPlay').textContent=T_.playing?'⏸':'▶';
  tutMuteUI();
  if(T_.playing)speak(sc.say);else stopSpeech();
  tutBars();
  clearInterval(T_.timer);T_.timer=setInterval(tutTick,100);
}
function tutTick(){
  if(!$('pkTut')){clearInterval(T_.timer);return;}
  if(!T_.playing)return;
  const el=T_.el+(now()-T_.t0);
  const d=tutDur(TUT[T_.i]);
  tutBars(Math.min(1,el/d));
  // move on when the time is up — and, if it's talking, when it finished the line
  const talking=T_.utt&&!T_.spoke;
  if(el>=d&&(!talking||el>=d*2.2))tutGo(T_.i+1);
}
function tutBars(frac){
  document.querySelectorAll('#pkTut .pt-bar').forEach((b,i)=>{
    const w=i<T_.i?100:i>T_.i?0:Math.round((frac||0)*100);
    b.firstChild.style.width=w+'%';
  });
}
function tutToggle(){
  if(!$('pkTut'))return;
  if(!T_.playing&&T_.i===TUT.length-1&&$('ptPlay').textContent==='↻'){T_.playing=true;tutGo(0);return;}
  if(T_.playing){T_.playing=false;T_.el+=now()-T_.t0;try{speechSynthesis.pause();}catch(e){}}
  else{T_.playing=true;T_.t0=now();try{if(T_.utt)speechSynthesis.resume();else speak(TUT[T_.i].say);}catch(e){}}
  $('pkTut').classList.toggle('paused',!T_.playing);
  $('ptPlay').textContent=T_.playing?'⏸':'▶';
}
function tutMute(){
  if(!canSpeak()){toast('אין במכשיר הזה קול בעברית — הכתוביות מופיעות למטה');return;}
  T_.muted=!T_.muted;lsSet('pkTutMute',T_.muted);
  if(T_.muted)stopSpeech();else if(T_.playing)speak(TUT[T_.i].say);
  tutMuteUI();
}
function tutClose(){clearInterval(T_.timer);stopSpeech();const el=$('pkTut');if(el)el.remove();}

// Start listening for invites once the app has loaded the families.
function boot(){
  if(!allFams().length||typeof fbInit!=='function'&&!window.POKER_FAKE_FS){setTimeout(boot,1500);return;}
  S.fid=resolveFam();
  subscribeLobby();homeUpdate();
}
setTimeout(boot,1200);
window.addEventListener('resize',()=>{if(S.view==='table')fitTable();});

window.openPokerOverlay=open;
window.closePokerOverlay=close;
window.pokerUI={
  back,deal:()=>deal(false),kick:kickSlow,leave:leaveTable,resetBanks,
  openTable,
  setFam(id){S.fid=id;lsSet('pkFam',id);render();homeUpdate();},
  changeFam(){S.fid=null;render();},
  act(type,amount){doAct(type,amount);},
  setRaise(v,quiet){S.raise=v;if(quiet){const el=document.querySelector('.pk-raise-val b');if(el)el.textContent=fmt(v);const go=document.querySelector('.pk-raise .pk-gold:last-child');if(go){go.setAttribute('onclick',`pokerUI.act('raise',${v})`);const H=S.T.hand,max=H.p[S.fid].bet+seatOf(S.T,S.fid).stack;go.textContent=v>=max?'אול-אין':'העלו ל-'+fmt(v);}return;}render();},
  openNew(){S.modal={kind:'new',sel:[],buy:defaultBuy()};render();},
  openInvite(){S.modal={kind:'invite',sel:[]};render();},
  openRebuy(){S.modal={kind:'rebuy',buy:defaultBuy()};render();},
  askJoin(tid){const t=(S.L.tables||{})[tid];if(t&&(t.players||[]).length>=MAX_SEATS){toast('השולחן מלא');return;}S.modal={kind:'join',tid,buy:defaultBuy()};render();},
  dismiss(tid){dismissInvite(tid);},
  toggleSel(id){const m=S.modal;const i=m.sel.indexOf(id);if(i>=0)m.sel.splice(i,1);else m.sel.push(id);render();},
  pickBuy(x){S.modal.buy=x;render();},
  closeModal(){S.modal=null;render();},
  confirmModal(){
    const m=S.modal;S.modal=null;render();
    if(m.kind==='new')createTable(m.sel,m.buy);
    else if(m.kind==='invite')inviteMore(m.sel);
    else if(m.kind==='join')joinTable(m.tid,m.buy);
    else if(m.kind==='rebuy')rebuy(m.buy);
    else if(m.kind==='loan')requestLoan(m.to,m.buy);
  },
  bannerGo(key,tid){markSeen(key);open();if(tid){S.modal={kind:'join',tid,buy:defaultBuy()};}else{S.view='lobby';}render();},
  bannerX(key){markSeen(key);},
  openLoan(){S.modal={kind:'loan',to:null,buy:2000};render();},
  pickTo(id){S.modal.to=id;render();},
  answerLoan(id,yes){answerLoan(id,yes);},
  repayLoan(id){repayLoan(id);},
  forgiveLoan(id){forgiveLoan(id);},
  cancelLoan(id){cancelLoan(id);},
  tutorial(){tutOpen();},
  tut:{play:tutToggle,next:()=>tutGo(T_.i+1),prev:()=>tutGo(T_.i-1),go:i=>tutGo(i),mute:tutMute,close:tutClose}
};
// exposed for tests
window.__poker={eval5,best7,startHand,act,canStart,pot,S};
})();
