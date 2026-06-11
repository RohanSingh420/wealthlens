'use strict';
const express    = require('express');
const session    = require('express-session');
const fetch      = require('node-fetch');
const fs         = require('fs');
const path       = require('path');
const cron       = require('node-cron');
const { google } = require('googleapis');

const app  = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR    = path.join(__dirname, '.data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const VIDEOS_FILE = path.join(DATA_DIR, 'videos.json');
const LOG_FILE    = path.join(DATA_DIR, 'log.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback={}) { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fallback; } }
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data,null,2)); }
function cfg()    { return readJSON(CONFIG_FILE, {}); }
function videos() { return readJSON(VIDEOS_FILE, []); }
function addLog(level, msg, data={}) {
  const logs = readJSON(LOG_FILE, []);
  logs.unshift({ ts: new Date().toISOString(), level, msg, data });
  writeJSON(LOG_FILE, logs.slice(0,200));
}

let automationJob=null, pipelineRunning=false, pipelineStatus='idle', pipelineProgress=[];
function setStatus(msg) {
  pipelineStatus=msg;
  pipelineProgress.unshift({ ts:new Date().toISOString(), msg });
  pipelineProgress=pipelineProgress.slice(0,50);
  addLog('info',msg);
  console.log('[Pipeline]',msg);
}

app.use(express.json({limit:'10mb'}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,'public')));
app.use(session({ secret:process.env.SESSION_SECRET||'wl-secret-2026', resave:false, saveUninitialized:false, cookie:{maxAge:7*24*60*60*1000} }));
function auth(req,res,next){ if(req.session&&req.session.ok) return next(); res.status(401).json({error:'Not authenticated'}); }

app.post('/api/login',(req,res)=>{
  const pw=cfg().admin_password||'admin123';
  if(req.body.password===pw){ req.session.ok=true; res.json({ok:true}); }
  else res.status(401).json({error:'Wrong password'});
});
app.post('/api/logout',(req,res)=>{ req.session.destroy(); res.json({ok:true}); });
app.get('/api/auth-check',(req,res)=>res.json({authenticated:!!(req.session&&req.session.ok)}));

app.get('/api/config',auth,(req,res)=>{
  const c=cfg();
  const mask=v=>v?'........'+String(v).slice(-4):'';
  res.json({
    groq_key_set:!!c.groq_api_key, groq_preview:mask(c.groq_api_key),
    unrealspeech_set:!!c.unrealspeech_api_key, unrealspeech_preview:mask(c.unrealspeech_api_key),
    pexels_set:!!c.pexels_api_key, pexels_preview:mask(c.pexels_api_key),
    creatomate_set:!!c.creatomate_api_key, creatomate_preview:mask(c.creatomate_api_key),
    youtube_client_id_set:!!c.youtube_client_id,
    youtube_connected:!!(c.youtube_tokens&&c.youtube_tokens.access_token),
    youtube_channel:c.youtube_channel_name||'',
    schedule_days:c.schedule_days||'tuesday,friday',
    schedule_time:c.schedule_time||'09:00',
    auto_publish:c.auto_publish!==false,
    tts_voice:c.tts_voice||'Dan',
    admin_password_set:!!c.admin_password,
  });
});
app.post('/api/config',auth,(req,res)=>{
  const c=cfg();
  ['admin_password','groq_api_key','unrealspeech_api_key','pexels_api_key','creatomate_api_key',
   'youtube_client_id','youtube_client_secret','schedule_days','schedule_time','auto_publish','tts_voice']
  .forEach(k=>{ if(req.body[k]!==undefined&&req.body[k]!=='') c[k]=req.body[k]; });
  writeJSON(CONFIG_FILE,c);
  res.json({ok:true,message:'Settings saved'});
});

