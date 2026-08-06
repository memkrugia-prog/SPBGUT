const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();
const db = require('./db');
const tg = require('./telegram');
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname,'public')));
const PORT = process.env.PORT || 3000;
const ADMIN_IDS = (process.env.ADMIN_TG_IDS||'').split(',').map(s=>s.trim()).filter(Boolean).map(Number);
const VERSION = '0.3.0';
const REMIND_HOUR_MOSCOW = parseInt(process.env.REMIND_HOUR || '19'); // 19:00 МСК по умолчанию
const MOSCOW_OFFSET = 3; // МСК = UTC+3
const REMIND_HOUR_UTC = (REMIND_HOUR_MOSCOW - MOSCOW_OFFSET + 24) % 24; // 16:00 UTC

const CHANGELOG = [
 { v:'0.3.0', date:'сегодня', notes:[
   'Автоматическая рассылка в заданное время (19:00 МСК)',
   'Обратный отсчёт 24 часа до штрафа в реальном времени',
   'Категории сложности: лёгкие / средние / сложные',
   'Множественные переводы и синонимы для каждого слова',
   'Штраф −50 очков за 24 часа без диктанта (считается по часам)' ]},
 { v:'0.2.0', date:'ранее', notes:['Railway + PostgreSQL, Telegram OAuth, турнир'] },
 { v:'0.1.0', date:'ранее', notes:['Первый релиз'] }
];

const nowUTC = () => new Date();
const today = () => new Date().toISOString().slice(0,10);

async function applyPenaltiesFor(userId){
  const u = (await db.q('SELECT * FROM users WHERE id=$1',[userId])).rows[0];
  if(!u || !u.last_dict_at) return;
  const diff = (Date.now() - new Date(u.last_dict_at).getTime()) / 36e5; // часов
  if(diff > 24){
    const missCount = Math.floor(diff / 24) - 1; // количество пропущенных 24ч
    if(missCount > 0){
      await db.q('UPDATE users SET rating=GREATEST(0,rating-$1) WHERE id=$2',[missCount*50,userId]);
    }
  }
}
async function applyAllPenalties(){
  const us = (await db.q('SELECT id FROM users')).rows;
  for(const u of us) await applyPenaltiesFor(u.id);
}

async function addActivity(userId,{points=0,answered=0,correct=0,dictations=0}){
  await db.q(`INSERT INTO activity(user_id,day,points,answered,correct,dictations) VALUES($1,CURRENT_DATE,$2,$3,$4,$5)
    ON CONFLICT(user_id,day) DO UPDATE SET
      points=activity.points+EXCLUDED.points, answered=activity.answered+EXCLUDED.answered,
      correct=activity.correct+EXCLUDED.correct, dictations=activity.dictations+EXCLUDED.dictations`,
    [userId,points,answered,correct,dictations]);
}
async function addRating(userId,n){ await db.q('UPDATE users SET rating=rating+$1 WHERE id=$2',[n,userId]); }

async function createSession(userId){
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now()+30*864e5);
  await db.q('INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,$3)',[token,userId,exp]);
  return token;
}
async function auth(req,res,next){
  const token = req.cookies.sid;
  if(!token) return res.status(401).json({error:'unauthorized'});
  const s = (await db.q('SELECT * FROM sessions WHERE token=$1',[token])).rows[0];
  if(!s || new Date(s.expires_at)<new Date()) return res.status(401).json({error:'session expired'});
  const u = (await db.q('SELECT * FROM users WHERE id=$1',[s.user_id])).rows[0];
  if(!u) return res.status(401).json({error:'no user'});
  req.user = u; next();
}
function adminOnly(req,res,next){ if(!req.user.is_admin) return res.status(403).json({error:'admin only'}); next(); }

app.get('/api/config',(req,res)=>{
  const tokenParts = (process.env.BOT_TOKEN||'').split(':');
  const botId = tokenParts[0] || '';
  res.json({ botUsername:process.env.BOT_USERNAME, botId, version:VERSION, remindHour:REMIND_HOUR_MOSCOW });
});

