const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const rooms = new Map();
const MAX_PLAYERS = 12;
const names = ['Forward Pulse','Reverse Pulse','Double Pulse','Chaos Shift','Reset Signal','Mirror Flip','Quantum Jump'];
const mime = {'.png':'image/png','.ico':'image/x-icon','.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
const rand = n => crypto.randomInt(n);
const uid = n => crypto.randomBytes(n).toString('hex');
const shuffled = a => { const b=[...a]; for(let i=b.length-1;i>0;i--){const j=rand(i+1);[b[i],b[j]]=[b[j],b[i]];} return b; };
const blankRoom = (code, host) => ({code,host,adminSeat:null,adminIds:[],variant:'classic',cluePrice:2,publicClues:[],purchased:{},rankings:[],rankingRound:0,lastAdminId:null,players:[],spectators:[],phase:'lobby',round:0,roundLimit:6,startingPoints:10,revealReward:2,verifyReward:-1,interfereReward:-2,cardReward:1,oneDialReward:1,twoDialReward:3,turn:0,acted:0,order:[],roundStarter:0,publicVersion:null,version:0,state:null,history:[],deck:[],discard:[],log:[],adminLog:[],audit:[],roundStart:0,roundEnd:null,winners:[],endReason:null,clues:{},hands:{},verified:{},predictions:{},earned:{},roomEvents:[]});

function applyCard(room, card, dial) {
  const i='ABC'.indexOf(dial), old=room.state[i]; let value;
  if(card==='Forward Pulse') value=(old+1)%4;
  else if(card==='Reverse Pulse') value=(old+3)%4;
  else if(card==='Double Pulse') value=(old+2)%4;
  else if(card==='Overload') value=(old+3)%4;
  else if(card==='Chaos Shift') { const values=[0,1,2,3].filter(v=>v!==old); value=values[rand(3)]; }
  else if(card==='Quantum Jump') value=room.version>0?room.history[room.version-1][i]:old;
  else if(card==='Reset Signal') value=old===0?2:0;
  else value=3-old;
  room.state[i]=value; room.version++; room.history[room.version]=[...room.state]; room.discard.push(card);
}

function refreshEventClues(room,dial){
  const version=room.version-1,index='ABC'.indexOf(dial);
  room.publicVersion=room.version;
  for(const player of room.players){
    const clues=room.clues[player.id]||[],matches=clues.filter(c=>c.dial===dial);
    if(!matches.length)continue;
    const newest=matches.reduce((a,b)=>b.dealtRound>a.dealtRound?b:a);
    const updated={...newest,id:uid(5),version,value:room.history[version][index]};
    room.clues[player.id]=[...clues.filter(c=>c.dial!==dial),updated];
    const removed=new Set(matches.map(c=>c.id));
    room.verified[player.id]=(room.verified[player.id]||[]).filter(v=>!removed.has(v.clueId));
    addAudit(room,{player:player.name,action:`Event Card refreshed dial ${dial} clue to V${version} = ${updated.value}`});
  }
  if(room.variant!=='classic'){const refreshed=room.publicClues.map(c=>c.dial===dial?{...c,id:uid(5),version,value:room.history[version][index]}:c),unique=new Map();for(const c of refreshed){const key=`${c.version}:${c.dial}`;if(!unique.has(key)||!c.owner)unique.set(key,c);}room.publicClues=[...unique.values()];}
  excludePublicClues(room);
  addLog(room,`Event Card resolved: current Version ${room.version}. Existing dial ${dial} clues now refer to Version ${version}.`);
}

function draw(room,allowQuantum=true){const indices=room.deck.map((card,i)=>({card,i})).filter(x=>allowQuantum||x.card!=='Quantum Jump');if(!indices.length)return null;return room.deck.splice(indices[rand(indices.length)].i,1)[0];}
function randomClue(room,version,usedDials=[],dealtRound=room.round){ const available='ABC'.split('').filter(d=>!usedDials.includes(d));if(!available.length)return null;const dial=available[rand(available.length)];return {id:uid(5),version,dial,value:room.history[version]['ABC'.indexOf(dial)],dealtRound}; }
function addLog(room,text){room.log.push({text,at:Date.now()});room.log=room.log.slice(-40);}
function addAdminLog(room,text){room.adminLog.unshift({text,at:Date.now()});room.adminLog=room.adminLog.slice(0,400);}
function addAudit(room,{player='',clues='',action='',prediction='',points=''}={}){room.audit.push({round:room.round||0,player,clues,action,prediction,points,at:Date.now()});if(room.audit.length>4000)room.audit.splice(0,room.audit.length-4000);}
function isAdmin(room,id){return Array.isArray(room.adminIds)?room.adminIds.includes(id):room.host===id;}
const fmtPts=n=>n<0?`−${-n}`:`+${n}`;
const pointsPhrase=n=>n<0?`loses ${-n} point${-n===1?'':'s'}`:n>0?`gains ${n} point${n===1?'':'s'}`:'keeps the same points';
const canAfford=(p,reward)=>p.points+reward>=0;
const everyone=room=>[...room.players,...room.spectators,...(room.adminSeat?[room.adminSeat]:[])];
function dropAdmin(room,id){const had=room.adminIds.includes(id);room.adminIds=room.adminIds.filter(x=>x!==id);if(had&&!room.adminIds.length)room.lastAdminId=id;}
// When nobody holds admin access, the last admin (or, if they have left the room, the first player) may start the game and continue rounds. This is not admin access.
function caretaker(room){if((room.adminIds||[]).length)return null;const last=everyone(room).find(x=>x.id===room.lastAdminId);return last?last.id:(room.players[0]?.id||null);}
function releaseAdminSeat(room,id){if(room.adminSeat?.id===id){room.spectators.push(room.adminSeat);room.adminSeat=null;}}
function serial(room, player) {
  const active=room.players.find(p=>p.id===player),spectator=room.spectators.find(p=>p.id===player),adminOnly=room.adminSeat?.id===player,own=active||spectator||(adminOnly?room.adminSeat:null),admin=isAdmin(room,player),starterId=caretaker(room),isStarter=starterId===player,starterPerson=starterId?everyone(room).find(x=>x.id===starterId):null;
  return {
    code:room.code,variant:room.variant,cluePrice:room.cluePrice,publicClues:room.publicClues||[],boughtClue:room.purchased?.[player]===room.round, rankings:room.rankings||[], rankingRound:room.rankingRound||0, phase:room.phase, round:room.round, roundLimit:room.roundLimit, startingPoints:room.startingPoints,revealReward:room.revealReward,verifyReward:room.verifyReward,interfereReward:room.interfereReward,cardReward:room.cardReward,oneDialReward:room.oneDialReward,twoDialReward:room.twoDialReward,endReason:room.endReason, turnPlayer:room.players[room.turn]?.id||null,
    publicVersion:room.publicVersion, roundStart:room.roundStart, roundEnd:room.roundEnd,
    finalState:room.phase==='finished'?[...room.state]:null, finalVersion:room.phase==='finished'?room.version:null,
    players:room.players.map(p=>({id:p.id,name:p.name,points:p.id===player||admin?p.points:undefined,host:isAdmin(room,p.id),admin:isAdmin(room,p.id),connected:!!p.socket,ready:!!room.predictions[p.id]})),
    spectators:room.spectators.map(p=>({id:p.id,name:p.name,host:isAdmin(room,p.id),admin:isAdmin(room,p.id),connected:!!p.socket})),
    admins:(room.adminIds||[]).map(id=>{const person=room.players.find(p=>p.id===id)||room.spectators.find(p=>p.id===id)||(room.adminSeat?.id===id?room.adminSeat:null);return person?{id,name:person.name,adminOnly:room.adminSeat?.id===id}:null}).filter(Boolean),
    you:own?{id:own.id,name:own.name,points:own.points,host:admin,admin,adminOnly,starter:isStarter,spectator:!!spectator}:null,
    clues:active?room.clues[active.id]||[]:[], hands:active?room.hands[active.id]||[]:[],
    verified:active?room.verified[active.id]||[]:[], predictions:room.players.map(p=>({id:p.id,name:p.name,locked:!!room.predictions[p.id],earned:(room.phase==='reveal'||(room.phase==='finished'&&room.endReason==='points'))&&p.id===player?room.earned[p.id]||0:undefined})),
    log:room.log, winners:room.winners, deckCount:room.deck.length,
    canAct:room.phase==='actions'&&room.players[room.turn]?.id===player,
    canStart:room.phase==='lobby'&&(admin||isStarter)&&room.players.length>=1,noAdmin:!(room.adminIds||[]).length,starterName:starterPerson?.name||null,canNext:room.phase==='reveal'&&(!!active||admin||isStarter),canTakeSeat:room.phase==='lobby'&&!active&&(adminOnly||!!spectator)&&(admin||isStarter)&&room.players.length<MAX_PLAYERS,canStepOut:room.phase==='lobby'&&!!active&&admin,
    actionIndex:room.acted, roomEvents:room.roomEvents, previousVersions:Array.from({length:room.version},(_,version)=>version),adminLog:admin?room.adminLog:[],adminAudit:admin?room.audit:[],adminView:admin?{currentEngine:room.state?[...room.state]:null,currentVersion:room.version,players:room.players.map(p=>({id:p.id,name:p.name,points:p.points,connected:!!p.socket,hand:room.hands[p.id]||[],clues:room.clues[p.id]||[],verified:room.verified[p.id]||[],prediction:room.predictions[p.id]?.values||null}))}:null
  };
}
function send(ws,obj){ if(ws&&ws.readyState===1) ws.send(JSON.stringify(obj)); }
function broadcast(room){ for(const p of [...room.players,...room.spectators,...(room.adminSeat?[room.adminSeat]:[])]) if(p.socket) send(p.socket,{type:'state',state:serial(room,p.id)}); }
function error(ws,message){send(ws,{type:'error',message});}
// Each round has a fixed turn order that starts at roundStarter and wraps around the table, so every active player acts exactly once.
function syncTurn(room){const i=room.players.findIndex(p=>p.id===room.order[room.acted]);room.turn=i<0?room.players.length:i;}
function beginRound(room){const n=room.players.length;room.order=n?Array.from({length:n},(_,i)=>room.players[(room.roundStarter+i)%n].id):[];room.acted=0;syncTurn(room);}
function advance(room){room.acted++;syncTurn(room);if(room.acted>=room.order.length){room.phase='predict';addLog(room,'All actions are in. Lock your three-dial prediction.');}}
function moveSeat(room,id,{spectate=false}={}){
  const index=room.players.findIndex(p=>p.id===id);
  if(index>=0){
    const [p]=room.players.splice(index,1);
    const oi=room.order.indexOf(id);if(oi>=0){room.order.splice(oi,1);if(oi<room.acted)room.acted--;}
    if(index<room.roundStarter)room.roundStarter--;
    if(spectate)room.spectators.push(p);
    else{delete room.clues[id];delete room.hands[id];delete room.verified[id];}
    delete room.predictions[id];delete room.earned[id];
    room.roundStarter=room.players.length?((room.roundStarter%room.players.length)+room.players.length)%room.players.length:0;
    syncTurn(room);if(room.phase==='actions'&&room.acted>=room.order.length){room.phase='predict';addLog(room,'All remaining players have acted. Lock your prediction.');}
    if(room.phase==='predict'&&room.players.length&&room.players.every(x=>room.predictions[x.id]))scorePredictions(room);
    return p;
  }
  const spectatorIndex=room.spectators.findIndex(p=>p.id===id);
  if(spectatorIndex>=0){const [p]=room.spectators.splice(spectatorIndex,1);return p;}
  return null;
}
function excludePublicClues(room){
 if(room.variant==='classic')return;
 const keys=new Set(room.publicClues.map(c=>`${c.version}:${c.dial}`));
 for(const p of room.players){
  const removed=new Set((room.clues[p.id]||[]).filter(c=>keys.has(`${c.version}:${c.dial}`)).map(c=>c.id));
  room.clues[p.id]=(room.clues[p.id]||[]).filter(c=>!removed.has(c.id));
  room.verified[p.id]=(room.verified[p.id]||[]).filter(v=>!removed.has(v.clueId));
 }
}
function dealVariantRound(room){
 if(room.variant==='classic')return;
 const version=Math.max(0,room.version-1),clue=randomClue(room,version);
 room.publicClues=[...room.publicClues.filter(c=>c.owner&&!(c.version===clue.version&&c.dial===clue.dial)),{...clue,source:'system'}];
 for(const p of room.players){const used=[...room.publicClues,...(room.clues[p.id]||[])].filter(c=>c.version===version).map(c=>c.dial),privateClue=room.variant==='mixed'?randomClue(room,version,used):null,dealt=privateClue?[privateClue]:[];room.clues[p.id]=[...(room.clues[p.id]||[]),...dealt];room.verified[p.id]=[];for(const c of dealt)addAudit(room,{player:p.name,clues:`V${c.version} · Dial ${c.dial} = ${c.value}`});}
 excludePublicClues(room);
 addAudit(room,{player:'Public',clues:`V${clue.version} · Dial ${clue.dial} = ${clue.value}`});
}
function start(room){
  if(room.players.length<1||room.players.length>MAX_PLAYERS||room.phase!=='lobby')return false;
  room.round=1;
  room.state=[rand(4),rand(4),rand(4)];room.history=[[...room.state]];room.version=0;
  room.deck=names.flatMap(n=>Array(4).fill(n));room.discard=[];
  for(let n=0;n<2;n++){const card=draw(room,false);if(card)applyCard(room,card,'ABC'[rand(3)]);}
  room.audit=[];room.players.forEach(p=>{p.points=room.startingPoints;const first=randomClue(room,0);room.clues[p.id]=room.variant==='classic'?[first,randomClue(room,0,[first.dial]),randomClue(room,1)]:[];room.hands[p.id]=[];room.verified[p.id]=[];for(const clue of room.clues[p.id])addAudit(room,{player:p.name,clues:`V${clue.version} · Dial ${clue.dial} = ${clue.value}`});addAudit(room,{player:p.name,action:`Shared Event Card supply ready`,points:`${p.points} starting points`});});
  room.publicVersion=room.version;room.roundStart=room.version;room.roundStarter=0;room.phase='actions';beginRound(room);room.log=[];room.predictions={};room.earned={};room.winners=[];room.endReason=null;room.roundEnd=null;room.roomEvents=[];room.publicClues=[];room.purchased={};dealVariantRound(room);
  addLog(room,`Round 1 begins at public Version ${room.publicVersion}. ${room.players[room.turn].name} takes the first turn.`);addAdminLog(room,`Game started: ${room.players.length} players, ${room.roundLimit} rounds.`);addAudit(room,{player:room.adminSeat?.name||'Room host',action:`Game started · ${room.players.length} players · ${room.roundLimit} rounds · first turn: ${room.players[room.turn].name}`});return true;
}
function roundStart(room){
  room.round++;room.predictions={};room.earned={};room.verified=Object.fromEntries(room.players.map(p=>[p.id,[]]));room.roundStarter=(room.roundStarter+1)%room.players.length;beginRound(room);room.publicVersion=room.version;room.roundStart=room.version;room.roundEnd=null;
  const v1=Math.max(0,room.version-2),v2=Math.max(0,room.version-1);
  if(room.variant==='classic')for(const p of room.players){for(const version of (v1===v2?[v2]:[v1,v2])){const used=room.clues[p.id].filter(c=>c.version===version).map(c=>c.dial);const clue=randomClue(room,version,used);if(clue){room.clues[p.id].push(clue);addAudit(room,{player:p.name,clues:`V${clue.version} · Dial ${clue.dial} = ${clue.value}`});}}}
  dealVariantRound(room);room.phase='actions';addLog(room,`Round ${room.round} begins at public Version ${room.publicVersion}. ${room.players[room.turn].name} takes the first turn.`);addAudit(room,{action:`Round begins · public V${room.publicVersion} · first turn: ${room.players[room.turn].name}`});
}

function snapshotRankings(room,perfectIds=[]){
  const rows=room.players.map(p=>({id:p.id,name:p.name,points:p.points,perfect:perfectIds.includes(p.id)})).sort((a,b)=>Number(b.perfect)-Number(a.perfect)||b.points-a.points);
  let rank=0;
  room.rankings=rows.map((p,i)=>{if(i===0||p.perfect!==rows[i-1].perfect||p.points!==rows[i-1].points)rank=i+1;return {id:p.id,name:p.name,rank};});
  room.rankingRound=room.round;
}

function scorePredictions(room){
  const results=room.players.map(p=>{const guess=room.predictions[p.id].values;return {player:p,correct:guess.reduce((n,v,i)=>n+(v===room.state[i]?1:0),0)}});
  const perfect=results.filter(r=>r.correct===3).map(r=>r.player);
  room.phase='reveal';
  for(const {player:p} of results){const guess=room.predictions[p.id].values,actual=room.state,before=p.points,parts=['A','B','C'].map((dial,i)=>`${dial}: guessed ${guess[i]}, actual ${actual[i]} ${guess[i]===actual[i]?'✓':'✗'}`);addAudit(room,{player:p.name,prediction:parts.join(' · '),points:`${before} before scoring`});}
  if(perfect.length){room.endReason='perfect';room.winners=perfect.map(p=>p.id);snapshotRankings(room,room.winners);room.roundEnd=room.version;room.phase='finished';addLog(room,`${perfect.map(p=>p.name).join(' and ')} ${perfect.length===1?'has':'have'} guessed all three dials. Version ${room.roundStart} → ${room.roundEnd}; no automatic event was applied.`);for(const p of room.players)addAudit(room,{player:p.name,points:`FINAL TOTAL: ${p.points}${room.winners.includes(p.id)?' · WINNER':''}`});return;}
  for(const {player:p,correct} of results){const before=p.points,raw=correct===2?room.twoDialReward:correct===1?room.oneDialReward:0,earned=Math.max(raw,-p.points);room.earned[p.id]=earned;p.points+=earned;addAudit(room,{player:p.name,points:`${before} → ${p.points} (${earned?`${fmtPts(earned)} for ${correct} correct dial${correct===1?'':'s'}`:'no prediction points'})`});}
  snapshotRankings(room);
  const card=draw(room);
  if(card){const dial='ABC'[rand(3)],i='ABC'.indexOf(dial),old=room.state[i];applyCard(room,card,dial);if(room.variant!=='classic')refreshEventClues(room,dial);addAudit(room,{player:'Automatic event',action:`${card} on ${dial}: ${old} → ${room.state[i]} (V${room.version})`});addLog(room,`Automatic event: Version ${room.version}.`);}else addLog(room,'No Event Cards remain. No automatic event this round.');
  room.roundEnd=room.version;
  if(room.round>=room.roundLimit){const high=Math.max(...room.players.map(p=>p.points));room.winners=room.players.filter(p=>p.points===high).map(p=>p.id);room.endReason='points';room.phase='finished';addLog(room,`${room.roundLimit} rounds complete. ${room.players.filter(p=>room.winners.includes(p.id)).map(p=>p.name).join(' and ')} ${room.winners.length===1?'wins':'share the win'} on points.`);for(const p of room.players)addAudit(room,{player:p.name,points:`FINAL TOTAL: ${p.points}${room.winners.includes(p.id)?' · WINNER':''}`});return;}
}
function handle(room,player,msg,ws){
  const p=room.players.find(x=>x.id===player);
  if(msg.type==='admin'){
    if(!isAdmin(room,player))return error(ws,'Only an admin can use admin controls.');
    if(msg.action==='settings'){
      if(room.phase==='finished')return error(ws,'This game is complete.');
      const fields=['roundLimit','startingPoints','revealReward','verifyReward','interfereReward','cardReward','oneDialReward','twoDialReward','cluePrice'],updated={};
      for(const key of fields){const value=Number(msg[key]);const signed=['revealReward','verifyReward','interfereReward','cardReward','oneDialReward','twoDialReward'].includes(key),min=key==='roundLimit'?1:signed?-20:0,max=key==='roundLimit'?12:key==='startingPoints'?100:20;if(!Number.isInteger(value)||value<min||value>max)return error(ws,`Invalid value for ${key}.`);updated[key]=value;}
      const variant=msg.variant||room.variant;if(!['classic','mixed','paid'].includes(variant))return error(ws,'Choose a valid variant.');if(room.phase!=='lobby'&&variant!==room.variant)return error(ws,'Choose the variant before starting.');room.variant=variant;Object.assign(room,updated);
      const text=`Game values updated: ${room.roundLimit} rounds; start ${room.startingPoints}; reveal ${fmtPts(room.revealReward)}; verify ${fmtPts(room.verifyReward)}; interfere ${fmtPts(room.interfereReward)}; card ${fmtPts(room.cardReward)}; guesses ${fmtPts(room.oneDialReward)}/${fmtPts(room.twoDialReward)}.`;addAdminLog(room,text);addAudit(room,{player:room.adminSeat?.name||room.players.find(x=>x.id===player)?.name||'Admin',action:text});broadcast(room);return;
    }
    if(msg.action==='adminRole'){
      const action=msg.roleAction,target=String(msg.playerId||'');
      if(action==='resign'){const name=room.adminSeat?.name||room.players.find(x=>x.id===player)?.name||room.spectators.find(x=>x.id===player)?.name||'An admin';releaseAdminSeat(room,player);dropAdmin(room,player);addAdminLog(room,`${name} left the admin role.`);addAudit(room,{player:name,action:'Left the admin role'});if(!room.adminIds.length)addLog(room,`${name} left the admin role. The room has no admin now. ${name} can still start the game and continue rounds, but has no other admin controls.`);broadcast(room);return;}
      const person=room.players.find(x=>x.id===target)||room.spectators.find(x=>x.id===target);
      if(!person||target===player)return error(ws,'Choose another player or spectator.');
      if(action==='grant'){if(!isAdmin(room,target))room.adminIds.push(target);}
      else if(action==='revoke'){dropAdmin(room,target);}
      else if(action==='transfer'){if(!isAdmin(room,target))room.adminIds.push(target);releaseAdminSeat(room,player);dropAdmin(room,player);}
      else return error(ws,'Unknown admin role action.');
      const text=action==='grant'?`${person.name} was made an admin.`:action==='revoke'?`${person.name} no longer has admin access.`:`Admin access transferred to ${person.name}.`;
      addAdminLog(room,text);addAudit(room,{player:person.name,action:text});broadcast(room);return;
    }
    if(msg.action==='spectate'||msg.action==='remove'){
      const target=String(msg.playerId||'');if(!target||target===player)return error(ws,'You cannot remove yourself through this control.');
      const moved=moveSeat(room,target,{spectate:msg.action==='spectate'});if(!moved)return error(ws,'That participant is no longer in the room.');if(msg.action==='remove'&&moved.socket){send(moved.socket,{type:'removed'});moved.socket.close();}
      if(msg.action==='remove')dropAdmin(room,target);
      const text=msg.action==='spectate'?`${moved.name} was moved to spectators.`:`${moved.name} was removed from the room.`;addAdminLog(room,text);addAudit(room,{player:moved.name,action:text});broadcast(room);return;
    }
    return error(ws,'Unknown admin action.');
  }
  if(msg.type==='leave'){
    if(room.adminSeat?.id===player){dropAdmin(room,player);room.adminSeat=null;if(room.host===player)room.host=room.players[0]?.id||room.adminIds[0]||null;if(!room.players.length&&!room.spectators.length){rooms.delete(room.code);return;}broadcast(room);return;}
    const wasHost=player===room.host;const leaving=moveSeat(room,player);if(!leaving)return error(ws,'You are no longer in the room.');addAdminLog(room,`${leaving.name} left the room.`);addAudit(room,{player:leaving.name,action:'Left the room'});
    dropAdmin(room,player);
    if(wasHost){if(room.players.length)room.host=room.players[0].id;else if(room.spectators.length||room.adminSeat)room.host=room.adminIds[0]||room.adminSeat?.id||null;else{rooms.delete(room.code);return;}}
    if(!room.players.length&&!room.spectators.length&&!room.adminSeat){rooms.delete(room.code);return;}
    broadcast(room);return;
  }
  const runner=isAdmin(room,player)||caretaker(room)===player;
  if(msg.type==='start'){if(!runner)return error(ws,'Only an admin can start the game.');if(!start(room))return error(ws,'A game needs at least one active player and no more than 12.');broadcast(room);return;}
  if(msg.type==='seat'){
    if(room.phase!=='lobby')return error(ws,'Seats can only be changed before the game starts.');
    if(msg.action==='play'){
      if(p)return error(ws,'You already have a seat.');if(!runner)return error(ws,'Only an admin can take a seat this way.');if(room.players.length>=MAX_PLAYERS)return error(ws,'All seats are taken.');
      let person=null;if(room.adminSeat?.id===player){person=room.adminSeat;room.adminSeat=null;}else{const i=room.spectators.findIndex(x=>x.id===player);if(i>=0)[person]=room.spectators.splice(i,1);}
      if(!person)return error(ws,'You are no longer in the room.');
      person.points=0;room.players.push(person);const text=`${person.name} joined as a player.`;addAdminLog(room,text);addAudit(room,{player:person.name,action:text});broadcast(room);return;
    }
    if(msg.action==='watch'){
      if(!p)return error(ws,'You are not in a seat.');if(!isAdmin(room,player))return error(ws,'Only an admin can step out of a seat.');
      const person=moveSeat(room,player);if(!person)return error(ws,'You are no longer in the room.');
      if(!room.adminSeat)room.adminSeat=person;else room.spectators.push(person);
      const text=`${person.name} stepped out of the game.`;addAdminLog(room,text);addAudit(room,{player:person.name,action:text});broadcast(room);return;
    }
    return error(ws,'Unknown seat action.');
  }
  if(msg.type==='next'&&runner&&!p){if(room.phase!=='reveal')return error(ws,'The next round is not ready.');roundStart(room);broadcast(room);return;}
  if(!p)return;
  if(msg.type==='buyClue'){
    if(!p||room.variant!=='paid'||room.phase!=='actions'||room.players[room.turn]?.id!==player)return error(ws,'Buy a clue before your action on your turn.');
    if(room.purchased[player]===room.round)return error(ws,'You already bought a clue this round.');
    if(p.points<room.cluePrice)return error(ws,'Not enough points to buy a clue.');
    const version=Math.max(0,room.version-1),used=[...(room.clues[player]||[]),...room.publicClues].filter(c=>c.version===version).map(c=>c.dial),clue=randomClue(room,version,used);
    if(!clue)return error(ws,'No private clue is available for this version beyond your existing clues and the public clues.');
    const before=p.points;p.points-=room.cluePrice;room.clues[player].push(clue);room.purchased[player]=room.round;addAudit(room,{player:p.name,clues:`Bought V${clue.version} · Dial ${clue.dial} = ${clue.value}`,points:`${before} → ${p.points}`});broadcast(room);return;
  }
  if(msg.type==='action'){
    if(room.phase!=='actions'||room.players[room.turn]?.id!==player)return error(ws,'It is not your action turn.');
    const a=msg.action;
    if(a==='reveal'){
      const clue=room.clues[player]?.find(c=>c.id===msg.clueId&&c.dealtRound===room.round);if(!clue)return error(ws,'Choose a fresh clue from this round to reveal.');
      if(room.roomEvents.some(e=>e.clue?.version===clue.version&&e.clue?.dial===clue.dial)||(room.publicClues||[]).some(c=>c.version===clue.version&&c.dial===clue.dial))return error(ws,'That clue is already public.');
      if(!canAfford(p,room.revealReward))return error(ws,`Revealing costs ${-room.revealReward} points and you have ${p.points}.`);const before=p.points;p.points+=room.revealReward;room.roomEvents.push({id:uid(4),clue:{...clue,owner:p.name}});if(room.variant!=='classic'){room.publicClues.push({...clue,owner:p.name});excludePublicClues(room);}const text=`Revealed V${clue.version}, dial ${clue.dial} = ${clue.value}`;addAdminLog(room,`${p.name} ${text}.`);addAudit(room,{player:p.name,action:text,points:`${before} → ${p.points}`});advance(room);
    } else if(a==='verify'){
      if(!canAfford(p,room.verifyReward))return error(ws,`You need at least ${-room.verifyReward} points to verify.`);const clue=room.clues[player]?.find(c=>c.id===msg.clueId);if(!clue)return error(ws,'Choose one of your clues first.');const before=p.points;p.points+=room.verifyReward;const yes=room.state['ABC'.indexOf(clue.dial)]===clue.value;room.verified[player].unshift({clueId:clue.id,answer:yes,round:room.round});room.verified[player]=room.verified[player].slice(0,20);const text=`Verified V${clue.version}, dial ${clue.dial} = ${clue.value}: ${yes?'MATCH':'NO MATCH'}`;addAdminLog(room,`${p.name} ${text}.`);addAudit(room,{player:p.name,action:text,points:`${before} → ${p.points}`});advance(room);
    } else if(a==='interfere'){
      if(!canAfford(p,room.interfereReward))return error(ws,`You need at least ${-room.interfereReward} points to interfere.`);if(!'ABC'.includes(msg.dial)||![-1,1].includes(msg.direction))return error(ws,'Choose a dial and a direction.');const before=p.points,i='ABC'.indexOf(msg.dial),old=room.state[i];p.points+=room.interfereReward;room.state[i]=(room.state[i]+msg.direction+4)%4;room.version++;room.history[room.version]=[...room.state];
      const text=`Interfered with dial ${msg.dial}: ${old} → ${room.state[i]} (Version ${room.version})`;addAdminLog(room,`${p.name} ${text}.`);addAudit(room,{player:p.name,action:text,points:`${before} → ${p.points}`});advance(room);
    } else if(a==='card'){
      if(!room.deck.length)return error(ws,'No Event Cards remain. Choose another action.');
      if(!/^[ABC]$/.test(msg.dial))return error(ws,'Choose a target dial.');
      const target=room.version-1;
      if(!canAfford(p,room.cardReward))return error(ws,'Not enough points to play an Event Card.');
      const card=draw(room),before=p.points,i='ABC'.indexOf(msg.dial),old=room.state[i];
      if(card==='Quantum Jump'){room.state[i]=room.history[target][i];room.version++;room.history[room.version]=[...room.state];room.discard.push(card);}else applyCard(room,card,msg.dial);
      p.points+=room.cardReward;addLog(room,`${p.name} plays a random Event Card on dial ${msg.dial} and ${pointsPhrase(room.cardReward)}.`);
      addAudit(room,{player:p.name,action:`Random ${card} on ${msg.dial}: ${old} → ${room.state[i]} (V${room.version})${card==='Quantum Jump'?` · restored V${target}`:''}`,points:`${before} → ${p.points}`});
      refreshEventClues(room,msg.dial);advance(room);
    } else return error(ws,'Unknown action.');
    broadcast(room);return;
  }
  if(msg.type==='predict'){
    if(room.phase!=='predict')return error(ws,'Predictions are not open yet.');if(room.predictions[player])return error(ws,'Your prediction is already locked.');if(!Array.isArray(msg.values)||msg.values.length!==3||msg.values.some(v=>!Number.isInteger(v)||v<0||v>3))return error(ws,'Choose values from 0 to 3 for A, B and C.');room.predictions[player]={values:msg.values};addAdminLog(room,`${p.name} locked a prediction: A ${msg.values[0]}, B ${msg.values[1]}, C ${msg.values[2]}.`);addAudit(room,{player:p.name,prediction:`Locked: A ${msg.values[0]} · B ${msg.values[1]} · C ${msg.values[2]}`});
    if(room.players.every(x=>room.predictions[x.id]))scorePredictions(room);
    broadcast(room);return;
  }
  if(msg.type==='next'){
    if(room.phase!=='reveal')return error(ws,'The next round is not ready.');roundStart(room);broadcast(room);return;
  }
}

const server=http.createServer((req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'content-type':'text/plain'});return res.end('ok');}
  const pathname=new URL(req.url,'http://localhost').pathname;
  const file=pathname==='/'?'index.html':pathname.slice(1);
  const full=path.resolve(ROOT,file);
  if(!full.startsWith(ROOT+path.sep)){res.writeHead(403);return res.end('Forbidden');}
  fs.readFile(full,(e,data)=>{if(e){res.writeHead(404);return res.end('Not found');}res.writeHead(200,{'content-type':mime[path.extname(full)]||'application/octet-stream','cache-control':'no-cache'});res.end(data);});
});
server.on('upgrade',(req,socket)=>{
  if(req.headers.upgrade?.toLowerCase()!=='websocket'||!req.headers['sec-websocket-key'])return socket.destroy();
  const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const ws={socket,readyState:1,buffer:Buffer.alloc(0),send(data){const body=Buffer.from(data);let head;if(body.length<126){head=Buffer.from([0x81,body.length]);}else if(body.length<65536){head=Buffer.from([0x81,126,body.length>>8,body.length&255]);}else{head=Buffer.alloc(10);head[0]=0x81;head[1]=127;head.writeBigUInt64BE(BigInt(body.length),2);}socket.write(Buffer.concat([head,body]));},close(){this.readyState=3;socket.end(Buffer.from([0x88,0x00]));}};
  let room=null,player=null;
  function join(code,id,name,adminOnly=false){
    if(room&&player){const prior=room;const old=[...prior.players,...prior.spectators,...(prior.adminSeat?[prior.adminSeat]:[])].find(x=>x.id===player);if(old?.socket===ws)old.socket=null;broadcast(prior);}
    code=String(code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);name=String(name||'').trim().slice(0,18);
    if(!/^[A-Z0-9]{4,6}$/.test(code)||name.length<1)return error(ws,'Enter a room code and a name.');
    room=rooms.get(code);const freshRoom=!room;if(!room){if(id)return error(ws,'That room has closed. Create a new room.');room=blankRoom(code,null);rooms.set(code,room);}
    let p=room.players.find(x=>x.id===id)||room.spectators.find(x=>x.id===id);
    if(id&&room.adminSeat?.id===id){p=room.adminSeat;if(p.socket&&p.socket!==ws)p.socket.close();p.socket=ws;p.name=name||p.name;player=p.id;}
    else if(p){if(p.socket&&p.socket!==ws){p.socket.close();}p.socket=ws;p.name=name||p.name;player=p.id;}
    else {if(id)return error(ws,'Your seat is no longer in this room.');if(adminOnly){if(!freshRoom||room.host||room.players.length||room.spectators.length)return error(ws,'An admin-only room must be created as a new room.');player=uid(12);room.adminSeat={id:player,name,socket:ws,points:0};room.host=player;room.adminIds.push(player);p=room.adminSeat;}else if(room.players.length+room.spectators.length>=24)return error(ws,'This room has reached its participant limit.');if(!adminOnly){player=uid(12);p={id:player,name,points:0,socket:ws};if(room.phase==='lobby'&&room.players.length<MAX_PLAYERS){room.players.push(p);if(!room.host){room.host=player;if(freshRoom)room.adminIds.push(player);}}else{room.spectators.push(p);}}}
    send(ws,{type:'joined',id:player,code,token:player,adminOnly:room.adminSeat?.id===player});broadcast(room);
  }
  function onFrame(chunk){ws.buffer=Buffer.concat([ws.buffer,chunk]);while(ws.buffer.length>=2){const b=ws.buffer;let len=b[1]&127,off=2;if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);off=4;}else if(len===127){if(b.length<10)return;const big=b.readBigUInt64BE(2);if(big>1000000n)return ws.close();len=Number(big);off=10;}const masked=!!(b[1]&128);if(masked)off+=4;if(b.length<off+len)return;let payload=Buffer.from(b.subarray(off,off+len));if(masked){const mask=b.subarray(off-4,off);for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];}ws.buffer=b.subarray(off+len);const opcode=b[0]&15;if(opcode===8){ws.close();return;}if(opcode===9){socket.write(Buffer.from([0x8a,0]));continue;}if(opcode===1){try{const msg=JSON.parse(payload.toString());if(msg.type==='join')join(msg.code,msg.token,msg.name,msg.adminOnly);else if(msg.type==='ping')continue;else if(room&&player)handle(room,player,msg,ws);else error(ws,'Join or create a room first.');}catch{error(ws,'Could not read that message.');}}}}
  socket.on('data',onFrame);socket.on('close',()=>{ws.readyState=3;if(room&&player){const p=[...room.players,...room.spectators,...(room.adminSeat?[room.adminSeat]:[])].find(x=>x.id===player);if(p?.socket===ws){p.socket=null;broadcast(room);}}});socket.on('error',()=>{});
});
server.listen(PORT,'0.0.0.0',()=>console.log(`The Lie Engine listening on ${PORT}`));