function oauthClient() {
  const c=cfg();
  const redirect=`${process.env.APP_URL||'http://localhost:'+PORT}/api/youtube/callback`;
  return new google.auth.OAuth2(c.youtube_client_id,c.youtube_client_secret,redirect);
}
app.get('/api/youtube/connect',auth,(req,res)=>{
  const c=cfg();
  if(!c.youtube_client_id||!c.youtube_client_secret) return res.status(400).json({error:'Set YouTube Client ID and Secret in API Keys first.'});
  const url=oauthClient().generateAuthUrl({access_type:'offline',scope:['https://www.googleapis.com/auth/youtube.upload','https://www.googleapis.com/auth/youtube','https://www.googleapis.com/auth/yt-analytics.readonly'],prompt:'consent'});
  res.json({url});
});
app.get('/api/youtube/callback',async(req,res)=>{
  try {
    const o=oauthClient();
    const {tokens}=await o.getToken(req.query.code);
    o.setCredentials(tokens);
    const yt=google.youtube({version:'v3',auth:o});
    const ch=await yt.channels.list({part:['snippet'],mine:true});
    const name=ch.data.items?.[0]?.snippet?.title||'My Channel';
    const c=cfg(); c.youtube_tokens=tokens; c.youtube_channel_name=name;
    writeJSON(CONFIG_FILE,c);
    res.redirect('/?page=apikeys&connected=youtube');
  } catch(e){ addLog('error','YouTube OAuth failed',{error:e.message}); res.redirect('/?page=apikeys&error=youtube'); }
});
app.post('/api/youtube/disconnect',auth,(req,res)=>{
  const c=cfg(); delete c.youtube_tokens; delete c.youtube_channel_name;
  writeJSON(CONFIG_FILE,c); res.json({ok:true});
});
function getYT() {
  const c=cfg();
  if(!c.youtube_tokens) throw new Error('YouTube not connected');
  const o=oauthClient(); o.setCredentials(c.youtube_tokens);
  return {yt:google.youtube({version:'v3',auth:o}),oauth2:o};
}

async function groq(sys,usr,max=4096,fast=false) {
  const c=cfg();
  if(!c.groq_api_key) throw new Error('Groq API key not set');
  const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{
    method:'POST',
    headers:{'Authorization':'Bearer '+c.groq_api_key,'Content-Type':'application/json'},
    body:JSON.stringify({model:fast?'llama-3.1-8b-instant':'llama-3.3-70b-versatile',messages:[{role:'system',content:sys},{role:'user',content:usr}],max_tokens:max,temperature:0.8,response_format:{type:'json_object'}}),
  });
  if(!r.ok) throw new Error('Groq '+r.status);
  const d=await r.json();
  const txt=d.choices?.[0]?.message?.content||'{}';
  try{return JSON.parse(txt);}catch{const m=txt.match(/{[sS]*}/);return m?JSON.parse(m[0]):{};}
}

async function fetchTrends() {
  const subs=['personalfinance','investing','financialindependence'];
  const posts=[];
  for(const sub of subs){
    try{
      const r=await fetch('https://www.reddit.com/r/'+sub+'/hot.json?limit=15',{headers:{'User-Agent':'WealthLensBot/1.0'}});
      const d=await r.json();
      for(const p of d?.data?.children||[]){
        const x=p.data; if(x.stickied||!x.title) continue;
        const t=x.title.toLowerCase();
        let b=0;
        if(t.includes('credit card')||t.includes('roth')||t.includes('ira'))b+=30;
        if(t.includes('invest')||t.includes('index fund'))b+=25;
        if(t.includes('401k')||t.includes('tax'))b+=20;
        if(t.includes('budget')||t.includes('debt'))b+=15;
        posts.push({title:x.title,subreddit:x.subreddit,score:x.score||0,totalScore:(x.score||0)+(x.num_comments||0)*3+b});
      }
    }catch{}
  }
  posts.sort((a,b)=>b.totalScore-a.totalScore);
  return posts.slice(0,10);
}

async function genVoice(text) {
  const c=cfg();
  if(!c.unrealspeech_api_key) throw new Error('Unreal Speech key not set');
  const urls=[];
  for(let i=0;i<text.length;i+=2800){
    const r=await fetch('https://api.v7.unrealspeech.com/speech',{
      method:'POST',
      headers:{'Authorization':'Bearer '+c.unrealspeech_api_key,'Content-Type':'application/json'},
      body:JSON.stringify({Text:text.slice(i,i+2800),VoiceId:c.tts_voice||'Dan',Bitrate:'192k',Speed:'0',Pitch:'1',OutputFormat:'uri'}),
    });
    if(!r.ok) throw new Error('TTS '+r.status);
    const d=await r.json();
    if(d.OutputUri) urls.push(d.OutputUri);
  }
  return urls;
}

async function fetchBroll(keywords) {
  const c=cfg();
  if(!c.pexels_api_key) throw new Error('Pexels key not set');
  const clips=[];
  for(const kw of (keywords||['finance money']).slice(0,3)){
    try{
      const r=await fetch('https://api.pexels.com/videos/search?query='+encodeURIComponent(kw)+'&per_page=5&size=medium&orientation=landscape',{headers:{Authorization:c.pexels_api_key}});
      const d=await r.json();
      for(const v of (d.videos||[]).slice(0,3)){
        const f=v.video_files||[];
        const hd=f.find(x=>x.quality==='hd'&&x.width>=1280)||f[0];
        if(hd?.link) clips.push({url:hd.link,duration:v.duration||10});
      }
    }catch{}
  }
  return clips.slice(0,10);
}