app.get('/auth/telegram', async (req,res)=>{
  try{
    const data = req.query;
    if(!tg.verifyAuth(data)) return res.redirect('/?error=bad_hash');
    const isAdmin = ADMIN_IDS.includes(Number(data.id));
    const count = (await db.q('SELECT COUNT(*)::int n FROM users')).rows[0].n;
    const makeAdmin = isAdmin || count===0;
    await db.q(`INSERT INTO users(tg_id,username,first_name,last_name,photo,is_admin,last_check)
      VALUES($1,$2,$3,$4,$5,$6,CURRENT_DATE)
      ON CONFLICT(tg_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,
        last_name=EXCLUDED.last_name,photo=EXCLUDED.photo`,
      [data.id,data.username||null,data.first_name||null,data.last_name||null,data.photo_url||null,makeAdmin]);
    const u = (await db.q('SELECT * FROM users WHERE tg_id=$1',[data.id])).rows[0];
    const token = await createSession(u.id);
    res.cookie('sid',token,{ httpOnly:true, sameSite:'lax', maxAge:30*864e5, secure:process.env.NODE_ENV==='production' });
    res.redirect('/');
  }catch(e){ console.error('auth error',e); res.redirect('/?error=server'); }
});

app.post('/auth/telegram', async (req,res)=>{
  try{
    const data = req.body;
    if(!tg.verifyAuth(data)) return res.status(400).json({error:'bad hash'});
    const isAdmin = ADMIN_IDS.includes(Number(data.id));
    const count = (await db.q('SELECT COUNT(*)::int n FROM users')).rows[0].n;
    const makeAdmin = isAdmin || count===0;
    await db.q(`INSERT INTO users(tg_id,username,first_name,last_name,photo,is_admin,last_check)
      VALUES($1,$2,$3,$4,$5,$6,CURRENT_DATE)
      ON CONFLICT(tg_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,
        last_name=EXCLUDED.last_name,photo=EXCLUDED.photo`,
      [data.id,data.username||null,data.first_name||null,data.last_name||null,data.photo_url||null,makeAdmin]);
    const u = (await db.q('SELECT * FROM users WHERE tg_id=$1',[data.id])).rows[0];
    const token = await createSession(u.id);
    res.cookie('sid',token,{ httpOnly:true, sameSite:'lax', maxAge:30*864e5, secure:process.env.NODE_ENV==='production' });
    res.json({ user:{ id:u.id, name:(u.first_name||u.username||'User'), username:u.username, isAdmin:u.is_admin } });
  }catch(e){ console.error('auth error',e); res.status(500).json({error:'server error'}); }
});

app.post('/auth/logout',(req,res)=>{ res.clearCookie('sid'); res.json({ok:true}); });

app.get('/api/me', auth, async (req,res)=>{
  await applyPenaltiesFor(req.user.id);
  const u = (await db.q('SELECT * FROM users WHERE id=$1',[req.user.id])).rows[0];
  // считаем время до следующего обязательного диктанта (24ч от последнего)
  let nextDeadline = null;
  if(u.last_dict_at){
    nextDeadline = new Date(u.last_dict_at).getTime() + 24*36e5;
  }
  res.json({
    user:{ id:u.id, name:(u.first_name||u.username||'User'), username:u.username, isAdmin:u.is_admin, rating:u.rating, streak:u.streak },
    lastDictAt: u.last_dict_at,
    nextDeadline,
    remindHour: REMIND_HOUR_MOSCOW
  });
});

