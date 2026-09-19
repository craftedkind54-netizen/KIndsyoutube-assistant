import 'dotenv/config';
import express from 'express';
import { google } from 'googleapis';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const cfg = {
  port: Number(process.env.PORT || 3000),
  base: process.env.BASE_URL || 'http://localhost:3000',
  handle: process.env.YOUTUBE_CHANNEL_HANDLE || '@KindCrafted-m4q',
  phrase: process.env.VERIFY_PHRASE || 'CRAFTED-MANAGER-VERIFY-2026',
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  geminiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  postsPerDay: Math.max(1, Number(process.env.POSTS_PER_DAY || 2)),
  tz: process.env.TIMEZONE || 'Pacific/Honolulu',
  sessionSecret: process.env.SESSION_SECRET || 'change-me'
};

const db = new Database(path.join(__dirname, 'data', 'creator.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS handled_comments (comment_id TEXT PRIMARY KEY, action TEXT, reply TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS questions (comment_id TEXT PRIMARY KEY, author TEXT, text TEXT, video_id TEXT, video_title TEXT, created_at TEXT, status TEXT DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS performance (video_id TEXT, sampled_at TEXT, views INTEGER, likes INTEGER, comments INTEGER);
`);
const getKV=k=>db.prepare('SELECT v FROM kv WHERE k=?').get(k)?.v;
const setKV=(k,v)=>db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k,String(v));

const oauth = () => new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, `${cfg.base}/oauth2callback`);
function authed(){ const o=oauth(); const raw=getKV('tokens'); if(!raw) throw new Error('YouTube not connected'); o.setCredentials(JSON.parse(raw)); o.on('tokens',t=>setKV('tokens',JSON.stringify({...JSON.parse(getKV('tokens')||'{}'),...t}))); return o; }
function yt(){ return google.youtube({version:'v3',auth:authed()}); }

app.get('/auth/google',(req,res)=>{
  if(!cfg.clientId||!cfg.clientSecret) return res.status(500).send('Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.');
  const o=oauth();
  res.redirect(o.generateAuthUrl({access_type:'offline',prompt:'consent',scope:['https://www.googleapis.com/auth/youtube.force-ssl','https://www.googleapis.com/auth/youtube.readonly']}));
});
app.get('/oauth2callback',async(req,res)=>{ try { const o=oauth(); const {tokens}=await o.getToken(req.query.code); setKV('tokens',JSON.stringify(tokens)); res.redirect('/?connected=1'); } catch(e){res.status(500).send(e.message);} });

async function channelInfo(){
  const y=yt(); const r=await y.channels.list({part:['snippet','statistics','contentDetails'],mine:true});
  const c=r.data.items?.[0]; if(!c) throw new Error('No authorized YouTube channel found'); return c;
}
async function verifyDescription(){ const c=await channelInfo(); return {ok:(c.snippet?.description||'').includes(cfg.phrase),channel:c}; }

async function allOwnedVideos(){
  const c=await channelInfo(); const uploads=c.contentDetails.relatedPlaylists.uploads; let token; const ids=[];
  do { const r=await yt().playlistItems.list({part:['contentDetails'],playlistId:uploads,maxResults:50,pageToken:token}); ids.push(...(r.data.items||[]).map(x=>x.contentDetails.videoId)); token=r.data.nextPageToken; } while(token);
  const out=[]; for(let i=0;i<ids.length;i+=50){ const r=await yt().videos.list({part:['snippet','status','statistics','contentDetails'],id:ids.slice(i,i+50)}); out.push(...(r.data.items||[])); }
  return out;
}

function ageHours(iso){return (Date.now()-new Date(iso).getTime())/36e5;}
function scoreVideo(v){ const h=Math.max(1,ageHours(v.snippet.publishedAt)); return (Number(v.statistics?.viewCount||0)/h)+(Number(v.statistics?.likeCount||0)*2/h)+(Number(v.statistics?.commentCount||0)*3/h); }
function bestHours(videos){
  const pub=videos.filter(v=>v.status.privacyStatus==='public'&&v.snippet.publishedAt).map(v=>({h:Number(new Intl.DateTimeFormat('en-US',{timeZone:cfg.tz,hour:'numeric',hour12:false}).format(new Date(v.snippet.publishedAt)))%24,s:scoreVideo(v)}));
  const agg=new Map(); for(const x of pub){const a=agg.get(x.h)||{sum:0,n:0};a.sum+=x.s;a.n++;agg.set(x.h,a);} const ranked=[...agg].map(([h,a])=>({h,avg:a.sum/a.n,n:a.n})).sort((a,b)=>b.avg-a.avg);
  const chosen=[]; for(const x of ranked){if(chosen.every(h=>Math.min(Math.abs(h-x.h),24-Math.abs(h-x.h))>=4)) chosen.push(x.h); if(chosen.length>=cfg.postsPerDay)break;}
  for(const fallback of [12,18,9,21]) if(chosen.length<cfg.postsPerDay&&!chosen.includes(fallback)) chosen.push(fallback);
  return chosen.sort((a,b)=>a-b).slice(0,cfg.postsPerDay);
}
function nextSlots(hours,count){ const slots=[]; let d=new Date(); for(let day=0;slots.length<count&&day<60;day++){ for(const h of hours){ const parts=new Intl.DateTimeFormat('en-CA',{timeZone:cfg.tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(d.getTime()+day*86400000)); const val=Object.fromEntries(parts.map(p=>[p.type,p.value])); const approx=new Date(`${val.year}-${val.month}-${val.day}T${String(h).padStart(2,'0')}:00:00-10:00`); if(approx>Date.now()+10*60000)slots.push(approx); if(slots.length>=count)break; } } return slots; }

async function schedulePrivateVideos(){
  const verified=await verifyDescription(); if(!verified.ok) return {scheduled:0,reason:'Verification phrase not found in channel description'};
  const videos=await allOwnedVideos(); const priv=videos.filter(v=>v.status.privacyStatus==='private'&&!v.status.publishAt&&v.status.uploadStatus==='processed').sort((a,b)=>new Date(a.snippet.publishedAt)-new Date(b.snippet.publishedAt));
  const hours=bestHours(videos); const slots=nextSlots(hours,priv.length); let n=0;
  for(let i=0;i<priv.length;i++){ await yt().videos.update({part:['status'],requestBody:{id:priv[i].id,status:{privacyStatus:'private',publishAt:slots[i].toISOString(),selfDeclaredMadeForKids:priv[i].status.selfDeclaredMadeForKids}}}); n++; }
  return {scheduled:n,hours};
}

async function gemini(prompt){
  if(!cfg.geminiKey) throw new Error('GEMINI_API_KEY missing');
  const u=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.geminiModel)}:generateContent?key=${encodeURIComponent(cfg.geminiKey)}`;
  const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}]})}); if(!r.ok)throw new Error(`Gemini ${r.status}: ${await r.text()}`); const j=await r.json(); return j.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('').trim();
}
async function classifyAndReply(){
  const verified=await verifyDescription(); if(!verified.ok)return {handled:0,reason:'Not verified'};
  const r=await yt().commentThreads.list({part:['snippet'],allThreadsRelatedToChannelId:verified.channel.id,maxResults:50,order:'time'}); let handled=0;
  for(const th of r.data.items||[]){ const c=th.snippet.topLevelComment; const id=c.id; if(db.prepare('SELECT 1 FROM handled_comments WHERE comment_id=?').get(id))continue; const s=c.snippet; if(s.authorChannelId?.value===verified.channel.id){db.prepare('INSERT OR IGNORE INTO handled_comments(comment_id,action) VALUES(?,?)').run(id,'own');continue;}
    const verdict=(await gemini(`Classify this YouTube comment. Return only QUESTION, SPAM, or NORMAL. A question includes requests for information even without a question mark. Comment: ${JSON.stringify(s.textOriginal||s.textDisplay||'')}`)).toUpperCase();
    if(verdict.includes('QUESTION')){ db.prepare('INSERT OR IGNORE INTO questions(comment_id,author,text,video_id,created_at) VALUES(?,?,?,?,?)').run(id,s.authorDisplayName,s.textOriginal||s.textDisplay,th.snippet.videoId,s.publishedAt); db.prepare('INSERT OR IGNORE INTO handled_comments(comment_id,action) VALUES(?,?)').run(id,'question'); }
    else if(verdict.includes('SPAM')) db.prepare('INSERT OR IGNORE INTO handled_comments(comment_id,action) VALUES(?,?)').run(id,'spam');
    else { const reply=await gemini(`Write one short, friendly, positive, family-friendly YouTube reply as the creator KindCrafted. Do not pretend to know facts not in the comment. Do not ask a question. Comment: ${JSON.stringify(s.textOriginal||s.textDisplay||'')}`); await yt().comments.insert({part:['snippet'],requestBody:{snippet:{parentId:id,textOriginal:reply}}}); db.prepare('INSERT OR IGNORE INTO handled_comments(comment_id,action,reply) VALUES(?,?,?)').run(id,'replied',reply); }
    handled++;
  } return {handled};
}