function thumbUrl(pillar) {
  const vis={
    investing:'golden coins stacked, glowing green stock chart, dark navy blue background, cinematic 3D render, no text, no people',
    credit_and_cards:'premium credit cards floating, gold luxury dark background, no text, no people',
    beginner_finance:'dollar bills and calculator on dark desk, studio lighting, dark navy, no text, no people',
    wealth_mindset:'city skyline golden sunset, wealth atmosphere, cinematic dark, no text, no people',
    side_hustles:'glowing laptop with coins, dark home office, gold light, no text, no people',
  };
  const p=encodeURIComponent('YouTube thumbnail background, '+(vis[pillar]||vis.investing)+', ultra sharp, professional, 16:9');
  return 'https://image.pollinations.ai/prompt/'+p+'?width=1280&height=720&model=flux&nologo=true&enhance=true&seed='+(Date.now()%99999);
}

async function assemble(audioUrls,broll,durMin) {
  const c=cfg();
  if(!c.creatomate_api_key) throw new Error('Creatomate key not set');
  const secs=durMin*60,cd=8,needed=Math.ceil(secs/cd);
  const vEls=[];
  for(let i=0;i<needed;i++){
    const cl=broll[i%Math.max(broll.length,1)];
    if(cl) vEls.push({type:'video',track:1,time:i*cd,duration:cd,source:cl.url,fit:'cover',trim:0});
  }
  const aEls=audioUrls.map(url=>({type:'audio',track:2,time:0,source:url,volume:'100%'}));
  const tEls=[
    {type:'text',track:3,time:0,duration:3,text:'WealthLens','font-family':'Montserrat','font-weight':'700','font-size':'9 vw',color:'#E8B44B','x-alignment':'50%','y-alignment':'50%',fill_color:'rgba(13,27,42,0.92)',width:'100%',height:'100%'},
    {type:'text',track:3,time:secs-5,duration:5,text:'SUBSCRIBE for more','font-family':'Montserrat','font-weight':'700','font-size':'7 vw',color:'#FFFFFF','x-alignment':'50%','y-alignment':'50%',fill_color:'rgba(13,27,42,0.90)',width:'100%',height:'100%'},
  ];
  const r=await fetch('https://api.creatomate.com/v1/renders',{
    method:'POST',
    headers:{'Authorization':'Bearer '+c.creatomate_api_key,'Content-Type':'application/json'},
    body:JSON.stringify({output_format:'mp4',width:1920,height:1080,frame_rate:30,elements:[...vEls,...aEls,...tEls]}),
  });
  if(!r.ok) throw new Error('Creatomate '+r.status);
  const d=await r.json();
  return Array.isArray(d)?d[0]?.id:d?.id;
}

async function pollCreatomate(id) {
  const c=cfg();
  for(let i=0;i<40;i++){
    await new Promise(r=>setTimeout(r,15000));
    const r=await fetch('https://api.creatomate.com/v1/renders/'+id,{headers:{Authorization:'Bearer '+c.creatomate_api_key}});
    const d=await r.json();
    if(d.status==='succeeded') return d.url;
    if(d.status==='failed') throw new Error('Render failed: '+d.error_message);
    setStatus('Rendering... '+(i+1)+'/40');
  }
  throw new Error('Render timed out');
}

async function ytUpload(videoUrl,tUrl,meta,publishAt) {
  const {yt}=getYT();
  const vr=await fetch(videoUrl);
  if(!vr.ok) throw new Error('Could not fetch video');
  setStatus('Uploading to YouTube...');
  const c=cfg();
  const up=await yt.videos.insert({
    part:['snippet','status'],
    requestBody:{
      snippet:{title:(meta.final_title||'WealthLens Video').slice(0,100),description:(meta.description||'').replace('[ROBINHOOD_LINK]','https://robinhood.com').replace('[FIDELITY_LINK]','https://fidelity.com'),tags:(meta.tags||[]).slice(0,20),categoryId:'27',defaultLanguage:'en'},
      status:{privacyStatus:publishAt?'private':(c.auto_publish?'public':'private'),publishAt:publishAt||undefined,selfDeclaredMadeForKids:false},
    },
    media:{body:vr.body},
  });
  const vid=up.data.id;
  try {
    const tr=await fetch(tUrl);
    await yt.thumbnails.set({videoId:vid,media:{mimeType:'image/jpeg',body:tr.body}});
  } catch(e){ addLog('warn','Thumbnail failed',{error:e.message}); }
  return {videoId:vid,videoURL:'https://www.youtube.com/watch?v='+vid};
}