app.get('/api/words', auth, async (req,res)=>{
  const diff = req.query.difficulty;
  let q_str = 'SELECT * FROM words';
  let params = [];
  if(diff && diff!=='all'){
    q_str += ' WHERE difficulty=$1';
    params.push(parseInt(diff));
  }
  q_str += ' ORDER BY id DESC';
  const { rows } = await db.q(q_str, params);
  res.json(rows);
});
app.post('/api/words', auth, async (req,res)=>{
  const { en, ru, note, difficulty, synonyms } = req.body;
  if(!en||!ru) return res.status(400).json({error:'en/ru required'});
  const diff = parseInt(difficulty)||2;
  const { rows } = await db.q('INSERT INTO words(en,ru,note,difficulty,synonyms,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[en,ru,note||null,diff,synonyms||null,req.user.id]);
  res.json(rows[0]);
});
app.delete('/api/words/:id', auth, adminOnly, async (req,res)=>{
  await db.q('DELETE FROM words WHERE id=$1',[req.params.id]); res.json({ok:true});
});

app.post('/api/answer', auth, async (req,res)=>{
  const { word_id, mode, correct } = req.body;
  await db.q('INSERT INTO answers(user_id,word_id,mode,correct) VALUES($1,$2,$3,$4)',[req.user.id,word_id,mode,correct]);
  const pts = correct?10:0;
  if(pts) await addRating(req.user.id,pts);
  await addActivity(req.user.id,{points:pts,answered:1,correct:correct?1:0});
  res.json({ ok:true });
});

app.post('/api/dictation', auth, async (req,res)=>{
  const { total, correct, difficulty } = req.body;
  let bonus = 20; if(correct===total) bonus+=30;
  // бонус за сложность
  if(difficulty==3) bonus += 15;
  else if(difficulty==2) bonus += 5;
  await addRating(req.user.id,bonus);
  await addActivity(req.user.id,{points:bonus,dictations:1});
  await db.q('INSERT INTO dictations(user_id,total,correct,points,difficulty) VALUES($1,$2,$3,$4,$5)',[req.user.id,total,correct,bonus,difficulty||2]);
  // обновляем время последнего диктанта — обнуляем таймер штрафа
  await db.q('UPDATE users SET last_dict_at=NOW() WHERE id=$1',[req.user.id]);
  // стрик
  const u = (await db.q('SELECT * FROM users WHERE id=$1',[req.user.id])).rows[0];
  const t = today();
  const lastDay = u.last_dict_at ? u.last_dict_at.toISOString().slice(0,10) : null;
  if(lastDay !== t){
    const streak = (lastDay === new Date(Date.now()-864e5).toISOString().slice(0,10)) ? u.streak+1 : 1;
    await db.q('UPDATE users SET streak=$1 WHERE id=$2',[streak,req.user.id]);
  }
  res.json({ bonus });
});

app.get('/api/stats', auth, async (req,res)=>{
  await applyPenaltiesFor(req.user.id);
  const uid = req.user.id;
  const u = (await db.q('SELECT * FROM users WHERE id=$1',[uid])).rows[0];
  const agg = (await db.q(`SELECT COALESCE(SUM(answered),0) a, COALESCE(SUM(correct),0) c, COALESCE(SUM(dictations),0) d FROM activity WHERE user_id=$1`,[uid])).rows[0];
  const modes = (await db.q(`SELECT mode, COUNT(*)::int a, SUM(CASE WHEN correct THEN 1 ELSE 0 END)::int c FROM answers WHERE user_id=$1 GROUP BY mode`,[uid])).rows;
  const m = {'en-ru':{a:0,c:0},'ru-en':{a:0,c:0}};
  modes.forEach(r=>m[r.mode]={a:r.a,c:r.c});
  const days=[...Array(7)].map((_,i)=>new Date(Date.now()-((6-i)*864e5)).toISOString().slice(0,10));
  const chart=[];
  for(const d of days){ const a=(await db.q('SELECT COALESCE(points,0) p FROM activity WHERE user_id=$1 AND day=$2',[uid,d])).rows[0]; chart.push({d,p:a?a.p:0}); }
  // статистика по сложностям
  const diffs = (await db.q(`SELECT d.difficulty, COUNT(*)::int cnt, SUM(d.correct)::int corr FROM dictations d WHERE d.user_id=$1 GROUP BY d.difficulty`,[uid])).rows;
  const byDiff = {1:{n:0,c:0},2:{n:0,c:0},3:{n:0,c:0}};
  diffs.forEach(r=>{ if(r.difficulty) byDiff[r.difficulty]={n:r.cnt,c:r.corr}; });
  res.json({ rating:u.rating, streak:u.streak, answered:+agg.a, correct:+agg.c, dictations:+agg.d, modes:m, chart, byDiff });
});

function periodRange(p){
  const t=today(), now=new Date();
  if(p==='day') return [t,t];
  if(p==='week'){ const mon=new Date(now); mon.setDate(mon.getDate()-((now.getDay()+6)%7)); return [mon.toISOString().slice(0,10), new Date(mon.getTime()+6*864e5).toISOString().slice(0,10)]; }
  if(p==='month') return [t.slice(0,8)+'01', new Date(now.getFullYear(),now.getMonth()+1,0).toISOString().slice(0,10)];
  return [t.slice(0,4)+'-01-01', t.slice(0,4)+'-12-31'];
}
app.get('/api/tournament', auth, async (req,res)=>{
  const [start,end]=periodRange(req.query.period||'day');
  const { rows } = await db.q(`SELECT u.id,u.first_name,u.username,u.streak, COALESCE(SUM(a.points),0)::int pts
    FROM users u LEFT JOIN activity a ON a.user_id=u.id AND a.day BETWEEN $1 AND $2
    GROUP BY u.id ORDER BY pts DESC`,[start,end]);
  res.json(rows.map(r=>({ id:r.id, name:(r.first_name||r.username||'User'), streak:r.streak, pts:r.pts, me:r.id===req.user.id })));
});

app.get('/api/changelog',(req,res)=>res.json(CHANGELOG));
app.post('/api/broadcast', auth, adminOnly, async (req,res)=>{
  const chatId = await getBroadcastChat();
  if(!chatId) return res.status(400).json({error:'Сначала /setbroadcast в группе'});
  const r = await tg.sendMessage(chatId, req.body.message||'📚 StudyСПб');
  res.json({ ok:!!r.ok });
});
async function getBroadcastChat(){
  const env = process.env.BROADCAST_CHAT_ID; if(env) return env;
  const r=(await db.q("SELECT value FROM settings WHERE key='broadcast_chat_id'")).rows[0];
  return r?r.value:null;
}

app.post('/telegram/webhook', async (req,res)=>{
  res.sendStatus(200);
  const msg = req.body?.message; if(!msg) return;
  const text=(msg.text||'').trim(), chatId=msg.chat.id, from=msg.from;
  if(text.startsWith('/setbroadcast')){
    const u=(await db.q('SELECT is_admin FROM users WHERE tg_id=$1',[from.id])).rows[0];
    if(!u||!u.is_admin) return tg.sendMessage(chatId,'⛔ Только админ.');
    await db.q("INSERT INTO settings(key,value) VALUES('broadcast_chat_id',$1) ON CONFLICT(key) DO UPDATE SET value=$1",[String(chatId)]);
    return tg.sendMessage(chatId,'✅ Группа привязана.');
  }
  if(text.startsWith('/broadcast')){
    const u=(await db.q('SELECT is_admin FROM users WHERE tg_id=$1',[from.id])).rows[0];
    if(!u||!u.is_admin) return;
    const m=text.replace('/broadcast','').trim(); const target=await getBroadcastChat();
    if(target&&m) return tg.sendMessage(target,m);
  }
  if(text.startsWith('/start')) return tg.sendMessage(chatId,`Привет, ${from.first_name}! Это бот StudyСПб 📚\n\nКоманды:\n/start — приветствие\n/help — список команд`);
  if(text.startsWith('/help')) return tg.sendMessage(chatId,'Команды:\n/start — приветствие\n/setbroadcast — (админ) привязать группу\n/broadcast <текст> — (админ) рассылка');
});

// Планировщик: рассылка + штрафы
let lastBroadcast='';
setInterval(async ()=>{
  try{
    const now = new Date();
    const mskHour = (now.getUTCHours() + MOSCOW_OFFSET) % 24;
    const mskMin = now.getUTCMinutes();
    const dayKey = now.toISOString().slice(0,10);

    // Штрафы — каждые 10 минут
    await applyAllPenalties();

    // Рассылка в заданное время (минута 0-1)
    if(mskHour === REMIND_HOUR_MOSCOW && mskMin < 2 && lastBroadcast !== dayKey){
      const chat = await getBroadcastChat();
      if(chat){
        await tg.sendMessage(chat, `⏰ <b>StudyСПб: время ежедневного диктанта!</b>\n\nНе забудь пройти хотя бы один диктант в течение 24 часов, иначе потеряешь −50 очков рейтинга.\n\n🔥 Сохрани свой стрик!`);
        lastBroadcast = dayKey;
      }
    }
  }catch(e){ console.error('scheduler',e.message); }
}, 30000);

(async ()=>{
  await db.init();
  if(process.env.PUBLIC_URL) await tg.setWebhook(process.env.PUBLIC_URL+'/telegram/webhook').catch(()=>{});
  app.listen(PORT,()=>console.log('StudyСПб v'+VERSION+' запущен на',PORT,'| напоминание в',REMIND_HOUR_MOSCOW,':00 МСК'));
})();