app.get('/api/status',async(req,res)=>{try{const v=await verifyDescription(); const videos=await allOwnedVideos(); res.json({connected:true,verified:v.ok,channel:{title:v.channel.snippet.title,stats:v.channel.statistics},bestHours:bestHours(videos),privateQueue:videos.filter(x=>x.status.privacyStatus==='private').sort((a,b)=>new Date(a.snippet.publishedAt)-new Date(b.snippet.publishedAt)).map(x=>({id:x.id,title:x.snippet.title,publishAt:x.status.publishAt||null})),questions:db.prepare("SELECT * FROM questions WHERE status='pending' ORDER BY created_at DESC").all()});}catch(e){res.json({connected:false,error:e.message});}});
app.post('/api/run/schedule',async(req,res)=>{try{res.json(await schedulePrivateVideos());}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/run/comments',async(req,res)=>{try{res.json(await classifyAndReply());}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/questions/:id/reply',async(req,res)=>{try{const q=db.prepare('SELECT * FROM questions WHERE comment_id=?').get(req.params.id); if(!q)return res.status(404).json({error:'Question not found'}); const text=String(req.body.text||'').trim(); if(!text)return res.status(400).json({error:'Reply required'}); await yt().comments.insert({part:['snippet'],requestBody:{snippet:{parentId:q.comment_id,textOriginal:text}}}); db.prepare("UPDATE questions SET status='replied' WHERE comment_id=?").run(q.comment_id); res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/questions/:id/ignore',(req,res)=>{db.prepare("UPDATE questions SET status='ignored' WHERE comment_id=?").run(req.params.id);res.json({ok:true});});

let busy=false; async function cycle(){if(busy)return;busy=true;try{if(getKV('tokens')){await schedulePrivateVideos();await classifyAndReply();}}catch(e){console.error('[cycle]',e.message);}finally{busy=false;}}
setInterval(cycle,10*60*1000); setTimeout(cycle,15000);
app.listen(cfg.port,()=>console.log(`KindCrafted Creator Manager running on ${cfg.port}`));
