const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const rooms = new Map();
const MAX_PLAYERS = 12;
const names = ['Forward Pulse','Reverse Pulse','Double Pulse','Chaos Shift','Overload','Reset Signal','Mirror Flip','Quantum Jump'];
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
const rand = n => crypto.randomInt(n);
const uid = n => crypto.randomBytes(n).toString('hex');
const shuffled = a => { const b=[...a]; for(let i=b.length-1;i>0;i--){const j=rand(i+1);[b[i],b[j]]=[b[j],b[i]];} return b; };
const blankRoom = (code, host) => ({code,host,adminSeat:null,players:[],spectators:[],phase:'lobby',round:0,roundLimit:6,startingPoints:10,revealReward:2,verifyCost:1,interfereCost:2,cardReward:1,oneDialReward:1,twoDialReward:3,turn:0,roundStarter:0,publicVersion:null,version:0,state:null,history:[],deck:[],discard:[],log:[],adminLog:[],audit:[],roundStart:0,roundEnd:null,winners:[],endReason:null,clues:{},hands:{},verified:{},predictions:{},earned:{},roomEvents:[]});

function applyCard(room, card, dial) {
  const i='ABC'.indexOf(dial), old=room.state[i]; let value;
  if(card==='Forward Pulse') value=(old+1)%4;
  else if(card==='Reverse Pulse') value=(old+3)%4;
  else if(card==='Double Pulse') value=(old+2)%4;
  else if(card==='Overload') value=(old+3)%4;
  else if(card==='Chaos Shift') { const values=[0,1,2,3].filter(v=>v!==old); value=values[rand(3)]; }
  else if(card==='Quantum Jump') value=room.version>0?room.history[rand(room.version)][i]:(old+(rand(2)?1:3))%4;
  else if(card==='Reset Signal') value=old===0?2:0;
  else value=3-old;
  room.state[i]=value; room.version++; room.history[room.version]=[...room.state]; room.discard.push(card);
}
function draw(room){ if(!room.deck.length && room.discard.length){room.deck=shuffled(room.discard);room.discard=[];} return room.deck.pop()||null; }
function randomClue(room,version,usedDials=[],dealtRound=room.round){ const available='ABC'.split('').filter(d=>!usedDials.includes(d));if(!available.length)return null;const dial=available[rand(available.length)];return {id:uid(5),version,dial,value:room.history[version]['ABC'.indexOf(dial)],dealtRound}; }
function addLog(room,text){room.log.push({text,at:Date.now()});room.log=room.log.slice(-40);}
function addAdminLog(room,text){room.adminLog.unshift({text,at:Date.now()});room.adminLog=room.adminLog.slice(0,400);}
function addAudit(room,{player='',clues='',action='',prediction='',points=''}={}){room.audit.push({round:room.round||0,player,clues,action,prediction,points,at:Date.now()});if(room.audit.length>4000)room.audit.splice(0,room.audit.length-4000);}
function serial(room, player) {
  const active=room.players.find(p=>p.id===player),spectator=room.spectators.find(p=>p.id===player),adminOnly=room.adminSeat?.id===player,own=active||spectator||(adminOnly?room.adminSeat:null),isAdmin=player===room.host;
  return {
    code:room.code, phase:room.phase, round:room.round, roundLimit:room.roundLimit, startingPoints:room.startingPoints,revealReward:room.revealReward,verifyCost:room.verifyCost,interfereCost:room.interfereCost,cardReward:room.cardReward,oneDialReward:room.oneDialReward,twoDialReward:room.twoDialReward,endReason:room.endReason, turnPlayer:room.players[room.turn]?.id||null,
    publicVersion:room.publicVersion, roundStart:room.roundStart, roundEnd:room.roundEnd,
    finalState:room.phase==='finished'?[...room.state]:null, finalVersion:room.phase==='finished'?room.version:null,
    players:room.players.map(p=>({id:p.id,name:p.name,points:p.id===player||isAdmin?p.points:undefined,host:p.id===room.host,connected:!!p.socket,ready:!!room.predictions[p.id]})),
    spectators:room.spectators.map(p=>({id:p.id,name:p.name,host:p.id===room.host,connected:!!p.socket})),
    you:own?{id:own.id,name:own.name,points:own.points,host:isAdmin,admin:isAdmin,adminOnly,spectator:!!spectator}:null,
    clues:active?room.clues[active.id]||[]:[], hands:active?room.hands[active.id]||[]:[],
    verified:active?room.verified[active.id]||[]:[], predictions:room.players.map(p=>({id:p.id,name:p.name,locked:!!room.predictions[p.id],earned:(room.phase==='reveal'||(room.phase==='finished'&&room.endReason==='points'))&&p.id===player?room.earned[p.id]||0:undefined})),
    log:room.log, winners:room.winners, deckCount:room.deck.length,
    canAct:room.phase==='actions'&&room.players[room.turn]?.id===player,
    canStart:room.phase==='lobby'&&room.host===player&&room.players.length>=3,
    actionIndex:room.turn, roomEvents:room.roomEvents, previousVersions:Array.from({length:room.version},(_,version)=>version),adminLog:isAdmin?room.adminLog:[],adminAudit:isAdmin?room.audit:[],adminView:isAdmin?{currentEngine:room.state?[...room.state]:null,currentVersion:room.version,history:room.history.map((values,version)=>({version,values:[...values]})),players:room.players.map(p=>({id:p.id,name:p.name,points:p.points,connected:!!p.socket,hand:room.hands[p.id]||[],clues:room.clues[p.id]||[],verified:room.verified[p.id]||[],prediction:room.predictions[p.id]?.values||null}))}:null
  };
}
function send(ws,obj){ if(ws&&ws.readyState===1) ws.send(JSON.stringify(obj)); }
function broadcast(room){ for(const p of [...room.players,...room.spectators,...(room.adminSeat?[room.adminSeat]:[])]) if(p.socket) send(p.socket,{type:'state',state:serial(room,p.id)}); }
function error(ws,message){send(ws,{type:'error',message});}
function advance(room){ room.turn++; if(room.turn>=room.players.length){room.phase='predict';addLog(room,'All actions are in. Lock your three-dial prediction.');} }
function moveSeat(room,id,{spectate=false}={}){
  const index=room.players.findIndex(p=>p.id===id);
  if(index>=0){
    const [p]=room.players.splice(index,1);
    if(index<room.turn)room.turn--;
    if(index<room.roundStarter)room.roundStarter--;
    if(spectate)room.spectators.push(p);
    else{delete room.clues[id];delete room.hands[id];delete room.verified[id];}
    delete room.predictions[id];delete room.earned[id];
    room.roundStarter=room.players.length?((room.roundStarter%room.players.length)+room.players.length)%room.players.length:0;
    if(room.phase==='actions'&&room.turn>=room.players.length){room.turn=0;room.phase='predict';addLog(room,'All remaining players have acted. Lock your prediction.');}
    if(room.phase==='predict'&&room.players.length&&room.players.every(x=>room.predictions[x.id]))scorePredictions(room);
    return p;
  }
  const spectatorIndex=room.spectators.findIndex(p=>p.id===id);
  if(spectatorIndex>=0){const [p]=room.spectators.splice(spectatorIndex,1);return p;}
  return null;
}
function start(room){
  if(room.players.length<3||room.players.length>MAX_PLAYERS||room.phase!=='lobby')return false;
  room.round=1;
  room.state=[rand(4),rand(4),rand(4)];room.history=[[...room.state]];room.version=0;
  const copies=Math.max(3,Math.ceil((room.players.length*2+2)/names.length));room.deck=shuffled(names.flatMap(n=>Array(copies).fill(n)));room.discard=[];
  const setup=[];while(setup.length<2){const card=draw(room);if(!card)break;if(card==='Quantum Jump'){room.deck=shuffled([...room.deck,card]);continue;}setup.push(card);}for(const card of setup)applyCard(room,card,'ABC'[rand(3)]);
  room.audit=[];room.players.forEach(p=>{p.points=room.startingPoints;const first=randomClue(room,0);room.clues[p.id]=[first,randomClue(room,0,[first.dial]),randomClue(room,1)];room.hands[p.id]=[draw(room),draw(room)];room.verified[p.id]=[];for(const clue of room.clues[p.id])addAudit(room,{player:p.name,clues:`V${clue.version} · Dial ${clue.dial} = ${clue.value}`});addAudit(room,{player:p.name,action:`Starting hand dealt: ${room.hands[p.id].join(', ')}`,points:`${p.points} starting points`});});
  room.publicVersion=room.version;room.roundStart=room.version;room.roundStarter=0;room.turn=0;room.phase='actions';room.log=[];room.predictions={};room.earned={};room.winners=[];room.endReason=null;room.roundEnd=null;room.roomEvents=[];
  addLog(room,`Round 1 begins at public Version ${room.publicVersion}. ${room.players[room.turn].name} takes the first turn.`);addAdminLog(room,`Game started: ${room.players.length} players, ${room.roundLimit} rounds.`);addAudit(room,{player:room.adminSeat?.name||'Room host',action:`Game started · ${room.players.length} players · ${room.roundLimit} rounds · first turn: ${room.players[room.turn].name}`});return true;
}
function roundStart(room){
  room.round++;room.predictions={};room.earned={};room.verified=Object.fromEntries(room.players.map(p=>[p.id,[]]));room.roundStarter=(room.roundStarter+1)%room.players.length;room.turn=room.roundStarter;room.publicVersion=room.version;room.roundStart=room.version;room.roundEnd=null;
  const v1=Math.max(0,room.version-2),v2=Math.max(0,room.version-1);
  for(const p of room.players){for(const version of (v1===v2?[v2]:[v1,v2])){const used=room.clues[p.id].filter(c=>c.version===version).map(c=>c.dial);const clue=randomClue(room,version,used);if(clue){room.clues[p.id].push(clue);addAudit(room,{player:p.name,clues:`V${clue.version} · Dial ${clue.dial} = ${clue.value}`});}}}
  room.phase='actions';addLog(room,`Round ${room.round} begins at public Version ${room.publicVersion}. ${room.players[room.turn].name} takes the first turn.`);addAudit(room,{action:`Round begins · public V${room.publicVersion} · first turn: ${room.players[room.turn].name}`});
}
function scorePredictions(room){
  const results=room.players.map(p=>{const guess=room.predictions[p.id].values;return {player:p,correct:guess.reduce((n,v,i)=>n+(v===room.state[i]?1:0),0)}});
  const perfect=results.filter(r=>r.correct===3).map(r=>r.player);
  room.phase='reveal';
  for(const {player:p} of results){const guess=room.predictions[p.id].values,actual=room.state,before=p.points,parts=['A','B','C'].map((dial,i)=>`${dial}: guessed ${guess[i]}, actual ${actual[i]} ${guess[i]===actual[i]?'✓':'✗'}`);addAudit(room,{player:p.name,prediction:parts.join(' · '),points:`${before} before scoring`});}
  if(perfect.length){room.endReason='perfect';room.winners=perfect.map(p=>p.id);room.roundEnd=room.version;room.phase='finished';addLog(room,`${perfect.map(p=>p.name).join(' and ')} ${perfect.length===1?'has':'have'} guessed all three dials. Version ${room.roundStart} → ${room.roundEnd}; no automatic event was applied.`);for(const p of room.players)addAudit(room,{player:p.name,points:`FINAL TOTAL: ${p.points}${room.winners.includes(p.id)?' · WINNER':''}`});return;}
  for(const {player:p,correct} of results){const before=p.points,earned=correct===2?room.twoDialReward:correct===1?room.oneDialReward:0;room.earned[p.id]=earned;p.points+=earned;addAudit(room,{player:p.name,points:`${before} → ${p.points} (${earned?`+${earned} for ${correct} correct dial${correct===1?'':'s'}`:'no prediction points'})`});}
  const card=draw(room)||names[rand(names.length)],dial='ABC'[rand(3)],i='ABC'.indexOf(dial),old=room.state[i];applyCard(room,card,dial);room.roundEnd=room.version;addAudit(room,{player:'Automatic event',action:`${card} on ${dial}: ${old} → ${room.state[i]} (new V${room.version})`});
  addLog(room,`The automatic event advances the machine to Version ${room.roundEnd}. The round's hidden changes remain secret.`);
  if(room.round>=room.roundLimit){const high=Math.max(...room.players.map(p=>p.points));room.winners=room.players.filter(p=>p.points===high).map(p=>p.id);room.endReason='points';room.phase='finished';addLog(room,`${room.roundLimit} rounds complete. ${room.players.filter(p=>room.winners.includes(p.id)).map(p=>p.name).join(' and ')} ${room.winners.length===1?'wins':'share the win'} on points.`);for(const p of room.players)addAudit(room,{player:p.name,points:`FINAL TOTAL: ${p.points}${room.winners.includes(p.id)?' · WINNER':''}`});return;}
}
function handle(room,player,msg,ws){
  const p=room.players.find(x=>x.id===player);
  if(msg.type==='admin'){
    if(player!==room.host)return error(ws,'Only the room host can use admin controls.');
    if(msg.action==='settings'){
      if(room.phase==='finished')return error(ws,'This game is complete.');
      const fields=['roundLimit','startingPoints','revealReward','verifyCost','interfereCost','cardReward','oneDialReward','twoDialReward'],updated={};
      for(const key of fields){const value=Number(msg[key]);const min=key==='roundLimit'?1:0,max=key==='roundLimit'?12:key==='startingPoints'?100:20;if(!Number.isInteger(value)||value<min||value>max)return error(ws,`Invalid value for ${key}.`);updated[key]=value;}
      Object.assign(room,updated);
      const text=`Game values updated: ${room.roundLimit} rounds; start ${room.startingPoints}; reveal +${room.revealReward}; verify −${room.verifyCost}; interfere −${room.interfereCost}; card +${room.cardReward}; guesses +${room.oneDialReward}/+${room.twoDialReward}.`;addAdminLog(room,text);addAudit(room,{player:room.adminSeat?.name||'Room host',action:text});broadcast(room);return;
    }
    if(msg.action==='engine'){if(!room.state||room.phase==='finished')return error(ws,'The engine is not editable now.');if(!Array.isArray(msg.values)||msg.values.length!==3||msg.values.some(v=>!Number.isInteger(v)||v<0||v>3))return error(ws,'Choose dial values from 0 to 3.');const before=[...room.state];room.state=[...msg.values];room.version++;room.history[room.version]=[...room.state];if(room.phase==='reveal')room.roundEnd=room.version;addLog(room,'The room admin adjusted the engine.');const text=`Engine set from A ${before[0]}, B ${before[1]}, C ${before[2]} to A ${msg.values[0]}, B ${msg.values[1]}, C ${msg.values[2]} (Version ${room.version})`;addAdminLog(room,`Admin ${text}.`);addAudit(room,{player:room.adminSeat?.name||'Room host',action:text});broadcast(room);return;
    }
    if(msg.action==='spectate'||msg.action==='remove'){
      const target=String(msg.playerId||'');if(!target||target===room.host)return error(ws,'The host cannot be removed or made a spectator.');
      const moved=moveSeat(room,target,{spectate:msg.action==='spectate'});if(!moved)return error(ws,'That participant is no longer in the room.');if(msg.action==='remove'&&moved.socket){send(moved.socket,{type:'removed'});moved.socket.close();}
      const text=msg.action==='spectate'?`${moved.name} was moved to spectators.`:`${moved.name} was removed from the room.`;addAdminLog(room,text);addAudit(room,{player:moved.name,action:text});broadcast(room);return;
    }
    return error(ws,'Unknown admin action.');
  }
  if(msg.type==='leave'){
    if(room.adminSeat?.id===player){room.adminSeat=null;room.host=room.players[0]?.id||null;if(!room.host){rooms.delete(room.code);return;}broadcast(room);return;}
    const wasHost=player===room.host;const leaving=moveSeat(room,player);if(!leaving)return error(ws,'You are no longer in the room.');addAdminLog(room,`${leaving.name} left the room.`);addAudit(room,{player:leaving.name,action:'Left the room'});
    if(wasHost){if(room.players.length)room.host=room.players[0].id;else{rooms.delete(room.code);return;}}
    if(!room.players.length&&!room.spectators.length){rooms.delete(room.code);return;}
    broadcast(room);return;
  }
  if(msg.type==='start'&&player===room.host){if(!start(room))return error(ws,'A game needs 3–12 players to start.');broadcast(room);return;}
  if(msg.type==='next'&&player===room.host&&!p){if(room.phase!=='reveal')return error(ws,'The next round is not ready.');roundStart(room);broadcast(room);return;}
  if(!p)return;
  if(msg.type==='start'){if(player!==room.host)return error(ws,'Only the room host can start the game.');if(!start(room))return error(ws,'A game needs 3–12 players to start.');broadcast(room);return;}
  if(msg.type==='action'){
    if(room.phase!=='actions'||room.players[room.turn]?.id!==player)return error(ws,'It is not your action turn.');
    const a=msg.action;
    if(a==='reveal'){
      const clue=room.clues[player]?.find(c=>c.id===msg.clueId&&c.dealtRound===room.round);if(!clue)return error(ws,'Choose a fresh clue from this round to reveal.');
      if(room.roomEvents.some(e=>e.clue?.id===clue.id))return error(ws,'That clue is already public.');
      const before=p.points;p.points+=room.revealReward;room.roomEvents.push({id:uid(4),clue:{...clue,owner:p.name}});const text=`Revealed V${clue.version}, dial ${clue.dial} = ${clue.value}`;addAdminLog(room,`${p.name} ${text}.`);addAudit(room,{player:p.name,action:text,points:`${before} → ${p.points}`});advance(room);
    } else if(a==='verify'){
      if(p.points<room.verifyCost)return error(ws,`You need at least ${room.verifyCost} points to verify.`);const clue=room.clues[player]?.find(c=>c.id===msg.clueId);if(!clue)return error(ws,'Choose one of your clues first.');const before=p.points;p.points-=room.verifyCost;const yes=room.state['ABC'.indexOf(clue.dial)]===clue.value;room.verified[player].unshift({clueId:clue.id,answer:yes,round:room.round});room.verified[player]=room.verified[player].slice(0,20);const text=`Verified V${clue.version}, dial ${clue.dial} = ${clue.value}: ${yes?'MATCH':'NO MATCH'}`;addAdminLog(room,`${p.name} ${text}.`);addAudit(room,{player:p.name,action:text,points:`${before} → ${p.points}`});advance(room);
    } else if(a==='interfere'){
      if(p.points<room.interfereCost)return error(ws,`You need at least ${room.interfereCost} points to interfere.`);if(!'ABC'.includes(msg.dial)||![-1,1].includes(msg.direction))return error(ws,'Choose a dial and a direction.');const before=p.points,i='ABC'.indexOf(msg.dial),old=room.state[i];p.points-=room.interfereCost;room.state[i]=(room.state[i]+msg.direction+4)%4;room.version++;room.history[room.version]=[...room.state];
      const text=`Interfered with dial ${msg.dial}: ${old} → ${room.state[i]} (Version ${room.version})`;addAdminLog(room,`${p.name} ${text}.`);addAudit(room,{player:p.name,action:text,points:`${before} → ${p.points}`});advance(room);
    } else if(a==='card'){
      const hand=room.hands[player],idx=hand?.indexOf(msg.card);if(idx<0||!hand)return error(ws,'That card is not in your hand.');const card=hand[idx];
      if(card==='Quantum Jump'){
        const target=Number(msg.version);if(!'ABC'.includes(msg.dial))return error(ws,'Choose a target dial.');if(!Number.isInteger(target)||target<0||target>=room.version)return error(ws,'Choose a previous version to restore.');
        const before=p.points,i='ABC'.indexOf(msg.dial),old=room.state[i];hand.splice(idx,1);room.state[i]=room.history[target][i];room.version++;room.history[room.version]=[...room.state];room.discard.push(card);p.points+=room.cardReward;addLog(room,`${p.name} plays an Event Card on dial ${msg.dial} and gains ${room.cardReward} point(s).`);const text=`Played Quantum Jump on ${msg.dial}: ${old} → ${room.state[i]} (restored V${target}, new V${room.version})`;addAdminLog(room,`${p.name} ${text}.`);addAudit(room,{player:p.name,action:text,points:`${before} → ${p.points}`});
      }else{
        if(!'ABC'.includes(msg.dial))return error(ws,'Choose a target dial.');
        const before=p.points,i='ABC'.indexOf(msg.dial),old=room.state[i];hand.splice(idx,1);applyCard(room,card,msg.dial);p.points+=room.cardReward;addLog(room,`${p.name} plays an Event Card on dial ${msg.dial} and gains ${room.cardReward} point(s).`);const text=`Played ${card} on ${msg.dial}: ${old} → ${room.state[i]} (new V${room.version})`;addAdminLog(room,`${p.name} ${text}.`);addAudit(room,{player:p.name,action:text,points:`${before} → ${p.points}`});
      }
      const replacement=draw(room);if(replacement){hand.push(replacement);addAudit(room,{player:p.name,action:`Replacement card dealt: ${replacement}`});}advance(room);
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
    room=rooms.get(code);if(!room){if(id)return error(ws,'That room has closed. Create a new room.');room=blankRoom(code,null);rooms.set(code,room);}
    let p=room.players.find(x=>x.id===id)||room.spectators.find(x=>x.id===id);
    if(room.adminSeat?.id===id){p=room.adminSeat;if(p.socket&&p.socket!==ws)p.socket.close();p.socket=ws;p.name=name||p.name;player=p.id;}
    else if(p){if(p.socket&&p.socket!==ws){p.socket.close();}p.socket=ws;p.name=name||p.name;player=p.id;}
    else {if(id)return error(ws,'Your seat is no longer in this room.');if(adminOnly){if(room.host||room.players.length||room.spectators.length)return error(ws,'An admin-only room must be created as a new room.');player=uid(12);room.adminSeat={id:player,name,socket:ws,points:0};room.host=player;p=room.adminSeat;}else if(room.players.length+room.spectators.length>=24)return error(ws,'This room has reached its participant limit.');if(!adminOnly){player=uid(12);p={id:player,name,points:0,socket:ws};if(room.phase==='lobby'&&room.players.length<MAX_PLAYERS){room.players.push(p);if(!room.host)room.host=player;}else{room.spectators.push(p);}}}
    send(ws,{type:'joined',id:player,code,token:player,adminOnly:room.adminSeat?.id===player});broadcast(room);
  }
  function onFrame(chunk){ws.buffer=Buffer.concat([ws.buffer,chunk]);while(ws.buffer.length>=2){const b=ws.buffer;let len=b[1]&127,off=2;if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);off=4;}else if(len===127){if(b.length<10)return;const big=b.readBigUInt64BE(2);if(big>1000000n)return ws.close();len=Number(big);off=10;}const masked=!!(b[1]&128);if(masked)off+=4;if(b.length<off+len)return;let payload=Buffer.from(b.subarray(off,off+len));if(masked){const mask=b.subarray(off-4,off);for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];}ws.buffer=b.subarray(off+len);const opcode=b[0]&15;if(opcode===8){ws.close();return;}if(opcode===9){socket.write(Buffer.from([0x8a,0]));continue;}if(opcode===1){try{const msg=JSON.parse(payload.toString());if(msg.type==='join')join(msg.code,msg.token,msg.name,msg.adminOnly);else if(msg.type==='ping')continue;else if(room&&player)handle(room,player,msg,ws);else error(ws,'Join or create a room first.');}catch{error(ws,'Could not read that message.');}}}}
  socket.on('data',onFrame);socket.on('close',()=>{ws.readyState=3;if(room&&player){const p=[...room.players,...room.spectators,...(room.adminSeat?[room.adminSeat]:[])].find(x=>x.id===player);if(p?.socket===ws){p.socket=null;broadcast(room);}}});socket.on('error',()=>{});
});
server.listen(PORT,'0.0.0.0',()=>console.log(`The Lie Engine listening on ${PORT}`));