function nextUploadTime() {
  const c=cfg();
  const [h,m]=(c.schedule_time||'09:00').split(':').map(Number);
  const dmap={sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6};
  const targets=(c.schedule_days||'tuesday,friday').split(',').map(d=>dmap[d.trim().toLowerCase()]).filter(n=>n!==undefined);
  const now=new Date();
  for(let i=1;i<=14;i++){
    const d=new Date(now); d.setDate(d.getDate()+i); d.setHours(h,m,0,0);
    if(targets.includes(d.getDay())) return d.toISOString();
  }
  const fb=new Date(now); fb.setDate(fb.getDate()+1); fb.setHours(h,m,0,0);
  return fb.toISOString();
}

async function runPipeline() {
  if(pipelineRunning){ addLog('warn','Already running'); return; }
  pipelineRunning=true;
  const rec={id:Date.now(),started_at:new Date().toISOString(),status:'running'};
  try {
    setStatus('Scanning Reddit for trending topics...');
    const posts=await fetchTrends();
    const topic=await groq('You are a YouTube strategist for WealthLens finance channel. Pick the best topic. Return ONLY valid JSON.','Posts: '+JSON.stringify(posts.slice(0,8))+'
Return: {"selected_title":"YouTube title max 70 chars","pillar":"investing","broll_search_terms":["finance money","investing stocks","financial planning"]}',300,true);
    rec.topic=topic.selected_title; rec.pillar=topic.pillar||'investing'; rec.broll_kw=topic.broll_search_terms||['finance money'];
    setStatus('Topic: '+topic.selected_title);
    setStatus('Writing script...');
    const script=await groq('You are a YouTube scriptwriter for WealthLens personal finance channel for Americans 25-42. Write engaging scripts. Rules: 30-second hook. 5-7 sections. Subscribe CTA. 1800-2200 words. Add disclaimer. Return ONLY valid JSON.','Topic: "'+topic.selected_title+'"
Return: {"optimized_title":"title max 70 chars","hook":"first 45 seconds","sections":[{"title":"name","minutes_in":1,"content":"text"}],"cta":"60 second CTA","full_script":"complete script","word_count":2000,"broll_keywords":["finance","investing"]}',4096);
    rec.title=script.optimized_title||topic.selected_title; rec.word_count=script.word_count||0;
    setStatus('Script: '+rec.word_count+' words');
    setStatus('Generating metadata...');
    const meta=await groq('You are a YouTube SEO expert. Return ONLY valid JSON.','Video: "'+script.optimized_title+'"
Return: {"final_title":"max 70 chars","description":"400 word description","tags":["tag1"],"chapters":[{"time":"0:00","label":"Intro"}],"thumbnail_line1":"HOOK","thumbnail_line2":"text","pinned_comment":"question"}',1200,true);
    rec.final_title=meta.final_title||rec.title; rec.tags=meta.tags||[];
    setStatus('Generating voiceover...');
    const cleanScript=(script.full_script||'').replace(/[.*?]/g,'').trim();
    const audioUrls=await genVoice(cleanScript);
    rec.audio_parts=audioUrls.length;
    setStatus('Voiceover: '+audioUrls.length+' parts');
    setStatus('Fetching footage...');
    const broll=await fetchBroll(rec.broll_kw);
    rec.broll_count=broll.length;
    setStatus(broll.length+' clips ready');
    setStatus('Generating thumbnail...');
    const tUrl=thumbUrl(rec.pillar);
    rec.thumbnail_url=tUrl;
    setStatus('Assembling video (5-10 min)...');
    const estMin=Math.round((script.word_count||2000)/150);
    const renderId=await assemble(audioUrls,broll,estMin);
    rec.render_id=renderId;
    const videoUrl=await pollCreatomate(renderId);
    rec.video_url=videoUrl;
    setStatus('Video assembled!');
    const publishAt=nextUploadTime();
    rec.scheduled_at=publishAt;
    setStatus('Uploading to YouTube...');
    const {videoId,videoURL}=await ytUpload(videoUrl,tUrl,meta,publishAt);
    rec.youtube_id=videoId; rec.youtube_url=videoURL;
    rec.status='published'; rec.completed_at=new Date().toISOString();
    setStatus('Done! '+videoURL);
  } catch(e) {
    rec.status='failed'; rec.error=e.message;
    setStatus('Failed: '+e.message);
    addLog('error','Pipeline error',{error:e.message});
  } finally {
    pipelineRunning=false;
    const vids=videos(); vids.unshift(rec);
    writeJSON(VIDEOS_FILE,vids.slice(0,100));
  }
}

app.post('/api/automation/start',auth,(req,res)=>{
  if(automationJob) return res.json({ok:true,message:'Already running'});
  const c=cfg();
  const [h,m]=(c.schedule_time||'09:00').split(':').map(Number);
  const dmap={sunday:'0',monday:'1',tuesday:'2',wednesday:'3',thursday:'4',friday:'5',saturday:'6'};
  const dow=(c.schedule_days||'tuesday,friday').split(',').map(d=>dmap[d.trim().toLowerCase()]||'2').join(',');
  const expr=m+' '+h+' * * '+dow;
  automationJob=cron.schedule(expr,()=>runPipeline().catch(e=>addLog('error','Cron error',{error:e.message})),{timezone:'America/New_York'});
  writeJSON(path.join(DATA_DIR,'automation.json'),{running:true,cron:expr,started:new Date().toISOString()});
  res.json({ok:true,message:'Automation active'});
});
app.post('/api/automation/stop',auth,(req,res)=>{
  if(automationJob){automationJob.stop();automationJob=null;}
  writeJSON(path.join(DATA_DIR,'automation.json'),{running:false});
  res.json({ok:true,message:'Stopped'});
});
app.post('/api/automation/run-now',auth,(req,res)=>{
  if(pipelineRunning) return res.status(409).json({error:'Already running'});
  res.json({ok:true,message:'Pipeline started!'});
  runPipeline();
});
app.get('/api/automation/status',auth,(req,res)=>{
  const auto=readJSON(path.join(DATA_DIR,'automation.json'),{running:false});
  res.json({automation_active:!!automationJob,pipeline_running:pipelineRunning,current_status:pipelineStatus,progress:pipelineProgress.slice(0,20),scheduled:auto});
});

app.get('/api/videos',auth,(req,res)=>res.json({ok:true,videos:videos()}));
app.get('/api/logs',auth,(req,res)=>res.json({ok:true,logs:readJSON(LOG_FILE,[]).slice(0,50)}));
app.get('/api/research/trends',auth,async(req,res)=>{
  try{const posts=await fetchTrends();res.json({ok:true,posts});}
  catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/analytics',auth,async(req,res)=>{
  const vids=videos().filter(v=>v.youtube_id);
  if(!vids.length) return res.json({ok:true,stats:[],channel:null});
  try{
    const {yt}=getYT();
    const ids=vids.slice(0,10).map(v=>v.youtube_id).join(',');
    const r=await yt.videos.list({part:['statistics'],id:[ids]});
    const stats=(r.data.items||[]).map(item=>({youtube_id:item.id,title:vids.find(v=>v.youtube_id===item.id)?.final_title||item.id,views:parseInt(item.statistics?.viewCount||0),likes:parseInt(item.statistics?.likeCount||0),comments:parseInt(item.statistics?.commentCount||0)}));
    const ch=await yt.channels.list({part:['statistics'],mine:true});
    const s=ch.data.items?.[0]?.statistics||{};
    res.json({ok:true,stats,channel:{subscribers:parseInt(s.subscriberCount||0),total_views:parseInt(s.viewCount||0),total_videos:parseInt(s.videoCount||0)}});
  }catch(e){res.json({ok:true,stats:[],channel:null,error:e.message});}
});
app.get('/api/revenue',auth,async(req,res)=>{
  const vids=videos(); const RPM=18; let totalViews=0;
  try{
    const {yt}=getYT();
    const pub=vids.filter(v=>v.youtube_id).slice(0,20);
    if(pub.length){
      const r=await yt.videos.list({part:['statistics'],id:[pub.map(v=>v.youtube_id).join(',')]});
      (r.data.items||[]).forEach(i=>{ totalViews+=parseInt(i.statistics?.viewCount||0); });
    }
  }catch{}
  const rev=(totalViews/1000)*RPM;
  res.json({ok:true,total_views:totalViews,estimated_revenue:+rev.toFixed(2),rpm:RPM,total_videos:vids.length,published_videos:vids.filter(v=>v.youtube_id).length,failed_videos:vids.filter(v=>v.status==='failed').length,monthly_estimate:+rev.toFixed(2),six_month_forecast:+(rev*6*3).toFixed(2)});
});

(()=>{
  const a=readJSON(path.join(DATA_DIR,'automation.json'),{running:false});
  if(a.running&&a.cron){
    automationJob=cron.schedule(a.cron,()=>runPipeline().catch(e=>addLog('error','Cron error',{error:e.message})),{timezone:'America/New_York'});
    addLog('info','Automation resumed');
  }
})();

app.listen(PORT,()=>{ console.log('WealthLens running on port '+PORT); addLog('info','Server started port '+PORT); });
